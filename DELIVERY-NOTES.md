# Delivery — 2026-09-27

This is the full CT-Runtime source snapshot with the new minimum-loop pilot, not a patch-only archive. Start with `docs/VNEXT-PILOT.md`.

## Baseline and changes

Remote main observed: `b22b605647d21d0143a6b17d377aa7e8016a4f1e`.
PR #63 head incorporated: `ac2ab1531824895646c7fcfa483fa7c826620c91`.
The PR changes include A8 authorization provenance and A9 atomic transitions; they were not assumed to be merged on remote main. The delivery was assembled on an isolated local branch. No remote push or deployment occurred.

New implementation: durable pilot inbox and input watermark; atomic result/continuation scheduling; fresh-process caller; bounded Linux command executor and OpenCode bridge; optional durable learning, evidence and explicit next-wake timestamp; retained evidence bytes; project-scoped authority adapter example; disabled systemd service/timer; local disk-backed proof and SQL integration tests. Direct work is allowed; a mandatory stage/delegation hierarchy is not introduced.

Core fixes made while connecting the path: do not turn uncertain settlement into an asserted failure; verify optional evidence on nonterminal turns; retain new input arriving during completion; disallow expired external-effect takeover on the pilot path.

The selected human interface is the new CLI inbox/status pair. Existing GAS Feedback remains unchanged and is not connected to this new inbox by this delivery. Runtime state and credentials stay outside the repository.

## Verification

- Node v24.19.0, Linux.
- Full `npm test`: **360 tests; 329 pass; 0 fail; 31 skip**.
- New SQL integration suite exercises actual migrations and adapter queries using PGlite/PostgreSQL WASM locally. It can run against native PostgreSQL via TEST_DATABASE_URL, and the CI workflow includes that explicit invocation.
- Command-executor tests verify structured result delivery, no inherited runtime database credentials, timeout rejection, and ordinary descendant-process termination.
- Separate-process disk-backed proof: first invocation continued, second invocation reconstructed the same objective and completed it under a distinct execution ID; a later invocation was quiescent. This is a deterministic fixture, not an autonomous model/project qualification.
- `git diff --check` passed.
- Existing tests requiring native PostgreSQL, S3 or other external service configuration were skipped locally. Native concurrent transactions, actual OpenCode/provider authentication, deployed timer/host restart behavior, GAS/Neon production, legacy exclusion, and the multi-day real-project acceptance test are not claimed as verified.

## Remaining activation work

Configure the real project and identity paths, backend model/agent and credentials, existing execution authority, project acceptance policy and durable host. Verify native DB invariants and actual legacy exclusion; then activate one qualified path and run the multi-day pilot. The scheduler and sample authority grant are deliberately inactive/unconfigured. Automatic backend-specific reconciliation of uncertain external effects is not implemented; such work is durably blocked for evidence-based reconciliation rather than blindly retried.

Do not replace a newer checkout blindly: compare these baseline SHAs and preserve subsequent changes. Install dependencies with `npm ci`. The ZIP excludes `.git`, `node_modules`, credentials, runtime state, and test databases.
