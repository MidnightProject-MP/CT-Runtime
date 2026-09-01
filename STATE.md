# CT-Runtime State

CT-Runtime is an experimental single-machine V1. It carries no production claim.

State is caller-owned and lives under the selected `--store`: manifests, leases, lock files, schedules, bounded raw evidence, result handoffs, events, telemetry, and the Observer bridge directory. Files are retained indefinitely unless the external supervisor applies its own reviewed retention policy.

The external supervisor supplies model, agent, bootstrap task, cwd, executable, timeout/retry bounds, and Observer path. Task Scheduler may invoke the one-shot `scheduler` command and periodically invoke `recover` and `observe-pending`.

The configured current prototype binding is Northflank for `disposable_compute` and `scheduler`, using the existing immutable CT-Runtime image, Neon durable state, and Backblaze B2 evidence store. Northflank API discovery identified the existing `CT-Runtime` project as `ct-runtime`; it currently has no jobs. Live job/secret permission, project secret-group, image, runtime credential, and model-secret authorization plus fresh-container proof are pending; this is not a verified deployment claim.

The production `evidence_store:s3` binding actively uses Backblaze B2 bucket `ct-runtime-evidence` in `us-east-005` with a bucket-scoped read/write application key. Real-provider S3 conformance, production doctor, reconstruction, and the regression suite passed on 2026-08-30. Reconstruction had zero canonical evidence references, so cross-provider continuity for existing evidence objects remains unexercised. The standard adapter prefers atomic conditional writes and bounded readback verification; B2 rejects the conditional header, so only its rechecked GET/unconditional PUT/GET fallback is non-atomic against a competing writer.

Residual limitations: an external supervisor is required; an Observer semantic provider is not configured by default; OpenCode fields are unavailable unless an adapter supplies them; unsupported topology, task, and orchestration fields are not claimed to survive Foundry projection; and Observer immutable conflict detection remains external.

The isolated `gas/` provider-binding prototype is now present. It uses fixed-sheet/Drive reconstruction, semantic continuation records, cooperative preemption with a bounded configurable safety clock, a serialized single writer, one recurring safety trigger with durable fenced wakes, bounded OpenRouter free-only turns, constrained GitHub/GitHub Actions APIs, and a provider-neutral Chronicle mapping. Duration alone never requests `general_compute`; that remains unavailable and would require an exact capability gap reason. GAS is remote/provider metadata to Node, and Google authorization, deployment-owned storage, Script Properties, workflow allowlisting, and trigger setup remain human-only trust gates.
