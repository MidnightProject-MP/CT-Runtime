# GAS pilot commissioning package

Status: **historical evidence aggregate and proposed operating plan for the
selected GAS vNext path.** The GAS stack was merged to `main` through #101; the
runtime remains disabled and no live qualification is claimed. This document
authorizes no deployment, database apply, GAS configuration, trigger change,
model call, or mail send. Every provisioning and live step below requires
separate explicit approval.

## Candidate identity

| Item | Value |
|---|---|
| Historical candidate branch | `work/gas-integrated-pilot-candidate` |
| Main incorporated | `d0725aba087709b321ab227b0a320afddead6c93` (#100) |
| Merge to main | `8572550c90000f29496ec979ad54286a45b5fb09` (#101) |
| GAS stack / Increment A tip | `80d15e177d73c7b068b79d4296d98ef4d3e7165f` |
| Integration merge | `10fb00c1a0892212430de27a92a52a2036508000` (parents `80d15e1`, `d0725ab`) |
| Lifecycle and `no_effect` commit | `bce25b0c2f0404cf501a2f390d8a8ba984e306fb` |
| Verified code/test head | `6132c52224782c23fc6e878da40debb28e99272b` |
| GAS bundle at verified head | 25 files, `06fbbc227bbf623cb19c4990e2937264dbd3b6850d58f109f15b1e0c54e34278` |
| Bundle build environment | WSL Ubuntu 24.04, Node 22.14.0, LF checkout |

This commissioning document is added in a docs-only commit after the verified
head. It changes no code, test, migration, or deployment input.

The release bundle identity is the canonical Linux build above. The builder
normalizes CRLF to LF, and `test/gas-bundle-builder.test.mjs` proves LF and CRLF
sources yield the same hash. A Windows checkout is not a release identity.

The candidate incorporates current main through #100 and the GAS email stack
represented by draft PR #75, including the merged #84 acceptance separation, the
acceptance-replay prerequisite `817e054`, and Increment A (`da19305`, `80d15e1`).
PR #75 remains a draft and is not merged by this candidate. No other open PR is
claimed as incorporated, and no PR is superseded by this package.

Live state is unchanged. Repository documentation records the existing
production registration `gas-vnext-email` in project `celestan-email` as active
for owner qualification, the email runtime as disabled, and 010 as not
live-applied. This candidate neither verifies nor changes that state; the pilot
must use its own isolated target. The candidate includes the binding
`no_effect` decision in `docs/VNEXT-GAS-NO-EFFECT-EVIDENCE.md`.

Only `.github/workflows/ci.yml` changed on both sides of the merge. It was
resolved as a union: main's core verifier and role-handoff job remain alongside
the GAS native suite step. Every other file is single-side; no concern is
reimplemented on both sides.

The verified code/test commit `6132c52` normalizes CRLF to LF in the bundle
builder and adds the regression test. Production SQL, runner code, migrations,
and deployment workflows are unchanged from `1b829eb`.

## Evidence at the verified candidate

| Gate | Result |
|---|---|
| Core local tests | 591 tests, 542 pass, 49 platform skips |
| Legacy migrations | 1-17 applied |
| Required native PostgreSQL suites | 14/14 pass |
| Cross-process cold-continuation proof | pass |
| GAS integration | 61/61 pass, 0 skips |
| GAS bootstrap | 2/2 pass |
| GAS delivery upgrade | 7/7 pass |
| GAS model retry | 2/2 pass |
| GAS failure watermark | 8/8 pass |
| GAS bundle | 25 files, hash above |

The affected bundle/deploy-contract suites were rerun separately at this head:
30/30 pass, including the LF/CRLF hash regression.

The GAS integration suite includes the pilot-lifecycle test: the actual GAS
runner executes in a cold VM on every tick with mocked Gmail and OpenRouter and
the public SQL RPC. It proves the ordered path intake -> claim -> checkpoint ->
`delivery-peek` -> `delivery` admission -> one send -> `note-send-receipt` ->
readback -> `record`, then explicit acceptance and a cold restart that remains
idle with no second send, admission, or execution. It also asserts one admission,
settlement binding, zero reconciliation blocks, exact acceptance replay, and
health counts.

The PGlite run of the same integration file passes 55 tests with 6 native-only
skips. PGlite does not qualify the native concurrency behavior; the native
suites above were executed separately, not skipped.

A test-only ordering flake was found and fixed at `1b829eb`. PGlite returns
`clock_timestamp()` at millisecond resolution, so two continuation rows can tie
and `ORDER BY created_at` alone can return them in either order. The assertions
now select rows by `kind` or `execution_id`. No production query or behavior was
changed.

The evidence above is local: Linux Node 22.14.0, PostgreSQL 16.15 in the WSL
verification workspace, plus Windows Node 24.19.0 for the PGlite path. The #101
merge does not convert this local evidence into a live qualification.

## Proven and not proven

Proven:

- The current main and GAS stack merge without unresolved semantic conflict.
- Send admission, cancellation, exact receipt replay, acceptance replay after
  authority rotation/revocation, and the 009-to-010 upgrade boundary on native
  PostgreSQL.
- The complete GAS runner lifecycle with mocked Gmail/OpenRouter, including a
  single send and cold-restart idleness.
- Bootstrap integrity, upgrade rollback, model-retry bounds, and failure
  watermark behavior.

Not proven:

- Real Gmail send/readback, real OpenRouter inference, or real Neon Data API and
  Google-JWT behavior.
- GAS source deployment, Script Properties, Gmail consent, label/filter, trigger
  installation, or activation.
- The actual acceptance caller, its independent review, or the cancellation
  caller as operating paths.
- Live lease recovery, quota behavior, MIME readback against real Gmail, and
  cross-account trigger ownership.
- Uncertain-send recovery. `no_effect` is not establishable on this boundary;
  Increment B remains closed.

## Authority map

| Fact | Authority | Enforcement and evidence | Gap |
|---|---|---|---|
| Execution and send admission | Registered instance `grant_ref` plus active flag; GAS Google JWT principal | Authenticated RPC, project lock, immutable admission receipt, one `send` transition; native integration/races | Real Data API/JWT path not exercised |
| Acceptance | Per-instance `gas_email_acceptance_authorities` row, separate from execution | `acceptance-context` snapshot, digest binding, exact replay; native acceptance/rotation tests | Actual accepting caller and substantive review not operational |
| Cancellation | Per-instance `gas_email_cancellation_authorities` row, separate from execution and acceptance | `cancel`; pending versus `after-admission`; exact replay; native tests | Cancellation caller/UX not operationally qualified |
| Uncertain-send recovery | None | Block remains `external-effect-uncertain` | Intentionally absent; no override or resend |
| Bootstrap and upgrades | Database owner direct connection | Checksummed manifest and upgrade ledger; `inspect`/`validate`/`apply`; rollback on failure | Not executed on a pilot database |
| Source deployment | Manual hash-pinned GitHub workflow in `gas-production` | Reviewed release tag/commit, desired and expected-live bundle hashes, readback | No release tag, approval, or deployment |
| Activation and trigger | GAS owner | `activateVnextEmailRuntime`, verified single five-minute trigger, disabled until checks pass | Not run; Gmail consent unknown |
| Gmail send | GAS runtime | Admission before send, provider receipt, exact readback, `record` before block clear | Real Gmail not exercised |

## Provisioning and deployment order

This order is a proposal. Do not skip a gate because an earlier gate passed.

1. **Approve the pilot target.** Use a new isolated database and Data API, a
   dedicated GAS project/script ID, a test mailbox and allowed sender distinct
   from production, and an explicit JSON-capable model. Confirm none of these is
   the archived or production target. Record the project, branch, database,
   endpoint, script ID, mailbox, sender, and model identities.

2. **Bootstrap the database.** Create NOLOGIN `authenticated` and `anonymous`
   roles if absent. With the exact owner target in
   `CT_BOOTSTRAP_DATABASE_HOST`, `CT_BOOTSTRAP_DATABASE_NAME`,
   `CT_BOOTSTRAP_DATABASE_OWNER`, and `CT_BOOTSTRAP_DATABASE_URL`, run:

   ```sh
   node scripts/bootstrap-gas-email.mjs inspect
   node scripts/bootstrap-gas-email.mjs validate
   node scripts/bootstrap-gas-email.mjs apply
   ```

   The manifest is exactly seven files: `vnext-migrations/001_outer_loop.sql`,
   `002_survivability.sql`, `006_project_mutation_authority.sql`,
   `007_authorization_provenance.sql`, `008_minimum_pilot.sql`,
   `009_project_reconciliation.sql`, and `deploy/gas-email/schema.sql`. Do not
   run the generic migration CLI against this database.

3. **Apply forward upgrades 002-010.** Run:

   ```sh
   node scripts/upgrade-gas-email-delivery.mjs inspect
   node scripts/upgrade-gas-email-delivery.mjs apply
   ```

   The chain is `002_delivery_provider_receipts`, `003_model_diagnostics`,
   `004_failure_watermark_snapshot`, `005_failure_recovery_boundary`,
   `006_settlement_receipts`, `007_continuation_proposals`,
   `008_acceptance_decisions`, `009_acceptance_replay`, `010_send_admission`.

   **Ordering constraint:** the upgrade script permits zero registrations or
   exactly one registration named `gas-vnext-email` in project
   `celestan-email`. If the pilot uses any other instance or project name,
   apply the upgrades before inserting its registration. The 010 upgrade does
   not backfill admission receipts for legacy admitted outboxes; those remain
   reconciliation-only and must never be resent.

4. **Register the pilot instance with `active=false`.** Use bound parameters,
   never interpolated secrets:

   ```sql
   INSERT INTO public.gas_email_instances
     (instance_id, jwt_sub, jwt_aud, project_id, mailbox, allowed_sender, active, grant_ref)
   VALUES ($1, $2, $3, $4, $5, $6, false, $7);
   ```

   Use the actual Google subject and audience, the exact mailbox and allowed
   sender, and a reviewed text-only grant reference. Verify that a wrong
   principal, wrong audience, inactive registration, and another project are all
   denied before activation.

5. **Provision acceptance and cancellation authorities separately.** Generate
   unpredictable credentials through the owner's secret channel and record only
   non-secret audit identifiers:

   ```sql
   INSERT INTO public.gas_email_acceptance_authorities
     (instance_id, authority_ref, authority_id)
   VALUES ($1, $2, $3);

   INSERT INTO public.gas_email_cancellation_authorities
     (instance_id, authority_ref, authority_id)
   VALUES ($1, $2, $3);
   ```

   These credentials are distinct from the execution grant and from each other.
   Do not put them in logs, events, documentation, or the ordinary sender's
   environment. No recovery authority exists; do not create one.

6. **Configure the Data API.** Enable the verified Google OIDC JWT integration
   for the actual GAS audience, with issuer, signature, expiry, and audience
   validation, mapping only verified requests to `authenticated`. Confirm the
   runtime role has only the public RPC execute privilege, with no direct table,
   column, sequence, or other function access. This is owner-managed
   configuration; it is not performed by repository code.

7. **Set only the allowlisted Script Properties, disabled.** Use
   `deploy/gas-email/properties.example.json` as the complete property list:
   `CT_VNEXT_EMAIL_ENABLED=false`, instance, Data API URL, approved Data API
   host, approved script ID, approved mailbox, approved sender, explicit model,
   and label. Set `OPENROUTER_API_KEY` separately as the only secret property.
   The file's `secret_property_names_only` key is metadata identifying the
   secret; it is not a Script Property and must not be set. Keep the runtime
   disabled.

8. **Deploy reviewed source through the canonical workflow only.** The manual
   `gas-self-deploy.yml` workflow requires an exact reviewed
   `refs/tags/gas-release/*` tag, a full release commit equal to the dispatched
   workflow SHA, a reviewed desired bundle hash, a freshly and independently
   inspected live predecessor hash, and the `GAS_APPROVED_RELEASE` variable. Run
   `qualify_only=1` first. Only after reviewing that result, dispatch the
   deployment with `qualify_only=0` and both hashes. Verify HEAD equals LIVE and
   the deployed version equals the desired hash. Never perform a local
   `clasp push`; legacy clasp workflows fail closed.

   The verified-head bundle hash above is evidence for this candidate, not a
   standing deployment authorization. Rebuild and re-review the bundle from the
   exact release commit; do not reuse a hash after any source change.

9. **Verify read-only before activation.** Call `healthVnextEmailRuntime()` and
   `inventoryVnextEmailProperties()`. Confirm the instance, project, mailbox,
   sender, model, grant, and script ID; no unresolved authority or
   reconciliation; no runtime work/execution/outbox rows; and exactly the
   expected properties. GAS source deployment does not establish Gmail consent
   or runtime qualification.

10. **Prepare Gmail and activate through the owner helpers.** In the Gmail UI,
    create the `Celestan` label and a future-mail-only filter from the allowed
    sender to the mailbox. Run `prepareVnextEmailRuntime` and
    `diagnoseVnextEmailPreparation` as needed. Only after all readiness stages
    pass, run `activateVnextEmailRuntime` once. It must verify the real Gmail
    profile, exact bindings, active database registration, label, and trigger
    inventory; create at most one five-minute trigger; and enable the runtime
    only after verified single-trigger readback. Activation itself does not poll,
    call the model, or send mail; the first real task is separate. Do not
    manually create a duplicate trigger or edit properties concurrently.

## First pilot

The first real send requires separate explicit approval. The first pilot is one
bounded, human-reviewed task:

- one plain-text objective, one message, one thread, one recipient;
- no attachments, no HTML-only message, no tools, no repository or shell
  access;
- the existing bounded model-turn and continuation limits apply; no unattended
  long-running loop;
- a human reviewer inspects the draft and issues acceptance independently.

Expected evidence:

- one Gmail intake and one Work Unit;
- one claimed execution, one settlement, one admission, one send;
- `note-send-receipt` records the provider identity; exact readback matches the
  admitted envelope; `record` clears the block;
- the reply remains in the same thread;
- review is accepted once and becomes terminal; exact replay returns the
  recorded decision;
- no duplicate send, admission, or execution after a cold restart;
- health reports zero uncertain, zero review, one accepted, and no block;
- no secret appears in inputs, results, logs, or evidence.

Stop the pilot immediately on any uncertain send or block, duplicate send,
readback mismatch, unexpected message, authority or registration mismatch,
model failure loop, duplicate trigger, or migration drift. A delivered draft is
not terminal until the independent acceptance decision is recorded.

## Stop, rollback, and recovery

To stop future work, run `pauseVnextEmailRuntime`, which sets and verifies
`CT_VNEXT_EMAIL_ENABLED=false`. Then delete every `vnextEmailTick` trigger in
the Apps Script editor's Triggers page, which is the owner-only mechanism; no
exported helper deletes triggers. Do not call `installVnextEmailTrigger` or
`activateVnextEmailRuntime` during stop. Verify the Triggers page shows no
`vnextEmailTick` trigger, then run `diagnoseVnextEmailPreparation()` and confirm
its `trigger-inventory` stage reports `emailTriggerCount: 0` with no unexpected
handler. Revoke the instance grant and the separate acceptance and cancellation
authorities as required. Do not delete the database, blocks, or evidence.

An uncertain send is a permanent project stop:

- do not clear or manually delete the reconciliation block;
- do not resend or retry the same envelope under a new execution;
- do not treat search absence, recipient confirmation, elapsed time, audit-log
  absence, credential revocation, or trigger disablement as `no_effect`;
- preserve the admission, outbox, receipt, readback, Gmail state, and bounded
  diagnostics;
- record the incident factually.

Continuing after an uncertain send requires a new project or isolated instance
and explicit authorization. The old block remains historical evidence. There is
no operator override and no `no_effect` recovery on this boundary.

If source rollback is required, use the canonical hash-pinned deployment
workflow with a separately reviewed prior release and its hashes. Never use a
local clasp push. The database schema is forward-only; do not attempt to roll
back migrations or delete state to recover. Preserve data and escalate.

## Remaining blockers and go/no-go

Blockers:

- `no_effect` recovery is unavailable; uncertain send is a permanent stop.
- No real Gmail, OpenRouter, Neon Data API, or Google-JWT qualification exists.
- The actual acceptance caller and substantive review are not operational.
- 010 is not live-applied; the provisioning and upgrade sequence above has not
  been executed on a pilot database.
- This package establishes no approved release tag, approved-release variable, or
  current self-deploy release for the candidate. A source-only deployment from
  `work/vnext-gas-email-loop` at `6839783` ran on 2026-10-12
  ([workflow run 38307713234](https://github.com/MidnightProject-MP/CT-Runtime/actions/runs/38307713234));
  source push, pinned deployment update, and post-deployment HEAD/version checks
  succeeded. Its Script Properties, trigger, and Gmail configuration steps were
  skipped. This is historical source-deployment evidence, not current canonical
  release qualification or current HEAD/LIVE verification.
- The evidence in this package is local and bounded. The #101 merge and any green
  CI do not constitute live qualification.

Go/no-go:

| Scope | Decision |
|---|---|
| Isolated, bounded, human-reviewed pilot after all approvals and provisioning | Conditional go |
| Unattended or production operation | No-go |
| Any uncertain send or unresolved reconciliation | Stop; no-go |
| `no_effect` recovery or manual block clearing | No-go; closed |
| Merge of PR #75 or push of this candidate as a side effect of commissioning | No-go; separate authorization required |

## Reproducible evidence commands

Run in the WSL workspace with the local disposable PostgreSQL URL. Each GAS
suite is a separate invocation; do not pass multiple suite paths to
`run-postgres-suite.mjs`, because it isolates one database per invocation and
Node would otherwise run files concurrently against it.

```sh
env POSTGRES_URL=<local-test-database-url> \
  /home/philippecave/.nvm/versions/node/v22.14.0/bin/node scripts/verify.mjs core

env POSTGRES_URL=<local-test-database-url> \
  /home/philippecave/.nvm/versions/node/v22.14.0/bin/node scripts/run-postgres-suite.mjs test/gas-email.integration.test.mjs

env POSTGRES_URL=<local-test-database-url> \
  /home/philippecave/.nvm/versions/node/v22.14.0/bin/node scripts/run-postgres-suite.mjs test/gas-email-bootstrap.test.mjs

env POSTGRES_URL=<local-test-database-url> \
  /home/philippecave/.nvm/versions/node/v22.14.0/bin/node scripts/run-postgres-suite.mjs test/gas-email-delivery-upgrade.test.mjs

env POSTGRES_URL=<local-test-database-url> \
  /home/philippecave/.nvm/versions/node/v22.14.0/bin/node scripts/run-postgres-suite.mjs test/gas-email-model-retry.test.mjs

env POSTGRES_URL=<local-test-database-url> \
  /home/philippecave/.nvm/versions/node/v22.14.0/bin/node scripts/run-postgres-suite.mjs test/gas-email-failure-watermark.test.mjs

node scripts/build-gas-bundle.mjs gas <bundle-output.json>
```

The GAS stack is merged. The historical 2026-10-12 source-only deployment in
[workflow run 38307713234](https://github.com/MidnightProject-MP/CT-Runtime/actions/runs/38307713234)
successfully pushed source, updated the pinned deployment, and verified the
deployed version against HEAD at that time. The workflow did not configure
Script Properties, triggers, or Gmail, and it did not activate the runtime.
Current canonical release qualification, current HEAD/LIVE equality, and current
runtime readiness remain unverified; no activation or first live task is claimed.
