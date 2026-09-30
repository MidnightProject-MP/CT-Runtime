# Minimum durable loop: implementation and operation

This source delivery connects a PostgreSQL-backed human inbox to a bounded command execution and durable future eligibility. It includes current-main foundation code plus PR #63's A8/A9 fixes, a small Linux caller, and a disabled systemd timer. It does not deploy or activate anything. It does not claim the multi-day operational MVP has passed.

## What is implemented

- `submit` transactionally records an immutable receipt identity and message, creates/reuses one project/thread objective, and makes input discoverable. Same receipt/content is idempotent; changed content under the same receipt ID is rejected. A new human reply can reopen a completed thread, but cannot automatically clear an uncertain/review state.
- `tick` selects one eligible objective, rereads explicit identity files and current durable state, authorizes and claims one execution, and invokes one worker. The worker can directly inspect, change and check; no mandatory delegation or stage pipeline is added.
- `persistTurn` atomically records the outcome, optional lesson, exact evidence, input watermark, and next inspection time with the existing execution/work transition. A reply arriving during execution remains unconsumed and eligible, including during completion.
- A new process discovers progress from PostgreSQL without a queued in-memory continuation. `continue` schedules the next opportunity after a minimum interval. `waiting` stays quiet unless new human input arrives or Celestan supplies a UTC `requested_next_wake`. There is no generic external-condition subscription service.
- `status` reads durable responses and questions. The append-only-by-adapter `vnext_pilot_results` table preserves all accepted turn reports; the last ten are included in cold reconstruction. Original identity files and attempt request/result files remain outside the checkout. The command executor retains hash-checked copies of cited file evidence under each attempt directory (maximum 16 MiB per file), so later working-file changes do not erase those bytes.
- The command worker receives explicitly selected environment variables; database credentials are not inherited. Raw stdout/stderr are discarded. A Linux process-group timeout prevents an ordinary child/descendant from outliving its execution; systemd's control-group boundary contains the complete service on the selected host.
- Failure after starting the worker requires review. An ambiguous settlement leaves the claim for durable inspection rather than recording a false failure or rerunning effects. Expired ownership does not permit automatic external-worker takeover in the pilot. A blocked status identifies work requiring reconciliation.

## Source provenance

- Main observed for this delivery: `b22b605647d21d0143a6b17d377aa7e8016a4f1e`.
- PR #63 head incorporated: `ac2ab15` (full SHA in `DELIVERY-NOTES.md`). These changes were not represented as merged on remote main.
- Migration 008 is new. Migrations 001–007 retain their source checksums.
- No git push, merge to remote, secret change, GAS write, migration against production, or deployment was performed.

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
2. Copy `examples/vnext-pilot.config.json` to `/etc/celestan/pilot.json`. Replace all paths, the explicit OpenCode model/agent, and the authority module. Keep `enabled` and `legacyExcluded` false during qualification. State belongs in `/var/lib/celestan/pilot`, not in either repository.
3. Connect the existing authorization authority. The required module exports `authorizeExecution(context)`, `verifyExecution(decision, context)`, and `authorizeTerminal(context)`. These functions must retain project scope and existing quality requirements. The sample `examples/vnext-pilot-authority.mjs` is an implementable file-grant adapter; copy it outside the checkout and supply `CT_PILOT_GRANT_FILE` pointing at an actual existing entrustment. Its decision reference binds grant contents and execution ID, and optional `objectiveIds` restricts objectives. The grant's scope is supplied to cognition. The sample grant is deliberately invalid until configured; it grants nothing by itself.
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

## Activate after qualification

Establish the real schema/grants, worker availability, actual authority, exact release, and absence of competing legacy admission/in-flight effects. The two configuration booleans are operator assertions, not exclusion evidence. The old GAS deployment policy remains in force: GAS writes only through the canonical GitHub Actions path.

After those facts are proven, enable the configured pilot and test one bounded invocation:

```sh
node bin/vnext-pilot.mjs tick --config /etc/celestan/pilot.json
```

Install the supplied `deploy/vnext-pilot.service` and `.timer` with the actual user and paths, then enable the timer through the host's normal deployment procedure. Match `TimeoutStartSec` to the configured worker timeout plus settlement margin; the supplied service uses 240 seconds for the 120-second worker. Do not run another project writer concurrently. The timer is not installed by this package.

The periodic scan recovers a missed wake signal because eligibility is in the same transaction as the result. Systemd prevents overlapping instances of the same unit; database authority also excludes competing project claims. Keep the service account, executor isolation and PostgreSQL permissions in the qualified operating envelope.

## Recovery and limits

Inspect `status`, the exact attempt request/result files, and the external project before resolving an uncertain effect. Review/expired work does not automatically launch a replacement. This delivery intentionally includes no generic force-unlock command: stopping/reconciling the actual worker and deciding whether to resume requires the selected backend's evidence and authority. Automatic backend-specific reconciliation is not claimed.

Human input is bounded at 100 messages and 128 KiB per thread; identity context at 16 files/256 KiB; command result at 64 KiB. Exceeding a bound stops rather than silently dropping context. There is no generalized memory compaction yet. Per-wake timeout and cooldown prevent a hot loop; the observation period must still assess whether repeated work is useful.

Pending live acceptance: the configured backend and terminal policy, native database concurrency/recovery checks, host restart/containment, real human-interface delivery, legacy exclusion, and several days of useful autonomous project work. Follow the revised implementation plan for those gates.
