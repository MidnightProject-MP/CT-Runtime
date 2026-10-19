# vNext stop-confirmation contract

Status: **enforced** (Milestone 1D, item D4). Adopted sequencing: D4 -> D2 -> D1
-> D3 (`docs/VNEXT-MILESTONE-1D-SCOPE.md` §5). This document states the
contract; the stores and the recovery path enforce it.

## The rule

A conflicting takeover or effect re-admission requires **one of**:

- **provable stop** — a recorded launch identity whose process group is
  confirmed stopped by recovery's kill-then-poll evidence (Node runner);
- **effective capability revocation** with sender-termination evidence (GAS);
  or
- **completed reconciliation** — a durable resolution of the uncertain effect.

`unavailable` verification never passes. It is `unknown`, and `unknown` blocks.

## Enforcement at admission

`beginExecution` (both transactional stores, inside the project lock) refuses:

| Condition | Refusal |
| --- | --- |
| Unresolved project reconciliation block | `E_RECONCILIATION_REQUIRED` |
| Live (unexpired) project mutation authority | `E_PROJECT_AUTH_HELD` |
| Expired project mutation authority | `E_RECONCILIATION_REQUIRED` |
| Expired Work Unit claim bound to an unsettled attempt | `E_RECONCILIATION_REQUIRED` |

An expired claim bound to an already-settled (legacy pre-A8) execution is
inert bookkeeping and does not block; reconstruction already rejects an
expired non-legacy execution.

Elapsed time is not evidence. Admission never marks a predecessor `expired`,
never clears its claim, and never deletes its authority; those transitions
belong exclusively to settlement and recovery. A present authority row
therefore means an unsettled predecessor, and it always blocks admission.

## What counts as stop evidence

- Recovery-controlled settlement paths are the only paths that release expired
  authority and expired claims: `recoverAttempt`, and settled attempts recovered
  through `persistTurn(..., { recovery: true })` or
  `persistSuperseded(..., { recovery: true })`. Each settles the attempt,
  clears the claim, and deletes the authority row in one transaction.
- Classification is a durable-records decision, never a timing guess:
  - no launch record + intact empty attempt directory -> `not-launched`
    (retry-eligible; exact replay is idempotent, divergent content fails
    closed);
  - recorded launch + identity and group probes both `gone` -> stopped; a
    retained result settles the turn, its absence is `uncertain` with reason
    `worker-exited-without-result`;
  - missing or unreadable attempt storage, artifacts without a launch record,
    or any probe returning `unavailable` -> `unknown`, which settles `uncertain`
    into a durable reconciliation block before anything may run again.
- A provably running group is stopped by kill-then-poll over the recorded
  process group before settlement (`lib/vnext/dispatch-recovery.mjs`); a
  launcher pid that is gone while its group still runs is still `running`.
- The pilot path reconciles in-doubt attempts before selecting `nextEligible`;
  ordinary operation therefore reaches admission only after recovery has run,
  or is explicitly reported blocked (`lib/vnext/pilot.mjs`).

## GAS sender half

An already-running GAS sender is not stopped by an expired claim, absent
authority, or an unrenewable fence. Sender-side revocation semantics are the
stop-confirmation half of the already-scoped uncertain-send `no_effect`
increment and ride with it (scope decision 5). This milestone states the
backend-neutral contract; it does not implement the GAS operational gate.

## Legacy note

The `expired` execution state stays readable for historical rows and
reconstruction, but after D4 no transition marks an execution `expired`;
attempts settle as `failed` (recovery) or their ordinary terminal states.

## Enforcement map

- `lib/vnext/neon-store.mjs` — `beginExecution` refusal cluster; `recoverAttempt`.
- `lib/vnext/memory-store.mjs` — same seam for the reference store.
- `lib/vnext/dispatch-recovery.mjs` — classification, kill-then-poll,
  settlement of recovered attempts.
- `lib/vnext/pilot.mjs` — recovery-before-admission ordering.

## Evidence

- Refusal preserves predecessor Execution, claim, and authority and creates no
  successor; recovery `not-launched` makes the successor admissible; the
  concurrent settlement/refusal pair serializes without deadlock:
  `test/vnext-project-authority.integration.test.mjs`,
  `test/vnext-project-authority.test.mjs`, `test/vnext-a9-postgres.integration.test.mjs`,
  `test/vnext-a9-transactional.test.mjs`, `test/vnext-fencing.test.mjs`,
  `test/vnext-outer-loop.test.mjs`.
- Classification, kill-then-poll, and recovery evidence:
  `test/vnext-recoverable-dispatch.integration.test.mjs`.
