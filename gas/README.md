# GAS-native CT-Runtime prototype

> **Every execution body emits evidence. Observer consumes evidence.**

Execution bodies persist bounded factual evidence to `observer/inbox` and do not run semantic Observer analysis. The single GAS Observer consumes that inbox asynchronously during `gasSafetyWake`, appending idempotent semantic observations and leaving backlog for later wakes. Execution Federation remains responsible for immediate coordination; Observer lag does not affect continuity.

The existing authenticated HMAC web-app transport also accepts the narrow `operation: "evidence-ingest"` request. It validates the versioned package, size, identity, and hash, then returns only `evidenceId`, Drive `fileId`, and the stored hash. It never invokes Observer or accepts arbitrary files/transcripts.

This directory is a copyable Apps Script provider binding. It uses global V8 JavaScript only: Sheets plus `LockService` are local provider state, Drive stores bounded redacted artifacts, and UrlFetchApp calls only OpenRouter, GitHub, GitHub Actions, and the fixed Neon Data API RPC paths in `gas_federation.js`. External notifications use a shared HMAC secret; Neon calls use separate short-lived `ScriptApp.getIdentityToken()` bearer tokens. It never starts Docker/OpenCode, invokes a shell, or returns any secret to a model, tool, telemetry row, artifact, or response.

## Setup

1. Create or bind an Apps Script project to this directory's files and set `gas/appsscript.json` as its manifest.
2. Create a spreadsheet and a restricted deployment-owned Drive root folder. Folder membership and Google account permissions are the actual boundary; Drive metadata does not enforce immutability.
3. Run `initializeGasSchema()` once and approve the listed Apps Script scopes. This creates the `observer_processing` durable idempotency index in addition to the runtime sheets.
4. In Script Properties, set `CT_GAS_SPREADSHEET_ID`, `CT_GAS_DRIVE_ROOT_ID`, `OPENROUTER_API_KEY`, `GITHUB_TOKEN`, `GITHUB_REPO` (`owner/name`), `CT_GAS_PROOF_MODEL`, `GITHUB_ACTION_WORKFLOW_ALLOWLIST`, `CT_GAS_FEDERATION_DATA_API_URL`, `CT_GAS_FEDERATION_HMAC_SECRET`, and `CT_GAS_FEDERATION_INSTANCE_ID`. Enter values directly in Apps Script settings; never put values in source, logs, Sheets, Drive, or prompts. The HMAC secret is only for external notification authentication and is not a Neon credential.
5. Configure the OpenRouter key for `openrouter/...:free` models only. Configure a least-privilege GitHub token and repository. A dedicated Google account is recommended.
6. Call `CT_GAS_TRIGGER.ensure()` once. It maintains exactly one recurring `gasSafetyWake` trigger. `requestNextWake()` records an idempotent durable wake; it does not create recursive one-shot handler triggers.
7. Run `inspectFederationIdentity()` once in the Apps Script editor and authorize its OpenID scopes. The setup-only function deliberately raises a visible `FEDERATION_IDENTITY` error containing the non-secret `aud` and `sub` claims, not the token. Configure Neon's external provider with `https://www.googleapis.com/oauth2/v3/certs` and that exact `aud`; register the `sub` to the stable `CT_GAS_FEDERATION_INSTANCE_ID` in `federation_gas_instances`.
8. Deploy the script as a web app owned by the deployment account. Grant the authenticated role only the pending/take/checkpoint functions. Google identity tokens have no `role` claim; if the Data API uses its fallback role for such tokens, configure that fallback as `authenticated`. Missing-bearer requests must remain rejected, authenticated must have no direct federation-table grants, and the private JWT-sub registry remains mandatory. State must be persisted in Neon before notification. A failed POST is recoverable because `gasSafetyWake` polls pending advisories for the JWT subject every 15 minutes.

## GitHub Actions / clasp

The repository now contains a manual deployment path at `.github/workflows/gas-clasp-deploy.yml`. It keeps Apps Script credentials out of Git, generates the local `.clasp.json` from a GitHub Actions repository variable, validates the manifest, shows the clasp file set, pushes the complete GAS project, and creates or updates a deployment. `gas/.clasp.json.example` documents the local shape and is intentionally not a live project configuration.

Before using the workflow, configure:

- repository variable `CT_GAS_SCRIPT_ID` — the Apps Script project ID;
- repository secret `CLASPRC_JSON` — the complete authenticated `.clasprc.json` content for the deployment identity;
- GitHub environment `gas-production` — the workflow targets this environment so its approval/protection rules can remain the release gate.

The deployment workflow is deliberately `workflow_dispatch` only. GitHub Actions is a deployment mechanism here, not the GAS scheduler or runtime authority. Existing deployment IDs can be supplied at dispatch time; otherwise clasp creates a new deployment. Never commit `.clasprc.json`, access tokens, Script Properties, or other credentials.

## Operation

`runWake()` creates a conservative clock before reconstruction. `CT_GAS_BUDGET_MS` is clamped to 30,000..300,000 ms and defaults to 240,000 ms; explicit per-operation budgets and a 10-second reserve are retained for persistence, release, and scheduling. Every state, trigger, model, Drive, Observer, and GitHub operation has an admission and post-operation checkpoint boundary. Checkpoints use a separate measured emergency budget and never report success if durable continuation and retry scheduling cannot complete. A semantic `continuations` record carries bounded goal, decisions, evidence/provenance, outstanding work, next operation, reason, logical work-order ID, and physical execution count. Evidence progress is written immediately after Drive succeeds, before Observer or later guards, and the next continuation carries the exact Drive reference and hash. The proof work order records step A on one wake and reconstructs evidence for step B on a later wake. Model/network/rate exhaustion first persists `deferred` state, then creates a durable retry wake for the same logical work order, execution, continuation, selected model, and launch/resume context. The recurring safety trigger repairs a persisted continuation that lost its wake during a scheduling failure. GitHub Actions dispatch/inspection is a test executor and is never a scheduler.

Chronicle is a Drive Markdown artifact plus a Sheets index. Its canonical mapping is `{drive_file_id, sha256, schema, provenance}` and can be copied to Postgres/S3 by another adapter. Existing artifacts are verified before an idempotent reference is returned; corrections create validated superseding artifacts.

## Boundaries

`general_compute` remains missing: Apps Script is not a container, process executor, or OpenCode host. Federation reconstructs a bounded proof from Neon, creates a real local physical execution/continuation/evidence/Observer record, and commits a canonical bounded checkpoint through a fenced transaction. `gasSafetyWake` also polls pending federation advisories. `PostgresObserverStore.lineageFor()` provides the unified ordered federation projection without changing Foundry digest schemas.

## Trust and mappings

Google Script Properties are trusted configuration and the only credential source. Sheets are the canonical append-only runtime ledger, with `executions`, `work_orders`, `wakes`, `continuations`, `observer_ledger`, and `model_telemetry` corresponding to Postgres runtime concepts. Telemetry is bounded and excludes raw secrets and transcripts. Drive artifacts correspond to S3 objects; Sheets `evidence` rows hold the canonical Drive ID, SHA-256, schema, and provenance reference. Apps Script scopes are limited to Sheets, Drive, ScriptApp triggers, and external requests because those operations are unavoidable. Human setup owns account selection, folder/spreadsheet creation, property values, token scopes, workflow allowlisting, and trigger authorization.

`CT_GAS.runGuard()` is the authoritative cooperative admission boundary. The model request uses a conservative upper bound because UrlFetch cannot be cancelled; the non-recursive emergency checkpoint has its own reserved budget and records checkpoint latency separately. Wakes and deferred retries retain logical work-order, execution, continuation, and launch/resume identity, including the same model. Waiting conditions are `ci`, `worker`, `api`, `model-quota`, `scheduled`, or `human`. Duration pressure never requests `general_compute`; that field requires an exact non-duration capability reason. Observer proof is a deterministic correlated pending/observed ledger lifecycle, not a semantic model-pass claim.

Each inference transport attempt writes one bounded provider-neutral telemetry row. The normalized failure taxonomy is `rate_limited`, `quota_exhausted`, `insufficient_balance`, `model_unavailable`, `provider_unavailable`, `context_exceeded`, `malformed_or_invalid_request`, `transient_provider_error`, `model/output_failure`, or `unknown`. Rows retain logical and physical identity, role/purpose, requested/canonical/actual provider and model, timestamps and latency, HTTP/error class, retry and free-only fallback path, and authoritative usage, context, cost, or quota fields when supplied. They never retain a key, prompt/transcript, or raw provider response. A `429` is refined to quota exhaustion or insufficient balance only from bounded structured error fields or authoritative headers; otherwise it remains `rate_limited`.

Fallback is caller policy, not a universal model ranking. `launch.allow_free_fallback: true` permits transition only to a syntactically free model listed in `launch.eligible_models`; the normal catalog verification still runs before that model is called. The transition is checkpointed and resumes under the same logical work-order identity in a later physical execution. Without that policy, terminal scarcity suspends cleanly. The model named in the L1 closeout remains empirical evidence from that proof date, not a default or standing fallback.

## L1 acceptance

L1 is demonstrated capability, not production readiness. Acceptance requires scheduled GAS wake dispatch, Sheets reconstruction, Drive evidence persistence and hash verification, one logical work order spanning multiple durable physical executions, safe provider deferral, catalog-verified zero-priced inference, bounded GitHub mutation, later CI observation, no process-local continuity, and no paid fallback. L1 does not prove high availability, quota capacity, strong Drive immutability, arbitrary compute, browser automation, long-running processes, or production-scale concurrency.

## Wake authority

A wake identity is `(work_order_id, execution_id, continuation_id, reason)`. Its idempotency key excludes mutable schedule time. Sheets stores append-only revisions; only the latest revision for a wake ID is authoritative. Claims are leased and fenced. An expired claim may be taken over with a new fence; an unexpired claim cannot. Only checkpointed or complete execution results finalize a wake. Deferred, interrupted, invalid, and stale results retain or repair durable continuation rather than being reported as success. Completed work is never re-entered.

## Soak measurements

The bounded soak records physical execution count, logical work-order count, executions per work order, reconstructions, stale/duplicate wake suppression, preemptions, abnormal terminations, checkpoints, repeated/lost work, model calls and useful outcomes, free-model failures/fallbacks, provider latency/failure classes, CI waits/resumptions, Drive writes/verifications, Sheets lock failures, runtime/checkpoint margins, trigger health, and available quota signals. Synthetic maintenance/probe work is used; the soak never authorizes unrelated project work. Drive file ID references remain provider-local evidence.
