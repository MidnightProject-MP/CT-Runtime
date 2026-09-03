# Inference Management

## Boundary

CT-Runtime treats a model and provider as replaceable execution resources. A
work order owns the logical identity; an inference attempt records the
requested route, observed route, purpose, timing, bounded usage, outcome, and
normalized failure without changing that identity.

The established Node route remains OpenCode invocation. The inference adapter
catalog describes routes and candidates but does not invoke them. Local Ollama
is an unverified candidate until a caller explicitly enables and verifies it.

## Stages

- Stage A records one redacted, bounded normalized record per transport
  attempt. Records are persisted by the filesystem or Postgres store.
- Stage B produces a task-specific shadow recommendation from observed
  evidence, sample size, uncertainty, scarcity, and measured cost. Its
  `executionRoute` is always the established route; it cannot reroute work.
- Later controlled selection stages require an explicit policy change and are
  outside this implementation.

## Future routing signals (consumer only)

Runtime can validate, look up, and apply the narrowly scoped
`celestan-future-routing-signal-v1` advisory signals supplied by Foundry. A
signal has the exact Foundry fields (`schema`, `signalId`, `contentHash`,
`status`, `subject`, `direction`, `proposedEffect`, `scopeLimit`, provenance
IDs, lineage arrays, `supersessionMode`, and `acceptedAt`). Its body is the
recursive key-sorted canonical serialization of every field except
`signalId` and `contentHash`; `contentHash` is SHA-256 of that body and
`signalId` is `rps_` plus its first 32 hex characters.

Validation is fail-closed: unknown fields, malformed IDs or hashes, global or
wildcard subjects/scopes, non-canonical timestamps, incompatible effects and
modes, duplicate IDs, supersession cycles, and dangling `narrow` targets in a
supplied active snapshot are rejected. The supplied `signals` array is itself
the active snapshot; runtime does not accept a separate relationship snapshot.
Matching is exact model × role × task
class, with an optional project. Models must be provider-qualified; a broad
negative therefore applies across projects, while a project-scoped `narrow`
restore only restores that project. `restore`/`replace` snapshots may omit
retired targets, and a positive restore always names superseded IDs.

Negative `lower-preference` signals only move the named route later and retain
it as an eligible route, including when it is the sole route. Positive
`restore-default` signals restore baseline ordering without promotion. Runtime
is a consumer, not an approval authority: artifact authenticity depends on
the trusted Foundry ingestion channel, not on runtime validation alone.

This is a review-only boundary. Runtime does not derive, approve, activate, or
globally blacklist routes from signals. Foundry supplies active signals and
immutable provenance IDs; unknown context and malformed/global signals fail
closed.

## Scarcity

Failures use the exact provider-neutral taxonomy in
`lib/inference-management.mjs`. Retryability is conservative: rate limits,
temporary provider failures, and availability failures may retry; quota,
balance, context, request, and output failures do not. GAS may use a caller-
authorized free fallback only when the eligible model list and free-price
verification permit it. Otherwise it suspends durably until a state change can
make progress possible.

## Observer and Foundry

When terminal executions are observed, normalized attempts are projected into
the Observer model-runtime schema as invocations and failures. This projection
is evidence only: Observer semantic analysis remains separate, and Foundry
signals are not automatically promoted into identity, memory, or policy.

Telemetry excludes credentials, prompts, transcripts, raw provider responses,
and unbounded output. Existing aggregate-only runtime telemetry is treated as
unavailable to the Observer schema rather than misrepresented as invocation
evidence.
