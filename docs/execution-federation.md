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
it contains IDs, provider/mode, parent handoff, continuation and repository
digests where available, and a checkpoint digest, never transcripts or secrets.
`createOpenCodeFederationBridge()` is a local semantic API only (`begin`,
`checkpoint`, `defer`, `continue`, `finalize`, `discover`, `takeover`,
`lineage`).

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
Foundry digest schemas are unchanged.
The external provider configuration uses Google JWKS and exact audience
`788761466843-bqaho4ssrgp2ahif41uacv3o832o7hoo.apps.googleusercontent.com`, never a wildcard. Google identity tokens contain no `role` claim; this Neon Data API build therefore uses its configured fallback role. The fallback is `authenticated`, but missing-bearer requests are still rejected by the external-provider gateway, the role has no direct federation-table grants, and every definer RPC maps JWT `sub` through the private active instance registry before returning or mutating anything.

Live L1 acceptance on 2026-09-01 used web deployment `AKfycbwyFPC55MvhCfPUmBlfm7eRp-uHr5tpZ2H9suobETGXod_hLLVDQtC9DelC7ee_WSNawg` and work order `work-gas-proof-420d7ae6-b3dc-420d-b78e-85ef20fc13aa`. OpenCode checkpointed and handed off; GAS took fence 3, created physical execution `physical-execution_dc87814074e550a473c099fae1db37c0`, persisted Drive evidence `1Y7IYDAZbdecUvQkMU9aGL4jwaRYeTYTJ` with SHA-256 `6d56f293f690a48c8fd59a0c26eb80d5cb17a0936ee71cfcfe0a2e6e0a0482fc`, recorded an observed local Observer result, and committed canonical checkpoint digest `2d47e6e1ad478362d8426dad91417dd20e7cc7939f0f17115aff835aa08ceaba`. Unified lineage returned two physical executions plus `claimed`, `checkpointed`, `gas-taken`, and `gas-checkpointed` events. Duplicate delivery returned `already-consumed`; tamper and stale timestamp were HMAC-rejected; a deliberately advanced target fence returned `stale-target` and durably rejected its advisory. Work order `work-gas-proof-e5fb7d7b-7d8f-4529-bc53-0f463daa7492` was persisted with a simulated notification failure and later consumed without a POST by `gasSafetyWake`, with a real GAS checkpoint and one evidence reference.

## Interactive takeover

The next milestone adds reverse GAS-to-OpenCode continuity without making GAS a
queue or continuation authority. `discoverResumableWork({workOrderId, project})`
queries the Postgres coordination ledger directly and is strictly read-only. It
returns one bounded classification (`missing`, `unavailable`, `active`,
`completed`, `continuation-invalid`, or `resumable`) plus identifiers, decimal
fence, lease time, checkpoint/evidence/repository digests, Observer lineage IDs,
and the bounded next operation. It returns no raw checkpoint, repository object,
event payload, task body, prompt, transcript, credential, or evidence content.
Repeated discovery does not acquire a claim, advance a fence, insert an event,
or consume a continuation.

`takeoverResumableWork(...)` is separate and explicit. In one transaction it
locks the logical work order, verifies the project, handles a stable takeover ID
idempotently, rejects any live mutation lease, validates the discovered
continuation ID and fence, compares the expected repository state before any
mutation, advances the work-order fence, creates a fresh
`opencode-local`/`foreground` physical execution, records an
`interactive-takeover` handoff and event, and returns only the bounded semantic
continuation reference. The previous GAS execution is never reused as foreground
authority. Terminal work is reported as completed and is not reopened. An
expired GAS execution is eligible only when its canonical GAS checkpoint and
continuation metadata are internally consistent.

Migration `009_interactive_takeover_safety` preserves the existing schema but
replaces the GAS take/checkpoint functions. It treats a null prior GAS lease as
expired when checking for a competing foreground owner, omits the Google JWT
subject from new events, and records a database-recomputable canonical JSONB
checkpoint digest so later discovery detects checkpoint mutation. Migration
`010_gas_checkpoint_release` atomically marks a successfully checkpointed GAS
execution deferred and clears its lease after consuming the advisory; completed
background work therefore becomes discoverable without stealing an active claim
or waiting for lease expiry. Migration `011_superseded_gas_advisory` requires
the target execution and work-order fence to remain current, so an advisory
cannot revive superseded GAS authority after a later foreground lease expires.
Applied migrations 005-008 remain unchanged. The stable takeover ID uses the existing
handoff primary key and the new foreground execution uses the existing execution
identity and per-work-order fence counter. GAS still exposes only
pending/take/checkpoint RPCs; safety-wake and interactive takeover serialize
through the same authoritative work-order and live-claim checks. Local adversarial tests cover read-only repeated discovery,
project scoping, live and expired GAS leases, completed and corrupted
continuations, stale fences, repository drift, duplicate and concurrent
takeovers, and a stale GAS wake after foreground takeover.

## Interactive takeover acceptance

Bidirectional continuity was accepted live on 2026-09-01 with GAS deployment
version 38 and production migrations 1-11. Work order
`work-interactive-ff5a1806-12dc-4211-b550-f55d378c9691` preserved one logical
identity across:

- OpenCode A: `opencode-a-ff5a1806-12dc-4211-b550-f55d378c9691`, fence 1;
- GAS B: `exec-23ed0fca-5826-47f8-9299-880aab462ae2`, fence 2, local physical
  execution `physical-execution_8d4152eb4e7127db2a8f3b8171997ed8`;
- OpenCode C: `opencode-c-ff5a1806-12dc-4211-b550-f55d378c9691`, fence 3.

The canonical continuation was
`federation-nonce-ff5a1806-12dc-4211-b550-f55d378c9691`; the forward handoff was
`handoff-gas-ff5a1806-12dc-4211-b550-f55d378c9691`; and the explicit reverse
takeover was `takeover-opencode-ff5a1806-12dc-4211-b550-f55d378c9691`.
Discovery returned `resumable` twice with identical bounded output while the
work-order fence and event count remained unchanged. Takeover verified repository
digest `4eba8da33ea56cf47f709e427bf262f90c71537300bda0ffaaec1ede5a95c2bd`,
created the fresh foreground execution, and committed one bounded reconstructed
checkpoint. Observer returned the three physical executions plus `claimed`,
`checkpointed`, `gas-taken`, `gas-checkpointed`, and
`interactive-takeover` events under the same work order, with no JWT subject in
the projection.

After takeover, advisory
`stale-ff5a1806-12dc-4211-b550-f55d378c9691` was persisted without notification.
The recurring `gasSafetyWake` later marked it `rejected`; GAS B retained its null
lease and fence 2 while OpenCode C remained live at fence 3. This establishes
notification-independent discovery and safety-wake non-conflict. Bidirectional
OpenCode <-> GAS continuity is proven for this bounded federation contract. It
does not claim arbitrary compute, automatic reopening of completed work, or
production-scale availability.

Migration 011 was separately verified in a rolled-back branch transaction with
the foreground fence-3 lease already expired and a pending fence-2 GAS advisory.
The take returned `stale-target`; GAS retained fence 2 and a null lease. This
covers delayed polling after foreground expiry, not only the live-lease race.
