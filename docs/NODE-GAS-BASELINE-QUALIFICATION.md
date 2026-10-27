# Node/GAS baseline qualification

> **Historical evidence aggregate.** The selected vNext execution path is the GAS-hosted email loop. This document preserves the combined Node/GAS verification record; it does not make the Node path the selected launch and does not authorize deployment or activation. See [VNEXT-GAS-EMAIL.md](VNEXT-GAS-EMAIL.md) and [VNEXT-GAS-PILOT-COMMISSIONING.md](VNEXT-GAS-PILOT-COMMISSIONING.md).

Evidence aggregate for the "qualify the combined Node/GAS baseline" work order. Branch
`work/node-gas-baseline-integration` is a verification aggregate; it is not a proposal to merge the
open stack (#71/#72/#75) and carries no deployment permission.

## Pinned inputs and aggregate

- main: `f0739f023f6f1524aa3898959b4514619e382e1b` (#85)
- stack: `work/vnext-email-owner-activation-c3` at `c0e0d77941bb06c719db6334eb294a2ff0335611` (#84)
- aggregate: ordinary merge commit `ec4bc40` on `work/node-gas-baseline-integration`, merge base `2e98c27`

Exactly one file changed on both sides — `.github/workflows/ci.yml` — resolved as a union: main's
Linux two-process cold-continuation proof and role-handoff job are retained alongside the stack's
native GAS suite step. Every other changed file is single-side; no file re-implements the same
concern on both sides.

## Aggregate gates (commit `ec4bc40`)

- CI push run `39074201096`: attempt 1 flaked on the known ECR/Docker `toomanyrequests` image pull
  before any code ran; attempt 2 green on both jobs (`core`, `gas-data-api-role-handoff`).
- `core`, on the aggregate: explicit legacy `npm run migrate` against real PostgreSQL (direct/owner
  URL), full Linux `npm test`, the native PostgreSQL suites for both paths (Node: postgres-boundary,
  observer, vnext-neon, a9-postgres, pilot, phase1-operating-boundary, project-authority, isolation;
  GAS: gas-email.integration including concurrent acceptance with authority rotation/revocation —
  `ok 49`/`ok 50`, executed not skipped — bootstrap, delivery-upgrade, model-retry,
  failure-watermark), the Linux two-process cold-continuation proof (timestamp-free continue), and
  `npm audit`.
- Local aggregate (Windows): 527 tests, 485 pass, 39 skipped, 3 failing — all three failures are
  platform-only (Linux spawn/process-group suites); no merge-induced failure.
- GAS bundle built from the aggregate: `node scripts/build-gas-bundle.mjs gas <out>` → 25 files,
  bundleHash `64939e7c38769a2a1f12581f8ca4f4cc56800eea37354984a46e5a76cd946bad`, including the
  canonical `gas_vnext_email.js` arm and `gas_vnext_email_owner.js`.

## Migration-path selection

Three chains exist and are explicitly selected; none is interchangeable with another:

| Chain | Applied by | Scope |
|---|---|---|
| Legacy federation `migrations/` 001–017 | `bin/ct-runtime.mjs migrate` → `lib/migration.mjs` (explicit direct/owner URL required; pooled URL rejected) | legacy runtime (being retired) |
| vNext Node `vnext-migrations/` 001–012 | `migrateVNext` (`lib/vnext/migration.mjs`), directory always explicit: `bin/vnext-pilot.mjs`, `scripts/prove-vnext-pilot.mjs`, native suites | Node path |
| GAS `deploy/gas-email/` bootstrap.json + 002–008 | `scripts/bootstrap-gas-email.mjs` (manifest + `schema.sql` + 006 authority migration, checked against the manifest) then forward-only `scripts/upgrade-gas-email-delivery.mjs` (checksum ledger, refuses drift) | GAS path |

The merge modified none of these files; historical migrations and checksums are untouched.

## Authority map

| Fact | Node path writer (transaction) | GAS path writer (transaction) | Evidence | Gap |
|---|---|---|---|---|
| Admission | outer loop: `wake.inspected` event (replay-guarded) + `isJustified` + `beginExecution` (claim + execution + authorization decision in one store transaction; Postgres boundary is the durable form, memory boundary the reference) | `ingest` (input row) then `claim` (FOR UPDATE on the work unit; continuation-proposal consumption and mutation-authority acquisition in the same transaction) | phase1-operating-boundary, a9 transactional suites, gas-email integration | none for single-coordinator operation; cross-coordinator admission is fenced by claim + authority |
| Launch / dispatch | `createCommandExecutor`: request.json (`wx`), detached spawn, credential-stripped env, process-group SIGKILL on exit and timeout; result + hash-retained evidence. Durable claim/execution/authority exist before spawn | delivery admission → outbox; a reconciliation block requires delivery evidence (`record`) before dispatch continues | phase1-operating-boundary, Linux two-process proof | Node: no durable launch intent or run identity — a crash between `beginExecution` and result is only classified conservatively, not distinguished. GAS: the resolved-without-effect (`no_effect`) branch is not implemented |
| Settlement | `applyTurn` + `persistTurn` (turn + state + authority release in one transition; `E_STALE_REVISION` → `persistSuperseded` releases the excluded attempt's authority for the current revision); settlement receipt/digest via 011/012 | `checkpoint`: one fence across turn + outbox + progress + state + authority release; `gas_email_settlements` receipt | a9 transactional suite (exact replay, supersede), receipt digests, gas-email integration | none established |
| Continuation | settlement writes `pending_proposal`; `runPilotOnce.isJustified` consumes it (immediate mode, `runnable_at` due); cooldown honored | 007 proposal cursor; considered at `claim`; same justification rule; cooldown honored | Linux two-process cold-continuation proof (timestamp-free continue), gas-email integration | none established |
| Acceptance | `getAcceptanceContext` snapshot (revision + requirements + settlement) → `authorizeTerminal` decision, enforced distinct from the execution authorization ref → `acceptWork` + `validateAcceptanceDecision` | 008 `acceptance-context`/`accept`: acceptance authority read FOR SHARE through the accepting transaction, separate from execution authority; recorded `authority_id` is a non-secret identifier; digest binds the reviewed snapshot; concurrent rotation/revocation serialized in both orderings | kernel/phase1 acceptance tests, native GAS acceptance + rotation suite | both paths: authority provisioning and the actual accepting caller are not exercised as an operating path (implemented and integration-proven, not operationally qualified) |
| Reconciliation | `failExecution(..., reconciliationRequired=true)` (conservative: maxAttempts 1) + coordinator `blocked: reconciliation-required` disposition; resolution starts from durable inspection; the rejected turn stays unsettled until resolved | pre-dispatch reconciliation block + delivery `record` evidence; failure watermark | phase1-operating-boundary, a9 failure paths, failure-watermark suite | GAS `no_effect` resolution (uncertain send resolved as not sent) missing; Node post-restart launch classification missing (below) |

## Remaining gates (classified)

Code, not yet implemented (in order):

1. GAS uncertain-send `no_effect` recovery (separate increment; not started).
2. Node recoverable dispatch — durable launch intent + run identity + post-restart classification
   (proposal below).
3. F3 race-test determinism — implemented on main in a separate small PR (#86); the stack inherits
   it on the next forward merge.

Isolated runtime qualification (implemented and integration-proven; not yet qualified as an
operating path):

- GAS acceptance-authority provisioning, the actual accepting caller, and its substantive review.
- Continuous coordinator operation: live scheduling, real wakes, and restart behavior on a real host.
- Recoverable dispatch exercised against real crash points on a real host.
- GAS cutover (operating the GAS path as the active path).

Production release configuration (no code):

- Branch/tag protection for the GAS release path (F2: `gas-production` rules; tag ruleset for
  hash-pinned releases).
- Production Script Properties, spreadsheet binding, and Gmail account configuration.

## First recoverable-dispatch proposal (bounded, commission-ready)

Backend: the existing Node pilot command executor (Linux process groups). It is the only execution
backend with integration evidence: credential isolation enforced at construction
(DATABASE/POSTGRES/CT_PILOT names rejected), process-group lifetime (group SIGKILL after exit and on
timeout), hash-retained evidence, and the CI Linux two-process cold-continuation proof. No Cloud Run
or GAS-side execution backend is scheduled.

Additions, smallest missing safeguard first:

1. Durable launch intent + identity (the increment). Persist, transactionally with (or immediately
   after) `beginExecution` and before spawn, a launch record for the attempt: `execution_id`,
   attempt fence (revision + authorization decision ref), host identity
   (`/proc/sys/kernel/random/boot_id`), and the state directory. After spawn, record the run identity
   (pid/pgid + `/proc/<pid>/stat` start ticks, which survive pid reuse) as `launched`. A crash can
   then never leave an attempt that is implicitly unknown.
2. Recovery classification from durable records only: no intent → definitely-not-launched →
   conservative failure settlement (existing path; retry policy decides). Intent but no run identity
   → definitely-not-launched, same. Run identity live (boot id + start ticks match) → running.
   Identity gone + result present → completed. Identity gone + no result → definitely-not-launched.
   Identity live + no result → unknown → `reconciliation-required` (existing blocked disposition).
   Never relaunch blind; only definitely-not-launched attempts proceed to retry.
3. Inspection surface: command/inspection over launch records + state directory + live identity
   probe, exposed through existing store/status conventions — no new control plane.
4. Worker lifetime enforcement stays in the runner (timeout + group kill); the recovering
   coordinator enforces deadlines from durable launch records and takes over only after confirming
   the recorded run identity no longer exists (stop confirmation).
5. Lost launch response is covered by (2): a missing `launched` record with no live identity is
   definitely-not-launched; a live identity with no result is unknown → reconciliation, never an
   automatic retry.

Done when: crash-injection tests at the three points — between `beginExecution` and spawn, between
spawn and the `launched` record, and during a running worker — each classify correctly from durable
state alone; no execution both mutates and relaunches; the single-winner invariant and conservative
failure path are preserved.

## Notes

- #86 (F3 determinism) is green and awaiting the merge verdict; nothing in this aggregate depends
  on it.
- This aggregate grants no new permission: no deployment, no live-environment change, and no merge
  of the open stack.
- Postscript: item 2 of *Remaining gates* (Node recoverable dispatch) is implemented and merged on
  main (#88 at `9e8413a`), native CI green including the real-PostgreSQL and Linux process-group
  crash-recovery subtests. The classification above remains as of `ec4bc40`; one deliberate
  refinement is recorded in the implementation — a recorded identity that is provably gone but left
  no result settles as exited-without-result into reconciliation, not retry.
- Postscript 2: the review's recovery invariants are hardened on main (#90 at `007792d`): missing
  or unreadable attempt storage classifies as unknown and never retries blind; the recorded process
  group — not only the launcher pid — must be provably gone before settlement; unreadable or
  malformed retained results settle into durable reconciliation with a bounded reason; and a
  recorded launch can never be resolved as never-launched. Milestone 1D (lifetime and resource
  authority) remains unimplemented before 2A commissioning.
