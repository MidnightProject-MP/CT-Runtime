# Multi-project offline qualification

Status: **local offline candidate evidence**, not operational qualification,
deployment approval, or a production database trial.

## Candidate and environment

- Branch: `work/vnext-multi-project-reliability`
- Tested runtime commit: `16c14f2` (the documentation commit that follows this
  report has no runtime changes)
- Verification workspace: `/home/philippecave/CT-Runtime-local-tests`, detached
  at the tested commit with a clean worktree
- Node: `22.14.0` on Linux x64
- PostgreSQL: `16.15` (Ubuntu 16.15-0ubuntu0.24.04.1)
- Database: the existing disposable local test database supplied through
  `TEST_DATABASE_URL`; no production credentials were used
- Suite:
  `test/vnext-multi-project.integration.test.mjs`

Command:

```sh
env POSTGRES_URL=postgresql://ctruntime_test:local-test-only@127.0.0.1:5432/ctruntime \
  /home/philippecave/.nvm/versions/node/v22.14.0/bin/node \
  scripts/verify.mjs targeted test/vnext-multi-project.integration.test.mjs
```

Result at the tested runtime commit: `PASS`, 7 tests passed, 0 failed,
0 skipped.

## Contract under test

- A multi-project pass prepares every configured project but prepares at most
  one plan per project. This preserves one mutation authority per project.
- The pass orders projects by their most recent non-deferred
  `coordinator.pass` event. A capacity deferral is not service, so the deferred
  project is prioritized next.
- Only dispatches that fit the durable global pool are admitted. The store
  remains the atomic enforcement point for overlapping coordinators.
- A winning admission writes one authority; a losing overlapping admission is
  classified as a control refusal with `E_CONCURRENCY_LIMIT`, not as a
  coordinator failure.
- Project failure is local to that project. Other projects retain their own
  durable state and are not marked blocked.
- Aggregate `status` and `inspect` expose per-project state and global capacity.
- The CLI routes each dispatch to the executor configured for its project and
  uses per-purpose state directories for recovery.

## Scenarios and observed results

| Scenario | Observation |
| --- | --- |
| Fair scheduling with three projects and capacity two | First pass dispatched two and deferred one; the deferred project was served on the next pass; all three were served without starvation |
| Project mutation exclusion | The executor observed exactly one authority for each project and no more than two authorities globally |
| Overlapping coordinators with capacity one | Exactly one dispatched; the other returned `E_CONCURRENCY_LIMIT`; the deferred coordinator dispatched after release |
| Project fault isolation | The failing project became `failed` with a reconciliation block; the healthy project stayed `waiting` with no block; aggregate phase was `blocked`; healthy blocked count was zero |
| Backward clock correction | A one-hour rollback left no stranded authority and reported every dispatch with exactly one execution; forward correction served both projects |
| Real command workers | Three rounds of two projects completed stewardship, execution, review, and authorized acceptance |
| CLI boundary | `tick` routed two projects to two executors; aggregate `status` and `inspect` reported both projects and capacity two |

## Repeated trial metrics

Three bounded two-project rounds (six projects total):

```json
{"projects":6,"passes":18,"accepted":6,"duplicate_dispatches":0,"stranded_authorities":0,"resource_limit_violations":0,"blocked_projects":0,"quiet_redispatches":0,"execution_decisions":18,"assignment_decisions":12,"acceptance_decisions":6}
```

- Accepted: 6 of 6 Work Units reached `terminal`.
- Duplicate dispatches: 0 (grouped by Work Unit and admitted revision).
- Stranded authorities: 0.
- Blocked projects: 0.
- Quiet redispatches: 0 after terminal states.
- Execution, assignment-decision, and acceptance-decision counts match the
  lifecycle performed.
- The `resource_limit_violations: 0` field is backed by the capacity assertions
  in the fair-scheduling and overlapping-coordinator subtests, not by an
  independent telemetry stream.

## Limitations

- This is one local PostgreSQL instance and one host. It is not a multi-host,
  network-partition, or long-duration soak.
- No live model, email, GAS, production database, or deployment path was
  exercised. The authority modules are offline test adapters.
- Per-project caps are not implemented. The pool is global; fairness orders
  projects but does not reserve a per-project share.
- A backward clock correction can delay time-based eligibility. The test
  establishes that it does not strand an authority or create an execution that
  was not reported as a dispatch; it does not prove arbitrary clock-change
  liveness.
- The prior six-way stress result at `d0569ee` (4/6 runs, lifecycle/reconcile
  green all six) and the load-sensitive abort-registration timeout remain
  historical findings. They were not rerun as part of this report.
- The full core verifier evidence at `cd2707a` remains prior evidence, not
  evidence for this multi-project candidate. This report does not claim a
  full-core pass at the tested runtime commit.
