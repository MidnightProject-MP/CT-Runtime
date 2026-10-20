# Celestan vNext — Execution Roadmap

Governing dependency map. Derived from the approved design baseline, the Phase 0
transition-authority/lineage map, and the review of #76 / the local Phase 1
follow-on. This document defines *what must be true*, not what is done.

**Current phase: combined Node/GAS baseline qualified at `ec4bc40` (evidence:
`docs/NODE-GAS-BASELINE-QUALIFICATION.md`), merged at `4c5116f`; recoverable
dispatch (Milestone 1C) is implemented and merged on main (#88 at `9e8413a`,
native CI green including the real-PostgreSQL and Linux process-group
crash-recovery subtest), with the review's recovery invariants hardened on main
(#90 at `007792d`: storage-integrity classification, process-group verification,
durable uncertainty on ingestion failure, store-level launch guard, plus a CI
job timeout and superseded-run cancellation); the next bounded milestone task is
the recurring, LLM-free coordinator (Milestone 2A), but Milestone 1D is not
closed: its Node/store-side D3 scope is delivered on main (#98 at `a5aeb36`,
merge `e38c179`, native CI green), while GAS send-side enforcement and the
uncertain-send `no_effect` obligation remain open. The Node delivery is a
point-in-time eligibility check, not live effect-adapter integration or
production commissioning, and 2A must not be commissioned on it alone.**
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
canonical-settlement parity is a separate forward step; its first three
increments — durable settlement receipts with exact-replay and conflict
semantics (#79 at `9894d0d`, merged to `work/vnext-email-owner-activation-c3`
at `47c8efc`), durable continuation proposals with coordinator-only
consideration (#81 at `8f838c4`, merged at `95e2bd1`), and acceptance
separation (#84 at the accepted head `e38e702`, merged at `c0e0d77`) — are
implemented and integration-proven only inside the email stack, not on main
and not operationally qualified. Acceptance separation is explicitly not
operationally qualified: acceptance-authority provisioning, the actual
accepting caller, and its substantive review remain operating-path
qualification obligations. Their definitions, increment status, and
remaining-obligation mapping are recorded under Change 2. No live migration or
cutover is implied.

## Proof status — Node boundary and the first GAS increments, not full Phase 1

| Boundary | Code | Integration proof | Operational proof |
| --- | --- | --- | --- |
| Strict faithful dialect translation | `d197876`; existing validators reused | `test/handoff-contract.test.mjs` | No new live adapter rollout |
| Bound canonical settlement; atomic evidence/proposals/progress; content-addressed replay | Node memory/PostgreSQL store changes in #76 | `test/phase1-operating-boundary.test.mjs`, plus A9 rollback suites; local disposable PGlite | None; no live DB apply |
| Acceptance bound to the durable settlement receipt | `8d6929d`; snapshot reads the settlement event and pilot result row | Real pilot suite asserts the receipt/result digests match the completion claim; tampered result or pilot-result rejects | None; project-owned acceptance authority still must be operationally qualified |
| Separate snapshot-bound acceptance | `getAcceptanceContext` / `acceptWork`; independently issued opaque decisions | Same real pilot suite: fresh-store acceptance, concurrent exact replay, stale input/revision/evidence/result, revoked verifier, project authority, changed artifact, lost COMMIT | None |
| Timestamp-free continuation | Durable pending proposal; consume precisely the selected proposal only in authorized admission; fixed coordinator cooldown | Actual submit → `runPilotOnce` → closed pool/dataDir → new store → second admission; waiting quiet and late input; native suite and two-process Linux proof are CI gates | None; no scheduler enabled |
| Recovery after reconciliation and revision change | `f522740` + review corrections; `reconcileFailure` records its outcome, grants a coordinator due time, and resolves from the authoritative block and failed-attempt binding; input and requirements updates preserve a pending reconciliation disposition; outer loop settles a revision-invalidated attempt via `persistSuperseded` | Real pilot suite: cold-restart discovery, input- or revision-during-uncertainty recovery seeing the new input and binding the new revision, exactly one recovery admission under overlapping wakes, idempotent and divergent receipts failing closed before mutation in both adapters (identity stable across later revisions), bounded further failure, late-result fencing | None; no live DB apply |
| Effect admission — Node/store-side D3 | #98 at `a5aeb36`, merged at `e38c179`; builds on cancellation intent #97 at `581266f`, merged at `f4295ed` | Guard refuses a stale revision, pending cancellation, unresolved project block, or expired stop-unconfirmed claim/authority; missing and mismatched authority fail closed. Cancellation suite 11/11 and targeted verification 70/70 at `a5aeb36`; exact-head core CI `39450786089`/`39450792576`, post-merge `39452666025` | Not claimed — no external-effect adapter is wired; GAS send admission and `no_effect` recovery remain deferred; `true` is point-in-time eligibility, not durable permission |
| GAS canonical settlement — durable settlement receipts | `006_settlement_receipts.sql` in #79 @ `9894d0d`; forward-only within the checksum-ledger chain 002–006; merged to the email stack base at `47c8efc` | GAS suites through the public RPC: first settlement, exact replay with the recorded snapshot, divergent-content conflict, lost COMMIT response, replay after successor admission, late-input eligibility, atomic rollback; the native CI stage executes the concurrent exact replay proof (not skipped); focused 47 pass / 2 native-only skips / 0 fail | Not claimed — not on main, not applied live; acceptance binding is implemented (see the acceptance-separation row) but remains operationally unqualified; no_effect recovery remains open |
| GAS canonical settlement — durable continuation proposals | `007_continuation_proposals.sql` in #81 @ `8f838c4`; forward-only within the checksum-ledger chain 002–007; merged to the email stack base at `95e2bd1` | GAS suites through the public RPC: proposal bound to the settling attempt (fence and captured input snapshot), cooldown-gated consideration, consumption exactly with authorized successor admission, exactly one successor under competing claims, waiting quiet, late-input supersession, delivery-first rejection staying pending, rollback and inert exact replay, and a 002–006→007 backfill admitting only authorized legacy continuations; the native CI stage executes the concurrent proposal admission proof (not skipped); focused 61 tests / 58 pass / 3 native-only skips / 0 fail | Not claimed — not on main, not applied live; acceptance binding is implemented (see the acceptance-separation row) but remains operationally unqualified; no_effect recovery remains open |
| GAS canonical settlement — acceptance separation | `008_acceptance_decisions.sql` in #84 @ accepted head `e38e702`; forward-only within the checksum-ledger chain 002–008; merged to the email stack base at `c0e0d77` | GAS suites through the public RPC: acceptance binds the settled revision to the canonical digest over the exact settlement receipt, exact replay returns the recorded decision, divergent content fails before mutation, stale decisions fail closed against superseded input / newer attempts / unknown work, the terminal transition rolls back atomically, an unprovisioned instance cannot accept, new acceptance is refused during unresolved reconciliation blocks or active mutation with the read-only context aligned, and an accepted decision replays while exclusions hold; the native CI stage executes concurrent acceptance and authority rotation/revocation racing acceptance in both orderings (verified not skipped at the accepted head); reviewer-verified focused integration/upgrade/F1 suites 61 pass / 5 native-only skips / 0 fail | Not claimed — not on main, not applied live; acceptance-authority provisioning, the actual accepting caller, and its substantive review remain operating-path qualification obligations |
| F1 watermark / Milestone 1C dispatch | F1 forward fix merged and integration-tested (004 snapshot binding, 005 batch-boundary recovery); 1C implemented on main (#88 at `9e8413a`, recovery invariants hardened by #90 at `007792d`), the stack inherits it on the next forward merge | F1 GAS suites green at merged heads; separate gates required | Not claimed — not applied live |

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
remaining Change 2 obligations still need an explicit mapping. The first three
increments are implemented so far, and only inside the email stack: durable
settlement receipts — `006_settlement_receipts.sql` (#79 at `9894d0d`, merged
to `work/vnext-email-owner-activation-c3` at `47c8efc`, checks green); durable
continuation proposals — `007_continuation_proposals.sql` (#81 at `8f838c4`,
merged at `95e2bd1`, checks green, native concurrent-proposal admission proof
executed); and acceptance separation — `008_acceptance_decisions.sql` (#84 at
the accepted head `e38e702`, merged at `c0e0d77`, checks green, native
concurrent-acceptance and authority rotation/revocation race proofs
executed). Acceptance separation is
implemented and integration-proven, not operationally qualified:
acceptance-authority provisioning, the actual accepting caller, and its
substantive review remain operating-path qualification obligations. Nothing
else here is implemented, applied live, or qualified; nothing is merged to
main. Recoverable dispatch (Milestone 1C) is implemented and merged on main
(#88 at `9e8413a`) and hardened by its follow-up review (#90 at `007792d`:
storage-integrity classification, process-group verification, durable
uncertainty on ingestion failure, store-level launch guard). Milestone 1D's
Node/store-side D3 scope is delivered on main (#98 at `a5aeb36`, merge
`e38c179`): effect admission rechecks revision, cancellation, project
reconciliation, and unexpired claim/authority binding. That is a transactionally
consistent eligibility check, not durable authorization, and no external-effect
adapter is wired. The remaining 1D obligation is GAS send-side enforcement plus
the `no_effect` recovery and sender-revocation contract; 1D is not closed, and
2A must not be commissioned on the Node-side delivery alone.

**Uncertain external effect (delivery recovery, not full parity).** GAS already
inserts a durable reconciliation block before an admitted send and clears it
only with delivery evidence (`record`). The missing branch is *resolved-no-effect*:
a block whose send never happened can only be cleared by producing a `gmail_id`,
so a genuinely unsent message blocks the project indefinitely. The smallest
parity change is one guarded resolution operation (a closed addition to
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
qualification obligations. Uncertain-send no_effect recovery keeps its own
evidence contract above and remains a separate, still-open increment.

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
authorization; no effect adapter is wired, and GAS send admission plus
uncertain-send `no_effect` recovery remain the open 1D obligation.

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
Node/store-side effect-admission guard is delivered (#98); GAS send-side
enforcement and `no_effect` recovery remain open.

*Milestone 1 exit: authorized work can be claimed, launched, and reconciled
under stable identity without blind duplication or overlapping mutation
authority.*

## Milestone 2 — complete the autonomous loop

**A. One recurring, LLM-free coordinator.** Each pass: inspect durable state →
reconcile uncertain launches/effects → collect and settle finished attempts →
identify eligible assignments or pending decisions → check authority and
resources → dispatch bounded work → persist operational status and stop.
Missed notifications must not lose work; periodic scanning is the recovery path.

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

**D. Reversible cutover.** Stop old admission → inventory and reconcile
in-flight work and effects → verify artifact/schema/permissions/scheduler →
enable one coordinator → observe with a tested pause path. Rollback stops new
admission first and preserves reconciliation access; it must not reactivate a
competing writer while old effects remain unresolved.

**E. Retire superseded orchestration.** Remove duplicate admission and
scheduling decisions first, then obsolete adapters, triggers, commands, docs.
Close #68/#69 after preserving unique required content.

## Tracked findings carried forward

| # | Finding | Status |
| --- | --- | --- |
| F1 | `deploy/gas-email/schema.sql` failure/expiry records the **latest** input sequence rather than the failed attempt's **captured** sequence, so new input arriving after the snapshot is suppressed until more input arrives (and the follow-up batch boundary could recommission the identical snapshot indefinitely). | Fixed forward — snapshot binding (004) and batch-boundary recovery commissioning (005) merged and integration-tested; not applied live. The suites pin the separate eligibility guarantee too: after a permitted recovery succeeds on the older three-input batch, the fourth input must become eligible **without another human message** — preventing repeated commissioning and eventually processing preserved input are distinct guarantees. |
| F2 | Release controls not operationally complete: `gas-production` has no protection rules or deployment-branch policy; no tag-targeted ruleset. Green CI does not establish the independent release approval #71 describes. | Open — repository configuration. |
| F3 | A9 overlapping-acquisition race test is timing-flaky: `test/vnext-a9-transactional.test.mjs:105` pins the loser's refusal to `E_PROJECT_AUTH_HELD` / `Work Unit changed before execution could be claimed`, but when the two `claimWorkUnit` calls land ≥1 ms apart the loser is refused earlier at `lib/vnext/memory-store.mjs:130` (`execution claim expiration does not match Work Unit claim`) and the pinned regex misses. Observed once on PR #84's run (attempt 2, one failing test; same SHA green elsewhere and on the final attempt). | Open — separate small PR. The fix must make the race test deterministic or accept the documented losing-claim outcome, without weakening the single-winner invariant. |

## Management rules

- A PR delivers a coherent, reviewable behavior or safeguard — not a mechanical
  phase slice.
- Each new behavior arrives with its prerequisite protection.
- Reopen the next one or two changes after each accepted increment.
- Track code-complete, integration-proven, and operationally-proven separately.
- Retire duplicate authority as paths converge; defer harmless cleanup until it
  earns its cost.
