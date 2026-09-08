# CT-Runtime

CT-Runtime owns execution mechanics only. Celestan owns judgment, task meaning, stopping decisions, and `requested_next_wake`; Observer owns reflection and semantic interpretation.

Keep runtime state outside the repository. Use explicit `--store`, `--project`, `--model`, `--agent`, and `--task` values. Never persist environment secret values or raw process output in manifests, events, telemetry, or Observer records.

## GAS deployment authority

Canonical GAS writes happen only through GitHub Actions (`gas-clasp-deploy.yml` on push to `main` or dispatch; `gas-feedback-repair.yml` dispatch-only, never pushes). No supported workflow or documented operator path performs a local `clasp push`. Before repeating an external effect, inspect reality first via `diagnoseFeedbackInbox` (Script ID plus configured spreadsheet property) and only then configure or set up on observed mismatch.

## Reviewer freshness

Before closing a task as blocked or choosing the next action, re-check the newest evidence: are the blocker and next action still true against the latest workflow run, sheet state, and Script Properties?
