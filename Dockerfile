FROM node:22.14.0-bookworm-slim AS build
WORKDIR /app
ARG TARGETARCH
ARG FOUNDRY_COMMIT=213143b78486ffd38f3ed01bb9b008ab4fcf97c7
ARG OPENCODE_VERSION=1.18.25
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
RUN case "${TARGETARCH}" in \
      amd64) opencode_package=opencode-linux-x64 ;; \
      arm64) opencode_package=opencode-linux-arm64 ;; \
      *) echo "unsupported target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && npm install --global --omit=optional --no-audit --no-fund "opencode-ai@${OPENCODE_VERSION}" "${opencode_package}@${OPENCODE_VERSION}" \
    && test -x /usr/local/bin/opencode \
    && test -d "/usr/local/lib/node_modules/${opencode_package}" \
    && /usr/local/bin/opencode --version
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && test "$(printf '%s' "${FOUNDRY_COMMIT}" | wc -c)" -eq 40 \
    && mkdir -p /app/ct-foundry/capabilities/observer \
    && curl --fail --silent --show-error --location "https://raw.githubusercontent.com/MidnightProject-MP/CT-Foundry/${FOUNDRY_COMMIT}/capabilities/observer/observer.mjs" --output /app/ct-foundry/capabilities/observer/observer.mjs \
    && curl --fail --silent --show-error --location "https://raw.githubusercontent.com/MidnightProject-MP/CT-Foundry/${FOUNDRY_COMMIT}/capabilities/observer/schema.mjs" --output /app/ct-foundry/capabilities/observer/schema.mjs
COPY lib/ ./lib/
COPY bin/ ./bin/
COPY migrations/ ./migrations/
COPY container/entrypoint.sh ./container/entrypoint.sh

FROM node:22.14.0-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="CT-Runtime" org.opencontainers.image.description="Portable Celestan execution mechanics" org.opencontainers.image.source="https://github.com/MidnightProject-MP/CT-Runtime"
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules/
COPY --from=build /app/lib ./lib/
COPY --from=build /app/bin ./bin/
COPY --from=build /app/migrations ./migrations/
COPY --from=build /app/ct-foundry ./ct-foundry/
COPY --from=build /app/container/entrypoint.sh ./container/entrypoint.sh
COPY --from=build /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=build /usr/local/bin/opencode /usr/local/bin/opencode
RUN groupadd --gid 10001 ctruntime \
    && useradd --uid 10001 --gid 10001 --home-dir /tmp/ct-runtime/home --no-create-home --shell /usr/sbin/nologin ctruntime \
    && chmod 0555 /app/container/entrypoint.sh /usr/local/bin/opencode \
    && chown -R root:root /app /usr/local/lib/node_modules /usr/local/bin/opencode \
    && chmod -R a-w /app /usr/local/lib/node_modules
USER ctruntime
ENV PATH=/usr/local/bin:$PATH \
    TMPDIR=/tmp/ct-runtime/tmp \
    HOME=/tmp/ct-runtime/home \
    XDG_CONFIG_HOME=/tmp/ct-runtime/xdg/config \
    XDG_CACHE_HOME=/tmp/ct-runtime/xdg/cache \
    XDG_DATA_HOME=/tmp/ct-runtime/xdg/data \
    NODE_ENV=production
ENV CT_RUNTIME_OBSERVER_MODULE=/app/ct-foundry/capabilities/observer/observer.mjs
ENTRYPOINT ["/app/container/entrypoint.sh"]
