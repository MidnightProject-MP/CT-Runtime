# vNext concurrency pool contract

Status: **enforced** (Milestone 1D, item D2). Adopted sequencing: D4 -> D2 -> D1
-> D3 (`docs/VNEXT-MILESTONE-1D-SCOPE.md` §5). This document states the
contract; the stores enforce it. The stop-confirmation boundary
(`docs/VNEXT-STOP-CONFIRMATION.md`) is preserved unchanged.

## Scope record

§5 of the milestone scope ordered "per-project bound first, store for later
global cap". By explicit decision during D2 the pool is enforced as an
aggregate **global capacity now**; per-project caps, fairness, and
cross-project scheduling remain 2D. This paragraph is the explicit record.

## The rule

The coordinator owns a global execution pool. **Occupancy is derived from the
project mutation authority rows themselves**: one authority row is one occupied
slot, for exactly as long as the attempt holds authority. There is no separate
reservation table, so accounting can never orphan, drift, or disagree with the
state that actually admits and settles attempts (the memory store has always
derived reservations from reconstructed authorities; PostgreSQL now uses the
same single source of truth).

Consequences by construction:

- an attempt admitted before any capacity was configured is counted as soon as
  a bound exists — nothing to backfill, no upgrade window;
- an expired, stop-unconfirmed predecessor keeps its authority (D4) and
  therefore keeps its slot until recovery settles it;
- settlement of an attempt deletes its authority, which is its release —
  exactly once, in the settling transaction, guarded by the same identity
  checks that already govern settlement.

## Durable pool policy (shared writers)

`maxConcurrency` is coordinator configuration, but the bound is durable so a
shared database enforces one policy for every writer. A configured writer
establishes the row before its admission transaction (serialized on the pool
lock, `INSERT ... ON CONFLICT DO NOTHING`, committed independently), so a
capacity refusal cannot roll the shared bound back with the refused attempt.
Admission then takes the pool lock again and re-reads the row, adopting or
verifying it:

| Durable policy | Writer configured `maxConcurrency` | Result |
| --- | --- | --- |
| absent | set (`N`) | writer establishes `N` in its own committed transaction; enforced |
| absent | unset | unbounded |
| `N` | `N` | enforced |
| `N` | unset | writer adopts `N`; enforced — unconfigured writers cannot bypass |
| `N` | `M != N` | `E_POOL_POLICY_CONFLICT` (fail closed) |
| `NULL` (operator-set unbounded) | set | `E_POOL_POLICY_CONFLICT` |

Capacity is enforced by counting authority rows under the pool lock; when the
count reaches the effective capacity, admission refuses with
`E_CONCURRENCY_LIMIT: the coordinator concurrency pool is exhausted`. The
refusal is ordered after the stop-confirmation refusals, so an attempt blocked
by authority or reconciliation state reports that cause first. A refusal writes
no Execution row, no claim, and no authority; the Work Unit stays actionable
and eligible, and retry is coordinator-owned (the next tick rediscovers it when
a slot releases). The first configured refusal may still leave the pool policy
established — that is the point: the bound must not depend on admission
success.

The memory store is single-writer in-process; it enforces the same cap by
construction and has no durable policy row.

## Locking

- Policy initialization (`ensurePoolPolicy`) takes only the pool lock, in its
  own transaction, and commits before that attempt's admission begins.
- Admission takes the project lock first and the pool lock second. The order is
  acyclic: initialization never holds a project lock, and release takes no pool
  lock.
- Release never takes the pool lock: settlement deletes the authority in its
  transaction, and a committed delete is simply absent from the next count.

## Inspectability

`listReservations()` on both stores is a read-only view derived from the
authorities (project, Work Unit, execution, fence, owner). It is an operator
and test surface, not a control plane, and it cannot disagree with enforcement.

## Scope boundaries

- The cap is global; per-project caps and fairness are 2D.
- Budget exhaustion (`E_BUDGET_EXHAUSTED`) is D3 and stays out of this pool.

## Enforcement map

- `vnext-migrations/014_pool_policy.sql` — durable policy table.
- `lib/vnext/neon-store.mjs` — policy resolution under the pool lock, authority
  count enforcement, `listReservations`.
- `lib/vnext/memory-store.mjs` — in-process enforcement, derived
  `listReservations`.
- `lib/vnext/pilot-store.mjs`, `bin/vnext-pilot.mjs` — `maxConcurrency`
  passthrough from pilot config.

## Evidence

- Exhaustion refusal with zero durable trace; concurrent cross-project
  admission never exceeding the cap; release on each settlement path;
  stop-unconfirmed slot retention until recovery with refusal-cause ordering;
  rollback atomicity when the admission transaction fails after the authority
  insert; authorities predating the configured pool (active and
  expired-unsettled) being counted with no backfill; the durable policy binding
  every writer (adoption, fail-closed mismatch, explicit unbounded); coherent
  slot release by authority removal:
  `test/vnext-concurrency.integration.test.mjs`.
- Same rules against the reference store, including reconstruction deriving
  occupancy from recovered authorities: `test/vnext-concurrency.test.mjs`.
