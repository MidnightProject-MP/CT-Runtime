# vNext GAS email loop — pending live qualification

This is an independent, disabled-by-default vertical slice. **Nothing has been
provisioned, deployed, enabled, sent, or deleted by this change.** PR #68's Node
email pilot remains a separate merge gate; do not merge it to activate this path.
Its Gmail MIME/provenance and deterministic send identity ideas are recycled here,
not its Node worker, HTTP webapp bridge, migrations 010/011, or property fences.

## Actual capability and ownership

One explicit GAS time trigger performs:

`Gmail queue → Google-JWT Neon RPC → fenced text turn → atomic result/outbox → Gmail reply`

GAS is the only execution host. There is no Linux, Cloud Run, Oracle, shell, Node
worker, inbound webapp, or public endpoint requirement. A public webapp returning
403 does not prevent outbound time-trigger execution. Node is used for repository
tests and bundle building only. The existing canonical GitHub Actions deployment
authority is unchanged; never perform a local clasp push.

Celestan receives a source-pinned system capsule in `gas/gas_vnext_email.js` and
the original objective, previous bounded result, and at most three new messages
as **untrusted user-role data**. The capsule and configured exact model must be
reviewed before activation. The isolated executor reuses the existing OpenRouter
chat-completions mechanics without invoking the legacy Sheets telemetry sink.
No tools are advertised. It can draft, summarize, reason, answer, and ask a precise
question. It cannot inspect repositories, browse, execute code, edit files, make
GitHub changes, or deploy anything. A plain-text artifact is returned inline, not
published as a file. Email attachments/HTML-only messages are not supported.

The model returns `waiting`, `continue`, or `done`, summary (4,000 characters),
question (1,000), and optional artifact (3,000). The four canonical JSON string
values together are also capped at **15,900 UTF-8 bytes including JSON escaping**;
GAS checks exactly that budget before checkpoint and SQL enforces it independently.
NUL/unpaired-surrogate text is rejected before checkpoint. Waiting requires a question;
continue is limited to three turns per input watermark, separated by five
minutes. After the budget is exhausted there is no automatic wake until new
input. `done` produces a **draft outcome pending human review**, and Work Unit
state `review`, never `terminal`. There is deliberately no client-controlled
terminal-authorization flag or automatic terminal promotion. Human follow-up in
the same thread reopens the existing Work Unit.

Mailbox is fixed to `midnight.project.mp@gmail.com`; allowed From is fixed to
`midnightprojectantigravity@gmail.com`. GAS verifies its actual Gmail profile and
the database registration before polling. Exact From/To, non-Sent/non-Draft
provenance, original message ID, thread, and subject are checked. This is a
mailbox-routing policy, **not cryptographic sender authentication**: Gmail account
security, authenticated delivery/spam filtering, and a reviewed queue filter are
live gates. Do not label arbitrary/unverified mail. Attachments are ignored; a
plain-text MIME part and valid Message-ID are required. UTF-8/ASCII encoded-word
subjects are decoded; unsupported encodings remain queued for review.

## Durable state and concurrency

All per-message, turn, watermark, result, failure, and outbox state is in Neon.
The implementation uses the existing `vnext_work_units`, `vnext_executions`,
`vnext_project_mutation_authority`, `vnext_project_reconciliation_blocks`, and
pilot input/progress/result tables, including their deferred identity/fencing
constraints. It takes the same project advisory lock as the existing pilot.
It is not a second uncoordinated work lifecycle. Never run another host for the
registered project while this GAS-only grant is active.

`gas_email_rpc` exposes only fixed ingest, ID-only quarantine, claim/reconstruct,
checkpoint, failure, delivery preparation/admission, record/readback settlement,
and health operations. These
are server-side transactions. SECURITY DEFINER functions have a fixed search
path. Principal sub, audience, Google issuer, expiry, active instance, mailbox,
project, and a nonempty reviewed grant reference are required. The project and
destinations come from the registration, not caller arguments. Only the RPC is
granted to `authenticated`; direct table/sequence access and internal functions
are revoked for PUBLIC/authenticated/anonymous. Data API must validate Google
JWT signatures/issuer/audience/expiry before supplying claims. Never give these
roles a SQL login or expose an arbitrary-SQL RPC.

Ingest is idempotent only for an identical receipt; conflicting reuse fails.
Claim snapshots at most three inputs, advancing only through that snapshot.
Checkpoint atomically saves the result, reply envelope, consumed watermark,
Work Unit review/wait/continue state and releases the exact execution authority.
New input during a turn remains eligible. Input committed before reply admission
supersedes the old pending reply. Admission committed first creates a project
reconciliation block; newer inputs may be ingested but no new execution can start
until delivery is resolved. Native PostgreSQL CI tests both racing orderings.

Before admission, GAS retrieves the pending envelope read-only, verifies original
message provenance, and constructs/validates MIME. UTF-8 subject encoded words
are split on code-point boundaries, limited to 42 source bytes (at most 68 encoded
characters), and folded onto continuation lines. Admission then rechecks the exact
prepared execution and newer-input/authority conditions transactionally. A failed
preflight leaves the outbox pending, not irreversibly admitted.

Before Gmail send, Neon irreversibly admits that single attempt. Each outbox has
a deterministic RFC Message-ID derived from its durable execution identity. Only
the invocation receiving `send` may attempt the send. A later invocation gets
`reconcile`, **never permission to resend**, even if the first admission response
was lost before sending. Gmail readback requires Sent label, exact Message-ID,
thread, From/To, In-Reply-To, subject, and body. Reconciliation searches at most ten
results; **any nextPageToken leaves the effect uncertain**, even with one exact
match on the first page. Multiple exact matches also remain blocked. There is no
partial-search uniqueness claim. Search absence is not proof of
non-delivery. A send/ack/readback timeout remains uncertain, blocking that project.
The registered GAS principal is trusted to attest exact Gmail readback; SQL cannot
independently query Gmail. Do not grant that principal to arbitrary clients.

## Fresh bootstrap, not a migration of the archived database

`deploy/gas-email/bootstrap.json` is the authoritative **fresh dedicated database**
file list. Apply it once, in order, as the owner, inside a transaction, after
creating NOLOGIN roles `authenticated` and `anonymous` if absent. Assert the target
database is empty before applying it. Do not run the generic migration CLI on
this database, and do not apply `schema.sql` to a shared/legacy database: its
privilege revocations intentionally cover the dedicated public schema.

The manifest reuses kernel migrations 001, 002, 006–009 directly. It deliberately
omits legacy federation-dependent event/evaluation migrations 004/005; email
uses the pilot's input/result ledger, not that legacy Feedback transport. This
resolves fresh-bootstrap legacy dependencies without changing existing migration
checksums. The extension lives outside sequential `vnext-migrations`, so it cannot
collide with PR #68's independent 010/011. This is **not an upgrade path** from
either pilot, and no archived state is silently imported. Archived Neon project
`falling-bird-38424127` is not a migration/provisioning target.

Tests execute this exact manifest against PGlite and native PostgreSQL. Owner
bootstrap/setup SQL is an operator provisioning activity, never an authenticated
runtime operation. The schema requires PostgreSQL with `gen_random_uuid()`.

## Provisioning and activation — explicit parent approval required

1. Review this PR, capsule, limits, sender policy, model/cost policy, and CI. Do not
   merge/deploy as a side effect of qualification. Provision a **new** isolated
   Neon database/Data API only after approval. Capture the selected project,
   branch, database and endpoint identity; verify none is the archived project.
2. Create the two NOLOGIN roles; assert empty public schema; apply the manifest
   files in one owner transaction. Configure the Data API's verified Google OIDC
   JWT integration for the actual GAS OAuth audience, mapping verified requests
   to `authenticated`. Require issuer/signature/expiry/audience validation.
3. Register one row in `gas_email_instances`, using bound owner SQL parameters for
   `instance_id`, actual Google `jwt_sub`, exact `jwt_aud`, explicit `project_id`,
   the fixed mailbox and sender, `active=false`, and a reviewed text-only
   `grant_ref`. Never paste identity tokens or API secrets into SQL, logs or docs.
   Verify wrong principal, audience, inactive registration, and other project
   requests are denied before activation.
4. Through the canonical GitHub Actions deployment workflow only, deploy the
   reviewed source after approval. The bundle adds `gas_vnext_email`; the only
   added OAuth scope is `gmail.modify` (includes read/label/send). Existing legacy
   scopes are retained so this additive change does not break unrelated modules.
   Enable Gmail API for the linked Cloud project as required, and explicitly
   authorize GAS as the fixed mailbox account. No webapp deployment/access repair
   is needed for this runner.
5. Read reality before any configuration or repeated external effect. For the
   existing canonical script, first run the supported `diagnoseFeedbackInbox`
   against the exact Script ID/configured spreadsheet property. Inventory legacy
   executions, send fences and triggers; reconcile active references. Quiesce
   existing writers via the existing reviewed cutover procedure. No blanket
   property cleanup, trigger deletion, or assumed quiescence is authorized here.
6. Set only the allowlisted stable values from
   `deploy/gas-email/properties.example.json` manually via the approved secret/
   configuration channel. `secret_property_names_only` is documentation, not a
   property to set. Set `OPENROUTER_API_KEY` separately. Select an explicit model
   that supports JSON output; there is no silent model fallback or free-price
   guarantee. Keep `CT_VNEXT_EMAIL_ENABLED=false`. Create the Gmail `Celestan`
   label and a reviewed filter restricted to authenticated allowed-sender mail;
   replies must also receive that label. This runner never creates filters.
7. With the reviewed database grant active, call `healthVnextEmailRuntime()` and
   `inventoryVnextEmailProperties()` read-only. Verify project/mailbox/sender and
   no unresolved authority/reconciliation. Complete a controlled live test only
   with approval to send real email. Until then all live qualifications remain
   **pending**, not proven by VM tests.
8. Only then set `CT_VNEXT_EMAIL_ENABLED=true` and manually invoke
   `installVnextEmailTrigger()`. It creates one five-minute `vnextEmailTick`
   trigger, refuses other visible trigger handlers, and is idempotent for one
   existing matching trigger. GAS can only enumerate the current user's triggers;
   cross-account trigger ownership must be audited separately. Nothing installs
   on load or at deployment. Verify one physical trigger and controlled same-thread
   reply, cold reconstruction, and Neon outbox readback before unattended use.

To pause, set the stable enabled property false (future ticks are inert); revoke
the instance grant as a second gate. This does not cancel an already-admitted
in-flight Gmail effect. Inspect/reconcile first; do not delete its ledger.

## Recovery and property lifecycle

`healthVnextEmailRuntime()` returns only registration identity and aggregate
pending/uncertain/quarantine/failure/review counts, not secrets or message bodies.
Failed model turns settle without a reply and require fresh human input. Failure
and expiry **never advance the successful-consumption watermark**. A separate
failed-through watermark suppresses automatic retries of already-present input.
After a later human reply (for example, “retry”), reconstruction again includes
the oldest unconsumed failed messages in bounded batches of three. If the failed
batch contains three follow-ups, all three are reconstructed before the later
retry message; no failed follow-up is replaced by a generic failure summary.
There is no automatic endless retry or force-retry RPC. If GAS dies
during a text-only turn, its eight-minute lease can expire safely: the next claim
marks it expired, retains its unconsumed snapshot and newer inputs, and waits for
input newer than the failure gate. Text model calls have no external tools. An expired send is never
treated as safe to retry.

An admitted outbox with no exact Sent match needs operator investigation in
Gmail and Neon. Do not clear the reconciliation block or reset its state merely
because search is empty. No automatic retry, unsafe cleanup apply, or manual
"mark unsent" RPC is provided. Positive exact readback can settle on the next
tick. Truly unresolved effects require a separately reviewed recovery decision.
Intake examines at most three queued messages per tick. Oversized, malformed,
NUL-containing, unavailable, wrong-sender, or ingest-failing messages are isolated
per message: first record only instance/message ID and a fixed rejection reason in
Neon, then remove the queue label (never delete the email). This prevents three
poison messages from permanently hiding the fourth valid one. Even transient
failures are quarantined; an operator can inspect the durable ID and deliberately
reapply the label to retry. The quarantine audit row remains. If quarantine or
label removal cannot be confirmed, no new send is admitted that tick. An intake
listing failure likewise prevents new sends, **but already-admitted effects still
attempt readback reconciliation**. A persistent Gmail/Neon outage can require
operator recovery; there is no property cursor or unsafe implicit resend.
Durable records grow with work; database retention
is a separate reviewed policy, never Script Property eviction.

The new module performs **zero Script Property writes**, including no cursors,
events, tasks, runtime telemetry, receipts, nonces, or send fences. Properties hold
only six stable settings/secret names. `inventoryVnextEmailProperties()` emits
names/classifications/counts, never values. Legacy runtime names and unknowns are
preserved. Its cleanup preparation allowlist is intentionally empty: there is no
proof of inactive legacy references. Cleanup apply is separate parent work; never
delete unknown keys or unresolved `CT_EMAIL_SEND_*` fences. No Sheets reads/writes
occur on this email path.

## Verification boundaries

`node --test test/gas-email.integration.test.mjs` runs actual GAS source in fresh
VMs, simulated Gmail/OpenRouter, and real SQL via the existing test-pool helper.
It covers auth, grants, idempotency/conflicts, stale fences, bounded snapshots,
same-thread MIME replies, reconstruction, invalid/timeout models, artifacts,
new input, finite continuations, lost checkpoint/admission/send responses, poison
intake/quarantine, failed-snapshot retries, canonical multibyte/escaping byte
boundaries, RFC2047 folding, truncated/duplicate Sent searches, and
no Sheets/runtime-property access. CI also runs it through
`scripts/run-postgres-suite.mjs` against isolated native PostgreSQL, including
both genuine competing-transaction admission orderings; native races are not
substituted by PGlite serialization. Local non-PostgreSQL runs identify that race
subtest as unavailable; the native CI stage is required.

Still pending: real Neon Google-JWT/Data API integration, Gmail consent/quota and
MIME readback, actual model JSON behavior/latency/cost, sender filter provenance,
cross-account trigger audit, live lease recovery, and controlled ambiguous-send
reconciliation. A synchronous GAS UrlFetch cannot be forcibly cancelled by our
cooperative deadline; hard interruption is recovered from durable leases/admission.
Do not represent this bounded text assistant as a general autonomous coding agent.
