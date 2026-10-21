# Minimum durable loop: implementation and operation

This source delivery connects a PostgreSQL-backed human inbox to a bounded command execution and durable future eligibility. It includes current-main foundation code plus PR #63's A8/A9 fixes, a small Linux caller, and a disabled systemd timer. It does not deploy or activate anything. It does not claim the multi-day operational MVP has passed.
The Milestone 2A candidate adds a recurring coordinator pass, durable pass records, a derived operator view, optional long-running loop, pause/resume, and explicit acceptance/cancellation/reconciliation commands. The next offline candidate adds purpose-bound execution, independent review, stewardship, diagnosis, and authorized assignment decisions on the same Execution/Work Unit lifecycle. It is not operationally qualified. The existing timer remains the only supplied deployment unit.

## Milestone 2A candidate evidence

This candidate is based on merged main `8572550`. Targeted native verification
passed 60/60 across the coordinator, integrated CLI, pilot, operating boundary,
cancellation, and recoverable-dispatch suites. The full core verifier passed on
the exact local candidate commit from the existing clean WSL workspace: 601
local tests total (551 pass, 50 expected platform skips, 0 failures), migrations
pass, all 16 required native PostgreSQL suites pass (111 tests, zero skips), and
the cross-process proof passes. The coordinator and integrated CLI suites are
both required native suites.

The follow-up status correction reconstructs an accepted snapshot through a
read-only repeatable-read path, independent of project-wide eligibility to issue
a new acceptance. Its two-Work-Unit regression keeps accepted A visible while B
is active and while B holds a reconciliation block, and checks the recurring
coordinator does not duplicate B or exit.

This is local verification, not GitHub CI or operational qualification. Nothing
was pushed, merged to remote, deployed, live-applied, activated, or commissioned.
The existing GAS `no_effect` decision still makes an uncertain send a permanent
project stop.

## What is implemented

- `submit` transactionally records an immutable receipt identity and message, creates/reuses one project/thread objective, and makes input discoverable. Same receipt/content is idempotent; changed content under the same receipt ID is rejected. A new human reply can reopen a completed thread, but cannot automatically clear an uncertain/review state.
- `tick` selects one eligible objective, rereads explicit identity files and current durable state, authorizes and claims one execution, and invokes one worker. The worker can directly inspect, change and check; no mandatory delegation or stage pipeline is added.
- `persistTurn` atomically records the outcome, optional lesson, exact evidence, input watermark, and next inspection time with the existing execution/work transition. A reply arriving during execution remains unconsumed and eligible, including during completion.
- A new process discovers progress from PostgreSQL without a queued in-memory continuation. `continue` schedules the next opportunity after a minimum interval. `waiting` stays quiet unless new human input arrives or Celestan supplies a UTC `requested_next_wake`. There is no generic external-condition subscription service.
- `status` reads durable responses and questions. The append-only-by-adapter `vnext_pilot_results` table preserves all accepted turn reports; the last ten are included in cold reconstruction. Original identity files and attempt request/result files remain outside the checkout. The command executor retains hash-checked copies of cited file evidence under each attempt directory (maximum 16 MiB per file), so later working-file changes do not erase those bytes.
- `inspect` derives the coordinator view from the same durable records: objective revision, active and completed attempts, latest result and evidence, waiting/blocked/uncertain/cancelled reasons, the next eligible action or why none exists, completion claim vs accepted completion, and pending human decisions.
- `acceptance_history` retains prior receipts across revisions or new input. `accepted_completion` is populated only when the Work Unit is currently terminal and its accepted receipt matches the current last execution and work revision. Its digest is reconstructed through a repeatable-read, read-only snapshot that does not apply the project-wide eligibility gate for issuing new acceptance, so status remains readable while a sibling Work Unit is running or reconciliation-blocked.
- `run` executes the same bounded pass repeatedly with one dispatch per pass, a durable `coordinator.pass` event, sequential passes, and graceful stop after the current pass on SIGINT/SIGTERM. `tick` remains the single-pass form for the systemd timer. A configured pause file makes every pass quiescent without touching a live attempt; `pause` and `resume` manage that marker.
- `accept`, `cancel`, and `reconcile` are explicit operator commands over the existing guarded boundaries. They do not bypass execution, settlement, or acceptance checks. Acceptance still requires an independent decision; cancellation still requires a durable authorized intent; reconciliation requires an explicit decision document and records its reference with the resolution.
- Purpose-bound assignments bind objective, revision, input watermark, predecessor, subject digest, explicit model/agent, access class, and permissions. Review, diagnosis, and stewardship use read-only profiles and dedicated executor command profiles. Execution completion remains in `review` until a distinct reviewer report and Celestan decision; a review recommendation never accepts work. Requested changes route through stewardship and a bounded follow-up execution without manufacturing a new objective revision. New input, a requirements revision, or cancellation supersedes stale queued/reported assignments.
- `decide-assignment` records an authorized decision against the exact durable assignment/report/subject digests. The authority module must export `verifyAssignmentDecision`; automatic decisions may be supplied through `authorizeAssignmentDecision`, otherwise the report remains pending. Review decisions and the existing snapshot-bound `accept` transition are separate decisions.
- The command worker receives explicitly selected environment variables; database credentials are not inherited. Raw stdout/stderr are discarded. A Linux process-group timeout prevents an ordinary child/descendant from outliving its execution; systemd's control-group boundary contains the complete service on the selected host.
- Failure after starting the worker requires review. An ambiguous settlement leaves the claim for durable inspection rather than recording a false failure or rerunning effects. Expired ownership does not permit automatic external-worker takeover in the pilot. A blocked status identifies work requiring reconciliation.

## Source provenance

- Candidate base: merged main `3ce806e9d579a7c04950d3dc2cf772ecc757429b` (PR #102).
- The vNext Node migration chain adds `016_purpose_assignments.sql` for durable, target-linked internal assignment Work Units and immutable purpose-bound reports/decisions. GAS send admission and minimal cancellation use migration 010 from #101, not applied live by this candidate.
- No candidate push/PR, secret change, GAS write, production migration, activation, or deployment was performed.

## Install and prove the mechanics locally

Use Node 22–24 on Linux. From the extracted `CT-Runtime` directory:

```sh
npm ci
npm test
node scripts/prove-vnext-pilot.mjs /tmp/celestan-proof
# Wait at least one second, then start a separate process:
node scripts/prove-vnext-pilot.mjs /tmp/celestan-proof
node scripts/prove-vnext-pilot.mjs /tmp/celestan-proof
```

Expected results: `continue`, `terminal`, then `quiesced`. The same logical objective has different physical execution IDs. Each invocation opens the same disk-backed PGlite database; each work attempt uses a separate command process. This fixture checks two file increments and actual hashes. It proves mechanical continuity, not model judgment, production Neon, or scheduler reliability.

The archive includes the two pinned Foundry Observer source files as a sibling `CT-Foundry` directory for the existing repository tests. They are test dependencies, not a new Observer deployment. Keep that sibling layout for `npm test`.

`test/vnext-pilot.integration.test.mjs` runs automatically against PGlite for local SQL/transaction checks. With `TEST_DATABASE_URL`, it uses native PostgreSQL. CI explicitly invokes that native path. PGlite serializes test connections and cannot establish native cross-connection race behavior. Existing project-ownership native integration tests remain required for activation.

## Configure the chosen host and project

1. Install the code at `/opt/CT-Runtime`, the approved project checkout at its own path, and the authoritative identity files outside the runtime checkout. Run the worker with only the tool credentials and OS permissions required by the entrusted project. Prompt scope is not a sandbox. Keep runtime database/configuration access outside the worker's permitted tool surface; if stronger isolation is needed, use a qualified sandbox command as the executor.
2. Copy `examples/vnext-pilot.config.json` to `/etc/celestan/pilot.json`. Replace all paths, every explicit assignment model/agent/permission profile, the three dedicated read-only executor profiles, and the authority module. Reviewer model or agent must differ from execution. The configured read-only agents/executor environment must actually prohibit writes; a prompt or `access_class` label alone is not a sandbox. Keep `enabled` and `legacyExcluded` false during qualification. State belongs in `/var/lib/celestan/pilot`, not in either repository. `coordinatorId` labels durable pass records; `scanIntervalMs` controls the optional `run` loop; `pauseFile` is an absolute operator marker and is never inside the project checkout.
3. Connect the existing authorization authority. The required module exports `authorizeExecution(context)`, `verifyExecution(decision, context)`, and `authorizeTerminal(context)`. The `cancel` command additionally requires `verifyCancellation(decision, context)`; absent that export, cancellation fails closed. These functions must retain project scope and existing quality requirements. The sample `examples/vnext-pilot-authority.mjs` is an implementable file-grant adapter; copy it outside the checkout and supply `CT_PILOT_GRANT_FILE` pointing at an actual existing entrustment. Its decision reference binds grant contents and execution ID, and optional `objectiveIds` restricts objectives. The grant's scope is supplied to cognition. The sample grant is deliberately invalid until configured; it grants nothing by itself.
4. For completion, the sample authority loads a project-owned `acceptanceModule` exporting `accept({workUnit, execution, turn, evidence, grant})`. It must evaluate the actual finish condition and required project review/delivery evidence. File hashes prove artifact integrity, not semantic correctness. Without an acceptance policy the completion claim stays in `review`; Runtime does not fabricate one for SuperSimpleGames.
5. Configure `CT_PILOT_DATABASE_URL` only for the runtime process, in an environment file readable by the runtime account. Never put credentials in source, the grant, turn reports or the ZIP. Prepare the existing schema roles and migrations according to the current database runbook before applying the vNext migrations. Do not point first-time testing at production.

```sh
node bin/vnext-pilot.mjs migrate --config /etc/celestan/pilot.json
node bin/vnext-pilot.mjs submit --config /etc/celestan/pilot.json \
  --thread supersimplegames-improvement --receipt human-message-001 \
  --message-file /var/lib/celestan/request.txt
node bin/vnext-pilot.mjs status --config /etc/celestan/pilot.json
```

Use the same receipt ID only to retry delivery of exactly the same message. Use the same thread and a new receipt ID for a follow-up. The CLI inbox is the selected human interface in this slice; existing GAS Feedback ingestion/projection remains separate and has not been silently rewired. If Sheets must be the pilot interface, its receipt-to-this-inbox and response projection require a separately verified adapter before activation.

Inspect the durable coordinator view before and after each dispatch:

```sh
node bin/vnext-pilot.mjs inspect --config /etc/celestan/pilot.json
```

`run` is optional; the timer's repeated `tick` provides the same pass semantics. A long-running process is useful for local qualification and shorter scan intervals:

```sh
node bin/vnext-pilot.mjs run --config /etc/celestan/pilot.json
node bin/vnext-pilot.mjs pause --config /etc/celestan/pilot.json --reason maintenance
node bin/vnext-pilot.mjs resume --config /etc/celestan/pilot.json
```

Pause never interrupts the current worker. It prevents the next pass from admitting work; the pass stops after restoring durable state.

`accept` may ask the configured authority for a new acceptance decision or use an explicit decision document. A supplied decision is sent directly to the guarded acceptance operation so an exact historical receipt can replay after the Work Unit advances; the CLI still verifies that the Work Unit belongs to the configured project.

```sh
node bin/vnext-pilot.mjs accept --config /etc/celestan/pilot.json --work WORK_ID
node bin/vnext-pilot.mjs accept --config /etc/celestan/pilot.json --work WORK_ID --decision-file /var/lib/celestan/acceptance.json
```

`cancel` requires an authorized decision document and uses the current durable work revision. `reconcile` requires an exact decision document containing `ref`, `project_id`, `work_unit_id`, `execution_id`, `fence`, and `resolution` (`no_effect` or `effect_applied`). The identity fields are passed unchanged to the store. An exact replay returns its original receipt even after the block is gone; a mismatched identity or reuse of a decision reference for another attempt fails closed. These commands are operator surfaces, not evidence that an effect did or did not happen.

Purpose-bound automation also requires `verifyAssignmentDecision(decision, context)` on the authority module. It may export `authorizeAssignmentDecision(context)` for decisions supplied by Celestan; if it returns no decision, inspect the durable report and submit a separately authorized decision document:

```sh
node bin/vnext-pilot.mjs decide-assignment --config /etc/celestan/pilot.json \
  --assignment ASSIGNMENT_ID --decision-file /var/lib/celestan/assignment-decision.json
```

The document binds `ref`, `outcome`, `assignment_id`, `assignment_digest`, `report_digest`, and `subject_digest`. Reviewer `request_changes` decisions include `requested_changes` when the report omitted them. A decision to accept still proceeds through the existing independent snapshot-bound acceptance transition.

## Activate after qualification

Establish the real schema/grants, worker availability, actual authority, exact release, and absence of competing legacy admission/in-flight effects. The two configuration booleans are operator assertions, not exclusion evidence. The old GAS deployment policy remains in force: GAS writes only through the canonical GitHub Actions path.

After those facts are proven, enable the configured pilot and test one bounded invocation:

```sh
node bin/vnext-pilot.mjs tick --config /etc/celestan/pilot.json
```

Install the supplied `deploy/vnext-pilot.service` and `.timer` with the actual user and paths, then enable the timer through the host's normal deployment procedure. Match `TimeoutStartSec` to the configured worker timeout plus settlement margin; the supplied service uses 240 seconds for the 120-second worker. Do not run another project writer concurrently. The timer is not installed by this package.

The periodic scan recovers a missed wake signal because eligibility is in the same transaction as the result. Systemd prevents overlapping instances of the same unit; database authority also excludes competing project claims. Keep the service account, executor isolation and PostgreSQL permissions in the qualified operating envelope.

## Recovery and limits

Inspect `status` or `inspect`, the exact attempt request/result files, and the external project before resolving an uncertain effect. Review/expired work does not automatically launch a replacement. `reconcile` is an explicit, decision-bound operator command; it is not an unguarded force-unlock. Stopping/reconciling the actual worker and deciding whether to resume still requires the selected backend's evidence and authority. Automatic backend-specific reconciliation is not claimed.

Human input is bounded at 100 messages and 128 KiB per thread; identity context at 16 files/256 KiB; command result at 64 KiB. Exceeding a bound stops rather than silently dropping context. There is no generalized memory compaction yet. Per-wake timeout and cooldown prevent a hot loop; the observation period must still assess whether repeated work is useful.

Pending live acceptance: the configured backend and terminal policy, native database concurrency/recovery checks, host restart/containment, real human-interface delivery, legacy exclusion, and several days of useful autonomous project work. Follow the revised implementation plan for those gates.
