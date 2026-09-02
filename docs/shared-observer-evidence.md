# Shared Observer Evidence Pipeline

**Every execution body emits evidence. Observer consumes evidence.**

OpenCode, GAS, containers, workers, and reviewers produce bounded factual packages using `celestan-execution-evidence-v1`. Exporters allowlist fields, redact credential-shaped values, and attach an evidence ID, physical execution ID, provenance, and SHA-256 content hash. Exporters do not grade models or create learning.

The prototype GAS adapter stores accepted packages under the existing Drive root:

```text
observer/
  inbox/
  processed/
  quarantine/
  chronicle/
```

`gasSafetyWake` consumes a bounded inbox batch. It validates schema, bounds, and hash; quarantines malformed packages factually; and records an `observer_processing` index keyed by `evidenceId + hash`. The index makes duplicate delivery and recovery after an observation append idempotent. Semantic inference is a GAS-owned dependency and may defer without losing evidence. Backlog is expected and is exposed as a count.

Execution Federation remains the authority for claims, fencing, handoffs, and continuation. Drive is only the prototype Observer transport and evidence store, not a coordination database. OpenCode does not run semantic Observer analysis.

Legacy compatibility is deliberately one-way: evidence and inline Observer records created before this pipeline remain historical records and are not copied into `observer/inbox`. Legacy GAS reasoning artifacts receive content-addressed classifications with a safe structural projection, but the full artifact is semantically ineligible. Sanitized historical OpenCode structure may join a separately validated semantic claim envelope; without one it is `semantic-evidence-insufficient`. Rich extraction remains recovery-only regardless of envelope presence and never enters normal semantic inference.

> **Execution is responsible for leaving trustworthy evidence. Observer is responsible for deciding what that evidence means.**

## Claim-level semantic evidence (Stage 1)

The core rule is: **a claim is not evidence until it is bounded, linked to its supporting sources, and assigned an honest source classification**. Runtime accepts `celestan-semantic-evidence-envelope-v1` envelopes without embedding them in result handoffs or raw evidence. Source classifications are `operator-supplied`, `execution-reported`, `mechanically-verified`, `independently-reviewed`, `runtime-observed`, and `provider-reported`; they describe provenance, not confidence. Agent drafts contain only `sources` and `claims`, with no transcript or reasoning, and invalid drafts fall back to the minimal execution-reported handoff envelope.

Observer seals an immutable `celestan-observer-evidence-join-v1` between the structural digest and a validated claim envelope before creating a semantic task. Structural context has no semantic authority by itself. Semantic output must cite the join binding hash and admitted claim IDs; records without a join terminate as `semantic-evidence-insufficient` and are excluded from consolidation and Chronicle narratives.
