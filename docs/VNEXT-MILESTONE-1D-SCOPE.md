# Milestone 1D — Lifetime and Resource Authority: scope proposal

Status: **reviewed and approved; review decisions recorded (§5).** This document
scopes the work; it implements nothing and grants no permission. Definitions
and evidence obligations follow the roadmap (`docs/VNEXT-ROADMAP.md`,
Milestone 1, item D) and the completion plan.

## Exit condition (from the roadmap)

> **D. Enforce lifetime and resource authority.** Enforce deadlines outside the
> worker process. Reserve concurrency and applicable cost/tool budgets
> atomically. Retain project mutation exclusion by default. Require stop
> confirmation, effective revocation, or reconciliation before conflicting
> takeover. Check revision and cancellation at dispatch, settlement, and effect
> admission.

*Milestone 1 exit: authorized work can be claimed, launched, and reconciled
under stable identity without blind duplication or overlapping mutation
authority.*

## 1. What already exists (partial protections, mapped)

These are real and stay; 1D completes them rather than replacing them.

- **Coordinator-owned claim expiry.** `claim_expires_at` moves in one transaction
  across Work Unit, Execution and project mutation authority (deferred trigger
  block `006:83-106`); recovery consumes only expired claims.
- **Single-winner authority.** Authority acquisition is transactional under a
  project advisory lock (`neon-store.mjs:88`); the gate refuses with
  `E_RECONCILIATION_REQUIRED`/`E_PROJECT_AUTH_HELD` at `:138`/`:143`, and the
  insert's row-count check is `:157-158`, so a second concurrent admission
  fails closed.
- **Kill-then-poll (stop confirmation for the Node runner).** Recovery kills the
  recorded process group, then polls the identity probe and the group probe
  through a bounded window (`dispatch-recovery.mjs:115-122`) before settling;
  `probeProcessGroup` treats zombies as gone and reports `unavailable` (never
  `gone`) when unverifiable.
- **Reconciliation before takeover.** Unresolved project reconciliation blocks
  refuse new admission (`E_RECONCILIATION_REQUIRED`) and acceptance; uncertain
  outcomes (unconfirmed launch, exited-without-result, unreadable or malformed
  artifacts) settle into durable blocks with bounded reasons.
- **Deadline outside the worker (Node).** The runner timer kills the process
  group on `timeoutMs` (`command-executor.mjs:29-31`, cleanup at `:45-46`);
  claim TTL is `timeoutMs + margin`; a timeout settles as conservative failure,
  never a silent retry.
- **Revision checks at admission and settlement.** `work_revision` and the
  input snapshot are captured in the admission context and re-checked at
  `beginExecution` (`neon-store.mjs:113`); settlement of a superseded attempt
  fails as `E_STALE_REVISION` (`outer-loop.mjs:105`) and resolves through
  `persistSuperseded`.
- **Acceptance/terminal authority checks.** Acceptance is a distinct authorized
  decision, refused during reconciliation or active mutation, serialized with
  authority rotation/revocation (GAS).

## 2. What is genuinely missing (the scope)

### D1. Cancellation intent and its check points

No cancellation concept exists in vNext today: there is no authorized cancel
intent a coordinator can record, and no check for one at dispatch, settlement,
or effect admission. Revision supersession exists; cancellation does not.

Smallest sufficient change:

- A durable, idempotent **cancellation intent** (an authorized decision with an
  opaque reference, exact-replay semantics, divergent-content conflict), bound
  to project/Work Unit and the observed revision.
- Checks: **dispatch** refuses admission for a work unit with a pending
  cancellation intent; **settlement** settles the cancelled attempt explicitly
  (no result acceptance) and preserves effect uncertainty; **effect admission**
  refuses when a cancellation intent is pending for the revision being effected.
- The broader interruption/reconsideration UX (2C) is explicitly out of scope;
  1D defines the intent, the check points, and fail-closed behavior.

### D2. Atomic concurrency and budget reservation

There is no concurrency pool and no cost/tool budget anywhere. Project mutation
exclusion (authority, concurrency 1 per project) exists, but nothing bounds
concurrent execution across projects, and nothing reserves budget atomically
with admission.

Smallest sufficient change:

- Admission reserves, **in the same transaction as authority**: one concurrency
  slot from a configured bounded pool (the first budget dimension, decided).
  Reservation rows are stored so an aggregate global cap composes later.
- Attempt counts and wall-clock already exist (claim/attempt limits, runner
  timer, TTL): track them, don't duplicate them. Effect counts qualify only
  where enforceable at the boundary (GAS sends, with D3). Node model-call/turn
  counters are not runtime-enforceable today and are deferred — no aspirational
  counters.
- Refusal is fail closed with a distinct error (`E_CONCURRENCY_LIMIT`, and
  `E_BUDGET_EXHAUSTED` only where an enforceable budget dimension exists); the
  refused work keeps a coordinator-owned retry opportunity, never an immediate
  hot retry.
- Release is exactly once across every exit path: settlement, failure,
  supersession, cancellation, expired-claim recovery (only after the existing
  stop-confirmation window), and reconciliation resolution.
- Reservations are inspectable through existing store/status conventions — no
  new control plane.

### D3. Revision and cancellation at effect admission

Settlement already re-checks revision; dispatch admission already binds it.
The missing boundary is **effect admission**: the point where work transitions
from internal state into an external side effect (today: GAS sends; future Node
effect adapters such as deploy).

Smallest sufficient change:

- Define effect admission as a guarded boundary: refuse when the work revision
  has advanced past the effecting attempt's admission revision, when a
  cancellation intent is pending, or when the project has an unresolved
  reconciliation block.
- GAS send admission already inserts the reconciliation block before an
  admitted send; add the revision/cancellation checks there. For Node, the
  enforceable boundary remains the executor (dispatch + settlement); gating
  side effects *inside* an arbitrary worker is a non-goal — new effect adapters
  must route admission through the guarded boundary.

### D4. Stop-confirmation semantics as a contract

Node recovery has kill-then-poll; there is no uniform, stated contract, and the
GAS sender path has none (the uncertain-send contract already records that an
expired claim, absent authority, or an unrenewable fence does not stop an
already-running sender).

Smallest sufficient change:

- State and enforce one contract: a conflicting takeover or effect re-admission
  requires **one of** — provable stop (identity + group probe, Node), effective
  capability revocation with sender-termination evidence (GAS), or completed
  reconciliation. `unavailable` verification never passes; it is `unknown` and
  blocks.
- GAS sender-side revocation semantics are the stop-confirmation half of the
  already-scoped uncertain-send `no_effect` increment; the two ride together
  (decided) rather than duplicating the mechanism. 1D states the backend-neutral
  contract; it does not inherit the no_effect operational gate.

## 3. Explicit non-goals

- No distributed queue, multi-host scheduling, or worker-pool infrastructure;
  a bounded coordinator-owned pool over transactional reservations is the
  ceiling.
- No billing, pricing, or external cost-accounting integration; budgets are
  runtime-enforced counters.
- No change to transactional-store, fencing, or authority foundations
  (Milestones 2B/2C/2D) — 1D consumes them.
- No worker-internal effect gating for arbitrary commands.
- No reactivation/UX for cancelled work beyond the fail-closed check points
  (2C owns the full story).

## 4. Evidence plan

Following the established pattern (durable-records classification, native
PostgreSQL + Linux process-group tests in the isolated PG suite, crash
injection, exact-head CI):

- **Reservation:** pool exhausted refuses; budget-exhausted refuses; release is
  exactly once across settle/fail/supersede/cancel/expiry/recovery; a crash
  between admission and launch releases only after stop confirmation.
- **Cancellation:** intent before dispatch refuses admission; intent during a
  running attempt kills-and-polls then settles cancelled; intent racing
  settlement resolves fail-closed; replay returns recorded receipt; divergent
  content conflicts.
- **Effect admission:** stale revision, pending cancellation, or unresolved
  block refuses the send; exact replay inert.
- **Stop confirmation:** probe `unavailable` → `unknown` → no takeover; group
  live with launcher gone → still running; revocation evidence required for
  GAS re-admission.

## 5. Decisions (recorded per review)

1. **Cancellation authority — distinct authorized decision surface.** Same
   pattern as acceptance: opaque decision ref, authorized at the coordinator
   boundary, idempotent exact replay, divergent-content conflict. Reusing
   execution authority would conflate "run this" with "never finish this" and
   blur audit/verification paths; the check points need a durable verifiable
   intent anyway.
2. **Cancelled disposition — explicit `cancelled` state, terminal-ish.**
   Reactivation only via a new authorized revision. Reusing `review` plus a
   failure record would make cancelled work indistinguishable from work
   awaiting acceptance and leak into acceptance eligibility. Attempt history
   and effect uncertainty are preserved; reconciliation still gates project
   reuse.
3. **Budget dimensions — reserve only what admission can enforce and release
   can observe.** First implementation: concurrency slots. Attempt counts and
   wall-clock already exist — track, don't duplicate. Effect counts qualify
   only where enforceable at the boundary (GAS sends, with the
   `no_effect`/D3 work). Node model-call/turn counters are deferred; no
   aspirational counters.
4. **Pool scope — per-project bound first.** Authority is per-project; the
   per-project bound is the enforceable unit today. Store the reservation so an
   aggregate global cap composes later; cross-project scheduling belongs to 2D.
5. **GAS sender revocation — rides with the uncertain-send `no_effect`
   increment.** 1D states the backend-neutral stop-confirmation contract;
   duplicating the GAS mechanism separately would fork the evidence contract.

**Sequencing (suggested and adopted):** D4 (contract, smallest — clarifies
release/stop semantics) → D2 (reservation primitive and exactly-once release
paths) → D1 (cancellation intent wired to those paths) → D3 (Node guard
definition folds in; GAS send checks ship with `no_effect`).
