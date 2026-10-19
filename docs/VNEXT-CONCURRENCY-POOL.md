# vNext concurrency pool contract

Status: **enforced** (Milestone 1D, item D2). Adopted sequencing: D4 -> D2 -> D1
-> D3 (`docs/VNEXT-MILESTONE-1D-SCOPE.md` §5). This document states the
contract; the stores enforce it. The stop-confirmation boundary
(`docs/VNEXT-STOP-CONFIRMATION.md`) is preserved unchanged.

## The rule

The coordinator owns a **global execution pool**. An attempt occupies one slot
for exactly as long as it holds its project mutation authority:

- admission writes one durable reservation for the admitted attempt (always —
  accounting is part of the record, not an optional counter);
- settlement of that attempt deletes it exactly once;
- capacity is **coordinator configuration** (`maxConcurrency`, a positive
  integer); when unset, reservations are still recorded and released but no
  admission is refused for capacity.

Because authority is already at most one per project, reservations are keyed by
project: a slot cannot be double-held, and per-project bounds can compose with
the aggregate cap later (2D).

## Enforcement at admission

`beginExecution` (both stores) refuses with
`E_CONCURRENCY_LIMIT: the coordinator concurrency pool is exhausted` when the
configured cap is reached. The refusal is ordered after the stop-confirmation
refusals, so an attempt blocked by authority or reconciliation state reports
that cause first. A refusal writes nothing:

- no Execution row, no claim, no authority, no reservation;
- the Work Unit stays actionable and eligible;
- retry is coordinator-owned: the next tick re-discovers it when a slot
  releases. There is no hot retry and nothing to clean up.

## Locking and exactly-once release

- Admission takes the project lock first and the pool lock second
  (`ct-runtime:vnext-concurrency-pool`) for the count-and-reserve step. No
  other path ever takes the pool lock, so the lock order is acyclic.
- Release never takes the pool lock: settlement commits the reservation delete
  with the authority delete, and a committed row is simply absent from the
  next count.
- Release points (all inside the settling transaction, guarded by exact
  attempt identity `execution_id` + `fence` so a stale replay can never free a
  successor's slot):
  - settlement — `persistTurn` (both boundaries, including recovery mode);
  - failure — `persistFailure`;
  - supersession — `persistSuperseded` (including recovery mode);
  - recovery — `recoverAttempt`.
- Exactly-once follows from the authority: the reservation exists iff the
  authority exists. An attempt whose stop is unconfirmed keeps its authority
  (D4) and therefore keeps its slot until recovery settles it.

## Schema

Migration `014_concurrency_reservations.sql` adds
`vnext_concurrency_reservations` (project primary key, attempt binding, owner,
`reserved_at`). A deferred constraint trigger rejects any reservation row that
would commit without its matching project mutation authority; the check is
per-row so it cannot be defeated by unrelated orphaned rows. Direct SQL cannot
fabricate pool occupancy.

## Scope boundaries

- The cap is global and coordinator-configured. Per-project caps, fairness, and
  cross-project scheduling are deferred to 2D.
- Budget exhaustion (`E_BUDGET_EXHAUSTED`) is D3 and stays out of this pool.
- Inspectability only: `listReservations()` on both stores is a read surface for
  operators and tests, not a control plane.

## Enforcement map

- `vnext-migrations/014_concurrency_reservations.sql` — table and deferred
  authorization trigger.
- `lib/vnext/neon-store.mjs` — option and validation, pool lock and count,
  reservation insert after the authority insert, releases, `listReservations`.
- `lib/vnext/memory-store.mjs` — reference implementation: reservations derived
  from reconstructed authorities, released on the same four paths.
- `lib/vnext/postgres-boundary.mjs`, `lib/vnext/memory-boundary.mjs` —
  reservation delete inside `persistTurn`.
- `lib/vnext/pilot-store.mjs`, `bin/vnext-pilot.mjs` — `maxConcurrency`
  passthrough from pilot config.

## Evidence

- Exhaustion refusal with zero durable trace, concurrent cross-project
  admission never exceeding the cap, release on each settlement path,
  stop-unconfirmed slot retention until recovery, rollback atomicity when the
  admission transaction fails after reserving, and rejection of forged
  reservations: `test/vnext-concurrency.integration.test.mjs`.
- Same rules against the reference store, including reconstruction deriving
  reservations from recovered authorities:
  `test/vnext-concurrency.test.mjs`.
