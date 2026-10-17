# GAS deployment

This is the authoritative operating contract for CT-Runtime's GAS deployment capability. It describes the normal operating model and the break-glass boundary; it is not a history of the deployment work.

## Normal path

```text
review aggregate commit and protect release tag
        ↓
manually dispatch gas-self-deploy.yml at the exact release tag
        ↓
read current LIVE predecessor
        ↓
independent environment review of exact commit, desired hash and predecessor
        ↓
HMAC self-deploy exactly once
        ↓
GAS-native desiredBundleHash
        ↓
HEAD update
        ↓
version creation
        ↓
existing deployment update
        ↓
bounded readback reconciliation
        ↓
HEAD == LIVE == desiredBundleHash
```

A merge to `main` does not deploy. Only the manually dispatched, hash-pinned `gas-self-deploy.yml` release workflow is supported, subject to the reviewed release gate below. Independent environment approval is a prerequisite, not assumed by this document. Production deployment is serialized by the `gas-production-deploy` concurrency group with cancellation disabled.

## Identity and invariants

- `github_bundle_hash` is **provenance only**. It identifies the bundle produced from the GitHub source; it is not the authoritative identity of the deployed GAS content.
- `desiredBundleHash` is the **GAS-native deployment identity**, computed from the canonical file representation used by the GAS implementation.
- Before mutation, the valid states are:
  - `HEAD == LIVE` for an ordinary deployment; or
  - `HEAD == desired` when recovering an interrupted request whose HEAD update already completed.
- A state where `HEAD` differs from both `LIVE` and `desired` is a conflict. Stop before mutation.
- Successful convergence requires `HEAD == LIVE == desired`.
- If the mutation response is uncertain, perform **readback only**. Never automatically issue the mutation a second time merely because the first response was lost, timed out, redirected unexpectedly, or otherwise failed to prove its result.
- Existing deployment identity is preserved: the stable deployment is updated rather than replaced.

## Boundaries

- The deployment capability is infrastructure. CT-Runtime may invoke it as a reliable GAS deployment capability, but its HMAC protocol, GAS-native hashes, Apps Script versions, ContentService behavior, and reconciliation mechanics are not part of the vNext kernel's conceptual model.
- Legacy clasp push/deploy workflows are retired and fail closed. No supported operator path performs a local `clasp push`, including bootstrap or break-glass recovery.
- The Apps Script Execution API and `clasp run` are **not part of this architecture**.
- Do not add deployment workflow concepts such as GAS versions, deployment pointers, or HMAC request state to the Runtime outer-loop model merely to support this capability.

## Break-glass conditions

Use break-glass handling only when the normal capability cannot safely establish convergence.

| Situation | Action |
| --- | --- |
| Normal GAS-affecting merge | No deployment occurs. Review the aggregate artifact and use the manual, exact-tag/hash release gate. |
| Post-mutation timeout, HTML/redirect anomaly, or otherwise uncertain response | **Read back only**. Do not repeat the mutation automatically. |
| `HEAD == desired`, `LIVE == predecessor` after an interrupted request | Resume/reconcile the existing request through the deployment capability; do not rewrite HEAD unnecessarily. |
| `HEAD != LIVE` and `HEAD != desired` | Stop. Investigate the live/HEAD state before any further mutation. |
| HMAC self-deploy capability itself is broken | Stop release writes and investigate. Repair requires separate review; do not bypass the release gate with retired workflows or local clasp writes. |
| Version capacity is near the Apps Script limit | Perform planned version maintenance before production deployment becomes blocked. |

Break-glass work must preserve the same final invariant: `HEAD == LIVE == desired`.

## Change policy

The deployment control plane is intentionally small. The primary surfaces are:

- `.github/workflows/gas-self-deploy.yml`
- `scripts/deploy-gas.mjs`
- `gas/gas_deploy.js`
- deployment contract/state/readback tests

Before modifying deployment control-plane code, read this document and run the deployment contract tests. Changes must preserve the invariants above, especially single-mutation behavior, recovery/idempotency, bounded readback, GAS-native identity, and production concurrency serialization.


## GAS entry-point qualification boundary

The production bundle must contain exactly one `doPost` entry point. That entry
point delegates at invocation time to the named dispatch and authentication-trace
modules; the federation handler is named separately. Global file evaluation must
not call Apps Script services or mutate configuration. The dispatcher rejects
request bodies over 3 MiB before parsing, hashing, or tracing; federation requests
have a stricter 8 KiB limit. Authentication diagnostics are best-effort and must
never authorize a request or prevent the real authenticator from running.

The Node load-order test builds the bundle produced by
`scripts/build-gas-bundle.mjs` and exercises multiple file orders, authentication,
deployment identity rejection, qualification, and federation fallback. This is
useful regression evidence, but it is **not** a real Apps Script runtime test.

Before treating this change as runtime-qualified, deploy the reviewed bundle to
a dedicated, isolated GAS sandbox and verify real dispatch, invalid-signature and
wrong-target rejection, no cold-load side effects, and visible failure when a
required module is absent. Record the exact Git commit, normalized bundle hash,
GAS version, and deployment ID. Do not use the production project or production
mail/database grants for this qualification. The intentionally modified
missing-module bundle must have a separate hash and must not be reported as the
release artifact.

PR A does not add an autonomy activation route. Merging it must not enable the
email runtime, install or modify triggers, expand Gmail consent, or mutate
production Script Properties.
# Reviewed release gate (PR split)

Merging control-plane A or runtime B does **not** deploy anything. Main push
deployment is removed. Only manual `gas-self-deploy.yml` is a supported release
writer; legacy clasp deploy/push are explicitly disabled, including fallback
source-only writes. Do not re-enable them to work around an HTTP 403.

Create a `refs/tags/gas-release/*` tag pointing to the full reviewed aggregate
commit, then dispatch the workflow with that exact tag selected as the workflow
ref. Supply that exact `release_commit`, the same `release_ref`, the canonical
normalized desired bundle hash from the builder, and an independently freshly
inspected expected live predecessor hash. The authorization script rejects a run
whose actual `GITHUB_REF` differs from `release_ref`. The `gas-production` environment
must approve this exact tuple in `GAS_APPROVED_RELEASE`:
`<release_ref>:<commit>:<desired_hash>:<predecessor_hash>`. Missing/stale approval,
wrong ref, wrong commit, wrong built hash, or a changed live predecessor fails
closed. Environment protection/review and tag protection are operator prerequisites;
this change does not configure cloud resources or repository environments. The
available GitHub integration cannot read the `gas-production` environment's
protection settings, and no `gas-release/*` tags are currently visible. Treat both
controls as **unverified blockers** until a repository administrator confirms
required independent reviewers on `gas-production` and a protected release-tag
rule; the workflow/code changes are not a substitute for those controls.
The shared production concurrency and signed compare-and-swap/readback remain.

Pending: exact A sandbox signed-dispatch smoke, then final aggregate sandbox
qualification recording commit/hash/version/deployment. Historical email activity
does not prove signed dispatch; no split artifact is claimed live-qualified.
