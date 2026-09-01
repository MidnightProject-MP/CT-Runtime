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

Legacy compatibility is deliberately one-way: evidence and inline Observer records created before this pipeline remain historical records and are not copied into `observer/inbox`. Only a newly exported inbox package is pending. Thus adding the inbox mechanism cannot re-observe an already observed legacy execution.

> **Execution is responsible for leaving trustworthy evidence. Observer is responsible for deciding what that evidence means.**
