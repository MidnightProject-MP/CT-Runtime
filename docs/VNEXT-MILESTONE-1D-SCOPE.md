# Milestone 1D — Lifetime and Resource Authority: scope proposal

Status: **proposed, pending review.** This document scopes the work; it
implements nothing and grants no permission. Definitions and evidence
obligations follow the roadmap (`docs/VNEXT-ROADMAP.md`, Milestone 1, item D)
and the completion plan.

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
  across Work Unit, Execution and project mutation authority (deferred trigger,
  migration `006`); recovery consumes only expired claims.
- **Single-winner authority.** Authority acquisition is transactional under a
  project advisory lock; `ON CONFLICT DO NOTHING` plus a row-count check makes a
  second concurrent admission fail closed (`E_PROJECT_AUTH_HELD`).
- **Kill-then-poll (stop confirmation for the Node runner).** Recovery kills the
  recorded process group, then polls the identity probe and the group probe
  through a bounded window before settling; `probeProcessGroup` treats zombies
  as gone and reports `unavailable` (never `gone`) when unverifiable.
- **Reconciliation before takeover.** Unresolved project reconciliation blocks
  refuse new admission (`E_RECONCILIATION_REQUIRED`) and acceptance; uncertain
  outcomes (unconfirmed launch, exited-without-result, unreadable or malformed
  artifacts) settle into durable blocks with bounded reasons.
- **Deadline outside the worker (Node).** The runner timer kills the process
  group on `timeoutMs`; claim TTL is `timeoutMs + margin`; a timeout settles as
  conservative failure, never a silent retry.
- **Revision checks at admission and settlement.** `work_revision` and the
  input snapshot are captured in the admission context and re-checked at
  `beginExecution`; settlement of a superseded attempt fails as
  `E_STALE_REVISION` and resolves through `persistSuperseded`.
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
  slot (from a configured bounded pool) and any applicable counters (the
  effective, runtime-enforced subset of cost/tool budget attributes; no
  billing integration).
- Refusal is fail closed with a distinct error (`E_CONCURRENCY_LIMIT` /
  `E_BUDGET_EXHAUSTED`); the refused work keeps a coordinator-owned retry
  opportunity, never an immediate hot retry.
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
  already-scoped uncertain-send `no_effect` increment; the recommendation is
  that the two ride together rather than duplicating the mechanism.

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

## 5. Open questions for review

1. Cancellation authority: a distinct authorized decision surface (proposed,
   fail-closed, idempotent), or reuse of the existing execution authority with
   a different scope?
2. Cancelled work disposition: explicit `cancelled` terminal-ish disposition
   with reactivation only via a new authorized revision — or reuse of `review`
   with a cancellation failure record?
3. Budget dimensions: first implementation = concurrency slots, attempt counts
   (already bounded), wall-clock; model-call/turn and effect-count counters
   optionally in the same reservation table?
4. Pool scope: global-only first, or global + per-project bounds?
5. GAS sender revocation: confirm it rides with the uncertain-send `no_effect`
   increment (recommended) rather than a separate mechanism.
