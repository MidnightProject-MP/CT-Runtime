# Northflank Prototype Binding

Northflank is the configured prototype provider for both `disposable_compute` and `scheduler`. The adapter uses the official Northflank Jobs API model (`https://api.northflank.com/v1`) through native `fetch`; the CLI/API are provider configuration surfaces, not CT-Runtime state stores.

## Required secure variables

Provide these to the deployment or secure supervisor by name only; never put their values in bindings, payloads, manifests, or logs:

- `CT_RUNTIME_NORTHFLANK_API_TOKEN`
- `CT_RUNTIME_NORTHFLANK_PROJECT_ID`
- `CT_RUNTIME_NORTHFLANK_SECRET_GROUP_IDS` (IDs only, for adapter configuration)
- `CT_RUNTIME_DATABASE_URL`
- `CT_RUNTIME_S3_ACCESS_KEY_ID`
- `CT_RUNTIME_S3_SECRET_ACCESS_KEY`
- Any explicitly declared model-provider secret names in `CT_RUNTIME_PROVIDER_SECRET_NAMES`

The prototype model provider is OpenRouter. The exact runtime secret is `OPENROUTER_API_KEY`. Set `CT_RUNTIME_MODE=production`, `CT_RUNTIME_FREE_ONLY=true`, and a `$0` spend limit. The first unattended requested model is `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`.

The Northflank token is API transport authentication only and is never workload environment. Before creating the job, the project must already contain the named secret-group IDs supplied in `CT_RUNTIME_NORTHFLANK_SECRET_GROUP_IDS`; after creation, Northflank's separate project restriction configuration must restrict those groups to this job. Secret-group IDs are adapter configuration and validation only: they are never included in the create-job body. The adapter exposes `validateSecretGroupRestriction` for that separate setup/verification step; it does not create or update secrets and does not upload secret values. Required runtime names are exactly `CT_RUNTIME_DATABASE_URL`, `CT_RUNTIME_S3_ACCESS_KEY_ID`, `CT_RUNTIME_S3_SECRET_ACCESS_KEY`, plus explicitly declared model-provider names. There are no volumes or local-store environment variables.

## Job settings

Use the existing published CT-Runtime container with an immutable `image@sha256:` reference. The documented payload uses `billing.deploymentPlan`, Docker `configType: default` (preserving the image default entrypoint), external `imagePath`, ephemeral storage, `backoffLimit: 0`, and a bounded `activeDeadlineSeconds`. Scheduled jobs use `settings.cron.schedule`, `suspended: false`, `concurrencyPolicy: forbid`, and `runOnSourceChange: never`. Runtime environment values are non-secret only.

## Fresh-container proof

After human authorization, inspect the Northflank job definition, run it twice, and compare run IDs and startup evidence. Confirm the immutable image digest, fresh container identity, no mounted volumes, Neon durable state, B2 evidence references, bounded logs, and a successful result handoff. Then verify overlap rejection by starting a second scheduled run while the first is active.

## Limitations and acceptance

This is a declarative prototype adapter. It does not call Northflank during tests, does not replace CT-Runtime scheduling or Observer semantics, and does not claim production reliability, billing status, or no-card availability. Current acceptance is pending live token, project, immutable image, and model-secret authorization.
