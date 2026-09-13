# GAS deployment

This is the authoritative operating contract for CT-Runtime's GAS deployment capability. It describes the normal operating model and the break-glass boundary; it is not a history of the deployment work.

## Normal path

```text
merge GAS-affecting PR
        ↓
automatic GitHub Action
        ↓
read current LIVE predecessor
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

A GAS-affecting merge to `main` is the normal trigger. Production deployment is serialized by the `gas-production-deploy` concurrency group with cancellation disabled.

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
- `clasp` is **bootstrap / break-glass only**. It is not part of normal production deployment.
- The Apps Script Execution API and `clasp run` are **not part of this architecture**.
- Do not add deployment workflow concepts such as GAS versions, deployment pointers, or HMAC request state to the Runtime outer-loop model merely to support this capability.

## Break-glass conditions

Use break-glass handling only when the normal capability cannot safely establish convergence.

| Situation | Action |
| --- | --- |
| Normal GAS-affecting merge | Let the automatic self-deploy run. No manual intervention. |
| Post-mutation timeout, HTML/redirect anomaly, or otherwise uncertain response | **Read back only**. Do not repeat the mutation automatically. |
| `HEAD == desired`, `LIVE == predecessor` after an interrupted request | Resume/reconcile the existing request through the deployment capability; do not rewrite HEAD unnecessarily. |
| `HEAD != LIVE` and `HEAD != desired` | Stop. Investigate the live/HEAD state before any further mutation. |
| HMAC self-deploy capability itself is broken | Use `clasp` only as a deliberate bootstrap/break-glass recovery path, then restore the normal path. |
| Version capacity is near the Apps Script limit | Perform planned version maintenance before production deployment becomes blocked. |

Break-glass work must preserve the same final invariant: `HEAD == LIVE == desired`.

## Change policy

The deployment control plane is intentionally small. The primary surfaces are:

- `.github/workflows/gas-self-deploy.yml`
- `scripts/deploy-gas.mjs`
- `gas/gas_deploy.js`
- deployment contract/state/readback tests

Before modifying deployment control-plane code, read this document and run the deployment contract tests. Changes must preserve the invariants above, especially single-mutation behavior, recovery/idempotency, bounded readback, GAS-native identity, and production concurrency serialization.
