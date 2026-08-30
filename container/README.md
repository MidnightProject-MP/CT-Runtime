# Container Contract

The image is a one-shot job image. It contains `/app/lib`, `/app/bin`, `/app/migrations`, production dependencies, and exactly the pinned Foundry `capabilities/observer/observer.mjs` and `schema.mjs` sources. It contains no credentials, identity, Foundry root state/docs/tests, mutable runtime state, or local runtime store. Production requires `CT_RUNTIME_MODE=production`; PostgreSQL and S3 failures never fall back to filesystem storage.

OpenCode is pinned to `1.18.25`. BuildKit selects and verifies `opencode-linux-x64` for `linux/amd64` or `opencode-linux-arm64` for `linux/arm64`, and the final image exposes `/usr/local/bin/opencode`.

The image runs as UID/GID 10001. `/app` is owned by root without write bits and production should also use a read-only root filesystem. The entrypoint creates `HOME`, XDG, temporary, result, and workspace directories beneath the mounted `/tmp`; do not mount a narrower hidden directory from an image layer. Use `--tmpfs /tmp:rw,nosuid,nodev,size=128m` or the platform equivalent.

## Foundry Pin Sequence

The Dockerfile default is the last committed Foundry source. The current Observer correction is still uncommitted in CT-Foundry, so it cannot be fetched by a reproducible remote build yet.

1. Commit and push the Foundry correction first.
2. Build CI with `FOUNDRY_COMMIT=<new 40-character commit>` as a repository variable or `--build-arg FOUNDRY_COMMIT=<commit>`.
3. Verify the image gates.
4. Update the Dockerfile fallback pin in CT-Runtime in a later reviewed change.

CI fetches only the two pinned raw source paths. It never clones or copies the Foundry root.
