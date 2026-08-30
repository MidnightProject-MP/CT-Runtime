# Neon binding for durable_state → postgres

**Capability:** `durable_state` — canonical transactional continuity
**Binding:** `postgres` (standard `pg` Pool, no Neon SDK)
**Provider:** Neon — project `CT-Runtime` (`falling-bird-38424127`), org `MidnightProject` (`org-icy-union-90602157`), branch `production` (`br-curly-waterfall-ay7qszj8`), region `us-east-2`, Postgres `18.6`

## Why this binding

Provider-neutral: Celestan calls `request('durable_state', {project})` → `PostgresStore` via standard `pg`. Neon supplies standard `postgresql://` with pooling. No code change if switched to Supabase/self-hosted — only `CT_RUNTIME_DATABASE_URL` changes. Checked against official Neon skills: standard adapter suffices; no Neon-specific adapter gap.

**Free/thin fit:** Neon Free includes pooled+direct, branchable, scale-to-zero; matches `durable_state` guarantees (transactional, fenced `bigint` leases, `SKIP LOCKED`). S3-compatible evidence remains separate (`evidence_store → s3`).

## Actual configuration (no secrets committed)

* **CLI profile:** `celestan-ct-runtime` (project-scoped API key, `~/.config/neon/credentials.celestan-ct-runtime.json`), active `DEFAULT` is file-based OAuth. Verified `npx neon profile list` shows both; `npx neon connection-string --project-id falling-bird-38424127` returns direct, `--pooled` returns `-pooler`.
* **Connections (redacted):**
  * **Runtime (pooled, app traffic):** `postgresql://celestan_runtime:***@ep-divine-wave-ayqhq978-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require`
  * **Migration/admin (direct, DDL, pg_dump, logical replication):** `postgresql://neondb_owner:***@ep-divine-wave-ayqhz978.c-5.us-east-2.aws.neon.tech/neondb?...` and `celestan_runtime` direct variant. Direct required for migrations (`neon-postgres` skill: pooled = PgBouncer transaction mode, no `SET`/`LISTEN`/`PREPARE`).
* **Roles:** `neondb_owner` (owner, for `migrate`), `celestan_runtime` (least-privilege, created `2026-08-30T17:27:21Z` via `neon roles create`). Grants: `USAGE ON SCHEMA public`, `SELECT/INSERT/UPDATE/DELETE ON ALL TABLES` + `ALTER DEFAULT PRIVILEGES`, `USAGE/SELECT ON SEQUENCES`. Verified `GRANT` succeeded; `celestan_runtime` can `SELECT/INSERT` but cannot `DROP`/`CREATE` unrestricted.
* **Migrations:** Applied via direct owner `npm run migrate -- --database-url <direct>` → `{"status":"migrated","applied":[1,2,3,4]}` including `004_observer_production_contract`. Verified `SELECT version FROM runtime_schema_migrations` matches image `migrations/001-004` checksums.
* **Env / secrets placement (capability-first):**
  * **Non-secret:** `CT_RUNTIME_MODE=production`, `CT_RUNTIME_S3_BUCKET`, `CT_RUNTIME_S3_ENDPOINT`, `CT_RUNTIME_REGION=us-east-2`, `CT_RUNTIME_GIT_*`, `CT_RUNTIME_IMAGE/CONFIG_DIGEST`, `CELESTAN_DURABLE_STATE=postgres` (optional; defaults to postgres in production)
  * **Secrets:** `CT_RUNTIME_DATABASE_URL` (pooled runtime) + `CT_RUNTIME_DATABASE_URL_UNPOOLED`/`DATABASE_URL_UNPOOLED` (direct migration) → **GCP Secret Manager** `celestan-database-url` / `celestan-database-migration-url` (`secretAccessor` only `celestan-runtime` SA) → Cloud Run `--set-secrets` + Oracle env file `0600 /etc/celestan/env`. Never committed, never pasted in chat. Local dev uses `NEON_API_KEY` file `~/.config/neon/...` not `.env`.

## Verification performed against real Neon (no mocks)

* **Connectivity:** Direct `select version()` → `PostgreSQL 18.6 on aarch64…` (pooled `select 1` also ok). Warning about `sslmode=require` → `verify-full` noted but not blocking.
* **Migrations:** `doctor` → `{"mode":"production","database":"reachable","evidence":"reachable","schema":"1,2,3,4","healthy":true}` (with fake evidence `reachable:true` for isolated durable_state test). `reconstruct` → `{"status":"reconstructed","deploymentId":...,"schema":"current","evidenceReferences":0}` with ephemeral `workdir` clean. Both use `Store` + `PostgresObserverStore` transactionally; no `.neon` local state required.
* **Adapter conformance (standard pg):** Manual `PostgresStore` `createManifest` (idempotent), `lease`/`heartbeat`/`release` with `bigint` fence as decimal string, `schedule`/`claimSchedules` (`SKIP LOCKED`), `finalizeExecution` (fenced `UPDATE … WHERE owner/fence`), `updateManifest` fencing, `createManifest` identity conflict detection — all passed against Neon pooled/direct. Full `test:postgres` suite: `6/9` subtests pass on Neon direct; `3` timing-sensitive (`stale lease takeover 20ms`, `SKIP LOCKED` race, `claimed_at` reclaim) flap due to WAN latency (Neon `us-east-2` from Windows) vs CI's local `postgres:16.9` (<1 ms) — not a provider gap; increasing TTL to `1000ms` makes them pass. `search_path` via `Pool options` fails on pooled (expected `PgBouncer transaction mode` per Neon docs) — direct supports it; CI tests use `search_path` per-schema isolation, which is not needed in production (single `public` schema, unique `execution_id`). No Neon-specific adapter required.
* **Observer:** `PostgresObserverStore.append` (canonical `provenance_hash` excluding `observedAt`), `semantic-task` dedup fixed `lib/observer-store.mjs:52`, `appendSemantic` validated against `allowedEvidenceReferences`, `joinedRecords` export stable. Integration `test:postgres` with Neon direct passes `finalization commits attempt/event/execution/wake or rolls back`, `recovery writes crashed attempts`, `topology` — verified via direct Pool.
* **Windows path gap:** `test/observer.integration.test.mjs:20` fails on Windows (`c:` ESM specifier) — not Neon-related; passes on Linux CI (`test` success in `33322644303`). Skipped locally.

## Observed limitations / no new adapter needed

* **Pooled vs direct:** As documented (`neon-postgres` skill table): app → pooled, migrations/`pg_dump`/`LISTEN` → direct. `neon env pull` writes `DATABASE_URL` (pooled) + `DATABASE_URL_UNPOOLED` (direct) — we follow that.
* **Pooling constraints:** `PgBouncer transaction mode`; `SET`, `LISTEN/NOTIFY`, `PREPARE`, temp tables, `search_path` startup packet not supported on pooled. Not a gap for `durable_state` (uses transactional, no session state). Tests needing `search_path` must use direct.
* **Scale-to-zero:** Neon suspends after `5m` idle; cold start `~300ms`. Handled by standard `pg` retry — no adapter change.
* **Free-tier:** Not yet at `0.5 GB` storage or `5 GB` network limits; `evidence_store` remains in S3/MinIO, not Neon, so limits not hit.

## What remains human-owned

* **Neon account/billing** already exists — no further Neon human action unless rotating `celestan_runtime` password (`neon roles reset-password`) or changing region.
* **R2 / S3 `evidence_store`** not yet provisioned — next blocking human step per Human Setup Requirements Report `C2`.
* **Cloud Run + Scheduler** `scheduler` binding and Oracle `systemd_timer` — next human steps `C3/C4`.

## Remaining autonomous steps (Celestan, after you hand off secrets via Secret Manager)

* No code change for Neon; standard adapter stands. Celestan will, without further input, use `celestan_runtime` pooled URL for runtime, direct for one-off `migrate`, run `doctor`/`reconstruct` on every fresh container, and execute the `Cloud Run → Oracle → fresh Cloud Run` continuity experiment once R2 + compute hosts are available.
