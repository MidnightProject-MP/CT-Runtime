# GAS send admission and uncertain-send recovery — scope proposal

Status: **revised after review; decisions recorded; scopes work only and
implements nothing.** This document does not authorize a live database apply,
GAS deployment, activation, trigger change, or mail send. The acceptance-replay
correction and Increment A may proceed; Increment B is gated on the concrete
`no_effect` evidence contract in §4.

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

The existing test must be inverted: accept, revoke or rotate the authority, exact
replay succeeds with `replay:true`, and a new decision fails. It lands as a
separate prerequisite PR using a forward migration; it should not be bundled
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
  transition. **Only the winning first transition returns the `send`
  instruction.** Receipt replay is historical evidence: it returns the recorded
  admission and reconciliation information, never another `send`. If the first
  transition commits but its response is lost, the retry observes `admitted` and
  returns reconciliation/receipt information, not permission to send. Divergent
  content fails before mutation.
- Add a minimal `cancel` operation as the authorized writer plus the admission
  check in Increment A. A table and a check without a supported writer do not
  complete the cancellation boundary.
  - Use a per-instance cancellation authority separate from the execution and
    acceptance authorities; an opaque decision reference is exact-replayable,
    divergent content conflicts, and one intent may be pending per Work Unit.
  - Bind the intent to the Work Unit and captured input snapshot. GAS has no
    material-revision path, so the input watermark is the admission equivalent.
  - Broader cancellation interruption/reconsideration UX stays deferred.

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

### 4.1 Implementation gate (unresolved)

**Increment B must not be implemented until the concrete evidence rule is
defined and approved.** A trusted credential, a nonempty evidence reference, and
a digest are not enough; a digest proves binding and integrity, not the truth of
the asserted outcome. A generic block-clearing operation must not be built first
and given evidentiary meaning later. The evidence decision is recorded in
`docs/VNEXT-GAS-NO-EFFECT-EVIDENCE.md`: the current Gmail/GAS boundary cannot
establish retrospective `no_effect`, so Increment B remains closed and an
uncertain send remains a permanent project stop unless the transport changes to
one with an idempotent, durably queryable provider outcome.

The current refusal conditions are necessary but not sufficient:

- no provider receipt or `gmail_id`;
- a complete bounded search with no match; and
- sender-termination evidence.

Those conditions establish "sender stopped and no send found." They do not
establish "no send occurred": a sender could send, crash before recording its
receipt, and leave a message that the available search does not establish.

Before implementation, the increment must define:

1. the exact observable facts that establish `no_effect`, not merely absence;
2. who verifies each fact and what makes the verification trustworthy;
3. how the decision binds to the exact admitted send; and
4. the fail-closed result when the available evidence cannot establish no
   effect — it remains **uncertain**, never an operator override.

### 4.2 Operation shape (conditional on the gate)

Once the evidence rule is approved, the smallest operation shape is:

- A trusted, per-instance **delivery-recovery authority**, separate from the
  execution grant and acceptance authority, using the same bearer-credential
  pattern: `authority_ref` is never returned by an RPC; a non-secret
  `authority_id` is recorded for audit. Keep this credential out of the ordinary
  sender's environment; otherwise the sender could authorize clearing its own
  uncertainty.
- One guarded `resolve-no-effect` operation requiring instance/project, Work
  Unit, execution, fence, outbox/admission identity, a recovery decision
  reference, the approved evidence binding, and the current recovery
  credential.
- Record the resolution immutably with exact-replay and divergent-conflict
  semantics. Mark the outbox closed in a distinct `no_effect` state; do **not**
  fabricate a `gmail_id`; clear only that execution's block.
- Grant exactly one recovery opportunity without new input, consumed atomically
  by the next authorized admission, preserving attempt history and the existing
  bounded-retry limit. Newer input or cancellation invalidates the opportunity.
- Reuse the frozen envelope and settlement when still current and authorized,
  with a distinct delivery-attempt identity and the consumed recovery
  opportunity. Do not add a model turn merely to retry transport.

**Non-goal:** no automatic `no_effect` inference, no operator-free block
clearing, and no weakening of "absence never grants a resend."

## 5. Migration and operation boundary

- Migration numbering is **conditional on landing order**: each increment that
  lands takes the next forward migration after the current stack head. The
  acceptance-replay correction is a forward migration and lands first; then
  Increment A; then Increment B only after its evidence gate closes. Do not
  reserve one "next after 008" migration for all changes.
- Increment A's migration carries the admission receipt fields, the minimal
  cancellation authority/intent shape, and the admitted-send binding.
- Increment B's migration, if approved, carries the recovery-authority
  registration and the immutable resolution record.
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
  cancellation/block/authority refuses; exact receipt replay is historical and a
  second call receives `reconcile`, never `send`;
- lost admission response: the transaction commits, the response is lost, and a
  retry returns reconciliation/receipt information — not permission to send
  again;
- cancellation: the minimal authorized writer records an intent with exact replay
  and divergent conflict; a pending intent refuses delivery admission; exact
  replay is inert;
- races: delivery vs ingest (existing), competing admissions, cancellation vs
  delivery, competing cancellation writers;
- no_effect (only after the §4.1 gate closes): provider receipt or `gmail_id`
  refuses; missing block refuses; incomplete search/`nextPageToken` refuses;
  missing or invalid sender-termination evidence refuses; evidence that cannot
  establish no effect remains uncertain; valid resolution records exactly once,
  clears one block, and yields one consumed recovery opportunity; replay returns
  the receipt; divergence conflicts; no duplicate effect;
- acceptance: exact replay after authority revocation **and** rotation succeeds;
  new acceptance after either still fails.

Exact-head CI on the branch push and PR; native races executed, not skipped. No
live qualification is claimed by green tests.

## 7. Recorded review decisions

1. **Cancellation scope — include the minimal authorized writer plus admission
   check in Increment A.** A table/check without a supported writer does not
   complete the boundary. The writer uses a separate cancellation authority,
   exact replay, and divergent-conflict handling; broader UX remains deferred.
2. **Recovery authority — separate from execution and acceptance.** Keep the
   recovery credential out of the ordinary sender's environment, otherwise that
   sender could authorize clearing its own uncertainty.
3. **Successor work — reuse the frozen envelope/settlement when still current and
   authorized.** Use a distinct delivery-attempt identity and a consumed recovery
   opportunity. Newer input or cancellation invalidates reuse. Do not add a
   model turn merely to retry transport.
4. **Evidence attestation — unresolved and gated.** Define the observable facts,
   verifier, and exact-send binding before implementation (see §4.1). A digest
   proves binding/integrity, not truth. If the available evidence cannot
   establish no effect, retain uncertainty.
5. **Acceptance replay fix — separate prerequisite PR.** It lands first with
   replay-after-revocation and rotation coverage; new decisions still require
   current authority. Use a forward migration and preserve the existing migration
   chain.

## 8. Sequencing and exit conditions

Landing order:

1. acceptance-replay prerequisite;
2. Increment A (send admission, cancellation writer/check);
3. Increment B only after the §4.1 evidence rule is approved.

Exit conditions:

- **Acceptance prerequisite:** exact replay after revocation and rotation returns
  the recorded decision; new acceptance after either fails; native regression
  green.
- **Increment A:** a send can be admitted only from the current settled attempt
  and exact prepared envelope, with input-watermark, cancellation, authority,
  and block checks all fail closed; only the winning transition returns `send`;
  lost-response retry returns reconciliation, never permission; the cancellation
  writer and check are exercised.
- **Increment B:** gated on §4.1; once approved, `no_effect` is resolvable only
  through a durable, evidenced, exact-replayable trusted decision that establishes
  no effect, clears one block, and grants one bounded, consumed recovery
  opportunity.
- All evidence runs through the public RPC on native PostgreSQL; no live
  GAS/Neon operation has occurred.
