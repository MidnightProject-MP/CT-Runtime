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
* **Roles (separate authorities, like scheduler vs runtime):**
  * `neondb_owner` — super-owner, local workstation only, not granted to Cloud Run.
  * `celestan_migrator` — **deployer** (created `2026-08-30T18:26:04Z` via `neon roles create`), `GRANT USAGE,CREATE ON SCHEMA public` + `SELECT/INSERT/UPDATE/DELETE` + `USAGE,SELECT,UPDATE ON SEQUENCES`. Used only via `CT_RUNTIME_DATABASE_MIGRATION_URL` in explicit `deploy/migrate.sh` (`ct-runtime-migrate` job, SA `celestan-migrator`).
  * `celestan_runtime` — **wake** least-privilege (created `2026-08-30T17:27:21Z`), `GRANT USAGE ON SCHEMA public`, `SELECT/INSERT/UPDATE/DELETE ON ALL TABLES` + `ALTER DEFAULT PRIVILEGES`, `USAGE,SELECT ON SEQUENCES` (*no* `CREATE`). Used only via `CT_RUNTIME_DATABASE_URL` (pooled `-pooler`) in wake job (`celestan-runtime` SA). Verified `GRANT` succeeded; runtime cannot `DROP`/`CREATE`.
* **Migrations:** Applied via direct migrator `npm run migrate -- --database-url <direct>` (`celestan_migrator` direct `npg_...`, *not* `celestan_runtime` pooled) → `{"status":"migrated","applied":[1,2,3,4,5,6,7,8,9,10,11,12]}`. Migrations 009-012 add interactive-takeover safety, checkpoint integrity, atomic GAS authority release, rejection of advisories superseded by a newer work-order fence, and database-level federation state constraints. Verified first on expiring branch `dev-interactive-takeover-20260901`, then applied to production. A rolled-back branch proof with the newer foreground lease already expired returned `stale-target` and left the old GAS fence and null lease unchanged. Normal wake never runs migrations.
* **Data API:** Active for production `neondb`, exposing only `public`, with maximum 3 rows, OpenAPI disabled, Google Identity JWKS `https://www.googleapis.com/oauth2/v3/certs`, and the exact Apps Script OAuth audience. No default table grants were applied. `authenticated` has execute only on pending/take/checkpoint federation RPCs and zero direct federation-table grants. Because Google identity tokens have no `role` claim, the Data API fallback role is configured as `authenticated`; missing-bearer requests remain rejected, and RPCs additionally require the one active JWT `sub` mapping to `gas-primary`.
* **Env / secrets placement (capability-first, separate authorities):**
  * **Non-secret:** `CT_RUNTIME_MODE=production`, `CT_RUNTIME_S3_BUCKET`, `CT_RUNTIME_S3_ENDPOINT`, `CT_RUNTIME_REGION=us-east-2`, `CT_RUNTIME_GIT_*`, `CT_RUNTIME_IMAGE/CONFIG_DIGEST`, `CELESTAN_DURABLE_STATE=postgres` (optional; defaults to postgres in production)
  * **Runtime secrets (wake):** `CT_RUNTIME_DATABASE_URL` (pooled `celestan_runtime` `…-pooler…`) → **GCP Secret Manager** `celestan-database-url` (`secretAccessor` only `celestan-runtime` SA `roles/run.invoker`) → Cloud Run **wake job** `--set-secrets` + Oracle env file `0600 /etc/celestan/env`. Never receives owner/migrator URL.
  * **Migration secrets (deploy):** `CT_RUNTIME_DATABASE_MIGRATION_URL` (direct `celestan_migrator` `…` *not* `-pooler`, or `neondb_owner` for initial) → **separate** Secret `celestan-database-migration-url` (`secretAccessor` only `celestan-migrator` / `celestan-deployer` SA, *not* runtime) → one-off `deploy/migrate.sh` Cloud Run job `ct-runtime-migrate` (`--service-account celestan-migrator`) or local `npx neon connection-string --role-name celestan_migrator`. Never committed, never pasted in chat. Local workstation profile `~/.config/neon/` (`celestan-ct-runtime`) stays local — not baked into image (`.dockerignore` allowlist; `docker inspect` shows no `DATABASE_URL`).

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

* **Neon account/billing** already exists — no further Neon human action unless rotating `celestan_runtime`/`celestan_migrator` passwords (`neon roles reset-password`) or changing region. Local `~/.config/neon/` (`celestan-ct-runtime` profile) stays on workstation — Cloud Run image receives only `celestan_runtime` pooled secret, never `~/.config/neon` or owner URL (verified `docker inspect` + `.dockerignore` allowlist).
* **`evidence_store`** uses the provider-neutral `s3` adapter. Backblaze B2 is the active accepted binding; its acceptance status and configuration are recorded in `docs/backblaze-b2.md`.
* **Cloud Run + Scheduler** `scheduler` binding and Oracle `systemd_timer` — next human steps `C3/C4` (wake job gets only `celestan_runtime` pooled, migrator job gets only `celestan_migrator` direct).

## Remaining autonomous steps (Celestan, after you hand off secrets via Secret Manager)

* No code change for Neon; standard adapter stands. Celestan will, without further input, use `celestan_runtime` pooled URL for runtime, direct for one-off `migrate`, run `doctor`/`reconstruct` on every fresh container, and execute the `Cloud Run → Oracle → fresh Cloud Run` continuity experiment once the external evidence-store gates and compute hosts are available.
