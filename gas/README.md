# GAS-native CT-Runtime prototype

This directory is a copyable Apps Script provider binding. It uses global V8 JavaScript only: Sheets plus `LockService` are canonical runtime state, Drive stores bounded redacted artifacts, and UrlFetchApp calls only OpenRouter, GitHub, and GitHub Actions. A serialized single writer reconstructs revisions from fixed sheets; Drive file IDs and hashes are references, not metadata-enforced immutability. There are no web endpoints. It never starts Docker/OpenCode, invokes a shell, or returns `OPENROUTER_API_KEY` to a model, tool, telemetry row, or artifact.

## Setup

1. Create or bind an Apps Script project to this directory's files and set `gas/appsscript.json` as its manifest.
2. Create a spreadsheet and a restricted deployment-owned Drive root folder. Folder membership and Google account permissions are the actual boundary; Drive metadata does not enforce immutability.
3. Run `initializeGasSchema()` once and approve the listed Apps Script scopes.
4. In Script Properties, set `CT_GAS_SPREADSHEET_ID`, `CT_GAS_DRIVE_ROOT_ID`, `OPENROUTER_API_KEY`, `GITHUB_TOKEN`, `GITHUB_REPO` (`owner/name`), `CT_GAS_PROOF_MODEL`, and the exact workflow names in `GITHUB_ACTION_WORKFLOW_ALLOWLIST`. Enter values directly in Apps Script settings; never put them in source, logs, Sheets, or prompts.
5. Configure the OpenRouter key for `openrouter/...:free` models only. Configure a least-privilege GitHub token and repository. A dedicated Google account is recommended.
6. Call `CT_GAS_TRIGGER.ensure()` once. It maintains exactly one recurring `gasSafetyWake` trigger. `requestNextWake()` records an idempotent durable wake; it does not create recursive one-shot handler triggers.

## Operation

`runWake()` creates a conservative clock before reconstruction. `CT_GAS_BUDGET_MS` is clamped to 30,000..300,000 ms and defaults to 240,000 ms; explicit per-operation budgets and a 10-second reserve are retained for persistence, release, and scheduling. Every state, trigger, model, Drive, Observer, and GitHub operation has an admission and post-operation checkpoint boundary. Checkpoints use a separate measured emergency budget and never report success if durable continuation and retry scheduling cannot complete. A semantic `continuations` record carries bounded goal, decisions, evidence/provenance, outstanding work, next operation, reason, logical work-order ID, and physical execution count. Evidence progress is written immediately after Drive succeeds, before Observer or later guards, and the next continuation carries the exact Drive reference and hash. The proof work order records step A on one wake and reconstructs evidence for step B on a later wake. Model/network/rate exhaustion first persists `deferred` state, then creates a durable retry wake for the same logical work order, execution, continuation, selected model, and launch/resume context. The recurring safety trigger repairs a persisted continuation that lost its wake during a scheduling failure. GitHub Actions dispatch/inspection is a test executor and is never a scheduler.

Chronicle is a Drive Markdown artifact plus a Sheets index. Its canonical mapping is `{drive_file_id, sha256, schema, provenance}` and can be copied to Postgres/S3 by another adapter. Existing artifacts are verified before an idempotent reference is returned; corrections create validated superseding artifacts.

## Boundaries

`general_compute` remains missing: Apps Script is not a container, process executor, or OpenCode host. Cooperative preemption is the normal response to duration pressure and never requests `general_compute`; that capability is requested only for a genuinely unavailable capability, with the exact reason persisted. Waiting/deferred work records quota, CI/worker/API, scheduled, or human resume information and schedules a valid durable wake without busy-waiting. `gasSafetyWake` dispatches only wakes with valid durable identity; malformed due wakes produce bounded invalid-wake events and are safely deferred. Observer ledger/artifact capture is implemented with pending/observed correlation and recursion suppression. GAS is a remote provider binding, so the Node registry returns metadata and no callable GAS methods. Drive correction and supersession create a new artifact rather than mutating the old file.

## Trust and mappings

Google Script Properties are trusted configuration and the only credential source. Sheets are the canonical append-only runtime ledger, with `executions`, `work_orders`, `wakes`, `continuations`, `observer_ledger`, and `model_telemetry` corresponding to Postgres runtime concepts. Telemetry is bounded and excludes raw secrets and transcripts. Drive artifacts correspond to S3 objects; Sheets `evidence` rows hold the canonical Drive ID, SHA-256, schema, and provenance reference. Apps Script scopes are limited to Sheets, Drive, ScriptApp triggers, and external requests because those operations are unavoidable. Human setup owns account selection, folder/spreadsheet creation, property values, token scopes, workflow allowlisting, and trigger authorization.

`CT_GAS.runGuard()` is the authoritative cooperative admission boundary. The model request uses a conservative upper bound because UrlFetch cannot be cancelled; the non-recursive emergency checkpoint has its own reserved budget and records checkpoint latency separately. Wakes and deferred retries retain logical work-order, execution, continuation, and launch/resume identity, including the same model. Waiting conditions are `ci`, `worker`, `api`, `model-quota`, `scheduled`, or `human`. Duration pressure never requests `general_compute`; that field requires an exact non-duration capability reason. Observer proof is a deterministic correlated pending/observed ledger lifecycle, not a semantic model-pass claim.

## L1 acceptance

L1 is demonstrated capability, not production readiness. Acceptance requires scheduled GAS wake dispatch, Sheets reconstruction, Drive evidence persistence and hash verification, one logical work order spanning multiple durable physical executions, safe provider deferral, catalog-verified zero-priced inference, bounded GitHub mutation, later CI observation, no process-local continuity, and no paid fallback. L1 does not prove high availability, quota capacity, strong Drive immutability, arbitrary compute, browser automation, long-running processes, or production-scale concurrency.

## Wake authority

A wake identity is `(work_order_id, execution_id, continuation_id, reason)`. Its idempotency key excludes mutable schedule time. Sheets stores append-only revisions; only the latest revision for a wake ID is authoritative. Claims are leased and fenced. An expired claim may be taken over with a new fence; an unexpired claim cannot. Only checkpointed or complete execution results finalize a wake. Deferred, interrupted, invalid, and stale results retain or repair durable continuation rather than being reported as success. Completed work is never re-entered.

## Soak measurements

The bounded soak records physical execution count, logical work-order count, executions per work order, reconstructions, stale/duplicate wake suppression, preemptions, abnormal terminations, checkpoints, repeated/lost work, model calls and useful outcomes, free-model failures/fallbacks, provider latency/failure classes, CI waits/resumptions, Drive writes/verifications, Sheets lock failures, runtime/checkpoint margins, trigger health, and available quota signals. Synthetic maintenance/probe work is used; the soak never authorizes unrelated project work.
