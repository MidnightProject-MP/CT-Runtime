# Multi-project offline qualification

Status: **local offline candidate evidence**, not operational qualification,
deployment approval, or a production database trial.

## Candidate and environment

- Branch: `work/vnext-multi-project-reliability`
- Tested runtime commit: `7a17e7a` (this report update is documentation-only)
- Verification workspace: `/home/philippecave/CT-Runtime-local-tests`, detached
  at the tested commit with a clean worktree
- Node: `22.14.0` on Linux x64
- PostgreSQL: `16.15` (Ubuntu 16.15-0ubuntu0.24.04.1)
- Database: the existing disposable local test database supplied through
  `POSTGRES_URL`; no production credentials were used
- Suite:
  `test/vnext-multi-project.integration.test.mjs`

Command:

```sh
env POSTGRES_URL=postgresql://ctruntime_test:local-test-only@127.0.0.1:5432/ctruntime \
  /home/philippecave/.nvm/versions/node/v22.14.0/bin/node \
  scripts/verify.mjs targeted test/vnext-multi-project.integration.test.mjs
```

Result at the tested runtime commit: `PASS`, 13 tests passed, 0 failed,
0 skipped.

Full core verification at the same commit also passed:

```sh
env POSTGRES_URL=postgresql://ctruntime_test:local-test-only@127.0.0.1:5432/ctruntime \
  /home/philippecave/.nvm/versions/node/v22.14.0/bin/node \
  scripts/verify.mjs core
```

- Worktree: clean; tested commit: `7a17e7a`
- Local tests: 609 total, 557 passed, 52 expected skips, 0 failed
- Core runtime migration verifier: passed; the native multi-project suite
  applied and exercised vNext migrations 001–019 in its disposable database
- Required native PostgreSQL coverage: 17 suites, 128 tests passed, 0 failed,
  0 skipped
- Cross-process proof: first process returned `continue`; second process
  returned `terminal`; durable outcome was `2`

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
- Every project is durably bound to one canonical workspace root. Alias and
  nested roots across project IDs are rejected under a database advisory lock,
  including across coordinators; project IDs cannot be rebound to another root
  by normal coordinator operation.
- Service history orders `coordinator.pass` events by their durable identity
  sequence, not wall-clock timestamps. Capacity-deferred events are not service.
- Project-local preparation/recovery errors produce an identifiable failed
  project pass and do not stop healthy projects. Recognized shared database
  availability/schema errors still abort the aggregate pass.
- Project failure is local to that project. Other projects retain their own
  durable state and are not marked blocked.
- Aggregate `status` and `inspect` expose per-project state and global capacity.
- Active stewardship, review, and diagnosis assignments appear as active work;
  inspection reports their assignment identity and waits rather than suggesting
  another dispatch.
- The CLI routes each dispatch to the executor configured for its project and
  uses per-purpose state directories for recovery. Multi-project pass summaries
  preserve each `project_id`.

## Scenarios and observed results

| Scenario | Observation |
| --- | --- |
| Fair scheduling with three projects and capacity two | First pass dispatched two and deferred one; the deferred project was served on the next pass; all three were served without starvation |
| Project mutation exclusion | The executor observed exactly one authority for each project and no more than two authorities globally |
| Overlapping coordinators with capacity one | Exactly one dispatched; the other returned `E_CONCURRENCY_LIMIT`; the deferred coordinator dispatched after release |
| Workspace incompatibility | Canonical symlink aliases in one pass and nested roots already bound by another coordinator were rejected before execution; concurrent bind attempts admitted exactly one project |
| Preparation failure | Project-local planning and recovery failures were recorded against their project while the healthy peer dispatched and settled; simulated database unavailability aborted the pass |
| Timestamp reversal/tie | Reordered and tied `created_at` values did not change service order; each continuously eligible project received bounded service by event sequence |
| Active purpose work | Held stewardship, review, and diagnosis workers appeared in aggregate activity with assignment identity and `wait` next actions |
| Interruption and requested changes | Project A's review was interrupted before spawn and safely recovered without a duplicate launch while B completed; A applied requested changes and passed a fresh review |
| Lost response and revision race | A lost post-commit response was not replayed; a concurrent revision superseded A's stale result while B completed, then A completed the new revision |
| Project fault isolation | The failing project became `failed` with a reconciliation block; the healthy project stayed `waiting` with no block; aggregate phase was `blocked`; healthy blocked count was zero |
| Backward clock correction | A one-hour rollback left no stranded authority and reported every dispatch with exactly one execution; forward correction served both projects |
| Real command workers | Three rounds of two projects completed stewardship, execution, review, and authorized acceptance |
| CLI boundary | `tick` routed two projects to two executors; each compact pass retained its project ID; aggregate `status` and `inspect` reported both projects and capacity two |

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
- Workspace bindings are persistent and conservative. Moving a project to a
  different canonical root requires a deliberate binding migration; normal
  coordinator passes fail closed on a changed mapping.
- A backward clock correction can delay time-based eligibility. The test
  establishes that it does not strand an authority or create an execution that
  was not reported as a dispatch; it does not prove arbitrary clock-change
  liveness.
- The prior six-way stress result at `d0569ee` (4/6 runs, lifecycle/reconcile
  green all six) remains a historical finding; the stress run was not repeated.
- The abort-registration race test now uses a monotonic deadline and passed in
  the full-core verification above.
