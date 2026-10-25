# Milestone 3C — Offline unattended-trial campaign

Status: **bounded offline evidence only**. This campaign uses scripted workers,
a scripted decision authority, an isolated PostgreSQL database, and simulated
local artifact writes. It does not qualify live model/provider use, production
effects, deployment, or commissioning.

## Tested commit and command

- Tested commit: `384558e5188a0a02c2ff285788c0e60365e7b338`
- Worktree: clean, detached at the exact commit in
  `/home/philippecave/CT-Runtime-local-tests`
- Environment: Node `22.14.0`, Linux x64, PostgreSQL `16.15`
- Native suite: `test/vnext-unattended-trials.integration.test.mjs`
- Verifier: `scripts/verify.mjs targeted test/vnext-unattended-trials.integration.test.mjs`
- Result: 2 tests passed, 0 failed, 0 skipped; `verify: result=PASS`
- Campaign report and append-only worker/effect/interruption records:
  `/var/tmp/ct-runtime-m3c-campaigns/campaign-edb51127-fa3d-4c26-966e-6d2e1f311c9b/`

Related native PostgreSQL verification at the same exact commit also passed:

| Suite | Pass | Fail | Skip |
| --- | ---: | ---: | ---: |
| `test/vnext-coordinator-cli.integration.test.mjs` | 6 | 0 | 0 |
| `test/vnext-recoverable-dispatch.integration.test.mjs` | 14 | 0 | 0 |
| `test/vnext-multi-project.integration.test.mjs` | 13 | 0 | 0 |

## Predeclared limits and labels

The plan was written before submitting work. Each campaign gets a unique ID;
each of its four trials gets a distinct project, Work Unit, workspace, state
directory, and trial identity. The harness does not retry or reset a failed
trial; another run gets a new identity and retains prior run records.

- Four trials; at most 12 coordinator passes per trial.
- Campaign budget 220 seconds; CLI-command budget 30 seconds; worker timeout
  5 seconds.
- Global concurrency cap 2; at most three CLI processes in the overlap scenario;
  one coordinator restart; two overlapping wakes.
- Post-acceptance and post-reconsideration quiet probes: two later CLI wakes per
  trial.
- Automatic retries: 0. Real model calls/providers: 0.
- Workers and decision authority are scripted fixtures. The only effect is a
  local artifact write, explicitly recorded as simulated.
- The process-interruption trial sends `SIGKILL` to the actual coordinator CLI
  process and confirms the detached worker remains alive. The two overlapping
  CLI wakes occur **before** that SIGKILL, not during the post-kill orphan
  interval. The harness then releases the worker, confirms the retained result,
  and uses a **test-only lease-expiry fast-forward** before restart recovery. It
  measures restart recovery after expiry, not the natural claim-expiry duration.
- Executor-boundary fault injections counted in this campaign: 0. Existing
  executor-boundary tests are not counted as coordinator-process interruption.
- Report completeness and successful `report.json` persistence are qualification
  conditions, not reporting side effects. Missing trial observations are stored
  as `null`, totals become `null` rather than zero, and the campaign fails.

## Campaign results

Campaign ID: `edb51127-fa3d-4c26-966e-6d2e1f311c9b`. Plan:
`milestone-3c-offline-v2`. Total campaign runtime from the monotonic timer:
16,530 ms. All artifact digests below match the durable PostgreSQL result/evidence
records and their workspace files.

| Trial | Durable outcome | Executions | Additional evidence |
| --- | --- | ---: | --- |
| `normal-completion` | Terminal and accepted | 1 objective / 3 total | Two later CLI wakes changed no activity: 1 objective execution, 2 assignment executions, 2 assignments, 3 worker invocations, 1 simulated effect; artifact SHA-256 `2efa7cdb890df2d2fb4721608964500b1ac437ec6e564e3cf65bec43bba548e8` |
| `fresh-input` | Terminal and accepted | 2 objective / 6 total | One requested-change cycle; fresh scripted input advanced sequence 2→5 and `consumed_input_seq` reached latest sequence 5; two later CLI wakes changed no activity: 2 objective executions, 4 assignment executions, 4 assignments, 6 worker invocations, 2 simulated effects; artifact SHA-256 `aa3e066041173b6e708594f8d1b118c3be717cdd5d27a6d59f1e4d5341e97e86` |
| `bounded-non-progress` | Not accepted; explicit `reconsideration-exhausted` action | 2 objective / 6 total | Exactly two review `request_changes` decisions; two later CLI wakes changed no activity: 2 objective executions, 4 assignment executions, 4 assignments, 6 worker invocations, 2 simulated effects; `next_action` remained `reconsider` / `reconsideration-exhausted`; artifact SHA-256 `e884a794a284d4ed3483ae714253eadc6315110c799fd68eb43f0ca5a5837eab` |
| `surviving-worker` | Terminal and accepted after restart recovery | 1 objective / 3 total | Two overlapping CLI wakes occurred before the coordinator `SIGKILL`; worker survived; restart settled the retained result as `settled-from-retained-result`; two later CLI wakes changed no activity: 1 objective execution, 2 assignment executions, 2 assignments, 3 worker invocations, 1 simulated effect; artifact SHA-256 `937e68454ac461cf4b21be1cafc11ec963425f22d5784642f11d053c42c67528` |

Aggregate measurements derived from the durable records and append-only
campaign journals:

- Accepted outcomes: 3 of 4; the bounded non-progress trial is explicitly not
  counted as an unattended success.
- Objective executions: 6; assignment executions: 12; scripted worker
  invocations: 18; real model calls: 0.
- Simulated effect records: 6; duplicate effects: 0; conflicting effects: 0.
- Stranded work: 0; unresolved non-progress work remains visible with a
  reconsideration action.
- Human interventions: none. Human-rescued trials: none. The fresh input is a
  scripted test input, not a real human intervention.
- Restart recovery: 315.3 ms from coordinator interruption to durable settlement,
  including the scripted lease-expiry fast-forward; 281.1 ms from fast-forward
  to settlement. This is not a measurement of the production lease duration.
- Sampled peak project-authority occupancy: 1; configured global cap: 2.
- Report status: `complete`; report issues: none; `verification.report_complete`:
  `true`; reported failures: 0.

## Report-integrity and quietness checks

The second test in the suite, `campaign report gaps are unknown measurements and
fail qualification`, passed. It exercises the unavailable-trial path used when a
trial report cannot be generated and injects a `report.json` write failure. It
verifies that unavailable trial measurements and aggregate totals are `null`
rather than zero, that incomplete or unpersisted reports cannot qualify, and
that a write failure preserves a `report.partial.json` with `completed: false`
and `report_complete: false`. This is focused fault-injected coverage; the
successful live campaign did not deliberately corrupt its own report.

For every accepted trial, and after `reconsideration-exhausted`, the harness
issued two later CLI wakes and compared durable objective executions, assignment
executions, assignments, scripted worker invocations, and simulated effects.
Before/after values were identical in all four trials. The non-progress trial
also re-read coordinator status after its quiet wakes and retained the explicit
`reconsideration-exhausted` action.

## Preserved prior successful evidence

The earlier campaign `199b9092-3240-466d-b0f6-a0914f530cbc` at
`2a10fa6ed9bd18f22aa4edf07c32e8253a2b1e3e` remains intact under
`/var/tmp/ct-runtime-m3c-campaigns/campaign-199b9092-3240-466d-b0f6-a0914f530cbc/`.
It established the earlier recovery/interruption evidence and the same accepted,
objective, worker-invocation, and effect aggregate counts, but its quietness
checks covered only post-acceptance objective executions and it could suppress
report failures. It is preserved for that narrower scope and does not support
the corrected quietness or report-integrity claims above.

## Preserved failed attempts

The campaign did not discard earlier outcomes; each has a separate identity and
the later successful campaign uses a different ID.

| Campaign ID | Tested commit | Outcome and correction |
| --- | --- | --- |
| `87559e31-01ec-468a-88d5-4ad0e197b9e6` | `08dbeca` | Harness failed before any objective execution: scripted stewardship omitted the `propose` decision. Corrected at `61d01ef`. The original `/tmp` directory disappeared when WSL stopped; a reconstructed summary is retained in `/var/tmp/ct-runtime-m3c-campaigns/prior-attempts.jsonl`. |
| `cf95b1e0-2986-4734-8b1d-0c3d2f464914` | `f668495` | Partial campaign: normal/fresh-input accepted and bounded non-progress stopped; actual worker survived coordinator interruption. Harness then raised a `TypeError` because its wait helper discarded the expired-claim row. Original report remains at `/var/tmp/ct-runtime-m3c-campaigns/campaign-cf95b1e0-2986-4734-8b1d-0c3d2f464914/report.json`. Corrected at `1fcf83e`. |
| `23c24129-1bef-496f-9537-0ace76bf8a8b` | `e0692c4` | Actual process interruption and worker survival were observed, but restart conservatively produced `external-effect-uncertain`; recovery did not have the persisted workspace root needed to verify retained file evidence. Corrected in `dispatch-recovery.mjs` at `3e5be02` by falling back to the stored `request.workspaceRoot`. Original report remains at `/var/tmp/ct-runtime-m3c-campaigns/campaign-23c24129-1bef-496f-9537-0ace76bf8a8b/report.json`. |

The final campaign passed on `384558e`; the earlier failures remain failures and
are not relabeled as passes.

## Remaining qualification gaps

- One Linux host and one isolated PostgreSQL database; no multi-host, long
  duration, or production database trial.
- Scripted workers/authority and local simulated artifact writes only; no live
  model, provider, email, or other external effect.
- Lease expiry is deliberately advanced after process/group exit; natural lease
  timing and long-duration recovery behavior remain unqualified.
- The overlapping-wake evidence is before coordinator termination; this campaign
  does not qualify overlapping-wake behavior during the post-kill orphan interval.
- The non-progress trial stops for human reconsideration, but no actual human
  rescue is part of this campaign.
- Report-failure behavior is covered by focused fault injection, not a
  deliberately failed live campaign.
- No deployment, activation, or commissioning was performed.
