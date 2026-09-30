# Gmail pilot — corrected delivery, 2026-09-29

This supersedes the earlier `CT-Runtime-Email-Pilot-Final-2026-09-29.zip`, which was incomplete. Do not activate that archive.

## What runs where

GitHub Actions calls the existing Apps Script web app using `CT_GAS_ADMIN_WEB_APP_URL` and `CT_GAS_FEDERATION_HMAC_SECRET`. Apps Script uses its existing execution identity's Gmail OAuth authorization. GitHub does not require a new Gmail OAuth client or mailbox refresh token. `CLASPRC_JSON` remains deployment authorization; it does not establish Gmail consent.

Each poll imports up to ten individually labeled messages into the existing pilot inbox. It acknowledges a message by removing only its queue label after its receipt is durable. The runtime host's existing pilot timer picks up work, executes one bounded turn, and records the result. A subsequent email poll queues and sends that result to the fixed allowed sender in the original Gmail thread. GitHub does not execute the model itself. Both the poller and separately configured runtime host must run for the complete loop.

## Apply and configure

1. Compare the source snapshot with your current branch before applying it; preserve newer commits. Use `npm ci`, then run the tests. This package is based on the existing minimum-loop snapshot, not a fresh read of remote main.
2. Apply vNext migrations with `node bin/vnext-pilot.mjs migrate --config /absolute/path/pilot.json` and `CT_PILOT_DATABASE_URL`. This applies the canonical migration sequence through 011 using the migration ledger. Migration 009 is project reconciliation; 010 creates the Gmail schema; 011 adds integrity and provenance columns. A mailbox already recorded by 009 is disabled by 010 and requires explicit operator reconciliation. Do not edit applied migration checksums. Historical results with no input watermark do not generate retroactive replies.
3. Deploy through the repository's canonical GitHub Actions GAS deployment path. The bundle builder now includes `gas_zzz_email.js`; verify deployed bundle readback. Do not use a local clasp push.
4. Enable the Gmail API in the Apps Script project's existing Google Cloud project if needed. Authorize the manifest's `gmail.modify` scope as the existing execution identity. Run `authorizeEmailPilotMailbox` in the Apps Script editor for consent and mailbox readback. Verify that it returns the intended dedicated mailbox. No send happens in this helper.
5. Create a Gmail label such as `CT-Runtime` and a filter that applies it to incoming messages from the selected human sender addressed to the dedicated mailbox. Apply it to individual inbound messages; do not label an entire conversation containing bot replies. The adapter requires one exact sender and one exact destination. A sender address is a routing restriction, not a grant of execution authority: existing runtime authorization is still required.
6. Configure the settings below on both sides. Enable the GAS Script Property only when ready for a controlled test; keep the GitHub variable false until then. GAS properties must be set in Apps Script, not only GitHub.
7. Qualify the existing runtime host, project authority, model credentials and legacy exclusion as described in `VNEXT-PILOT.md`. Set the same project ID for the email adapter and host. Activate only one host timer.
8. Run the controlled acceptance below, then enable scheduled polling. GitHub's cron is best-effort, not a delivery latency guarantee.

| Setting | GitHub | GAS Script Properties |
|---|---|---|
| `CT_GAS_ADMIN_WEB_APP_URL` | Existing secret | Existing deployment |
| `CT_GAS_FEDERATION_HMAC_SECRET` | Existing secret | Same federation secret |
| `CT_PILOT_DATABASE_URL` | Secret, same database as host | Not needed |
| `CT_EMAIL_PILOT_ENABLED` | Variable, initially `false` | String `false` initially |
| `CT_EMAIL_MAILBOX_ID` | Variable, stable safe identifier | Same value |
| `CT_EMAIL_MAILBOX_ADDRESS` | Variable, dedicated mailbox | Same value |
| `CT_EMAIL_ALLOWED_SENDER` | Variable, exact human address | Same value |
| `CT_EMAIL_LABEL` | Variable, e.g. `CT-Runtime` | Same value |
| `CT_EMAIL_PROJECT_ID` | Variable, existing host project | Not needed |

`CT_EMAIL_REPLY_TO` from the previous delivery is obsolete: the only reply recipient is the exact configured allowed sender. If repository secrets live in a GitHub Environment, assign that environment to the workflow job before running it. The supplied workflow uses repository secrets/variables.

## Controlled acceptance

Send one plain-text request from the configured human address. Enable the GAS property and GitHub variable, then manually dispatch the email workflow. Confirm one receipt/input and removal of the queue label. Run a qualified host tick. Dispatch email polling again and confirm one reply in the same thread. Dispatch once more: no duplicate input or reply. Reply in that thread and verify that the same work unit becomes eligible with a new input. Disable polling if any step differs. This sequence includes live sending and must be conducted by the operator with an intended recipient.

Useful read-only checks:

```sql
SELECT receipt_id, provider_thread_id, work_unit_id, input_seq
FROM vnext_email_receipts ORDER BY received_at DESC LIMIT 20;
SELECT outbox_id, state, attempt, provider_message_id
FROM vnext_email_outbox ORDER BY created_at DESC LIMIT 20;
```

## Failure behavior and bounds

- Intake retries reuse the same deterministic pilot receipt. A crash between submission and receipt recording safely resumes; Gmail acknowledgement is last.
- Replies use the execution's recorded input watermark so a newer human message cannot redirect a prior execution's reply.
- Before sending, the database marks the row uncertain and GAS durably records an attempt under a script lock. The key binds mailbox, execution, recipient, thread and content. Retries consult the same fence. If the response was lost, GAS searches Sent for the deterministic Message-ID; it never interprets an empty search as permission to resend.
- A crash after recording the GAS fence but before sending deliberately leaves an uncertain reply. Inspect Sent and the exact fence/outbox before operator recovery; there is no automatic force-resend tool. Do not clear fences blindly. Up to ten oldest pending/uncertain replies are handled per run, so unresolved uncertainty can block later delivery and needs attention.
- Send fences have a conservative 500-entry capacity and are never automatically deleted. Reaching capacity requires operational review.
- Plain-text MIME content only, up to 16,000 characters per input. Attachments and HTML-only requests are unsupported. Existing pilot limits remain 100 inputs and 128 KiB per thread. Replies include the summary and optional question, bounded to 4,000 Unicode code points. They do not include arbitrary artifacts.
- Invalid/oversized/disallowed queued messages stop the poll rather than being silently dropped. Remove their queue label after inspection. Messages must have one destination, and replies require the original RFC Message-ID. No mailbox contents or provider errors are printed by the CLI.
- Uncertain runtime effects still use the existing runtime reconciliation policy. Email transport does not override execution authority or terminal checks.

## Verification boundary

The SQL integration test runs actual migrations and the real pilot store/outer loop with an in-process PostgreSQL-compatible engine, and drives the actual GAS bridge against a simulated Gmail REST service. It covers intake crash recovery, receipt conflicts, thread continuity, input arriving during execution, result provenance, lost send responses, exact recipients, sender rejection, authentication and queue draining. CI also runs the email test against an isolated native PostgreSQL database. That CI run and live Gmail consent/deployment have not been performed by this delivery.

Google API references: [send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send), [thread requirements](https://developers.google.com/workspace/gmail/api/guides/threads).
