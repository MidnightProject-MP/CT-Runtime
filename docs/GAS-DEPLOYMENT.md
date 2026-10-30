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
authorize exact commit, desired hash and predecessor under the current mandate
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

A merge to `main` does not deploy. Only the explicitly dispatched, hash-pinned `gas-self-deploy.yml` release workflow is supported, subject to the reviewed release gate below. `workflow_dispatch` means an explicit invocation, not necessarily a human button click. Production deployment is serialized by the `gas-production-deploy` concurrency group with cancellation disabled.

## Release authority: bootstrap to autonomous operation

The owner clarified on 2026-10-28 that this is Philippe and Celestan, with no
separate independent human reviewer. Celestan is not a second human approver.
During bootstrap, Philippe approves the exact release tuple; Celestan prepares,
tests, dispatches, and verifies that approved release. An additional human account
is not a commissioning requirement.

The intended commissioned operating model delegates routine work and releases
across CT repositories to Celestan under the owner's standing mandate. Per-release
human approval is a bootstrap measure, not the final architecture. Transition
requires demonstrated repository access, bounded execution, durable evidence,
exact-artifact verification, and recovery behavior on the commissioned path.
Record that transition and its scope before using standing authority for live
release writes. Scope expansion, consequential ambiguity, and unresolved recovery
are escalated to the owner; routine in-scope releases are not.

Both phases retain protected release tags, restricted release credentials,
`GAS_APPROVED_RELEASE` bound to the exact tuple, test evidence, and observed
HEAD/LIVE convergence. In the autonomous phase Celestan may prepare that tuple
under standing authority; it remains a deterministic artifact/predecessor check,
not evidence of independent review. These policy changes do not by themselves
commission the runtime or provision GitHub protections.

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
- `.github/workflows/gas-sandbox-self-deploy.yml`
- `.github/workflows/gas-sandbox-bootstrap.yml` (initial isolated installation only)
- `scripts/bootstrap-gas-sandbox.mjs`
- `scripts/deploy-gas.mjs`
- `scripts/qualify-gas-target.mjs`
- `lib/gas-targets.mjs`
- `gas/gas_deploy.js`
- deployment contract/state/readback/target tests

Before modifying deployment control-plane code, read this document and run the deployment contract tests. Changes must preserve the invariants above, especially single-mutation behavior, recovery/idempotency, bounded readback, GAS-native identity, and production concurrency serialization.


## Isolated sandbox qualification target

### Initial handler bootstrap

The signed self-deployment endpoint cannot install itself into an empty project.
Read-only inventory found only the known production script in the available local
Google login, and only `gas-production` in GitHub. This is evidence about those
credentials, not a claim that no sandbox exists under another account.

On 2026-10-30, following owner approval to reuse the Google owner account,
`gas-sandbox` was created. `GAS_SANDBOX_OWNER_EMAIL` was read back as
`midnight.project.mp@gmail.com`, matching `clasp show-authorized-user`.
The matching existing OAuth credential was transferred directly into the encrypted
environment secret `GAS_SANDBOX_GOOGLE_OAUTH_JSON`, without displaying its value.
Only the secret's presence was read back. This does not establish that OAuth
refresh or API scope checks have passed in Actions. The environment has no release
protections configured yet. No sandbox project was created and no bootstrap run
was dispatched. This authorization covers sandbox ownership and non-email
qualification; it does not authorize testing against the owner's real mailbox.

The initial installation candidate is `.github/workflows/gas-sandbox-bootstrap.yml`,
using the same `gas-sandbox` environment and `gas-sandbox-deploy` concurrency group.
It runs from an exact reviewed `gas-sandbox-release/*` tag. Source is installed via
the Google Apps Script REST API, never local upload or a legacy clasp workflow.
The runtime bundle is unchanged by this bootstrap implementation.

Prerequisites in the `gas-sandbox` GitHub environment:

- Variable `GAS_SANDBOX_OWNER_EMAIL`: lowercase email of the intended sandbox
  Google owner. Drive's authenticated user readback must match before any write.
- Secret `GAS_SANDBOX_GOOGLE_OAUTH_JSON`: owner-authorized Google user OAuth
  refresh credentials in the existing clasp JSON shape (`tokens.default` and
  optionally `oauth2ClientSettings`). This is a credential format, not a clasp
  upload route. Authorize the intended sandbox account; do not silently copy
  production credentials. Required permissions cover Drive project discovery,
  Apps Script project creation/content, and deployments. Apps Script API access
  must be enabled for that account/client.
- Variable `GAS_SANDBOX_BOOTSTRAP_APPROVED`, for `mode=create` only:
  `<release_ref>:<commit>:<bundle_hash>:<request_id>:<owner_email>`.

Begin with `mode=inspect`. It reads the authenticated Google identity and searches
for `CT-Runtime GAS Sandbox`; if present, it reports HEAD and version/deployment
hashes. It does not reserve a request or write Google project state. Multiple
matching projects or an incomplete inventory stop the operation. Renamed projects
are not discoverable by this title query; retain the recorded Script ID and use
targeted readback before considering another bootstrap.

After exact owner approval, `mode=create`:

1. Rechecks owner, tag, commit, built hash, approval, first run attempt, and absence
   of the named sandbox.
2. Creates `refs/tags/gas-sandbox-bootstrap-used/<request_id>` at the reviewed
   commit as a durable one-use reservation. Existing, lost, or ambiguous reservation
   outcomes prevent all Google writes. Protect these reservation tags against
   deletion/update; never delete one to rerun a bootstrap.
3. Creates a new standalone project, refuses any production identity, and verifies
   that it contains only its base manifest or no files before source installation.
4. Uploads the exact bundle once, reads HEAD, creates one version, reads that
   version, creates one web deployment, and reads the deployment and HEAD again.
5. Reports only validated project/deployment identifiers, version, URL, source
   hashes and stages. No OAuth or HMAC value is written into source or evidence.

Every write is attempted once. The workflow refuses `mode=create` on a rerun.
If an outcome is uncertain, preserve the reservation and use `mode=inspect` in a
new explicitly dispatched run. Do not change the request ID merely to bypass the
reservation. Partial bootstrap recovery needs a separately reviewed action against
the observed Script ID; this implementation deliberately does not overwrite an
existing project or automatically delete one.

### Owner handoff after source installation

`installed-owner-setup-required` means source readback passed, not that HMAC or
the email loop is qualified. Google project/content APIs do not set Script
Properties or grant the user's execution consent. In the **new sandbox only**:

1. Record the reported Script ID and deployment ID in `GAS_SANDBOX_SCRIPT_ID`
   and `GAS_SANDBOX_DEPLOYMENT_ID`; store the reported URL in the environment
   secret `GAS_SANDBOX_ADMIN_WEB_APP_URL`.
2. Generate a separate HMAC secret through the owner's secure secret tooling.
   Set it directly as sandbox Script Property `CT_GAS_DEPLOY_HMAC_SECRET` and
   environment secret `GAS_SANDBOX_DEPLOY_HMAC_SECRET`; never paste it into source,
   logs, a workflow input, or a chat. Set Script Property `CT_GAS_DEPLOYMENT_ID`
   to the reported deployment ID, and `CT_VNEXT_EMAIL_ENABLED=false`.
3. Complete execution consent using the sandbox owner account. The existing
   `inventoryVnextEmailProperties` function is a read-only owner entry point for
   this step; it lists property names, not values. Do not run the email tick or
   activation functions. Verify the new project's trigger list is empty.
4. Use the sandbox self-deploy workflow's `inspect_only=1` to verify the real
   signed handler. This reserves an HMAC nonce but does not change source.

No database, test mailbox queue, model credential, or GitHub read credential is
provisioned by source bootstrap. Those remain the next isolated runtime steps.
Remove the one-time OAuth secret from the environment once bootstrap/recovery is
complete; normal releases use the sandbox HMAC capability. Keep metadata and the
one-use reservation for continuity.

Local bootstrap verification on `feat/gas-sandbox-bootstrap`, a dirty worktree
based on PR #121 head `d6b7fcd`, passed **45 tests, 0 failures, 0 skips** on
Windows Node `24.19.0`: `gas-sandbox-bootstrap`, `gas-target-qualification`,
`gas-release-gate`, `gas-deploy-contract`, `gas-deploy-state-machine`, and
`gas-deploy-readback`. The new HTTP fixtures cover wrong owner, production
identity, nonempty target, consumed reservation, lost responses at each write,
partial inventory, and mismatched final readback. These are local contract tests,
not evidence that a sandbox has been created or that real Google OAuth works.

### Subsequent sandbox releases

Sandbox qualification uses the same signed deployment capability and exact-artifact
readback as production, but must never reuse production identity or credentials.
`.github/workflows/gas-sandbox-self-deploy.yml` is manually dispatched from a
`refs/tags/gas-sandbox-release/*` tag and uses the `gas-sandbox` environment,
`gas-sandbox-deploy` concurrency, and the `gas-sandbox-release/*` authorization
prefix. It binds:

- `GAS_SANDBOX_SCRIPT_ID` (environment variable)
- `GAS_SANDBOX_DEPLOYMENT_ID` (environment variable)
- `GAS_SANDBOX_ADMIN_WEB_APP_URL` (environment secret)
- `GAS_SANDBOX_DEPLOY_HMAC_SECRET` (environment secret)
- `GAS_SANDBOX_APPROVED_RELEASE` (environment variable, exact tuple)

`scripts/qualify-gas-target.mjs` runs before authorization and deployment. It
requires the sandbox target marker, a manual dispatch on the sandbox tag
namespace, a full commit, the explicit deployment ID, an endpoint whose embedded
deployment ID matches, the HMAC secret presence, and a target that is not the
production Script ID or production deployment ID. `scripts/deploy-gas.mjs` also
checks the explicit deployment ID before signing any request. The workflow does
not receive `CLASPRC_JSON` or production environment secrets.

Dispatch the sandbox workflow with `inspect_only=1` to read the current LIVE
version, LIVE bundle hash, HEAD bundle hash and version capacity without
authorization or deployment. This signs a read-only `self-deploy-plan` request
and reserves a nonce, but performs no HEAD or deployment mutation. Use the
observed predecessor for the later exact release tuple.

Bootstrap authorization still applies: the owner approves the exact sandbox
release tuple. Do not provision or dispatch this target until the owner supplies
the isolated GAS, database, mailbox and credential identities. Source deployment
alone does not configure Script Properties, triggers, Gmail consent, or database
migrations.

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
writer for production; the isolated sandbox workflows above are the scoped
bootstrap/release paths. Legacy clasp deploy/push are explicitly disabled, including fallback
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
closed. Restrict environment deployment refs to protected `gas-release/*` tags
and restrict release-tag creation/update to the authorized release principal.
Review follows the bootstrap/standing-authority policy above, without inventing
a second human approver. The 2026-10-28 GitHub API inspection found no environment
protection rules or deployment-ref policy, no tag-targeted ruleset, and no release
tags. `GAS_APPROVED_RELEASE` was absent at repository and environment scope.
These are **open configuration gaps**, not configured controls; workflow/code
checks do not replace them. A tag-only environment policy will also prevent the
existing readback workflow from running from `main`; select a reviewed protected
tag for future readback before imposing that policy.
The shared production concurrency and signed compare-and-swap/readback remain.

Pending: exact A sandbox signed-dispatch smoke, then final aggregate sandbox
qualification recording commit/hash/version/deployment. Historical email activity
does not prove signed dispatch; no split artifact is claimed live-qualified.
