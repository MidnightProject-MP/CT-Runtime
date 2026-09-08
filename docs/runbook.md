# V2 Runbook

Image, CI, Cloud Run, and Oracle gates described here are instructions, not evidence that they have run. Keep those gates marked unverified until the corresponding CI job or deployment output exists.

## Initial setup

1. Build and publish one immutable image digest from GitHub Actions.
2. Provision standard PostgreSQL and an S3-compatible bucket outside this repository.
3. Inject credentials through the platform secret mechanism.
4. Run `node bin/ct-runtime.mjs migrate --database-url URL` using the migration role.
5. Configure `CT_RUNTIME_MODE=production` and the non-secret variables in `deploy/cloud-run-job.env.example`.
6. Run `doctor` and `reconstruct` as one-shot jobs.

Normal production commands never apply migrations. `doctor` verifies PostgreSQL, exact migration versions/checksums, and S3 bucket reachability and exits nonzero on any unhealthy probe. `reconstruct` additionally validates leases, schedules, topology, Observer state, database evidence references against S3 HEAD responses, and deployment/image/config/Git provenance before conflict-checked deployment registration. Its workspace is deleted and recreated under the ephemeral temporary root; no canonical state is written there.

## Routine operation

Run `scheduler` from an external timer, `recover` on a separate bounded cadence, and `observe-pending` after terminal executions. Use `export-observer` for stable JSON export. Never mount a local runtime store in production.

Provider credentials must be named explicitly in `CT_RUNTIME_PROVIDER_SECRET_NAMES`. The production store adds only those values to a claimed schedule in memory and marks them for child redaction. Database URLs, PostgreSQL credentials, S3 credentials, AWS credentials, and secret access keys are rejected from that allowlist and are never placed in schedule records.

## Cloud Run

Set the variables required by `deploy/cloud-run.sh`, then run it with a principal authorized to manage Cloud Run Jobs and Cloud Scheduler. The script creates or updates the job with an immutable image, one task, zero platform retries, bounded CPU/memory/timeout, non-secret environment, Secret Manager bindings, and the image entrypoint's single scheduler argument list. It then creates or updates an authenticated Cloud Scheduler POST to the Cloud Run v2 `jobs:run` URI in the same region.

## Oracle systemd

Install `deploy/oracle-systemd.service.example` as `/etc/systemd/system/ct-runtime-scheduler.service` and the timer as `/etc/systemd/system/ct-runtime-scheduler.timer`. Store `/etc/ct-runtime/runtime.env` as mode `0600`, owned by the host `ctruntime` service account so the Docker CLI can read it. The example pulls the immutable digest on every run, uses a read-only root and `/tmp` tmpfs, and relies on the timer for the next retry after a failed one-shot execution.

Membership in the host `docker` group and access to `/var/run/docker.sock` are effectively root-equivalent. Prefer a separately configured rootless Docker service where practical and adjust the unit's Docker dependency/socket accordingly. A public GHCR package needs no login; a private package requires a prior least-privilege `docker login ghcr.io` for the service account's Docker configuration.

## Incident handling

If a worker loses its fence, its child must be terminated and its terminal write must be rejected. Run `recover`; inspect the immutable crash event and attempt rows. Reconcile S3 objects that lack database references before deleting anything.

### GAS feedback deployment

Before repeating a GAS external effect, inspect reality first: run `diagnoseFeedbackInbox` and confirm the returned Script ID plus configured feedback spreadsheet property. Only run `configureFeedbackInbox` or `setupFeedbackSheet` on observed mismatch. Deployment identity, execution authority, and sheet ownership are separate boundaries; a green `clasp` process exit is not proof of success without the expected semantic payload. Stale local GAS branches are a known deployment-source hazard; branch retirement is a separate cleanup operation.

## Human blockers

Database, bucket, network, secret-management, image-signing, retention, semantic-provider, Cloud Run, Oracle, and production Git access require external authorization and credentials. Local syntax and unit checks do not satisfy those gates.
