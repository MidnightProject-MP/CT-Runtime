# Execution Federation L1

Execution Federation separates a durable **logical work order** from its
provider-specific **physical executions**. Migration `005_execution_federation`
provides the initial Postgres adapter.

The adapter durably records claims, monotonic per-work-order fences, leases, checkpoints,
handoffs, finalization, events, and reconstruction. A stale or competing claim
cannot mutate state. An active foreground execution and a competing background
mutation conflict transactionally and fail closed. `repositoryDrift()` compares
the immutable work-order repository identity before a caller mutates a
workspace. Claims increment the counter on the locked work-order row, and lease
ownership is validated against PostgreSQL's `clock_timestamp()`, so stale writers
are fenced even when host clocks disagree. Handoffs accept a caller-supplied
`handoffId` and are safe to retry with the same identity.

Observer receives the provider-neutral `celestan-observer-lineage-v1` record;
it contains IDs, provider/mode, parent handoff, and a checkpoint digest, never
transcripts or secrets. `createOpenCodeFederationBridge()` is a local semantic
API only (`begin`, `checkpoint`, `defer`, `continue`, `finalize`, `lineage`).

GAS Sheets/Drive remain local provider state and evidence. They do not become
coordination authority, and no GAS mutation is permitted when canonical
coordination is unavailable. Migrations `006_gas_federation_transport`,
`007_federation_handoff_revision`, and `008_federation_handoff_target_required` add a
bounded advisory ledger with unique nonces, duplicate/replay/already-consumed
classification, handoff revision and target-fence validation, plus fixed RPC
functions for pending polling, transactional take/reconstruction, and checkpoint.
`gas/gas_federation.js` uses a short-lived Google identity token for outbound RPCs
and enforces instance/TTL/body bounds. It accepts no task, function, prompt, or
work-state input, reconstructs a federation proof from Neon, creates local execution
evidence, and writes a canonical bounded checkpoint without a model call. The 15-minute `gasSafetyWake` polls pending
advisories, so a persisted advisory survives a failed notification.

Node persists the complete canonical advisory in a transaction before notification.
GAS authenticates Neon with a short-lived `ScriptApp.getIdentityToken()` bearer;
Neon validates Google JWKS and the exact audience. Its take function derives the
subject from `request.jwt.claims.sub`, locks the advisory/work order/execution,
renews an owned live lease or allocates a monotonic takeover fence, and rejects a
live competing authority. Checkpoint and advisory consumption commit together.
`PostgresObserverStore.lineageFor()` returns unified ordered federation lineage;
Foundry digest schemas are unchanged. Reverse GAS-to-OpenCode remains blocked.
The external provider configuration uses Google JWKS and exact audience
`788761466843-bqaho4ssrgp2ahif41uacv3o832o7hoo.apps.googleusercontent.com`, never a wildcard. Google identity tokens contain no `role` claim; this Neon Data API build therefore uses its configured fallback role. The fallback is `authenticated`, but missing-bearer requests are still rejected by the external-provider gateway, the role has no direct federation-table grants, and every definer RPC maps JWT `sub` through the private active instance registry before returning or mutating anything.

Live acceptance on 2026-09-01 used web deployment `AKfycbwyFPC55MvhCfPUmBlfm7eRp-uHr5tpZ2H9suobETGXod_hLLVDQtC9DelC7ee_WSNawg` and work order `work-gas-proof-420d7ae6-b3dc-420d-b78e-85ef20fc13aa`. OpenCode checkpointed and handed off; GAS took fence 3, created physical execution `physical-execution_dc87814074e550a473c099fae1db37c0`, persisted Drive evidence `1Y7IYDAZbdecUvQkMU9aGL4jwaRYeTYTJ` with SHA-256 `6d56f293f690a48c8fd59a0c26eb80d5cb17a0936ee71cfcfe0a2e6e0a0482fc`, recorded an observed local Observer result, and committed canonical checkpoint digest `2d47e6e1ad478362d8426dad91417dd20e7cc7939f0f17115aff835aa08ceaba`. Unified lineage returned two physical executions plus `claimed`, `checkpointed`, `gas-taken`, and `gas-checkpointed` events. Duplicate delivery returned `already-consumed`; tamper and stale timestamp were HMAC-rejected; a deliberately advanced target fence returned `stale-target` and durably rejected its advisory. Work order `work-gas-proof-e5fb7d7b-7d8f-4529-bc53-0f463daa7492` was persisted with a simulated notification failure and later consumed without a POST by `gasSafetyWake`, with a real GAS checkpoint and one evidence reference. Reverse GAS-to-OpenCode remains an explicit limitation.
