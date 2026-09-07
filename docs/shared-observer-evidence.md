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

OpenCode backfill queries all local sessions with `opencode db "SELECT id FROM session ORDER BY time_created, id" --format json`, validates and deterministically de-duplicates `ses_` IDs, and continues after unavailable individual exports. Its report separates discovered, attempted, exported, duplicate, unavailable, and skipped-current sessions. Current sanitized evidence is metadata-only and audited fail-closed against a closed extractor-version-2 schema; old sanitized files are immutable history and do not count as current coverage. The optional `semanticEvidenceEnvelope` is independently validated, must have exact session lineage, and persists or reuses only when a durable source resolver supplies bytes whose SHA-256 hashes match every source. Reusable conflicting envelopes and corrupted canonical artifacts are rejected. No transcript or rich export is persisted.

> **Execution is responsible for leaving trustworthy evidence. Observer is responsible for deciding what that evidence means.**

### Reconciliation status (2026-09-07)

The main checkout was fast-forwarded to `00fafc8` and the unique evidence changes were isolated on `feat/opencode-evidence-reconciliation`. Original staged, unstaged, and untracked work is preserved in the named stash `preserve-pre-opencode-evidence-reconciliation-2026-09-07` (`13290cd8e5d073df3eb456e0b23c29ac8121b7a4`). No GAS changes were replayed; no commits or pushes were made during reconciliation.

Retained work is metadata-only extractor v2, all-local-session sanitized discovery/backfill, immutable revisions, and exact-session semantic envelopes whose source bytes are independently hash-checked by a supplied resolver. Canonical hashing retains the legacy ordinal key ordering and now round-trips omitted object values and undefined/sparse array entries. Admission checks cover malformed exports without source-text diagnostics, nested session lineage, closed metadata fields, corrupt canonical files, and preventing silent removal of an attached semantic envelope.

`lib/semantic-recovery.mjs` and `test/semantic-recovery.test.mjs` remain preserved only in the stash's untracked snapshot; their CLI/import/reexport wiring is not admitted. Heuristic objective/review/completion interpretation belongs outside Runtime's mechanics boundary, and campaign concurrency/revision risks remain deferred—not completed. No live OpenCode export/backfill, provider execution, database mutation, or deployment was performed.

Verification: targeted OpenCode suite **29 passed, 0 failed**; full `npm test` **191 tests, 187 passed, 0 failed, 4 skipped**, using the clean Observer/schema files at Foundry CI pin `5bb45fca93394800f533e75150599a54e6aaf96b` through `CT_RUNTIME_OBSERVER_MODULE`. The skipped Neon convergence, PostgreSQL runtime, PostgreSQL Observer, and S3 integration tests were not exercised; live integration remains unverified.

## Claim-level semantic evidence (Stage 1)

The core rule is: **a claim is not evidence until it is bounded, linked to its supporting sources, and assigned an honest source classification**. Runtime accepts `celestan-semantic-evidence-envelope-v1` envelopes without embedding them in result handoffs or raw evidence. Source classifications are `operator-supplied`, `execution-reported`, `mechanically-verified`, `independently-reviewed`, `runtime-observed`, and `provider-reported`; they describe provenance, not confidence. Agent drafts contain only `sources` and `claims`, with no transcript or reasoning, and invalid drafts fall back to the minimal execution-reported handoff envelope.

Observer seals an immutable `celestan-observer-evidence-join-v1` between the structural digest and a validated claim envelope before creating a semantic task. Structural context has no semantic authority by itself. Semantic output must cite the join binding hash and admitted claim IDs; records without a join terminate as `semantic-evidence-insufficient` and are excluded from consolidation and Chronicle narratives.
