# GAS repository access — first audit capability

Status: local implementation candidate; not deployed or live-qualified.

## Scope and inventory

The owner delegates CT repositories to Celestan. GitHub inventory on 2026-10-28
found these repositories under `MidnightProject-MP`:

| Repository | Role, verified from repository metadata/README |
|---|---|
| `CT-Runtime` | Execution mechanics; selected GAS email loop |
| `CT-Foundry` | Capability discovery, evaluation, acquisition, tests and registry |
| `CT-SuperSimpleGames` | Mobile-first, no-fail toddler experiences; product-owned intent |

`Celestan` is a separate private identity repository, not a CT-prefixed repository.
The current runtime tool does not read it or other non-CT repositories. The owner
scope is implemented as `MidnightProject-MP/CT-*`, so new CT repositories do not
require another code allowlist entry. Repository content never grants authority
to add another owner, expose credentials, execute code, or change runtime policy.

Foundry's existing repo-state inspector is a local Node capability. The selected
GAS loop needs direct HTTP reads instead of a local filesystem or Node host.
The legacy `gas_github.js` adapter combines read/write methods, binds one repository,
depends on the legacy clock, and truncates JSON before parsing. This candidate
adds a small read-only adapter rather than exposing that write surface to the model.

## Implemented contract

`gas_repository_read.js` exposes one tool, `repository_read`, with four operations:

- `catalog`: lists visible CT repositories in upstream pages of 100; returns
  `nextPage`, `possiblyMore`, and an explicit credential-visibility limitation.
- `resolve`: resolves an exact branch name (default `main`) to a full 40-character
  commit SHA. Direct tree/file reads verify the SHA with the commits API unless
  already resolved in this invocation; a tree/blob SHA is not commit provenance.
- `tree`: requires a full commit SHA, returns 50 entries per offset, reports both
  remaining local entries and GitHub's `truncated` flag. This recursive endpoint
  can exceed the response limit; an oversized tree is unavailable, never complete.
- `file`: requires a full commit SHA and repository-relative path; returns up to
  80 lines / 12,000 characters with blob SHA, line range, `nextLine`, and completeness.
  Files above 120,000 bytes, non-UTF-8/binary content, and single lines exceeding
  the range bound are explicitly unavailable.

All HTTP calls are GETs to fixed GitHub API routes. Redirects are refused; unknown
operations, extra arguments, mutable file refs, traversal, and other repositories
are rejected before HTTP. Responses above 250,000 characters fail explicitly,
rather than parsing a truncated prefix. No source is evaluated.

The email loop permits six sequential tool calls (at most twelve GitHub requests
including commit checks) and at most seven model calls
per claimed turn. The existing wall-clock deadline applies throughout, with time
reserved for synthesis and checkpointing. Provider tool-call support is required;
an unsupported/malformed response follows the existing model-failure path. There
is no retry that silently switches to a different model or execution host.

Tool results are untrusted context. Successful commit-pinned references are
appended by the runtime to the final artifact, within its existing 3,000-character
and total 15,900-byte contract. They reach the existing durable checkpoint and
next-turn `previous` input; they are read receipts, not terminal acceptance.
The runtime does not separately persist fetched source or intermediate tool
conversations; the bounded final result can quote relevant excerpts. A crash
before checkpoint can repeat read-only requests; it does not create a second
write path. The model must preserve useful findings and remaining work in its
bounded summary. This is not a complete durable source cache or unlimited audit.

## Credentials and commissioning

The adapter uses the existing `GITHUB_TOKEN` Script Property; its presence and
access have not been established in production. Provision metadata/contents read
access for the intended CT repositories and authenticated `/user/repos` listing,
not write permission merely for this capability. Known GitHub and OpenRouter secret values are redacted from intake
bodies, tool/model context, and checkpoint output; secret-bearing intake subject
or Message-ID fields are quarantined. Provider failures return fixed classifications,
not raw response bodies or tokens.

Before live use, verify the exact model supports tool calls and qualify read
access against the intended repositories in the isolated GAS environment. Test a
real commit-pinned read, a missing credential, an out-of-scope repository, partial
results, a bounded continuation, and checkpoint evidence survival. Use the
[release authority contract](GAS-DEPLOYMENT.md) for deployment and record the
exact bundle and target. Local VM tests do not establish this live qualification.

## Remaining path to the owner's intended autonomy

The read capability supports the first #118 implementation-gap audit; it is not
the finished autonomous system. The existing three-attempt continuation limit
and bounded result may constrain that audit, so do not claim it can inspect every
repository exhaustively in one input. Repository writes, test/workflow execution,
durable larger evidence, the substantive acceptance caller, and autonomous release
qualification remain distinct implementation/commissioning gaps. Reuse existing
mechanisms where their authority and durability contracts fit. The owner's human
approval is for bootstrap; routine commissioned in-scope work should use Celestan's
standing mandate instead of requiring permanent human approvals.

## Current observed deployment

Readback run [40736943649](https://github.com/MidnightProject-MP/CT-Runtime/actions/runs/40736943649)
on 2026-10-28 succeeded from main `49c1c8f` after the owner reset the endpoint
secret. HEAD and LIVE V108 both reported:

`274b6e353ede472ead96dc9085ab07811402b54af57c5877130b68b177929af2`

That exactly matches the 24-file artifact built/deployed from `6839783` in
[run 38307713234](https://github.com/MidnightProject-MP/CT-Runtime/actions/runs/38307713234).
The unmodified `49c1c8f` source builds a different 25-file artifact:

`1839067c009d4bc2ffc47a1b9783051095b8b496be5bbe5c929500708b5a5467`

Neither hash identifies this repository-access candidate. Its new artifact must
be built and qualified separately. Source readback does not establish database
migration state. Owner diagnostics confirmed a pause, matching preparation
configuration, Gmail profile/label, Neon health, and one installed tick trigger.
They did not qualify the current candidate or prove historical send activity.

## Local verification — 2026-10-28

Tested the dirty worktree on `feat/gas-repository-audit-access`, based on
`49c1c8f1a263c228ba7c2991f373d33beb95d605`, using Windows Node `v24.19.0`:

```powershell
node --test test/gas-repository-read.test.mjs test/gas-email-model-diagnostics.test.mjs test/gas-email-target.test.mjs test/gas-bundle-builder.test.mjs test/gas-load-order.test.mjs test/gas-deploy-contract.test.mjs test/gas-deploy-state-machine.test.mjs test/gas-deploy-readback.test.mjs test/gas-release-gate.test.mjs
```

Result: **49 passed, 0 failed, 0 skipped**. These are mocked HTTP/GAS and local
contract tests, not native PostgreSQL or live GAS/provider qualification. The
new tests exercise actual email tick/tool/checkpoint wiring, source references,
scope enforcement, missing credentials, pagination, large responses, commit object
validation, time/tool bounds, and credential redaction (including JSON escapes).

The local 26-file candidate bundle hashes to
`88e695eba90c8ea4371ab3c2e3d4afab33a9045811c678f4792d775f3acd6908`.
This is a working-tree artifact, not a committed or approved release tuple.
