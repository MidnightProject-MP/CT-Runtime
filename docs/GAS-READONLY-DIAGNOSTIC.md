# Read-only GAS diagnostic (review branch only)

Manual invocation of the existing `gas-clasp-auth-health.yml` workflow with
`mode=inspect-readonly` runs only the new diagnostic job. Its default manual mode
is inspection; the existing scheduled authentication-health behavior is unchanged.

The diagnostic refreshes existing CLASPRC_JSON OAuth credentials in memory and
makes exactly three Apps Script API GETs: the pinned deployment, HEAD content,
and content at the deployment's observed version (not an assumed version 100).
It prints only pinned IDs, version, file counts, three fixed property-reference
booleans, handler-presence booleans, and allowlisted webapp access/execution enums.
Source stays in memory; no source snapshot, artifact, raw error response, OAuth
token, property dump, file names, or deployment description is logged or saved.
Source presence is not evidence of a live property's value or handler reachability.

The extended diagnostic also reads actual deployment `entryPoints`: WEB_APP
access/executeAs enums and canonical URL identity, and EXECUTION_API presence
only (never invocation). CT_GAS_ADMIN_WEB_APP_URL is supplied as a secret environment
variable and compared to the canonical URL after URL normalization entirely in
memory. Only equality and allowlisted identity components are emitted; unknown
hosts/IDs become null, and credentials/query/fragment/full URLs are never printed.
HEAD/live equality uses SHA-256 over sorted exact `{name,type,source}` objects,
excluding API metadata. These diagnostic hashes are not deployment-protocol hashes.

The CLI additionally permits one unauthenticated GET per distinct strictly pinned
HTTPS `script.google.com/macros/s/<pinned deployment ID>/exec` target. Credentials,
queries, fragments, ports, encoded paths and other targets are rejected, not
rewritten into probeable URLs. Redirects are manual and never followed. Only
HTTP status and allowlisted base content type are retained; body streams are
cancelled and Location/cookies are not inspected. Identical canonical/configured
targets reuse one probe result. GET status is not proof of POST functionality or
live property access. No self-deploy POST, GAS execution API, or deployment occurs.

## Invocation

```text
gh workflow run gas-clasp-auth-health.yml --ref work/gas-readonly-diagnostics-2026-10-01 -f mode=inspect-readonly
```

Use only a process-scoped GH_TOKEN from `gh auth token --user MidnightProject-MP`
when the active GitHub identity lacks dispatch permission. Never print the token
or switch the global active identity.

## Live property boundary and proposed minimal mechanism

The Apps Script REST API exposes source/deployment metadata, not Script Properties.
A webapp 403 cannot be bypassed by `getContent`. Execution API / `clasp run` are
excluded by GAS-DEPLOYMENT.md. Existing self-deploy authentication writes nonce
properties, so even its planning/qualification operations are not strictly read-only.
This workflow deliberately invokes none of those endpoints.

`scripts/gas-diagnostic-properties.cjs` is an undeployed, GAS-compatible candidate
helper, outside the GAS bundle. It reads exactly CT_GAS_FEDERATION_DATA_API_URL,
CT_GAS_DEPLOYMENT_ID and CT_AUTONOMY_MODE using individual getProperty calls. It
returns only a sanitized HTTPS hostname/path, validated deployment ID, and known
mode enum. Invalid/unset values become null. Credentials, query and fragment are
removed; ambiguous URLs fail closed. Hostnames and paths are the explicitly
authorized disclosure; arbitrary secret-bearing path segments cannot be inferred.
No existing Neon/vNext project-ID property keys were established from repository
GAS source, so none are guessed or broadly searched/dumped at runtime.

For parent review: first inspect the observed webapp access/execution metadata.
If it establishes a usable approved invocation surface, a separately authorized
canonical Actions deployment could add only this helper plus a narrowly
authenticated, non-mutating diagnostic route. That requires review of access and
authentication without the nonce-writing deployment authenticator. Do not expose
an unauthenticated property route, change access configuration to overcome 403,
replace remote HEAD with this branch, or temporarily overwrite/restore source.
No such route or deployment is included here. If no approved reachable surface
exists, an authorized owner must inspect only these keys in the Apps Script UI;
the source API is not a substitute for live values.

The documented Neon project `falling-bird-38424127` is not proof of a different
live project. No Neon calls, migrations, property/config/trigger/polling/mail
changes, PR68 merge, or production deployment are part of this diagnostic.
