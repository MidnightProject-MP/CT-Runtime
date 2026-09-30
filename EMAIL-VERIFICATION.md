# Corrected Gmail pilot verification — 2026-09-29

Supersedes the original incomplete email ZIP. Read docs/VNEXT-EMAIL-PILOT.md before activation.

Archive producer's Linux verification: 366 tests, 335 passed, 0 failed, 31 skipped. These are delivery claims, not the integrating worker's results.
Email tests: six tests, including real SQL migrations and pilot execution with a simulated Gmail REST service. Tests exercise retry after ingress interruption, deterministic receipts, execution result provenance, same-thread follow-ups, concurrent arrival during completion, uncertain send readback without resending, sender/recipient checks, authentication, queue draining and deployable entry-point inclusion.

The build contains the Gmail bridge; workflow remains opt-in. Migration 009 is retained byte-for-byte; migration 010 adds required configuration and provenance. No live database migrations, Gmail access, email send, deployment, GitHub push or merge was performed. Native PostgreSQL CI and live Gmail/host acceptance remain pending. The full suite's external-service tests were skipped where credentials/services were unavailable.

The archive includes all tracked and non-ignored source files, including tests and fixtures. Dependencies and Git metadata are excluded. Its SHA256SUMS records every included source file except the checksum manifest itself; that snapshot manifest is deliberately not installed into this selectively integrated repository.

## Repository integration verification (Windows, Node v24.19.0)

- Source: `CT-Runtime-vNext-Email.zip`, SHA-256 `360b693219458b5e34fece64292a00a57b2af93e2c53a94d8090e0005eb4e056`.
- Corrected root: `CT-Runtime-Email-Pilot-Corrected-2026-09-29/`. ZIP has 256 entries: 236 files and 20 directories. All 235 checksummed files matched; the remaining file is `SHA256SUMS`.
- Integrated selectively on PR #65's `work/vnext-minimum-loop-2026-09-27` dependency branch; no base files deleted. Excluded the unrelated A9 takeover-test change and snapshot checksum manifest. Added portable filesystem URL handling and temporary bundle cleanup in touched tests.
- `npm ci` succeeded. `npm test`: 366 tests, 332 passed, 3 failed, 31 skipped. The failures are unchanged base tests: `autonomy-retirement` uses a nonportable URL pathname as child cwd; two command-executor tests require Linux process groups. They are not suppressed by this change.
- The six email tests passed, including actual offline SQL migrations through 010, pilot execution, simulated Gmail routing, authenticated transport, uncertain-send readback, and result/input provenance. The existing pilot SQL integration suite also passed.
- Focused regression command passed all 35 tests with no skips: `node --test test/vnext-email.test.mjs test/vnext-email.integration.test.mjs test/vnext-email-package.test.mjs test/vnext-arm-contract.test.mjs test/gas-bundle-builder.test.mjs test/gas-federation.test.mjs test/gas-control-plane-dispatch.test.mjs test/vnext-pilot.integration.test.mjs`. `git diff --check` passed.
- No production database migrations, mailbox access, email sending, deployment, or timer activation was performed. Native PostgreSQL, Linux process-group execution, and live mailbox/host qualification remain CI/operator verification requirements.


## Retargeting lineage

After minimum-loop PR #65, canonical migrations are `009_project_reconciliation.sql`, `010_email_pilot.sql`, and `011_email_pilot_integrity.sql`.
