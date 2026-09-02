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
