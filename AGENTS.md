# CT-Runtime

CT-Runtime owns execution mechanics only. Celestan owns judgment, task meaning, stopping decisions, and `requested_next_wake`; Observer owns reflection and semantic interpretation.

Keep runtime state outside the repository. Use explicit `--store`, `--project`, `--model`, `--agent`, and `--task` values. Never persist environment secret values or raw process output in manifests, events, telemetry, or Observer records.

## GAS deployment authority

Canonical GAS writes happen only through GitHub Actions (`gas-clasp-deploy.yml` on push to `main` or dispatch; `gas-feedback-repair.yml` dispatch-only, never pushes). No supported workflow or documented operator path performs a local `clasp push`. Before repeating an external effect, inspect reality first via `diagnoseFeedbackInbox` (Script ID plus configured spreadsheet property) and only then configure or set up on observed mismatch.

## GitHub identity

Always use the `MidnightProject-MP` GitHub account for this project. Before any
GitHub write (including a push or workflow dispatch), verify `gh api user --jq .login`
returns exactly `MidnightProject-MP` under the credentials used for that write.
Never commit secret tokens or change git configuration to select this identity.

## Reviewer freshness

Before closing a task as blocked or choosing the next action, re-check the newest evidence: are the blocker and next action still true against the latest workflow run, sheet state, and Script Properties?
