# Milestone 3D first-launch qualification

Status: **local offline mechanics passed; not operationally qualified**.

## Candidate and environment

- Tested commit: `7910e44` (`test(vnext): add local first-launch qualification harness`)
- Verification workspace: `/home/philippecave/CT-Runtime-local-tests`, detached at the tested commit with a clean worktree
- Node: `22.14.0` on Linux x64
- PostgreSQL: `16.15` on the local disposable test server
- Host control: WSL systemd user manager
- Worker: deterministic scripted fixture; zero model calls and no external effects
- Database: a fresh temporary database created for this run; a temporary runtime role was non-superuser, could not create databases or roles, and had `rolbypassrls=false`

Command:

```sh
env POSTGRES_URL=<local-disposable-test-database-url> \
  /home/philippecave/.nvm/versions/node/v22.14.0/bin/node \
  scripts/qualify-vnext-first-launch.mjs
```

The harness created and dropped the database and role. Post-run checks found no remaining `ct_first_launch_*` database, `ct_fl_runtime_*` role, or temporary `ct-first-launch-*` user unit link.

## Observed results

- The fresh database applied the repository migration ledger exactly: versions `001`, `002`, `004`–`009`, and `011`–`019`.
- A write probe through the WSL user-namespace read-only executor was blocked. The bounded execution path could write to the project workspace.
- The worker received no `CT_PILOT_DATABASE_URL`, `TEST_DATABASE_URL`, or `POSTGRES_URL`.
- Both pilot booleans remained false through migration, role setup, and permission-boundary checks; the harness set both true in the disposable config immediately before its first bounded `tick`.
- A live worker remained running while the operator pause was installed. The next `tick` returned `paused`; a second submitted Work Unit remained unclaimed and had no assignment while paused.
- After resume, the first Work Unit completed stewardship, execution, and independent review; it reached terminal state with one acceptance receipt and one simulated local artifact effect.
- Resume admitted the second Work Unit. One systemd user-timer service invocation ran the actual `tick` CLI with `OnActiveSec=1s`, `OnUnitInactiveSec=60s`, `AccuracySec=1s`, `TimeoutStartSec=30s`, `KillMode=control-group`, `NoNewPrivileges=yes`, and `UMask=0077`; its execution worker completed.
- The standalone harness exited `PASS`. No other test suites were executed, so suite pass/skip counts do not apply; this is not a `verify.mjs` suite.

## Remaining qualification gaps

- The deterministic local module exercises Runtime's authority interfaces but is not the real Celestan assignment-decision authority.
- The systemd unit ran under the current WSL user, not the target `celestan-runtime` service account or deployment host.
- The read-only mount boundary is proven in this WSL environment only; the selected production host/sandbox has not been qualified.
- Only one timer invocation was observed. Periodic re-trigger behavior, host reboot, and multi-day operation remain unqualified.
- This run did not kill the coordinator after spawn. Retain the separate Milestone 3C crash-recovery evidence for that behavior.
- No production database, real project, live OpenCode worker, GAS effect, or observed legacy-exclusion state was exercised. `enabled` and `legacyExcluded` in this disposable config do not prove live legacy exclusion.
- F2 and F4 remain open independently.

The local result narrows the remaining work; it does not authorize activation or establish operational qualification.

## R3 cleanup follow-up

The standalone harness cleanup was tightened and tested on exact commit `f0bc4a8`.
Three cleanup unit tests passed. The harness now reports operation success and
postcondition verification separately for pools, the temporary database and
runtime role, temporary state, and systemd unit stop/inactive/link-removal checks.
An injected cleanup operation exception and a failed postcondition both produce
a failed qualification result. The `f0bc4a8` run passed with all cleanup outcomes
verified; post-run inspection found no disposable database, runtime role, or
temporary systemd unit links. This remains local cleanup evidence, not target-host
qualification.
