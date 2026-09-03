# CT-Runtime Schemas

- `celestan-runtime-manifest-v1`: execution identity, caller topology, lifecycle status, bounded evidence references, Observer lifecycle, and validated result handoff.
- `celestan-runtime-event-v1`: append-only lifecycle facts with bounded safe fields; raw stdout/stderr is never included.
- `celestan-runtime-telemetry-v1`: append-only process facts with bounded per-attempt and cumulative stdout/stderr/chunk counters. Raw stream content is never included.
- `celestan-runtime-schedule-v1`: digest-idempotent `{time, reason, priority, project}` wake plus caller launch configuration and durable `pending|claimed|completed` state.
- `celestan-work-unit-convergence-v1`: optional Work Unit branch, PR head-SHA subject, intent/check implementation binding, deterministic check identity, three-state reconciliation, and merged-commit recording; immutability and attempt semantics remain a hardening gate.
- `gas-runtime-revision-v2`: fixed-sheet append-only revisions with deterministic latest-valid reconstruction, bounded payloads, and fenced wake claims.

The strict Celestan handoff has exactly `{status, summary, requested_next_wake}`. Status is `complete`, `continue`, or `failed`; summary is bounded; `requested_next_wake` is `null` or exactly `{time, reason, priority, project}`. Unknown keys and supplied secret values are rejected.

Topology is `{rootId,parentId,childIds}`. A parent and non-local root must already exist, self-links and cycles are rejected, and a child is linked to its parent under serialized manifest locks. Manifest creation and updates use serialized read-modify-write operations so concurrent claims do not overwrite each other.

Raw stdout/stderr evidence is redacted, capped at 64 KiB per stream, fsynced before manifest reference, and exposed through safe retrievable file URIs with SHA-256 metadata. Evidence and all runtime records remain in the caller-selected store indefinitely; retention is an external supervisor responsibility.

The GAS mapping is provider metadata in Node, not a local callable implementation. GAS Sheets map to Postgres runtime records and Drive references map to S3 object metadata; `general_compute` is intentionally missing.
