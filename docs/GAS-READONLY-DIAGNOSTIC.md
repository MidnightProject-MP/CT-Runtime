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
