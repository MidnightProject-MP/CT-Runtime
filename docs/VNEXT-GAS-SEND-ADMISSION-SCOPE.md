# GAS send admission and uncertain-send recovery — scope proposal

Status: **draft for stack review; scopes work only and implements nothing.** This
document does not authorize a live database apply, GAS deployment, activation,
trigger change, or mail send.

Inputs:

- Main at `ad7785ae` (#99), including the Node/store-side D3 guard (#98).
- Email stack `work/vnext-email-owner-activation-c3` at `c0e0d77` (#84), the
  head of draft PR #75 against `work/vnext-email-runtime-b`.
- `docs/VNEXT-ROADMAP.md` §"Uncertain external effect" and Milestone 1D.
- Carried review finding from #84, recorded below.

## 1. What the stack already does

The GAS delivery path is:

`delivery-peek` → provenance/MIME preflight → `delivery` → Gmail send →
`note-send-receipt` → readback → `record`

- `delivery` is the irreversible admission point. It inserts a durable
  `external-effect-uncertain` reconciliation block and sets the outbox to
  `admitted` before returning `send` (`deploy/gas-email/008_acceptance_decisions.sql:327-341`).
- A second invocation sees `admitted` and receives `reconcile`, never `send`.
- `note-send-receipt` records the Gmail provider ID before readback; `record`
  requires matching envelope identity and readback evidence, then marks the
  outbox `sent` and clears the block.
- Search absence, `nextPageToken`, multiple matches, or failed readback remain
  `uncertain`; the runner does not resend (`gas/gas_vnext_email.js:194-242`).
- Settlement receipts, continuation proposals, and acceptance decisions are
  already durable and exact-replayable.

This is a sound no-blind-resend base. Two obligations remain.

## 2. Carried #84 acceptance-replay finding

**Finding:** exact acceptance replay is blocked after acceptance-authority
rotation or revocation. `accept` checks the current authority before looking up
the recorded decision:

- authority check: `deploy/gas-email/008_acceptance_decisions.sql:290-296`
- replay lookup: `deploy/gas-email/008_acceptance_decisions.sql:297-305`

The existing native race test codifies the current behavior: after revocation,
replaying the already-recorded decision is expected to throw
`acceptance authority required`
(`test/gas-email.integration.test.mjs:776`). That contradicts the stated durable
replay guarantee: an exact replay returns the recorded decision, while only a
**new** acceptance requires current authority.

**Recommended correction:** validate the decision format, then perform the exact
replay lookup and binding comparison **before** the current-authority check and
the reconciliation/active-mutation exclusions. New acceptance still requires the
current authority. Replay remains read-only and returns the recorded decision.

The existing test must be inverted: accept, revoke the authority, exact replay
succeeds with `replay:true`, and a new decision fails. This is small enough to be
a separate prerequisite commit/PR on the stack; it should not be bundled
silently into the send-admission migration.

## 3. Increment A — actual send admission

Current `delivery` checks the prepared execution, active project authority, an
unresolved block, and newer input. It does not bind the whole admission record,
and GAS has no cancellation check at the effect boundary.

Smallest sufficient change:

- Keep the read-only `delivery-peek` preflight. Only `delivery` may authorize a
  send, and only one outbox transition may return `send`.
- Under the existing project lock, lock the outbox, execution, Work Unit, and
  settlement receipt; verify:
  - instance/project/Work Unit/execution/fence all agree;
  - the execution is succeeded and its settlement receipt binds the same
    captured `input_seq` and normalized turn;
  - the prepared envelope digest and deterministic Message-ID still match;
  - no provider receipt or delivery evidence already exists;
  - no newer input than the captured snapshot;
  - no reconciliation block or other admitted outbox;
  - the Work Unit is not cancelled and no cancellation intent governs the
    captured input snapshot.
- Record an immutable admission receipt (admission identity/digest and
  `admitted_at`) in the same transaction as the block insertion and outbox
  transition. Exact replay returns the recorded admission; divergent content
  fails before mutation.
- A cancellation intent is a fail-closed check, not the full cancellation UX.
  GAS has no material-revision path; the captured input snapshot is its
  admission watermark. Recording cancellation intents remains a separate
  authority/UX surface (review decision 1).

**Non-goal:** the admission receipt is still point-in-time eligibility, not a
lease that can stop a running GAS invocation. The GAS execution limit and script
lock are not sender-termination proof.

## 4. Increment B — uncertain-send `no_effect` recovery

Today a block whose send never happened can only be cleared by producing a
`gmail_id`; a genuinely unsent message blocks the project forever.

The missing operation must establish **both**:

1. the previous sender cannot still perform the send (confirmed sender
   termination, effective capability revocation, or an execution-boundary
   guarantee); and
2. authoritative evidence supports `no_effect`, not merely "not found".

Absence from a bounded Gmail search is not proof, and an expired claim, absent
authority, or unrenewable fence does not stop an already-running sender.

Proposed shape:

- Add a trusted, per-instance **delivery-recovery authority**, separate from the
  execution grant and acceptance authority, using the same bearer-credential
  pattern: `authority_ref` is never returned by an RPC; a non-secret
  `authority_id` is recorded for audit.
- Add one guarded `resolve-no-effect` operation. It requires instance/project,
  Work Unit, execution, fence, outbox/admission identity, a recovery decision
  reference, an evidence digest/reference, a sender-termination evidence
  reference, and the current recovery credential.
- Refuse unless: the outbox is `admitted`; a block exists for that exact
  execution; no `provider_receipt` and no `gmail_id` exist; the bounded readback
  is complete (no `nextPageToken`, no exact match); and sender-termination
  evidence is present and valid.
- Record the resolution immutably with exact-replay and divergent-conflict
  semantics. Mark the outbox closed in a distinct `no_effect` state (final name
  fixed with the forward migration); do **not** fabricate a `gmail_id`; clear
  only that execution's block.
- Grant exactly one recovery opportunity without new input, consumed atomically
  by the next authorized admission, preserving attempt history and the existing
  bounded-retry limit. Newer input supersedes the opportunity.
- The closed outbox is never resent. Whether the successor reuses the frozen
  settlement turn or re-runs the bounded model turn is review decision 3.

**Non-goal:** no automatic `no_effect` inference, no operator-free block
clearing, and no weakening of "absence never grants a resend."

## 5. Migration and operation boundary

- One forward-only GAS migration (next number after 008) for admission receipt
  fields, the minimal cancellation-intent shape if approved, the immutable
  resolution record, and the recovery-authority registration.
- Replace only the deepest RPC in the existing chain, preserving the 002
  wrapper's provider-receipt and evidence checks. Do not edit 002-008 or the
  checksum-pinned bootstrap files.
- The GAS runner gets only the new operation/state wiring; no new tools, model
  capability, deployment path, or public endpoint.
- No Node changes: the Node/store-side D3 guard already exists. No live apply,
  activation, trigger, Gmail, or Neon mutation is part of this scope.

## 6. Evidence plan

Focused PGlite suites plus native PostgreSQL through
`scripts/run-postgres-suite.mjs`:

- admission: settlement/fence/envelope mismatch refuses; newer input supersedes;
  cancellation/block/authority refuses; exact replay is inert; a second call
  receives `reconcile`, not `send`;
- races: delivery vs ingest (existing), competing admissions, cancellation vs
  delivery, `record` vs `resolve-no-effect`, two competing resolutions;
- no_effect: provider receipt or `gmail_id` refuses; missing block refuses;
  incomplete search/`nextPageToken` refuses; missing or invalid
  sender-termination evidence refuses; valid resolution records exactly once,
  clears one block, and yields one consumed recovery opportunity; replay returns
  the receipt; divergence conflicts; no duplicate effect;
- acceptance: exact replay after authority revocation succeeds; new acceptance
  after revocation fails.

Exact-head CI on the branch push and PR; native races executed, not skipped. No
live qualification is claimed by green tests.

## 7. Review decisions

1. **Cancellation scope.** Include the minimal GAS cancellation-intent table and
   admission check in this increment, or make it a dependent increment? The
   check alone is not a usable cancellation surface without a writer.
2. **Recovery authority.** Separate per-instance delivery-recovery credential
   (proposed), or owner-only SQL operation with no runtime credential? The
   separate credential keeps the recovery decision auditable without a new
   control plane.
3. **Successor work.** Reuse the frozen settlement turn for the one recovery
   delivery, or require a new bounded model turn? Reuse avoids unnecessary model
   work and preserves the reviewed reply, but needs a delivery-only attempt
   identity.
4. **Evidence attestation.** Confirm the exact form of complete readback and
   sender-termination evidence that the trusted caller may attest. SQL cannot
   query Gmail or prove an invocation stopped.
5. **Acceptance replay fix.** Separate prerequisite PR (recommended) or a first
   commit in this increment.

## 8. Exit condition

The increment is complete when:

- a send can be admitted only from the current settled attempt and exact prepared
  envelope, with revision-equivalent input, cancellation, authority, and block
  checks all fail closed;
- an admitted-but-unsent effect can be resolved as `no_effect` only through a
  durable, evidenced, exact-replayable trusted decision, clearing the block and
  granting one bounded recovery opportunity;
- the acceptance replay-after-revocation defect is closed with a native
  regression;
- all evidence above runs through the public RPC on native PostgreSQL, and no
  live GAS/Neon operation has occurred.
