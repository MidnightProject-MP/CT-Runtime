# CT-Runtime

CT-Runtime owns execution mechanics only. Celestan owns judgment, task meaning, stopping decisions, and `requested_next_wake`; Observer owns reflection and semantic interpretation.

Keep runtime state outside the repository. Use explicit `--store`, `--project`, `--model`, `--agent`, and `--task` values. Never persist environment secret values or raw process output in manifests, events, telemetry, or Observer records.

## GAS deployment authority

Canonical GAS release writes happen only through manually dispatched, hash-pinned GitHub Actions (`gas-self-deploy.yml`). Main pushes do not deploy. Legacy clasp push/deploy workflows are retired and fail closed. No supported workflow or documented operator path performs a local `clasp push`. Before repeating an external effect, inspect reality first via `diagnoseFeedbackInbox` (Script ID plus configured spreadsheet property) and only then configure or set up on observed mismatch.

Before every GitHub write verify `gh api user` is `MidnightProject-MP`. Do not change git identity/configuration, force-push, or amend user commits.

## Reviewer freshness

Before closing a task as blocked or choosing the next action, re-check the newest evidence: are the blocker and next action still true against the latest workflow run, sheet state, and Script Properties?
