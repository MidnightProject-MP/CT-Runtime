# vNext Runbook

This runbook covers the supported Node/PostgreSQL/OpenCode pilot. Image, CI, host, and deployment gates described here are instructions, not evidence that they have run. Keep those gates marked unverified until the corresponding CI job or deployment output exists. The optional GAS/email path remains separate and is not selected by this runbook.

## Initial setup

1. Build and publish one immutable image digest from GitHub Actions, or install the reviewed Node 22–24 source on the selected host.
2. Provision standard PostgreSQL and the least-privilege runtime roles. Keep migration, runtime, and authority credentials outside the worker environment and source.
3. Install the code at `/opt/CT-Runtime`, the approved project checkout at its own path, and the authoritative identity files outside the runtime checkout.
4. Copy `examples/vnext-pilot.config.json` or `examples/vnext-pilot-multi.config.json` to `/etc/celestan/pilot.json` and replace all paths, authority module, executor, model/agent, and permission values. Keep `enabled` and `legacyExcluded` false during qualification.
5. Configure `CT_PILOT_DATABASE_URL` and the authority settings in `/etc/celestan/pilot.env`, readable only by the runtime account. Do not expose database credentials to the worker.
6. Apply the vNext schema with `node bin/vnext-pilot.mjs migrate --config /etc/celestan/pilot.json`. Normal operation never applies migrations.
7. Verify the durable view with `node bin/vnext-pilot.mjs status --config /etc/celestan/pilot.json` and `inspect`. After the remaining qualification gates pass, set both `enabled` and `legacyExcluded` to `true` in `/etc/celestan/pilot.json` before running the first bounded `tick`.

The two configuration booleans are operator assertions, not proof that legacy admission is excluded. Both must be `true` after qualification and before the first `tick`. Before the first tick, inspect the selected target for competing legacy writers and in-flight effects; this fresh-launch check does not require a legacy cutover or migration exercise. Establish the real schema/grants, worker availability, authority, and exact release before enabling the pilot.

## Routine operation

The systemd timer invokes one bounded pass:

```sh
node bin/vnext-pilot.mjs tick --config /etc/celestan/pilot.json
```

Use `node bin/vnext-pilot.mjs run --config /etc/celestan/pilot.json` only when a long-running loop with a shorter scan interval is wanted. The timer's repeated `tick` has the same pass semantics. `pause` prevents the next pass from admitting work without interrupting a live worker; `resume` restores admission.

Use `submit` for human input, `status` and `inspect` for the durable operator view, and `accept`, `cancel`, `reconcile`, or `decide-assignment` only through their guarded decision inputs. `cancel` requires an authorized cancellation decision and current work revision. `reconcile` requires an exact decision document containing `ref`, `project_id`, `work_unit_id`, `execution_id`, `fence`, and `resolution` (`no_effect` or `effect_applied`). These commands are operator surfaces, not evidence that an external effect occurred.

Deploy the supplied `deploy/vnext-pilot.service` and `deploy/vnext-pilot.timer` with the actual user and paths, then enable the timer through the host's normal procedure. The timer is not installed by this package. Match `TimeoutStartSec` to the configured worker timeout plus settlement margin. A second coordinator is safe only when it shares the same database and durable pool policy; qualify that topology explicitly.

## Incident handling

If a worker loses its fence, its child must be terminated and its terminal write must be rejected. Do not rerun effects based on a guessed outcome. A later `tick` or `run` performs dispatch recovery from durable state; an ambiguous settlement remains in review or reconciliation rather than becoming a fabricated success.

Inspect `status` or `inspect`, the exact attempt request/result/evidence files, and the external project before resolving uncertainty. `reconcile` is an explicit decision-bound resolution, not an unguarded force-unlock. `cancel` requires a durable authorized intent; do not treat killing a process as proof of cancellation. Reconcile external evidence or artifact records that lack durable references before deleting anything.

### GAS feedback deployment

Before repeating a GAS external effect, inspect reality first: run `diagnoseFeedbackInbox` and confirm the returned Script ID plus configured feedback spreadsheet property. Only run `configureFeedbackInbox` or `setupFeedbackSheet` on observed mismatch. Deployment identity, execution authority, and sheet ownership are separate boundaries; a green `clasp` process exit is not proof of success without the expected semantic payload. Stale local GAS branches are a known deployment-source hazard; branch retirement is a separate cleanup operation.

## Human blockers

Database, bucket, network, secret-management, authority-module, image-signing, retention, model-provider, host, and production Git access require external authorization and credentials. Local syntax and unit checks do not satisfy those gates.
