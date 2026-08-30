# CT-Runtime — capability-first

CT-Runtime provides execution mechanics for Celestan behind **purpose-level capabilities**. Celestan requests `durable_state` (not Neon), `evidence_store` (not R2), `knowledge_publishing` (not Confluence), `project_system` (not Jira) — bindings select the adapter. Production bindings default to `durable_state:postgres` (standard Postgres — Neon/Supabase/pg) + `evidence_store:s3` (S3-compatible — R2/S3/MinIO); filesystem adapters remain for local/test. Celestan code is unchanged when Neon→Supabase or Jira→Linear.

```js
const durable = await request('durable_state', { project });
await durable.createManifest(...);

const work = await request('project_system', { project: 'BorderCrossing' }); // Jira there, GitHub Issues elsewhere
await work.listWork(...);

const pub = await request('knowledge_publishing', { project });
await pub.publishChronicle({ period, markdown });
```

See `capabilities/README.md`, `docs/capabilities.md`, `bindings.example.json`, `lib/capabilities/`. Production state still requires `durable_state` + `evidence_store`; image/CI/cloud claims remain unverified until gates run.

## CLI

```powershell
node bin/ct-runtime.mjs run --store C:\temp\ct --project demo --task "inspect" --model provider/model --agent build --cwd C:\work --opencode opencode
node bin/ct-runtime.mjs schedule --store C:\temp\ct --time 2030-01-01T00:00:00Z --reason maintenance --priority normal --project demo
node bin/ct-runtime.mjs scheduler --store C:\temp\ct --model provider/model --agent build --task "inspect" --cwd C:\work --observer C:\Celestan\projects\CT-Foundry\capabilities\observer\observer.mjs --opencode opencode
node bin/ct-runtime.mjs recover --store C:\temp\ct
node bin/ct-runtime.mjs observe-pending --store C:\temp\ct --observer C:\Celestan\projects\CT-Foundry\capabilities\observer\observer.mjs --semantic-result C:\temp\semantic.json
node bin/ct-runtime.mjs status --store C:\temp\ct
```

`scheduler` is a one-shot Task Scheduler entry point. It claims due wakes durably and launches each with the supervisor's model, agent, bootstrap task, cwd, executable, and optional Observer path. Each schedule stores one deterministic execution/work-order identity; stale interrupted claims are reclaimed for that same execution. A schedule is completed only after launch returns; duplicate schedule and claim calls are safe.

## Result handoff

Every non-dry run receives an ephemeral OS-temporary `CT_RUNTIME_RESULT_FILE`, removed during finalization, and a bootstrap prompt requiring exactly this JSON object:

```json
{"status":"complete","summary":"bounded factual summary","requested_next_wake":null}
```

The only accepted keys are `status`, `summary`, and `requested_next_wake`. The latter is either `null` or exactly `{time,reason,priority,project}`. Invalid or missing handoff is a bounded validation failure and never causes a guessed wake. A valid request is persisted and scheduled by digest idempotency.

## Recovery and observation

`recover` scans stale `manifested`, `running`, `retrying`, and `requeued` executions using the persisted lease TTL contract, fences the old lease, records the interrupted attempt as crashed, and requeues infrastructure recovery up to a bounded limit. It never reports success or fabricates a terminal recovered state. Terminal records are eligible for `observe-pending`; the manifest records pending, observed, or bounded pending failure transactionally with Observer lifecycle state. The runtime creates an immutable digest and semantic-task artifact. A caller may provide a bounded semantic JSON file or configure the optional OpenCode reflection provider; invalid or unavailable reflection remains pending and never invents semantic content. Observer executions are excluded from recursive observation.

Production model telemetry uses `PostgresObserverStore.appendModelTelemetryEnvelope()`. These authoritative sessions, invocations, failures, and transitions are distinct from `runtime_model_telemetry`, whose byte/chunk rows describe process mechanics. Production observation omits the model field when no authoritative envelopes exist. Startup, execution, and termination host samples are persisted through the separate host telemetry API and projected to Foundry independently.

`export-observer` calls Foundry's validated `joinedRecords()` projection and emits stable canonical JSON. PostgreSQL stores semantic tasks, policy decisions, coverage snapshots, and immutable Chronicle artifacts; an S3-compatible artifact sink may mirror them. Chronicle Markdown remains a portable manual Git-promotion format rather than operational authority.

## Safety and retention

Stdout and stderr are retained as redacted raw evidence, capped at 64 KiB per stream. Manifests record retrievable URI and SHA-256 references, byte counts, and truthful truncation flags. Events and telemetry contain bounded fields and no raw stderr. `--secret-name NAME` selects explicit secret names from the inherited/child environment for redaction; secret values are never persisted. This allowlist is not a claim that arbitrary model output is secret-free.

## Current Boundaries

- An external supervisor is required for scheduling, recovery, retention, and policy.
- An Observer semantic provider is not configured by default.
- OpenCode fields are unavailable unless an adapter supplies them; unsupported topology, task, and orchestration fields are not projected as if they survived Foundry projection.
- Cloud Run, Oracle systemd, Postgres, MinIO, and multi-host integration remain external verification gates; this repository makes no deployed claim.
- OCI/PostgreSQL/S3 portability is useful but is not a claim that deployments have no vendor lock-in.
- The pinned Foundry commit must expose Observer 1.2.0 for production images and integration tests.

Manifest, event, telemetry, schedule, and Observer files are retained until the caller removes the selected store. No automatic retention or deletion policy is hidden in the runtime.
