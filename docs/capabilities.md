# Capability-first integration

Celestan reasons over **purposes and contracts**, not vendors.

> **Celestan reasons over purposes and contracts. Capabilities define those purposes. Adapters implement capabilities. Bindings select the active implementation. Observer evaluates them. Foundry can create or replace them.**

## Concepts

**Capability** — what Celestan needs. Defined by purpose, operations, guarantees, authority, constraints. Example: `durable_state` = canonical transactional continuity; operations `createManifest`, `lease`, `finalizeExecution`, etc.; guarantees `fenced-leases`, `idempotent-manifests`; authority `canonical`.

**Adapter** — concrete implementation for a vendor. Example: `durable_state:postgres` (standard `pg`, works with Neon/Supabase/self-hosted), `durable_state:filesystem` (local), `evidence_store:s3` (standard S3-compatible API, works with AWS S3/Backblaze B2/R2/MinIO).

**Binding** — currently selected adapter, global + per-project. Example:
```json
{ "global": { "durable_state": "postgres", "project_system": "github_issues" },
  "projects": { "BorderCrossing": { "project_system": "jira" } } }
```
Celestan code stays:

```js
const durable = await request('durable_state', { project });
await durable.createManifest(...); // postgres today, neon→supabase tomorrow no code change

const work = await request('project_system', { project: 'BorderCrossing' });
await work.listWork(...); // Jira for BorderCrossing, GitHub Issues for CT-Foundry

const pub = await request('knowledge_publishing', { project });
await pub.publishChronicle({ period, markdown }); // git today, Confluence tomorrow
```

Provider details (endpoints, quotas, IAM) remain inside the adapter.

## Capabilities in this repo

| Capability | Purpose | Adapters (provider-neutral) |
|---|---|---|
| `durable_state` | canonical transactional continuity | `postgres` (standard pg), `filesystem` |
| `evidence_store` | raw/bulky evidence/provenance | `s3` (S3-compatible), `filesystem` |
| `project_system` | goals/work items/blockers | `jira`, `linear`, `github_issues` |
| `knowledge_publishing` | Chronicle/decisions/lessons | `git` (Markdown), `confluence`, `obsidian` |
| `code_repository` | source/commits/releases | `github`, `gitlab` |
| `disposable_compute` | bounded ephemeral execution | `northflank_sandbox`, `filesystem` |
| `scheduler` | mechanical wake triggering | `northflank`, `cloud_scheduler`, `systemd_timer`, `cron` |

The Northflank prototype uses OpenRouter with exact secret `OPENROUTER_API_KEY`, `CT_RUNTIME_FREE_ONLY=true`, and a `$0` spend limit. Its first unattended requested model is `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`; unavailable or rate-limited free execution is deferred with a durable bounded `retry` wake, never a paid fallback.

See `lib/capabilities/definitions.mjs` (contracts), `lib/capabilities/adapters.mjs` (catalog), `lib/capabilities/bindings.mjs` (resolver), `bindings.example.json` (sample).

## Discoverability

Adapters expose via registry:

```js
import { describeCapabilities, describeAdapters } from './lib/capabilities/registry.mjs';
describeCapabilities({ project: 'BorderCrossing' }); // purpose, binding, provider, authority, configRequirements, limitations
describeAdapters('durable_state'); // postgres vs filesystem
await health('durable_state');
```

CLI:

```
node bin/ct-runtime.mjs capabilities --project BorderCrossing
node bin/ct-runtime.mjs adapters --capability durable_state
node bin/ct-runtime.mjs bindings --project BorderCrossing
```

## Observer / Foundry

- Observer records per-adapter `latency / failures / cost / missing ops` from `runtime_events` / `runtime_model_telemetry` / host telemetry. Recurring friction may emit a Foundry signal to improve/replace the adapter (e.g., `tooling-friction`, `foundry-gap`).
- Foundry treats adapter creation/replacement as normal capability development. New adapter = new files under `lib/capabilities/adapters/` + entry in `adapters.mjs` + binding change — no Celestan logic change.

## Binding configuration

Precedence: `explicit arg` > `CELESTAN_BINDINGS_JSON` > `CELESTAN_<CAPABILITY>` env > `CT_RUNTIME_MODE` defaults (`production`→postgres/s3, `filesystem`→filesystem).

Example:

```powershell
$env:CELESTAN_BINDINGS_JSON='{"global":{"durable_state":"postgres","evidence_store":"s3"},"projects":{"BorderCrossing":{"project_system":"jira"}}}'
node bin/ct-runtime.mjs run --project BorderCrossing ...
```

Standard Postgres and S3 interfaces keep bindings replaceable (Neon→Supabase changes only `CT_RUNTIME_DATABASE_URL`; changing the S3-compatible provider changes only the `CT_RUNTIME_S3_*` configuration).

## Files

- `capabilities/README.md` — human overview
- `bindings.example.json` — global + per-project sample
- `lib/capabilities/definitions.mjs`, `adapters.mjs`, `bindings.mjs`, `registry.mjs`
- `lib/stores.mjs:createCapabilityStores()` — capability-first production wiring (legacy `createStore` preserved for tests)
## GAS binding

`gas/` is an optional provider binding for `durable_state`, `evidence_store`, `scheduler`, `agent_executor`, `workspace`, `test_executor`, and `model_provider`. Its continuation mapping is Sheets `continuations` plus `work_orders` and `executions`; its scheduler mapping is one locked recurring safety trigger plus idempotent identity-bearing wake records. `CT_GAS.runGuard()` provides cooperative preemption, with a reserved non-recursive emergency checkpoint; duration limits never request `general_compute`, which requires an exact non-duration capability reason. Observer proof is a deterministic correlated pending/observed ledger lifecycle, not a semantic pass claim. It is not selected by production defaults. See `gas/README.md` for human-only setup and its explicit lack of `general_compute`.
