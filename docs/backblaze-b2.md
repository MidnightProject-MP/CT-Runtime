# Backblaze B2 binding

`evidence_store` remains bound to the provider-neutral `s3` adapter. Backblaze B2 is the active provider binding, not a new adapter.

The adapter uses deterministic content-addressed keys and baseline S3 `GET`, `PUT`, `HEAD`, and `LIST` operations. It prefers atomic `If-None-Match: *` writes on providers that support them, without optional explicit checksum headers. B2 explicitly rejects that conditional header, so only its fallback uses a bounded preflight `GET`, unconditional `PUT`, and bounded readback with SHA-256, length, content-type, and protected-metadata verification. The fallback recheck prevents an observed conflict from being overwritten, but remains non-atomic against a competing writer.

## Non-secret configuration

- Bucket: `ct-runtime-evidence`
- Endpoint: `https://s3.us-east-005.backblazeb2.com`
- Region: `us-east-005`
- Path style: `false`
- Runtime names: `CT_RUNTIME_S3_BUCKET`, `CT_RUNTIME_S3_ENDPOINT`, `CT_RUNTIME_S3_REGION`, and `CT_RUNTIME_S3_PATH_STYLE`
- Credentials: a bucket-scoped B2 application key with read/write access, supplied only through the existing `CT_RUNTIME_S3_ACCESS_KEY_ID` and `CT_RUNTIME_S3_SECRET_ACCESS_KEY` secret names

## Acceptance evidence

The binding was accepted on 2026-08-30 after all external checks passed against the configuration above:

1. S3 adapter conformance comprised 12 deterministic adapter tests plus one real B2 integration test. The real test covered write, bounded readback verification, idempotency, listing, and cleanup deletion; cleanup completed, but absence was not separately re-listed afterward.
2. Production startup health: `npm run doctor` reported the real PostgreSQL and B2 bindings reachable, migrations `1,2,3,4` current, and `healthy: true`.
3. Production reconstruction: `npm run reconstruct` reported `status: reconstructed`, the current schema, and a clean ephemeral workspace.
4. Regression suite: `npm test` passed 49 tests with 3 external-provider integration tests skipped and no failures. B2 ran separately through the explicit conformance gate above.

Reconstruction found zero canonical evidence references, so it established production continuity and B2 reachability but did not need to validate existing evidence objects. A future reconstruction with canonical references remains the evidence gate for cross-provider object continuity.

External conformance is explicitly opted in from PowerShell with `$env:CT_RUNTIME_S3_CONFORMANCE='true'; npm run test:s3`. Without that exact opt-in, `CT_RUNTIME_S3_*` is ignored by the test; CI continues to opt in through `TEST_S3_*`. The production commands also require database and provenance variables. No credential values belong in commands, logs, test fixtures, or this repository.
