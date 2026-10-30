# CT-Runtime

CT-Runtime owns execution mechanics only. Celestan owns judgment, task meaning, stopping decisions, and `requested_next_wake`; Observer owns reflection and semantic interpretation.

The selected vNext execution path is the GAS-hosted email loop in `gas/gas_vnext_email.js` with `deploy/gas-email/`. GAS is the only execution host for that path. The Node/PostgreSQL/OpenCode pilot is a separate experimental path, not the selected first launch. See `docs/VNEXT-GAS-EMAIL.md` and `docs/VNEXT-GAS-PILOT-COMMISSIONING.md`.

Keep runtime state outside the repository. Use explicit `--store`, `--project`, `--model`, `--agent`, and `--task` values. Never persist environment secret values or raw process output in manifests, events, telemetry, or Observer records.

## GAS deployment authority

Canonical GAS release writes happen only through manually dispatched, hash-pinned GitHub Actions (`gas-self-deploy.yml`). Main pushes do not deploy. Legacy clasp push/deploy workflows are retired and fail closed. No supported workflow or documented operator path performs a local `clasp push`. Before repeating an external effect, inspect reality first via `diagnoseFeedbackInbox` (Script ID plus configured spreadsheet property) and only then configure or set up on observed mismatch.

The isolated sandbox uses `gas-sandbox-self-deploy.yml`. Its initial empty-project bootstrap is the narrowly scoped `gas-sandbox-bootstrap.yml`: exact tag/commit/hash/owner approval, a durable one-use request reservation, Google OAuth API installation only into the newly created non-production project, and readback. It cannot update an existing project or retry an uncertain write. HMAC self-deployment takes over after owner consent and sandbox Script Property setup. No local source upload is permitted.

Before every GitHub write verify `gh api user` is `MidnightProject-MP`. Do not change git identity/configuration, force-push, or amend user commits.

## Reviewer freshness

Before closing a task as blocked or choosing the next action, re-check the newest evidence: are the blocker and next action still true against the latest workflow run, sheet state, and Script Properties?

## Local Linux/PostgreSQL verification (Windows host)

Use the existing Ubuntu-24.04 WSL workspace at `/home/philippecave/CT-Runtime-local-tests`. Its Git origin points to the Windows repository; inspect the remote and worktree before synchronizing. Preserve uncommitted work. For final evidence, test an exact local commit fetched from that repository; pushing to GitHub is not required before local testing. Do not manually copy selected source files and report the resulting mixed tree as a clean commit.

Invoke WSL commands directly with `wsl --cd` and the absolute Linux Node executable. Do not embed `cd /home/...` or source NVM in `bash -lc`: Windows permission parsing can misinterpret Linux paths as `C:\home\...`. Do not request broad home-directory permission to work around that parsing.

```powershell
wsl -d Ubuntu-24.04 --cd /home/philippecave/CT-Runtime-local-tests -- git status --short
wsl -d Ubuntu-24.04 --cd /home/philippecave/CT-Runtime-local-tests -- env POSTGRES_URL=<local-test-database-url> /home/philippecave/.nvm/versions/node/v22.14.0/bin/node scripts/verify.mjs targeted test/vnext-cancellation.integration.test.mjs
```

The database URL above is a placeholder; supply the local disposable test connection at invocation, not production credentials. Keep Node aligned with CI if its pinned version changes.

- Prefer one `verify.mjs targeted <suite...>` invocation for the affected native PostgreSQL suites. Use `verify.mjs core` when broader verification is warranted; do not repeat full suites or stress runs without a change, failure, or unresolved concern that justifies them.
- Do not create additional home-directory clones, transfer patches through Windows user-temp directories, or symlink another checkout's `node_modules` as the routine test workflow. If a separate checkout is necessary, state why and use an explicitly scoped test location. Install dependencies in Linux for that checkout.
- Check WSL/PostgreSQL availability before testing. Connection refusal or WSL startup failure is an environment failure, not a test assertion failure. Preserve completed results and resume outstanding checks on unchanged source after recovery; do not treat retries as resolution of an unexplained failure.
- Report the tested commit, dirty-worktree status, executed suites, failures, and skips. Required native PostgreSQL coverage must execute rather than silently skip. Use the shared verifier where supported; do not broaden its suite allowlist merely to label unsupported coverage as passed.
