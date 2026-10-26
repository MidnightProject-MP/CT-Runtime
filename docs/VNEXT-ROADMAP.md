# Celestan vNext — Execution Roadmap

Governing dependency map. Derived from the approved design baseline, the Phase 0
transition-authority/lineage map, and the review of #76 / the local Phase 1
follow-on. This document records both required outcomes and commit-bound progress;
code, offline qualification, and operational proof remain distinct.

## Current progress

- **Merged baseline:** PR #107 merged at
  `70b511184dde069191e7c82b649c6c96b4bddb42`; post-merge CI `40185638482`
  passed (`core` and `gas-data-api-role-handoff`). This follows #102 coordinator,
  #103 purpose-bound assignments, #104 multi-project isolation/fairness, #105 F4
  harness hardening, and #106 roadmap reconciliation (merge `fd2d0c8`, post-merge
  CI `40021470976` passed).
- **Milestone 3C offline slice complete:** four scripted trials, three accepted
  outcomes and one explicit bounded reconsideration. The corrected campaign at
  `384558e` records 6 objective executions, 18 worker invocations, 6 simulated
  effects, and zero real model calls, duplicate/conflicting effects, stranded
  work, or human interventions. Actual coordinator termination with a surviving
  worker recovered in **315.3 ms**, including test-only lease-expiry fast-forward.
  See the detailed status under 3C and
  [the qualification report](VNEXT-UNATTENDED-TRIAL-QUALIFICATION.md).
- **Merged — Milestone 3E, Node-first cleanup:** PR #108 merged at
  `242223579b9ae875894a6c8476e1b5db1359c310` (head
  `b26bcdbe40adf055f719c7d4353bf4bf284003e1`). It extracts shared validation,
  retires the five legacy autonomous CLI commands, and aligns help/runbook
  guidance. The separate CI repair, PR #109, merged first at
  `38c40331ef5456e94774038744c899bc5d9b92ed` after replacing the deleted
  Docker Hub MinIO images with checksum-pinned GitHub release binaries. Fresh
  PR #108 checks passed, as did post-merge main CI `40350177230` and Legacy S3
  run `40350177481`. Two earlier failed `legacy-s3` check runs remain attached
  to the same head in GitHub's historical check rollup; the latest PR run and
  the post-merge run are green.
- **First-launch scope:** Node/PostgreSQL/OpenCode with CLI input and local
  artifacts. There is no running implementation to migrate from. GAS/email
  remains separate; its retention or removal is undecided. Real decision-authority
  integration, enforced worker permissions, and host qualification remain launch
  obligations. Offline campaign success does not establish these.
- **Open findings:** F2 release controls and F4's original wrong-marker trigger
  remain open. F3 was fixed in #86; the table below now reflects that disposition.
  No live migration, activation, deployment, or commissioning is claimed.

### Historical boundary progress

PR #105 local full-core evidence on `b6c1b11` remains incomplete: the first run
had a command-executor timeout under load (isolated test passed); a follow-up
passed all 610 local tests but WSL became unresponsive during native multi-project
verification. Those failed/incomplete results remain distinct from its passing
exact-head CI and post-merge run `40015030829`.

Changes 1
and 2 on the Node operating boundary (#76) are done; the separate F1 GAS
watermark correction is merged forward (004 snapshot binding plus 005
batch-boundary recovery commissioning) and integration-tested, not applied live.
The aggregate combined main (#85) with the reviewed email stack base (#84 at
`c0e0d77`) and passed the applicable Node and GAS proofs together (push run
`39074201096`, exact-head green after one pre-code ECR image-pull flake; Linux
two-process cold-continuation proof; native GAS suites including concurrent
acceptance and authority rotation/revocation, executed not skipped), touched one
shared file (`.github/workflows/ci.yml`, union resolution) and no migration file,
and is evidence only — it grants no deployment permission and does not merge the
stack. Remaining gates are classified there as code (GAS `no_effect` recovery;
Node recoverable dispatch — since closed on main at `9e8413a`, hardened at
`007792d`), isolated runtime
qualification (accepting caller,
continuous coordinator, real-crash dispatch, GAS cutover), and production
release configuration (F2 protections). The F3 race-test flake is fixed on main
(#86 at `164fbda`, deterministic shared-clock claim). The review findings on the
Node recovery boundary are closed on the branch (`f522740`, with review
corrections on the same branch): reconciliation of uncertain effects records its
outcome and grants a durable coordinator-owned recovery opportunity; input and
requirements updates during unresolved uncertainty preserve the reconciliation
disposition, and reconciliation resolves from the authoritative block and
failed-attempt binding; a requirements revision during execution settles the
stale attempt as superseded; supersession receipts replay idempotently, with
divergent content failing before any state change in both adapters, and a
committed supersession's identity survives later revisions. GAS
canonical-settlement parity is now merged to main through #101. Its first
three increments — durable settlement receipts with exact-replay and conflict
semantics (#79 at `9894d0d`, merged to `work/vnext-email-owner-activation-c3`
at `47c8efc`), durable continuation proposals with coordinator-only
consideration (#81 at `8f838c4`, merged at `95e2bd1`), and acceptance
separation (#84 at the accepted head `e38e702`, merged at `c0e0d77`) — plus
Increment A send admission and cancellation are implemented and
integration-proven. None is operationally qualified. Acceptance separation is
explicitly not operationally qualified: acceptance-authority provisioning, the
actual accepting caller, and its substantive review remain operating-path
qualification obligations. Their definitions, increment status, and
remaining-obligation mapping are recorded under Change 2. No live migration or
cutover is implied.

## Proof status — Node boundary and the GAS pilot candidate, not full Phase 1

| Boundary | Code | Integration proof | Operational proof |
| --- | --- | --- | --- |
| Strict faithful dialect translation | `d197876`; existing validators reused | `test/handoff-contract.test.mjs` | No new live adapter rollout |
| Bound canonical settlement; atomic evidence/proposals/progress; content-addressed replay | Node memory/PostgreSQL store changes in #76 | `test/phase1-operating-boundary.test.mjs`, plus A9 rollback suites; local disposable PGlite | None; no live DB apply |
| Acceptance bound to the durable settlement receipt | `8d6929d`; snapshot reads the settlement event and pilot result row | Real pilot suite asserts the receipt/result digests match the completion claim; tampered result or pilot-result rejects | None; project-owned acceptance authority still must be operationally qualified |
| Separate snapshot-bound acceptance | `getAcceptanceContext` / `acceptWork`; independently issued opaque decisions | Same real pilot suite: fresh-store acceptance, concurrent exact replay, stale input/revision/evidence/result, revoked verifier, project authority, changed artifact, lost COMMIT | None |
| Timestamp-free continuation | Durable pending proposal; consume precisely the selected proposal only in authorized admission; fixed coordinator cooldown | Actual submit → `runPilotOnce` → closed pool/dataDir → new store → second admission; waiting quiet and late input; native suite and two-process Linux proof are CI gates | None; no scheduler enabled |
| Recovery after reconciliation and revision change | `f522740` + review corrections; `reconcileFailure` records its outcome, grants a coordinator due time, and resolves from the authoritative block and failed-attempt binding; input and requirements updates preserve a pending reconciliation disposition; outer loop settles a revision-invalidated attempt via `persistSuperseded` | Real pilot suite: cold-restart discovery, input- or revision-during-uncertainty recovery seeing the new input and binding the new revision, exactly one recovery admission under overlapping wakes, idempotent and divergent receipts failing closed before mutation in both adapters (identity stable across later revisions), bounded further failure, late-result fencing | None; no live DB apply |
| Effect admission — Node/store-side D3 | #98 at `a5aeb36`, merged at `e38c179`; builds on cancellation intent #97 at `581266f`, merged at `f4295ed` | Guard refuses a stale revision, pending cancellation, unresolved project block, or expired stop-unconfirmed claim/authority; missing and mismatched authority fail closed. Cancellation suite 11/11 and targeted verification 70/70 at `a5aeb36`; exact-head core CI `39450786089`/`39450792576`, post-merge `39452666025` | Node/store-side eligibility only, not durable permission; GAS send admission and cancellation are merged through #101 but not live-qualified; `no_effect` remains closed by decision |
| Recurring coordinator — Milestone 2A | PR #102 merged at `3ce806e` (head `b1ea356`): bounded passes, durable status, pause/resume/loop, restart recovery, decision-file CLI, retry-deadline eligibility; no migration in #102 | Historical local core at `321bcba`: 601 tests (551 pass / 50 expected skips), 16 native suites (111 pass / 0 skips), migrations and cross-process proof; targeted follow-up at `c609d19`: 34 native tests, 0 skips. PR checks `39674851927` / `39674864967` and merged-head CI `39677618494` passed | Merged code; no live operation or commissioning qualification. This does not close Milestone 3 recovery or unattended-trial gates |
| Purpose-bound execute/review/revise/accept slice | PR #103 merged at `29f6c86` (head `fc18cde`); migration `016_purpose_assignments.sql`; immutable assignment identity/report/decision, revision/input/subject invalidation, dedicated read-only command profiles, explicit Celestan decision verification, separate snapshot-bound acceptance | Historical WSL core at `cd2707a`: 608 local tests (557 pass / 51 expected skips), 16 native suites (115 pass / 0 skips), migrations and cross-process proof. Exact-head targeted WSL at `fc18cde`: 56 pass / 0 fail / 0 skip. PR checks `39846114938` / `39846322762` and merged-head CI `39849414596` passed | Merged code; acceptance-authority provisioning, an operational accepting caller, substantive review, live migration, activation, and commissioning remain unqualified |
| Multi-project workspace isolation and fair scheduling | PR #104 merged at `ed274f1` (head `b200d35`); migrations `018_project_workspace_bindings.sql` and `019_event_sequence_fairness.sql`; canonical workspace binding, project-local preparation-failure isolation, durable event-sequence fairness, assignment-aware aggregate status | Historical runtime commit `7a17e7a`: multi-project suite 13/13; core 609 local tests (557 pass / 52 expected skips), 17 native PostgreSQL suites (128 pass / 0 skips), migrations and cross-process proof. PR checks `39973034666` / `39973224311`; post-merge CI `39979449336` passed. See `docs/VNEXT-MULTI-PROJECT-QUALIFICATION.md` | Offline one-host qualification only: no live model/email/GAS/production database/deployment; no per-project caps (global pool only); workspace roots are persistent and changed roots need deliberate migration; interruption coverage uses a controlled executor boundary, not an actual coordinator-process kill |
| GAS canonical settlement — durable settlement receipts | `006_settlement_receipts.sql` in #79 @ `9894d0d`; forward-only within the checksum-ledger chain 002–006; merged to the email stack base at `47c8efc` | GAS suites through the public RPC: first settlement, exact replay with the recorded snapshot, divergent-content conflict, lost COMMIT response, replay after successor admission, late-input eligibility, atomic rollback; the native CI stage executes the concurrent exact replay proof (not skipped); focused 47 pass / 2 native-only skips / 0 fail | Merged to main via #101; not applied live; acceptance binding remains operationally unqualified; `no_effect` recovery is closed by decision (permanent stop) |
| GAS canonical settlement — durable continuation proposals | `007_continuation_proposals.sql` in #81 @ `8f838c4`; forward-only within the checksum-ledger chain 002–007; merged to the email stack base at `95e2bd1` | GAS suites through the public RPC: proposal bound to the settling attempt (fence and captured input snapshot), cooldown-gated consideration, consumption exactly with authorized successor admission, exactly one successor under competing claims, waiting quiet, late-input supersession, delivery-first rejection staying pending, rollback and inert exact replay, and a 002–006→007 backfill admitting only authorized legacy continuations; the native CI stage executes the concurrent proposal admission proof (not skipped); focused 61 tests / 58 pass / 3 native-only skips / 0 fail | Merged to main via #101; not applied live; acceptance binding remains operationally unqualified; `no_effect` recovery is closed by decision (permanent stop) |
| GAS canonical settlement — acceptance separation | `008_acceptance_decisions.sql` in #84 @ accepted head `e38e702`; forward-only within the checksum-ledger chain 002–008; merged to the email stack base at `c0e0d77` | GAS suites through the public RPC: acceptance binds the settled revision to the canonical digest over the exact settlement receipt, exact replay returns the recorded decision, divergent content fails before mutation, stale decisions fail closed against superseded input / newer attempts / unknown work, the terminal transition rolls back atomically, an unprovisioned instance cannot accept, new acceptance is refused during unresolved reconciliation blocks or active mutation with the read-only context aligned, and an accepted decision replays while exclusions hold; the native CI stage executes concurrent acceptance and authority rotation/revocation racing acceptance in both orderings (verified not skipped at the accepted head); reviewer-verified focused integration/upgrade/F1 suites 61 pass / 5 native-only skips / 0 fail | Merged to main via #101; not applied live; acceptance-authority provisioning, the actual accepting caller, and its substantive review remain operating-path qualification obligations |
| F1 watermark / Milestone 1C dispatch | F1 forward fix merged and integration-tested (004 snapshot binding, 005 batch-boundary recovery); 1C implemented on main (#88 at `9e8413a`, recovery invariants hardened by #90 at `007792d`); #101 carries the integrated stack | F1 GAS suites green at merged heads; separate gates required | Not claimed — not applied live |
| F4 — GAS SQL-worker stale-response hardening | PR #105 at `b6c1b11`, merged at `d8dc44c`: monotonic response-sequence matching, FIFO worker handling, shared client for both SQL-worker consumers, and observed-state/result diagnostics | Partial hardening for stale-response consumption; the original wrong-marker (`blocked` vs `uncertain`) trigger at `test/gas-email.integration.test.mjs:211` remains unresolved. The regression exercises a stale response but does not claim every old-client schedule fails or reproduce the original trigger. Timeline: GAS failures preceded `55aeae1`; Docker rate-limit failures followed that hardening and blocked CI; PR #104's first attempt then reproduced the GAS failure, so the earlier hardening did not eliminate it. Exact-commit targeted WSL suites: 70 tests, 64 pass / 6 expected skips / 0 fail; protocol 10/10 and integration 3/3 stability runs passed pre-commit. Exact-head CI runs `40004335202` / `40004404632` and post-merge run `40015030829` passed | No operational change. F4 remains open pending resolution of the original trigger. The later 3C offline campaign does not resolve F4 |

The PR's exact-head CI checks are the native evidence record; local PGlite is not
native PostgreSQL and local Windows runs do not prove Linux process groups.
CI explicitly runs `scripts/run-postgres-suite.mjs test/phase1-operating-boundary.test.mjs`
in an isolated database and `scripts/prove-vnext-pilot.mjs` twice in separate Linux
processes against the same disposable data directory. The email stack runs its
own CI workflow on pushes and PRs. Its native PostgreSQL stage executes the GAS
email suites, including concurrent settlement replay, concurrent proposal
admission, concurrent acceptance, and authority rotation/revocation racing
acceptance. The green runs at each accepted increment head (the branch push and
the PR) and at the merged aggregate commit (the branch push and the updated #75
PR, the latter re-verified after an infra-only container-pull retry) are the
GAS increments' native evidence record. Green CI does
not imply independent review, acceptance of this PR, or production
qualification.

### Node representation and compatibility

Forward migration **012_operating_boundary.sql** adds a material `work_revision`
and bounded `requirements` JSON to Work Units, and a trusted admission snapshot
to executions. `objective_ref` is only identity and the existing claim `fence`
increments for every attempt; neither represents changed finish conditions.
Existing rows get an explicit legacy-objective-reference baseline, not an
acceptance grant. Historical executions with no admission snapshot cannot support
new acceptance. Trusted `reviseWorkRequirements` advances the material revision;
ordinary human input instead changes the input watermark and invalidates old
acceptance without relabeling requirements or suppressing late input.

Migration 011 and all historical migrations remain unchanged. Receipt storage
reuses `vnext_events` and its event-id uniqueness from **002_survivability**, not
a fabricated dependency introduced in 004. Exact request replay returns its
durable receipt; divergent content with the same identity fails closed.

Worker settlement derives state from the validated claim and current durable
authority: `done` settles into review. Caller terminal flags, including the pure
kernel's compatibility boolean, cannot accept work. A trusted outer-loop callback
may request acceptance only **after** settlement using the durable snapshot. It
must return an opaque decision reference plus `snapshotDigest`; bare booleans or
execution-derived labels do not confer authority. The verifier runs under project
serialization against locked durable rows and rechecks project-owned acceptance
policy and external artifact integrity. Runtime does not invent semantic approval.

Pending conditions and timestamps remain discoverable through reconstruction;
`nextEligible` selects runnable opportunities, not every pending decision.
Worker timestamps do not set `next_wake_at`. Fresh input or an explicitly
coordinator-approved due condition can reopen waiting work. Immediate proposals
are subject to coordinator `intervalMs` and fresh execution authorization.

The internal namespace is `ct-runtime:vnext`; Federation, legacy Runtime and
GAS-local identities are not aliases. No cross-namespace operating adapter is
enabled by matching identifier strings. Such an adapter requires an explicit
trusted mapping before binding a handoff.

Rollback: stop admission first and preserve outstanding claims, receipts and
reconciliation access. Do not downgrade to an older writer while these records
are active. 012 is additive; retaining its columns is the safe code-rollback
posture. Dropping revision/admission data would destroy acceptance provenance
and is not a supported automatic rollback. This PR performs no live apply.

## Ownership boundary

| Component | Responsibility |
| --- | --- |
| Celestan | Interpret the objective, choose bounded work, assess results, propose continuation/reconsideration, decide substantive completion within authority. |
| Runtime coordinator | Discover eligible work, enforce authority and limits, reserve resources, dispatch, reconcile, apply guarded transitions. **No LLM calls in coordinator logic.** |
| Execution backend | Run one bounded assignment; expose launch identity, status, cancellation, result. |
| Existing vNext ledger | Authoritative work, attempts, ownership, handoffs, decisions, uncertainty, acceptance. |
| Email / Feedback | Durable input and output adapters. |
| Observer | Reflection and semantic interpretation from recorded evidence. |

Stewardship, execution, review and diagnosis are initially **assignment purposes
on the same execution mechanism**, not four orchestration systems.

## Change 1 — Make the canonical handoff faithful and safe (`#76`)

The canonical handoff is a *translation boundary*. Its job is to preserve meaning
across the three current worker dialects without inventing guarantees.

Invariants:
- Evidence capability, supplied evidence references, integrity verification,
  and acceptance are **separate facts**. None may be inferred from another.
- Evidence-free completion never becomes evidence-complete.
- Work/execution/fence/revision binding stays in trusted runtime context and is
  never asserted by a worker.
- Technical failure stays distinct from a semantic wait.
- Every wake or successor suggestion is a **proposal**, never an authority.
- Valid current outputs from all three current dialects normalize correctly.

## Change 2 — One guarded settlement and decision boundary

- Route the operating path through canonical handoff settlement.
- Persist attempt outcome, evidence references, continuation proposal, and work
  disposition **atomically**.
- Separate successful execution from accepted work.
- Add an explicit **acceptance transition** operating on settled reviewable work,
  bound to objective/work revision, exact result and evidence, authorized
  decision identity, and current requirements. That decision is **verified at
  the authoritative boundary**, not inferred from execution identity.
- Preserve continuation proposals durably **without stranding them**: they must
  remain discoverable by the coordinator after restart.
- Preserve execution authority, fencing, and reconciliation protections.
- Apply equivalent behavior to the active GAS path through a **forward**
  migration; never rewrite historical migrations.

### GAS parity against the corrected boundary (definition and increment status)

The recovery corrections imply one missing GAS recovery mechanism, and the
remaining Change 2 obligations still need an explicit mapping. The GAS
increments are implemented and merged to main through #101: durable settlement
receipts — `006_settlement_receipts.sql` (#79 at `9894d0d`, merged to
`work/vnext-email-owner-activation-c3` at `47c8efc`, checks green); durable
continuation proposals — `007_continuation_proposals.sql` (#81 at `8f838c4`,
merged at `95e2bd1`, checks green, native concurrent-proposal admission proof
executed); acceptance separation — `008_acceptance_decisions.sql` (#84 at the
accepted head `e38e702`, merged at `c0e0d77`, checks green, native
concurrent-acceptance and authority rotation/revocation race proofs executed);
and Increment A — `009_acceptance_replay.sql` plus
`010_send_admission.sql` (`58b7236`, merge `8572550`, integration-proven).
Acceptance separation is implemented and integration-proven, not operationally
qualified: acceptance-authority provisioning, the actual accepting caller, and
its substantive review remain operating-path qualification obligations.
Nothing here is applied live or operationally qualified. Recoverable dispatch
(Milestone 1C) is implemented and merged on main
(#88 at `9e8413a`) and hardened by its follow-up review (#90 at `007792d`:
storage-integrity classification, process-group verification, durable
uncertainty on ingestion failure, store-level launch guard). Milestone 1D's
Node/store-side D3 scope is delivered on main (#98 at `a5aeb36`, merge
`e38c179`): effect admission rechecks revision, cancellation, project
reconciliation, and unexpired claim/authority binding. That is a transactionally
consistent eligibility check, not durable authorization. GAS send-side
enforcement and the minimal cancellation writer/check are now merged through
#101 (`58b7236`, merge `8572550`, migration 010) and integration-proven, but
not live-qualified. The uncertain-send `no_effect` branch is closed by the
recorded evidence decision: an uncertain send remains a permanent project stop.
2A must not be commissioned on the integration evidence alone.

**Uncertain external effect (delivery recovery, not full parity).** GAS already
inserts a durable reconciliation block before an admitted send and clears it
only with delivery evidence (`record`). The *resolved-no-effect* branch is
closed by decision, not implemented: the Gmail/GAS boundary cannot establish
retrospective `no_effect`, so a genuinely unsent message blocks the project
indefinitely. `docs/VNEXT-GAS-NO-EFFECT-EVIDENCE.md` records the required
facts and closes Increment B; the operation shape below is conditional and
unauthorized. If the transport changed to one with an idempotent, durably
queryable provider outcome, the smallest parity change would be one guarded
resolution operation (a closed addition to
`gas_email_rpc` or an extension of `record`) that verifies project block,
execution/fence, instance and outbox state; records the resolution durably and
immutably (exact replay returns the prior receipt; divergent content with the
same identity fails closed); marks the outbox entry resolved without fabricating
delivery evidence (closed state; exact name fixed with the forward migration);
clears the block; and grants one coordinator-owned recovery opportunity without
new input while preserving attempt history and the existing bounded-retry limit.

**No-effect evidence contract.** The envelope's embedded `messageId` is a lookup
identity only; absence from a search does not establish absence of the effect.
Rewritten Message-IDs, provider receipts, execution markers and incomplete
searches all coexist with a successful send, and a lost send response can
accompany a delivered message. A resolution may permit another send only after
establishing (a) the previous sender cannot still perform the action — confirmed
sender termination, effective capability revocation, or an execution-boundary
guarantee that prevents further sends; database conditions such as an expired
claim, absent authority or an unrenewable fence do not by themselves stop an
already-running sender — and (b) authoritative evidence supports no_effect
rather than merely "not found". Otherwise the state must remain uncertain. The
Node D3 guard delivered in #98 is an eligibility check only; it does not provide
sender termination, capability revocation, or no-effect evidence.

**Remaining Change 2 obligations in GAS (existing / missing).**
- *Canonical handoff semantics:* existing — trusted-context binding (RPC
  principal, execution/fence, bounded turn validation). Missing — handoff
  normalization and the evidence-capability / references / integrity /
  acceptance separation; GAS emits one native dialect.
- *Bound settlement:* existing — `checkpoint` atomically settles turn, outbox,
  progress, work/execution state and authority release under one fence.
  Receipts added — `gas_email_settlements` binds the normalized result to the
  trusted instance, project, execution, fence, and captured input snapshot in
  the same transaction; an exact replay returns the recorded receipt even after
  successor admission or later input; divergent content under the same identity
  fails closed before mutation; a lost COMMIT response resolves by durable
  inspection without repeated model work or a second send (upgrade chain
  002–006 via the checksum ledger; `docs/VNEXT-GAS-EMAIL.md` records the
   contract; later stack updates retain `006_settlement_receipts`). The
   acceptance binding that was previously missing is implemented — see
   *Acceptance separation* below — and its remaining obligations are
   operational qualification, not binding.
- *Acceptance separation:* implemented — `008_acceptance_decisions.sql` adds
  the explicit acceptance transition over settled `review` work, authorized by
  a separately provisioned per-instance acceptance authority (`authority_ref`
  bearer credential, with a non-secret `authority_id` recorded for audit; an
  unprovisioned instance cannot accept, and the text-execution grant never
  extends into terminal acceptance; the authority row is locked `FOR SHARE`
  through the accepting transaction, so owner rotation/revocation serializes
  with acceptance); an independently issued opaque decision identity binds
  the exact settlement receipt (instance, execution, fence, captured input
  snapshot, turn content) through its canonical digest; exact replay returns
  the recorded decision while divergent content fails closed before mutation;
  stale decisions against superseded input or newer attempts fail closed; new
  acceptance is refused during unresolved reconciliation or active execution
  with the read-only context aligned; the terminal transition is atomic and
  touches nothing else (later stack updates retain
  `008_acceptance_decisions`). Missing — operational qualification: nothing is
  applied live, so no acceptance authority is provisioned and no accepting
  caller is wired; the substantive review that accepts real work remains an
  operating-path obligation.
- *Continuation admission:* existing — `gas_email_continuations` records one
  bounded proposal per settled attempt (`continue` with cooldown, `waiting`,
  none for `done`/failure); `claim` considers pending continue proposals only
  after cooldown, for the exact source attempt/fence/snapshot, with no newer
  input and within the turn budget, and consumes the selected proposal
  atomically with authorized successor admission; waiting stays quiet, late
  input supersedes, exact replay is inert, and the 002–007 upgrade converts
  only authorized legacy schedules (later stack updates retain
  `007_continuation_proposals`). Input/wake eligibility is not a substitute.

**Completed increment this cycle: GAS acceptance separation.** A successful
`done` remains a completion claim, not accepted work; GAS now records an
explicit trusted acceptance decision over settled reviewable work, parallel to
the Node boundary: an independently issued opaque decision identity binds the
exact settlement receipt through its canonical digest; a decision against
superseded input, newer attempts, or a divergent result fails closed (stale
rejection); exact replay returns the recorded decision while divergent content
under the same identity fails before mutation (replayable); terminal
acceptance requires the separately provisioned per-instance acceptance
authority and serializes with its rotation/revocation (#84 at the accepted
head `e38e702`, merged at `c0e0d77`). Implemented and integration-proven, not
operationally qualified: acceptance-authority provisioning, the actual
accepting caller, and its substantive review remain operating-path
qualification obligations. Uncertain-send `no_effect` recovery is closed by
the evidence decision above: it is not implemented, and an uncertain send
remains a permanent project stop.

**Completed increment this cycle: Node/store-side D3 effect admission.** The
Node boundary now refuses an external effect when the Work Unit revision has
advanced past the attempt's admission revision, a cancellation intent is
pending, an unresolved project reconciliation block exists, or the attempt's
claim/authority is expired or mismatched, including an expired stop-unconfirmed
attempt that still holds its claim and running state. The guard verifies the
project mutation authority against the Execution, Work Unit, owner, fence,
authorization reference, and claim expiration under the project lock (#98 at
`a5aeb36`, merged at `e38c179`; cancellation suite 11/11, targeted verification
70/70, exact-head and post-merge core CI green). This closes the Node/store-side
D3 scope only: it is a transactionally consistent eligibility check, not durable
authorization. GAS send admission and cancellation are merged and
integration-proven through #101, not live-qualified. Uncertain-send
`no_effect` recovery remains closed by decision, so an uncertain send is a
permanent project stop.

**In-flight requirements revision:** GAS email has no trusted material-revision
path, and its equivalent — human input arriving during execution — is already
handled (pending delivery superseded; settled work returns to actionable when
newer input exists), so no change is implied there. The existing 005
batch-boundary recovery commissioning already matches the
coordinator-owned-opportunity semantics for model failures.

## Milestone 1 — one reliable coordination core

**A. Close the baseline.** Finish #71 → #72 → #75 in dependency order, including
the targeted input-watermark correction and outstanding qualification. Produce a
compact authority map: input admission, work creation/revision, claim and
resource reservation, launch, settlement, continuation admission, acceptance,
reconciliation — authoritative writer and transaction for each.
*Exit: no ambiguity about which component may change each authoritative fact.*

**B. Handoff and guarded decisions.** Changes 1 and 2 above. Add only the
bounded-work information the first operating path needs.
*Exit: attempts are disposable; work identity, requirements and decisions
survive them.*

**C. Make dispatch recoverable.** Persist launch intent and a stable dispatch
identity before launch, bound to one attempt and approved assignment. Recover
backend run identity after a lost launch response. Reconcile pending launches and
running attempts after coordinator restart. Distinguish definitely-not-launched,
running, completed, unknown. Preserve uncertainty.
*Exit: a crash around launch does not lose the attempt or cause blind relaunch.*

**D. Enforce lifetime and resource authority.** Enforce deadlines outside the
worker process. Reserve concurrency and applicable cost/tool budgets atomically.
Retain project mutation exclusion by default. Require stop confirmation,
effective revocation, or reconciliation before conflicting takeover. Check
revision and cancellation at dispatch, settlement, and effect admission. The
Node/store-side effect-admission guard is delivered (#98); GAS send admission
and cancellation are merged through #101 and integration-proven, not
live-qualified. Uncertain-send `no_effect` recovery is closed by decision as
unsupported on the current Gmail/GAS boundary.

*Milestone 1 exit: authorized work can be claimed, launched, and reconciled
under stable identity without blind duplication or overlapping mutation
authority.*

## Milestone 2 — complete the autonomous loop

**A. One recurring, LLM-free coordinator.** Each pass: inspect durable state →
reconcile uncertain launches/effects → collect and settle finished attempts →
identify eligible assignments or pending decisions → check authority and
resources → dispatch bounded work → persist operational status and stop.
Missed notifications must not lose work; periodic scanning is the recovery path.

*Status: merged via PR #102 at `3ce806e9d579a7c04950d3dc2cf772ecc757429b` (PR head `b1ea3569f91bffe6bb2c1918905313ec17f4d0f1`).* `lib/vnext/coordinator.mjs` and
`lib/vnext/coordinator-status.mjs` implement bounded passes, restart
recovery through `runPilotOnce`, overlap exclusion through the existing
admission guard, durable `coordinator.pass` records, pause/resume, a sequential
loop, and a ledger-derived status view. `bin/vnext-pilot.mjs` adds
`inspect`, `run`, `pause`, `resume`, and decision-file-bound
`accept`/`cancel`/`reconcile`; PR #102 itself adds no database migration.
The 8-case coordinator and 5-case integrated CLI suites are in the required
native suite list. Historical local core evidence at `321bcba`: 601 local tests (551
pass, 50 expected platform skips, 0 failures), migrations passed, all 16
required native PostgreSQL suites passed (111 tests, zero skips), and the
cross-process proof passed. Follow-up targeted evidence at `c609d19`: coordinator
8/8, integrated CLI 5/5, operating boundary 16/16, Neon 5/5 (34 tests, zero
skips). PR #102 exact-head checks `39674851927` and `39674864967`, and merged-head
CI run `39677618494`, passed. These historical results remain tied to their
tested commits. The coordinator code is merged, but this does not qualify live
operation or commissioning. The later PR #107 offline campaign supplies the
bounded recovery and unattended evidence described under Milestone 3C; remaining
operational gaps are not closed by either increment.

**B. Bounded Celestan assignment purposes.** Stewardship (bounded next-work
proposals), Execution (result, evidence, remaining work, uncertainties), Review
(assessment against finish conditions), Diagnosis (cause, evidence, justified
recovery/reconsideration proposal). Explicit model/agent selection and
purpose-specific permissions.

**C. Continuation, interruption, reconsideration.** Continuation of the same work
across attempts; human answers and changed requirements; cancellation and
supersession; blocked dependencies; provider failures; repeated unsuccessful
approaches. Separate technical retry from a substantive decision to try again.

**D. Controlled parallelism.** Start with independent projects and compatible
read-only work. Reserve all required resources atomically. A role name or
separate worker process does not establish independence.

**E. Objective completion and status.** Review against the original objective and
current authorized revision. Expose a ledger-derived view: objective/revision,
active assignments and attempts, what changed and evidence, waiting reason or
unresolved uncertainty, next eligible action and why, completion claim versus
accepted completion, specific human input needed.

## Milestone 3 — prove reliability, remove duplication

**A. Recovery matrix.** Crash before/after launch; lost launch or settlement
response; overlapping wakes; coordinator dies while worker survives; cancellation
or changed requirements; provider timeout/outage; uncertain external action;
repeated unsuccessful work; lost notification; new input during execution.

**B. Recheck safeguards.** Project-level serialization and stale fencing;
execution authorization provenance; immutable migrations and restricted database
roles; target validation before credential transmission; intake pagination and
poison-message handling; delivery receipts and no-blind-resend; secret-safe
diagnostics; exact-artifact release identity and readback.

**C. Repeated unattended trials.** Isolated, genuinely useful objective with a
clear finish condition. Record useful accepted outcomes, recovery time, duplicate
or conflicting effects, lost or stranded work, unnecessary model calls, repeated
non-progress, human coordination/rescue, stable quiet behavior after completion.
Human-rescued runs must be identified explicitly.

*Status: bounded offline campaign delivered in PR #107 (head `b552de8`, merge
`70b5111`).* Corrected campaign `edb51127-fa3d-4c26-966e-6d2e1f311c9b`
tested clean commit `384558e5188a0a02c2ff285788c0e60365e7b338` on Linux,
Node 22.14.0 and PostgreSQL 16.15. Campaign suite: 2/2; supporting coordinator
CLI 6/6, recoverable dispatch 14/14, multi-project 13/13; zero failures/skips.
Exact-head CI `40184966367` / `40185006409` and post-merge `40185638482` passed.

Four predeclared trials produced three accepted outcomes and one
`reconsideration-exhausted` outcome, explicitly not counted as accepted success.
Durable records show 6 objective executions, 12 assignment executions, 18 scripted
worker invocations, 6 simulated effects, zero duplicate/conflicting effects,
zero stranded work, zero real model calls, and zero human interventions/rescues.
Two later quiet probes per trial left execution, assignment, worker, and effect
counts unchanged. The actual coordinator was killed while its worker survived;
restart settled retained evidence without repeating the objective execution.
Corrected-campaign recovery was 315.3 ms including the lease fast-forward,
281.1 ms from fast-forward to settlement.

Limits: scripted workers and decision authority, one Linux host and isolated
database, simulated local effects only. Natural lease expiry, overlapping wakes
during the post-kill orphan interval, long-duration operation, real model judgment,
and production effects remain unqualified. Overlapping wakes occurred before the
kill. Prior failed attempts and the earlier narrower successful campaign remain
recorded in [the qualification report](VNEXT-UNATTENDED-TRIAL-QUALIFICATION.md).
The reporting-only correction `b552de8` has focused failure-path evidence; the
reported corrected campaign remains tied to `384558e`, not a new local campaign
at the final head. This closes the delivered offline slice, not live qualification.

**D. Qualified first launch and reversible stop (Milestone 3D).** No running
implementation is being migrated. Verify the exact artifact, fresh schema,
permissions, real decision authority, worker isolation, and timer/host → enable
one coordinator → observe with a tested pause path. Stopping admission must
preserve claims, receipts, and reconciliation access; repair or reset an isolated
environment only after accounting for its outstanding effects. Legacy cutover is
not a prerequisite for this fresh launch, although current code still requires the
`legacyExcluded` operator assertion. Historical cutover instructions are not
deployment authority.

*Status: local mechanics passed; operational qualification remains open.* The
standalone WSL harness passed on exact commit `7910e44` (clean worktree, Node
22.14.0, PostgreSQL 16.15), with a scripted authority and worker and zero model
calls. It exercised a fresh migration ledger and restricted runtime role, a WSL
read-only write probe, worker credential exclusion, pause while a worker remained
live, resume, and one systemd user-timer invocation. This is not a
`verify.mjs`-suite pass or evidence of the selected production path; details are
recorded in PR #112. The disposable config kept both pilot flags false during
preflight and set them true before its first bounded tick. At the remote heads
observed before this roadmap update, PR #111 at `50ea188` and PR #112 at
`5bb4ca6` were open, all checks were green, and `mergeStateStatus=CLEAN`; neither
was merged. This PR #111 update requires fresh checks.

Before the selected target's first tick, observe that it has no competing legacy
writers or in-flight effects. For this fresh launch, that target-specific
exclusion check does not require a legacy cutover or migration exercise. The
`legacyExcluded` boolean remains an operator assertion, not that evidence.

Still required for operational qualification:

- the real assignment-decision authority, not the deliberately incomplete
  example or deterministic local authority;
- the selected host and service account, with an OS- or sandbox-enforced worker
  permission boundary; the WSL read-only probe does not qualify the target host;
- the exact approved artifact and target fresh database with least-privilege
  runtime roles, separate from production credentials;
- a target-host timer invocation, recurring timer/reboot behavior, and the
  configured timeout and restart behavior;
- pause preventing new admission while a live worker finishes, plus recovery
  without duplicate effects on the selected path. The local pause/resume check
  passed, while the separate 3C crash-recovery evidence remains limited to its
  scripted environment.

F2 and F4 remain open independently.

**E. Retire superseded orchestration.** Remove duplicate admission and
scheduling decisions first, then obsolete adapters, triggers, commands, docs.
Close #68/#69 after preserving unique required content.

*Status: merged via [PR #108](https://github.com/MidnightProject-MP/CT-Runtime/pull/108)
at `2422235` (head `b26bcdb`).* Branch `work/node-first-cleanup` started from
`70b5111` and contains:

| Commit | Delivered change |
| --- | --- |
| `ee2814d595f4d5a1ad658cdfa0e2458e3e03977a` | Neutral `lib/celestan-result.mjs` validators; handoff no longer imports legacy runtime; compatibility re-exports retained |
| `f1c39c76e7c2139fcb5c87cbab240f66c30d7e54` | Removes legacy CLI `run`, `wake`, `schedule`, `scheduler`, `recover`; rejects them before store creation; updates tests and active guidance |
| `b26bcdbe40adf055f719c7d4353bf4bf284003e1` | Aligns runbook and CLI help, including discoverable vNext migration setup |

Reported exact-commit WSL evidence at `b26bcdb`: clean checkout, Node 22.14.0,
PostgreSQL 16.15; retirement/runtime/handoff suites 45/45; targeted coordinator
CLI 6/6, recoverable dispatch 14/14, cancellation 11/11 (31 pass, zero skips).
An earlier combined run failed a legacy scheduler test, then passed isolated
5/5 and in the exact-commit rerun; its cause remains unresolved, not fixed by
the documentation correction. Review approved push/PR. Fresh PR #108 checks
passed: `core` and `gas-data-api-role-handoff` in run `40349077380`;
`legacy-s3` in run `40349077365`. Post-merge main CI `40350177230` and Legacy S3
`40350177481` also passed. Earlier failed `legacy-s3` runs `40200639886` /
`40200672421` remain in GitHub's historical check rollup and reflect deleted
upstream Docker Hub images, not this cleanup. The separate repair
[PR #109](https://github.com/MidnightProject-MP/CT-Runtime/pull/109) replaced
those images with checksum-pinned GitHub release binaries and merged at
`38c4033` before this PR; GitHub retained the earlier failures in the rollup, so
the PR page did not present a fully clean check rollup at merge time. The latest
PR and post-merge runs are green.

Next: trace remaining legacy runtime consumers before deleting implementations.
Retained migration, inspection, evidence, and Observer utilities still have
consumers. GAS/email retention is a separate scope decision; no GAS removal or
issue #68/#69 closure is claimed.

## Tracked findings carried forward

| # | Finding | Status |
| --- | --- | --- |
| F1 | `deploy/gas-email/schema.sql` failure/expiry records the **latest** input sequence rather than the failed attempt's **captured** sequence, so new input arriving after the snapshot is suppressed until more input arrives (and the follow-up batch boundary could recommission the identical snapshot indefinitely). | Fixed forward — snapshot binding (004) and batch-boundary recovery commissioning (005) merged and integration-tested; not applied live. The suites pin the separate eligibility guarantee too: after a permitted recovery succeeds on the older three-input batch, the fourth input must become eligible **without another human message** — preventing repeated commissioning and eventually processing preserved input are distinct guarantees. |
| F2 | Release controls not operationally complete: `gas-production` has no protection rules or deployment-branch policy; no tag-targeted ruleset. Green CI does not establish the independent release approval #71 describes. | Open — repository configuration. |
| F3 | A9 overlapping-acquisition race test used independently sampled claim clocks, allowing a different losing-claim refusal and missing its pinned regex. | Fixed on main in #86 at `164fbda`: deterministic shared-clock claim, preserving the single-winner invariant. This is distinct from the later legacy scheduler-test failure reported during cleanup verification. |
| F4 | GAS SQL-worker stale-response cascade and original wrong-marker (`blocked` vs `uncertain`) failure. | Partial hardening merged in #105 at `d8dc44c`: FIFO handling and monotonic response matching. Original wrong-marker trigger remains unresolved; green reruns do not establish its cause or resolution. See proof-status evidence above. |

## Management rules

- A PR delivers a coherent, reviewable behavior or safeguard — not a mechanical
  phase slice.
- Each new behavior arrives with its prerequisite protection.
- Reopen the next one or two changes after each accepted increment.
- Track code-complete, integration-proven, and operationally-proven separately.
- Retire duplicate authority as paths converge; defer harmless cleanup until it
  earns its cost.
