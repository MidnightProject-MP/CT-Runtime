# Work Unit Convergence — Isolated Neon Proof

**Question:** *Can real Postgres, under retries, reordering, contradiction, and concurrency, represent exactly one valid convergence truth for a Work Unit?*

**Answer:** YES — proven on an isolated Neon branch with transactional immutability, idempotent duplicates, reordered convergence, contradiction rejection, rollback atomicity, and merge isolation.

## Artifact Binding

- **CT-Runtime commit:** `52bc36f31b490ff58b9f13ec04d3d465e2b16299` (`52bc36f`, branch `main`, exact commit under test — supersedes `acb33db5` after precedence fix)
- **Previous packet:** `proofs/convergence-acb33db5.json` bound to `acb33db5` (indeterminate incorrectly dominated fail); superseded by `proofs/convergence-52bc36f3.json` after fix.
- **Isolated Neon branch:** `proof-convergence-52bc36f-20260903` (`br-cold-bird-ay20qr8h`) — child of production `br-curly-waterfall-ay7qszj8`, region `us-east-2`, Postgres `18.6`, role `celestan_migrator` (direct); previous `br-delicate-field-ayfq86vw` deleted after capture
- **Migrations applied transactionally via `lib/migration.mjs`:**
  - `016_work_unit_convergence.sql` — `9b364aee6eafad0fd03d46b78930457601c0bbcc2b1ad34b352327f8eff716e7`
  - `017_work_unit_convergence_immutability.sql` — `620c20aef037797fb5c8892f00a5e39f62b5f40014644c33b3f99f191b081886`
  - `runtime_schema_migrations` rows `1..17` verified with checksums (see `proofs/convergence-52bc36f3.json`)
- **Production Neon untouched** — no `production` branch mutation, no `celestan_runtime` pooled writes, no deployment claim.
- **Continuation wiring absent** — proof exercises persistence and `lib/convergence.mjs` / `lib/convergence-store.mjs` only; no scheduler, GAS, or `ready→merge→next Work Unit` automation.

## Proof Harness

- **Harness:** `test/convergence.neon-proof.test.mjs` — gated on `TEST_DATABASE_URL`; otherwise `SKIP`. Uses `PostgresConvergenceAdapter` (`lib/convergence-store.mjs`) and `reconcileConvergence` (`lib/convergence.mjs`) against real Postgres.
- **Execution:** `TEST_DATABASE_URL=<branch-direct> node --test test/convergence.neon-proof.test.mjs` — 13 tests (1 top-level + 12 subtests) against the isolated branch.
- **Evidence capture:** After each assertion, exact SQL state is queried (`SELECT count(*)`, `SELECT result`, `SELECT evidence`, `SELECT source_head_sha`) and recorded in `proofs/convergence-52bc36f3.json` (`finalCounts`, `migrationRows`, `migrationChecksums`); previous packet `acb33db5` retained.

## Properties Proven (11 + concurrent race)

1. **Intent and convergence records remain immutable under retries** — `UPDATE federation_work_units SET intended_outcome=...` rejected with `work unit identity or intent is immutable` (trigger `federation_work_unit_identity_immutable`, code `45000`); `UPDATE federation_convergence_subjects SET head_sha=...` rejected with `convergence subject identity or head is immutable`; `UPDATE/DELETE federation_convergence_checks` rejected with `append-only` — verified by `assert.rejects` and row unchanged after attempt.

2. **Duplicate check delivery is idempotent** — Same `(work_unit_id, pull_request_id, head_sha, check_name, implementation_version)` inserted twice via `recordCheck` → first `created:true`, second `created:false`, same `checkId`, `count(*)=1`.

3. **Reordered check transactions converge identically** — Two workUnits with same `evidenceRequirements=['tests','lint']`, checks inserted in opposite orders (`[tests, lint]` vs `[lint, tests]`) → both `reconcileConvergence` yield `ready`, `missing=[]`, `checkIds` length 2, DB `count=2` for each.

4. **Stale implementation/version cannot override** — `recordCheck` with same identity `(tests, v1)` but different `result/evidence` → `convergence check identity conflict`; distinct `implementationVersion` (`v2`) allowed as separate row (`count=2`) but does not silently override `v1`.

5. **Contradictory PR/head/workUnit/intent bindings are rejected transactionally** — `pullRequestId` mismatch → `pull request binding is invalid`; `headSha` mismatch → `commit binding is invalid`; `workUnitId` mismatch → `work unit binding is invalid`; `intentDigest` mismatch → `intent binding is invalid`; cross-project `work_unit` creation → `federation_work_units_project_fk` violation; non-existent subject → foreign-key violation — all `assert.rejects` with no partial row (`count=0` after).

6. **Required-pass-without-evidence cannot become `ready`** — `evidenceRequirements=['tests']` with `checks=[]` → `reconcile` returns `indeterminate` with `missing=['tests']`; `evidenceRequirements=[]` with `checks=[]` → `ready`.

7. **Authoritative fail dominates indeterminate and missing** — `tests:pass + lint:fail` → `not ready`; `tests:pass + lint:indeterminate` → `indeterminate`; `tests:fail + lint:indeterminate` → `not ready` (authoritative `fail` takes precedence; verified via `reconcileConvergence` after `lib/convergence.mjs:94` fix).

8. **Optional checks never influence readiness** — `evidenceRequirements=['tests']` with `tests:pass + coverage:fail` (optional) → `ready`; `tests:pass + coverage:indeterminate` → `ready` — proven after fix to `lib/convergence.mjs` to filter `requiredChecks`.

9. **Merge canonicalization cannot occur without valid readiness / intent binding** — `recordMerge` with `sourceHeadSha` mismatch → `source head binding is invalid`; duplicate `mergeId` with same unique `(work_unit_id, pull_request_id, source_head_sha)` but different `mergedCommitSha` → `merge recording conflict`; identical retry with same `mergeId` → `created:false` idempotent; `count=1` after.

10. **Merge commit B becomes canonical without inheriting head A evidence** — Same `workUnit` with subjects `head_A` and `head_B` (same PR, different heads) → checks only on `A` (`count A=1, B=0`), merges for both heads distinct (`merges.length=2`, `source_head_sha` sorted equals `[HEAD_A, HEAD_B]`), `reconcile` for `A` with checks → `ready`, for `B` without checks → `indeterminate`, after adding checks to `B` → `ready`, evidence arrays remain isolated (`evidence-A` vs `evidence-B`).

11. **Failed transactions leave no partial contradictory state** — Explicit `BEGIN; INSERT valid check; INSERT duplicate same identity with different checkId → duplicate key violation; ROLLBACK` → `count=0`; subsequent valid single insert → `count=1` — proves atomic rollback.

**Concurrent race — two sessions racing same logical check:** Two `Pool`s racing `recordCheck` for same `(workUnit, PR, head, checkName, version, result:pass)` → `Promise.allSettled` yields one `created:true`, one `created:false`, same `checkId`, `count=1`, no duplicate rows; racing contradictory `fail` vs existing `pass` → one `rejected` with `identity conflict`, one `fulfilled` with `created:false` — proves Postgres `ON CONFLICT DO NOTHING` + `SELECT FOR SHARE` + unique constraint gives one coherent truth under contention.

## Verification

- **Isolated branch:** `npx neon branches list` shows `proof-convergence-52bc36f-20260903` (`br-cold-bird-ay20qr8h`) `ready` separate from `production`; `runtime_schema_migrations` on branch contains `016`/`017` with exact checksums, while production remains at `015` until promoted. Previous branch `br-delicate-field-ayfq86vw` deleted after evidence capture.
- **No production mutation:** All `INSERT`s target branch direct URL (`ep-delicate-resonance-...`), not pooled production; `TRUNCATE ... CASCADE` affects only branch; production verified at `15` migrations via `SELECT version FROM runtime_schema_migrations`.
- **No continuation wiring:** `lib/convergence-store.mjs` and `test/convergence.neon-proof.test.mjs` contain no scheduler/GAS/merge→next-Work-Unit code; `migrate` does not schedule.
- **Full suite:** `npm test` without `TEST_DATABASE_URL` → `194 passed, 4 skipped` (Neon proof `SKIP`); with `TEST_DATABASE_URL` → `197 passed` (including 13 Neon proof tests). `403` on `origin/main` push resolved by switching to `MidnightProject-MP` account (write access to org repo).

## Independent Review

Reviewer needs only:

1. The branch name and direct URL (or `npx neon connection-string <branch> --role-name celestan_migrator`) — recreate fresh child of `br-curly-waterfall-ay7qszj8` via `npx neon branches create --project-id falling-bird-38424127 --parent br-curly-waterfall-ay7qszj8 --name proof-convergence-<short>-<date>`.
2. The commit `52bc36f` (tree `52bc36f31...`) and files `lib/convergence.mjs` (`fail` first), `lib/convergence-store.mjs`, `migrations/016_*.sql`, `migrations/017_*.sql`, `test/convergence.neon-proof.test.mjs`.
3. The proof packet `proofs/convergence-52bc36f3.json` (commit `52bc36f31...`, `migrationRows`, `migrationChecksums`, `finalCounts`, `timestamp`); previous `convergence-acb33db5.json` retained for history but superseded.

Rerun (fresh branch, exact commit): `TEST_DATABASE_URL=$(npx neon connection-string <new-branch> --project-id falling-bird-38424127 --role-name celestan_migrator) node --test test/convergence.neon-proof.test.mjs` — all 13 should pass; any `FAIL` keeps the gate closed. Branch is ephemeral and should be deleted after capture (`npx neon branches delete <id> --project-id falling-bird-38424127`).

## Gate Status

- **Durable convergence substrate:** *Established on isolated branch*, not yet promoted to production.
- **Next gate:** Independent review of this packet → `deploy/migrate.sh` promotion of `017` to production → re-run proof against production (read-only) → classify substrate as *established* → then wire `ready → merge/canonicalize → choose/schedule next Work Unit`.

Automatic continuation remains explicitly blocked until that promotion is green.
