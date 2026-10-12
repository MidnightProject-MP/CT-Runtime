# Bounded model failure recovery

The October 12 14:44 UTC execution failed with legacy generic metadata. Its
historical cause is unknown; degraded public provider availability is not proof.
No model, token budget, or provider fallback changes accompany this extension.

`003_model_diagnostics.sql` wraps the existing delivery RPC, preserves its
principal and authoritative execution/fence checks, and stores only closed,
server-validated diagnostics in `vnext_executions.failure.diagnostics`. Old GAS
failure calls without diagnostics remain valid. Apply this extension before GAS.
Bootstrap and 002 checksums are unchanged. The upgrade tool accepts only the
known checksummed prefix and never updates old ledger rows.

Use an ephemeral owner connection validated by `validateTarget`, captured from
`npx neonctl connection-string br-falling-sky-b4d1fow0 --project-id steep-fog-88521756 --database-name neondb --role-name neondb_owner`.
Never print the captured connection or child process output on errors. The only
permitted target is the pinned new database in `bootstrap-gas-email.mjs`.

1. `node scripts/upgrade-gas-email-delivery.mjs inspect`
2. After tests, `node scripts/upgrade-gas-email-delivery.mjs apply`
3. Deploy the reviewed GAS through GitHub Actions, with a fresh preflight.
4. `node scripts/retry-gas-email-model.mjs inspect`
5. Only after confirming the diagnostics source is deployed:
   `node scripts/retry-gas-email-model.mjs apply <snapshot> --model-diagnostics-deployed`
6. Let the existing five-minute trigger perform the single eligible text turn.
   `node scripts/inspect-gas-email-runtime.mjs` observes the result without model,
   Gmail, or configuration effects.

Steps 1–2 and 4–6 use `CT_BOOTSTRAP_DATABASE_URL` only in ephemeral process memory.
The implementation worker must not execute step 5 or any GAS deployment.
The retry is pinned to failed execution
`gas-turn-963627a2-09f8-48b6-8c29-1ad46f8005cc`, fence 2, stored input 2 and the
existing sent reply. Its immutable audit key prevents a second release. It only
changes failed-through gating, due time and actionable state under the project
advisory lock; original execution/input/outbox records are untouched. A changed
snapshot, newer input, live authority, pending/uncertain delivery or reconciliation
blocks release. There is no generic unlock, fabricated input, resend, or automatic
failure retry loop. Re-inspect on rejection; do not relax guards.

Diagnostics contain fixed codes, HTTP status, allowlisted finish reason, finite
character/byte counts and presence booleans. They contain no content, provider
message, credentials or token usage. The owner inspector projects only normalized
metadata rather than exposing arbitrary failure JSON.
