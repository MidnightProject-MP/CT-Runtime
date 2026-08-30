#!/usr/bin/env bash
# Explicit deployment/migration authority — separate from runtime wake.
# Uses the direct migrator/owner URL, never the pooled runtime URL.
# Run from your workstation or a one-off privileged Cloud Run job, not from the wake container.
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
: "${REGION:?set REGION}"
: "${IMAGE:?set IMAGE to an immutable sha256 digest}"
: "${MIGRATION_SERVICE_ACCOUNT:?set MIGRATION_SERVICE_ACCOUNT to a deployer SA with secretAccessor on ct-runtime-database-migration-url only}"

if [[ ! "$IMAGE" =~ @sha256:[a-f0-9]{64}$ ]]; then
  echo "IMAGE must use an immutable sha256 digest" >&2
  exit 2
fi

# One-off migration job — do not add to scheduler; run explicitly when image changes.
# Uses the DIRECT migrator credential (celestan_migrator / neondb_owner), not the pooled runtime.
gcloud run jobs create ct-runtime-migrate \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --image="$IMAGE" \
  --service-account="$MIGRATION_SERVICE_ACCOUNT" \
  --args="migrate" \
  --tasks=1 \
  --parallelism=1 \
  --task-timeout=300s \
  --max-retries=0 \
  --set-secrets="CT_RUNTIME_DATABASE_MIGRATION_URL=ct-runtime-database-migration-url:latest" \
  --command="" 2>/dev/null || \
gcloud run jobs update ct-runtime-migrate \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --image="$IMAGE" \
  --set-secrets="CT_RUNTIME_DATABASE_MIGRATION_URL=ct-runtime-database-migration-url:latest"

echo "Run once: gcloud run jobs execute ct-runtime-migrate --project=\$PROJECT_ID --region=\$REGION --wait"
echo "Or locally: npx neon connection-string --project-id falling-bird-38424127 --role-name celestan_migrator --pooled false | xargs -I {} npm run migrate -- --database-url {}"
