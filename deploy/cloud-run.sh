#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}"
: "${REGION:?set REGION}"
: "${JOB_NAME:=ct-runtime-scheduler}"
: "${IMAGE:?set IMAGE to an immutable image digest}"
: "${RUNTIME_SERVICE_ACCOUNT:?set RUNTIME_SERVICE_ACCOUNT}"
: "${SCHEDULER_SERVICE_ACCOUNT:?set SCHEDULER_SERVICE_ACCOUNT}"
: "${MODEL:=openrouter/nvidia/nemotron-3-ultra-550b-a55b:free}"
: "${AGENT:?set AGENT}"
: "${TASK:?set TASK without commas}"
: "${NONSECRET_ENV:?set NONSECRET_ENV to the comma-separated values from cloud-run-job.env.example}"
: "${PROVIDER_SECRET_NAMES:=OPENROUTER_API_KEY}"
: "${PROVIDER_SECRET_BINDINGS:=OPENROUTER_API_KEY=ct-runtime-openrouter-api-key:latest}"

if [[ ! "$IMAGE" =~ @sha256:[a-f0-9]{64}$ ]]; then
  echo "IMAGE must use an immutable sha256 digest" >&2
  exit 2
fi

case ",${PROVIDER_SECRET_NAMES}," in
  *DATABASE*|*POSTGRES*|*S3*|*AWS*|*SECRET_ACCESS_KEY*)
    echo "provider allowlist contains an infrastructure credential" >&2
    exit 2
    ;;
esac

# Runtime job uses ONLY the pooled celestan_runtime credential (least-privilege).
# The owner/migrator direct URL (CT_RUNTIME_DATABASE_MIGRATION_URL) is NEVER set here.
# Local ~/.config/neon/ profile stays on your workstation and is not baked into the image
# (see .dockerignore allowlist — only lib/bin/migrations/container are copied).

if gcloud run jobs describe "$JOB_NAME" --project="$PROJECT_ID" --region="$REGION" >/dev/null 2>&1; then
  operation=update
else
  operation=create
fi

gcloud run jobs "$operation" "$JOB_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --image="$IMAGE" \
  --service-account="$RUNTIME_SERVICE_ACCOUNT" \
  --args="scheduler,--model,${MODEL},--agent,${AGENT},--task,${TASK}" \
  --tasks=1 \
  --parallelism=1 \
  --task-timeout=3600s \
  --max-retries=0 \
  --cpu=1 \
  --memory=1Gi \
  --set-env-vars="${NONSECRET_ENV},CT_RUNTIME_PROVIDER_SECRET_NAMES=${PROVIDER_SECRET_NAMES}" \
  --set-secrets="CT_RUNTIME_DATABASE_URL=ct-runtime-database-url:latest,CT_RUNTIME_S3_ACCESS_KEY_ID=ct-runtime-s3-access-key:latest,CT_RUNTIME_S3_SECRET_ACCESS_KEY=ct-runtime-s3-secret-key:latest,${PROVIDER_SECRET_BINDINGS}"

scheduler_uri="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${JOB_NAME}:run"
if gcloud scheduler jobs describe "$JOB_NAME" --project="$PROJECT_ID" --location="$REGION" >/dev/null 2>&1; then
  scheduler_operation=update
else
  scheduler_operation=create
fi

gcloud scheduler jobs "$scheduler_operation" http "$JOB_NAME" \
  --project="$PROJECT_ID" \
  --location="$REGION" \
  --schedule="*/5 * * * *" \
  --uri="$scheduler_uri" \
  --http-method=POST \
  --oauth-service-account-email="$SCHEDULER_SERVICE_ACCOUNT" \
  --oauth-token-scope=https://www.googleapis.com/auth/cloud-platform
