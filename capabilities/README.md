# Capabilities — purposes, not vendors

Celestan reasons over **purposes and contracts**, not products.

```
Celestan → requests capability → Binding selects adapter → Adapter implements purpose
                              ↘ Observer evaluates
                              ↘ Foundry can create/replace adapter
```

## Rule

- **Capability** = what Celestan needs (purpose, operations, guarantees, authority).
- **Adapter** = concrete implementation for a vendor (Jira, R2, Neon...).
- **Binding** = currently selected adapter (global + per-project).

Change binding → no change to Celestan logic.

## Defined capabilities

| Capability | Purpose | Authority | Replaceable adapters |
|---|---|---|---|
| `durable_state` | canonical transactional continuity | canonical | `postgres` (Neon/Supabase/pg), `filesystem` (local/test) |
| `evidence_store` | raw/bulky logs/artifacts/provenance | referenced | `s3` (R2/S3/MinIO), `filesystem` |
| `project_system` | goals, work items, priorities, blockers | human-authoritative | `jira`, `linear`, `github_issues` |
| `knowledge_publishing` | Chronicle, decisions, lessons | curated | `git` (Markdown), `confluence`, `obsidian` |
| `code_repository` | source, commits, releases | source | `github`, `gitlab` |
| `scheduler` | mechanical wake triggering | mechanical | `cloud_scheduler`, `systemd_timer`, `cron` |

Provider-specific details (endpoints, rate limits, free-tier quotas, IAM) remain inside the adapter.
Celestan code never says “write to Neon” — it says:

```js
const durable = await request('durable_state', { project });
await durable.createManifest(...); // postgres today, something else tomorrow
```

```js
const publishing = await request('knowledge_publishing', { project });
await publishing.publishChronicle({ period, markdown, provenance });
```

```js
const work = await request('project_system', { project: 'BorderCrossing' });
await work.listWork({ status: 'open' }); // Jira for BorderCrossing, GitHub Issues elsewhere
```

See `bindings.example.json` for global + per-project bindings.

## Discoverability

Adapters expose via `describeCapabilities()` / `describeAdapters()` / `health()`:

- purpose & operations
- authority / canonicality
- reliability & security properties
- config requirements
- provider limitations
- current health where useful

```js
import { describeCapabilities, describeAdapters } from './lib/capabilities/registry.mjs';
console.log(describeCapabilities({ project: 'BorderCrossing' }));
console.log(describeAdapters('durable_state'));
await health('durable_state');
```

## Where persistence fits

- **Disposable container** → `CT-Runtime` image only
- **`durable_state`** → `PostgresStore` adapter (standard `pg`, not Neon SDK)
- **`evidence_store`** → `S3EvidenceStore` adapter (standard S3, not R2 SDK)
- **`code_repository` + `knowledge_publishing`** → `GitHub` / `Git`

Changing Neon to Supabase changes `CT_RUNTIME_DATABASE_URL`, not Celestan code.
Changing R2 to S3 changes `CT_RUNTIME_S3_ENDPOINT`, not Celestan code.

## Foundry / Observer

- Foundry treats adapter creation/replacement as normal capability work.
- Observer measures adapter `latency / failures / cost / missing ops` from `runtime_events` / `runtime_model_telemetry` / host telemetry and may emit a `Foundry signal` to improve/replace the adapter.

## Files

- `lib/capabilities/definitions.mjs` — contracts
- `lib/capabilities/adapters.mjs` — adapter catalog
- `lib/capabilities/bindings.mjs` — resolver (global + per-project, env or `CELESTAN_BINDINGS_JSON`)
- `lib/capabilities/registry.mjs` — `request(capability, {project})`
- `lib/stores.mjs` — `createCapabilityStores()` now capability-first
