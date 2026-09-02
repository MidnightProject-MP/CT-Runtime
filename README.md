# CT-Runtime — capability-first

CT-Runtime provides execution mechanics for Celestan behind **purpose-level capabilities**. Celestan requests `durable_state` (not Neon), `evidence_store` (not an object-storage provider), `knowledge_publishing` (not Confluence), `project_system` (not Jira) — bindings select the adapter. Production bindings default to `durable_state:postgres` (standard Postgres — Neon/Supabase/pg) + `evidence_store:s3` (S3-compatible — AWS S3/Backblaze B2/R2/MinIO); filesystem adapters remain for local/test. Celestan code is unchanged when Neon→Supabase or Jira→Linear.

```js
const durable = await request('durable_state', { project });
await durable.createManifest(...);

const work = await request('project_system', { project: 'BorderCrossing' }); // Jira there, GitHub Issues elsewhere
await work.listWork(...);

const pub = await request('knowledge_publishing', { project });
await pub.publishChronicle({ period, markdown });
```

See `capabilities/README.md`, `docs/capabilities.md`, `docs/northflank.md`, `bindings.example.json`, `lib/capabilities/`. Production defaults currently bind `disposable_compute:northflank_sandbox` and `scheduler:northflank`; production state still requires Neon-backed `durable_state` + Backblaze B2-backed `evidence_store`, and live Northflank proof remains pending authorization.

An optional GAS-native binding lives in `gas/`. Select it only with explicit `CT_RUNTIME_MODE=gas` or an override. It reconstructs from Sheets/Drive, uses Apps Script locks/triggers, OpenRouter free-only bounded turns, and GitHub APIs; it does not provide general compute or run OpenCode.

## CLI

```powershell
node bin/ct-runtime.mjs run --store C:\temp\ct --project demo --task "inspect" --model provider/model --agent build --cwd C:\work --opencode opencode
node bin/ct-runtime.mjs schedule --store C:\temp\ct --time 2030-01-01T00:00:00Z --reason maintenance --priority normal --project demo
node bin/ct-runtime.mjs scheduler --store C:\temp\ct --model provider/model --agent build --task "inspect" --cwd C:\work --observer C:\Celestan\projects\CT-Foundry\capabilities\observer\observer.mjs --opencode opencode
node bin/ct-runtime.mjs recover --store C:\temp\ct
node bin/ct-runtime.mjs observe-pending --store C:\temp\ct --observer C:\Celestan\projects\CT-Foundry\capabilities\observer\observer.mjs --semantic-result C:\temp\semantic.json
node bin/ct-runtime.mjs evidence export run-example --store C:\temp\ct
node bin/ct-runtime.mjs evidence export ses_01ABC --store C:\temp\ct --opencode opencode
node bin/ct-runtime.mjs evidence backfill --store C:\temp\ct
node bin/ct-runtime.mjs status --store C:\temp\ct
```

`scheduler` is a one-shot Task Scheduler entry point. It claims due wakes durably and launches each with the supervisor's model, agent, bootstrap task, cwd, executable, and optional Observer path. Each schedule stores one deterministic execution/work-order identity; stale interrupted claims are reclaimed for that same execution. A schedule is completed only after launch returns; duplicate schedule and claim calls are safe.

## Result handoff

Every non-dry run receives an ephemeral OS-temporary `CT_RUNTIME_RESULT_FILE`, removed during finalization, and a bootstrap prompt requiring exactly this JSON object:

```json
{"status":"complete","summary":"bounded factual summary","requested_next_wake":null}
```

The only accepted keys are `status`, `summary`, and `requested_next_wake`. The latter is either `null` or exactly `{time,reason,priority,project}`. Invalid or missing handoff is a bounded validation failure and never causes a guessed wake. A valid request is persisted and scheduled by digest idempotency.

`complete` and the resulting runtime `success` describe only a bounded execution and valid handoff. They do not establish that the work-order claim, project objective, deployment, or user outcome succeeded; that judgment remains caller-owned and requires evidence appropriate to the claim.

## Claim-level semantic evidence

Envelopes use `celestan-semantic-evidence-envelope-v1`. The core rule is that every claim is bounded, source-linked, and classified; execution success never upgrades a claim into objective or outcome truth. Sources are explicitly classified as operator-supplied, execution-reported, mechanically-verified, independently-reviewed, runtime-observed, or provider-reported. Drafts contain only `sources` and `claims`; transcripts and reasoning are never accepted or persisted. Observer binds the structural digest and envelope in an immutable `celestan-observer-evidence-join-v1`; no semantic task or result is admitted without that join and cited claim IDs.

## Recovery and observation

`recover` scans stale `manifested`, `running`, `retrying`, and `requeued` executions using the persisted lease TTL contract, fences the old lease, records the interrupted attempt as crashed, and requeues infrastructure recovery up to a bounded limit. It never reports success or fabricates a terminal recovered state. Terminal records are eligible for `observe-pending`; the manifest records pending, observed, or semantic-evidence-insufficient transactionally with Observer lifecycle state. The runtime creates a semantic task only after sealing an eligible evidence join. A caller may provide bounded semantic JSON or configure the optional OpenCode reflection provider; invalid or unavailable reflection remains pending and never invents semantic content. Observer executions are excluded from recursive observation.

Production model telemetry uses `PostgresObserverStore.appendModelTelemetryEnvelope()`. These authoritative sessions, invocations, failures, and transitions are distinct from `runtime_model_telemetry`, whose byte/chunk rows describe process mechanics. Production observation omits the model field when no authoritative envelopes exist. Startup, execution, and termination host samples are persisted through the separate host telemetry API and projected to Foundry independently.

`export-observer` calls Foundry's validated `joinedRecords()` projection and emits stable canonical JSON. PostgreSQL stores semantic tasks, policy decisions, coverage snapshots, and immutable Chronicle artifacts; an S3-compatible artifact sink may mirror them. Chronicle Markdown remains a portable manual Git-promotion format rather than operational authority.

`evidence export EXECUTION` packages local runtime executions as before. For `ses_...`, the default invokes `opencode export SESSION --sanitize` and records structural-only fidelity. `--rich` (or `--source rich`) invokes the supported export without sanitizing; stdout is ephemeral process memory, bounded to 64 MiB, redacted again, and never persisted. Both modes use allowlisted factual fields and retain the source session ID without claiming a physical execution ID. Per-assistant route metadata is separate from the session default route, with bounded aggregates and contiguous segments. Canonical local inbox packages are immutable: identical exports are duplicates, while changed extraction is an explicit revision linked to its predecessor. Backfill remains sanitized-only. Missing historical sessions are reported unavailable rather than guessed.

## Safety and retention

Stdout and stderr are retained as redacted raw evidence, capped at 64 KiB per stream. Manifests record retrievable URI and SHA-256 references, byte counts, and truthful truncation flags. Events and telemetry contain bounded fields and no raw stderr. `--secret-name NAME` selects explicit secret names from the inherited/child environment for redaction; secret values are never persisted. This allowlist is not a claim that arbitrary model output is secret-free.

## Current Boundaries

### Execution Federation

`execution_federation` is provider-neutral. Postgres migration 005 is its
initial coordination adapter: one logical work order may have many physical
executions, and every mutation requires a fenced lease. Checkpoints, handoffs,
finalization, reconstruction, repository drift checks, and normalized Observer
lineage are durable. Foreground mutation conflicts with active background work
fail closed. GAS Sheets/Drive remain provider-local state, not coordination
authority. The local OpenCode bridge exposes semantic boundaries, including a
read-only project/work-order-scoped discovery operation and a separate explicit
transactional foreground takeover. Takeover keeps the logical work-order ID,
creates a fresh physical execution and fence, rejects live competing authority,
and verifies repository state before mutation. A bounded live
OpenCode -> GAS -> OpenCode proof, including safety-wake non-conflict, is accepted;
see `docs/execution-federation.md`.

- An external supervisor is required for scheduling, recovery, retention, and policy.
- An Observer semantic provider is not configured by default.
- OpenCode fields are unavailable unless an adapter supplies them; unsupported topology, task, and orchestration fields are not projected as if they survived Foundry projection.
- Cloud Run, Oracle systemd, Postgres, MinIO, and multi-host integration remain external verification gates; this repository makes no deployed claim.
- OCI/PostgreSQL/S3 portability is useful but is not a claim that deployments have no vendor lock-in.
- The pinned Foundry commit must expose Observer 1.2.0 for production images and integration tests.

Manifest, event, telemetry, schedule, and Observer files are retained until the caller removes the selected store. No automatic retention or deletion policy is hidden in the runtime.
