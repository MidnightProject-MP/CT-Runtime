# GAS uncertain-send `no_effect` evidence — decision

Status: **decision recorded. No implementation, migration, deployment, or live
operation is authorized by this document.** Increment B remains closed.

## Decision

No operation may clear an `external-effect-uncertain` reconciliation block as
`no_effect` on the current GAS/Gmail boundary. A legitimately uncertain send
remains uncertain and continues to block the project and its Work Unit. The only
supported way to clear the block remains exact Gmail readback followed by
`record`, which records provider evidence that the message exists.

Do not implement a generic `resolve-no-effect` RPC, an operator override, an
automatic inference, or a migration that gives a digest or assertion evidentiary
meaning without the facts below. A future recovery design must satisfy the
evidence contract in this document; otherwise it fails closed as uncertain.

## Required facts

Clearing an uncertain send as `no_effect` requires **both**:

1. **Sender termination bound to the exact attempt.** The sender that could have
   performed this admitted send can no longer perform it, and that fact is
   established by a mechanism outside the sender's own assertion.
2. **Authoritative provider evidence of no effect.** The provider that would have
   accepted the send has a durable, queryable outcome for the exact submission
   showing that it did not accept or commit the effect.

Neither fact is currently establishable. The current boundary can sometimes
prove that a send **did** happen (exact readback), but it cannot prove that a send
did **not** happen.

## Why the current boundary cannot establish `no_effect`

### Gmail send has no idempotent request identity

`users.messages.send` accepts a message and, on success, returns the created
Message resource. It has no client-supplied idempotency key or request identity,
and no queryable "submission outcome by request key" endpoint. A transport error,
timeout, or lost response therefore leaves two indistinguishable states:

- the provider never accepted the submission; or
- the provider accepted and committed the message, and only the response was lost.

Retrying can create a duplicate. The absence of a locally recorded receipt is
evidence about the caller, not about the provider.

### Gmail search is not an absence oracle

A bounded list/search with no `nextPageToken` and no matching message proves only
that the current view returned no match. It does not prove that no send occurred:

- search indexing and visibility are not a synchronous transactional ledger;
- messages can be deleted, expunged, moved, or filtered after a successful send;
- retention and scope limit what the authenticated view can see;
- a message may exist but not yet be indexed or returned;
- `nextPageToken` and pagination are explicitly treated as uncertainty already.

The exact deterministic Message-ID makes a **positive** match strong evidence.
A negative match is not proof of no effect. The same reasoning applies to thread
scans and to reading a message by ID.

### Audit logs and exports are not a per-request commit record

Workspace audit logs, Gmail exports, and similar facilities can be delayed,
retention-bound, and incomplete for a specific API submission. They are useful
for investigation and incident evidence, but they are not a synchronous,
authoritative "this exact submission was not accepted" record. They cannot
replace a provider-side idempotent outcome.

### GAS cannot prove sender termination

Apps Script exposes no API that proves an in-flight execution has stopped and
can never perform another Gmail call. In particular:

- execution time limits bound when a call might occur; they do not prove that a
  call did not occur before the limit;
- `LockService` is cooperative and does not terminate a running invocation;
- disabling a trigger, clearing a Script Property, or redeploying does not kill
  an execution that is already running;
- revoking an OAuth grant or deleting a credential does not prove that a prior
  send did not happen;
- an expired claim, missing authority, or unrenewable fence does not stop an
  already-running sender.

A trusted principal's statement that the sender "is stopped" is not sufficient
without a mechanism that makes further sends impossible and is verifiable outside
that principal.

### A digest or credential proves binding, not truth

A SHA-256 digest, a bearer credential, a nonempty evidence reference, and an
immutable row can prove that a decision is bound to an exact admission and that
it was recorded without mutation. They do not prove that the asserted external
outcome is true. Recording "no effect" because an operator or sender says so
would turn the block into an override with extra steps.

## Evidence contract for any future transport

A future transport or architecture may be considered only if it provides all of
the following. Any missing, partial, ambiguous, or unverifiable fact must leave
the effect uncertain.

1. **Exact attempt binding.** Instance, project, Work Unit, execution, fence,
   outbox/admission identity, captured `input_seq`, envelope digest, and
   deterministic message identity all agree with the admitted send.
2. **Durable provider outcome.** The provider accepts a client idempotency key
   (or equivalent request identity) and exposes a durable, queryable outcome for
   that exact key: definitively accepted/committed, or definitively not
   accepted. Duplicate submission with the same key must not create a second
   effect. A search returning no match is not a provider outcome.
3. **Sender termination proof.** A mechanism outside the sender's assertion
   proves that the exact sender capability or process cannot perform the send
   after the recovery decision. The proof is bound to the same attempt. Claim
   expiry, credential revocation alone, trigger disablement, or elapsed
   execution time is not proof.
4. **Independent verifier.** A principal outside the ordinary sender and its
   credential scope performs or verifies the provider query and termination
   check. The verifier must not be able to use the sender's credential to
   manufacture a no-effect outcome. Its authority is distinct from the execution
   and acceptance authorities.
5. **Immutable, exact-replayable decision.** The resolution records the evidence
   binding and the verifier identity immutably. Exact replay returns the recorded
   decision; divergent content conflicts. One decision clears one exact
   admission's block, never a generic project block, and never fabricates a
   `gmail_id`.
6. **Bounded recovery opportunity (only if separately approved).** A successful
   resolution may grant one recovery opportunity for the same frozen envelope
   when still current and authorized, consumed atomically by the next admission.
   Newer input or cancellation invalidates it. This does not authorize a model
   turn merely to retry transport.
7. **Fail closed.** If any fact cannot be established, retain `uncertain`. There
   is no operator override.

A definitive, durably captured provider rejection at send time (for example, a
non-retryable request-level rejection that provably occurred before acceptance)
would be admissible evidence for that exact attempt. The current system does not
capture such a rejection across a lost response, and this document does not
authorize adding that capture. Retrospective absence cannot substitute for it.

## What would change the decision

A transport must provide, at minimum:

- a client idempotency key or equivalent request identity;
- a synchronous durable accepted/rejected outcome retrievable by that key;
- duplicate suppression for retries with the same key; and
- an auditable provider record.

A controlled mail relay or email API with idempotent submission and durable
transaction records could meet this. A sender running in a controlled process
with exclusive credential access still needs the provider-side idempotent
outcome; process control alone does not distinguish "not accepted" from
"accepted with a lost response."

Gmail API does not meet these requirements as observed on 2026-10-20. If Google
adds an idempotent send/outcome contract, this decision must be revisited against
the actual API behavior, not against an assumption.

## Operational consequence for the pilot

An uncertain send is a **pilot stop condition**, not a recoverable state:

- stop new work for the project;
- disable the email runtime and its trigger through the approved owner path;
- do not clear or manually delete the reconciliation block;
- do not resend, and do not retry the same envelope under a new execution;
- preserve the database, admission/outbox/receipt/readback evidence, Gmail state,
  and bounded diagnostics;
- inspect the exact attempt and record the incident factually.

If the pilot must continue after an uncertain send, that requires a new project
or isolated instance and explicit authorization. The uncertain attempt and its
block remain historical evidence. Operator review, recipient confirmation,
search absence, elapsed time, or a new deployment are not `no_effect` evidence
and must not be used to clear the old block.

## Rejected alternatives

The following are not sufficient, alone or in combination, and must not be
implemented as block-clearing evidence:

- a complete bounded search with no match, or the absence of a `nextPageToken`;
- a thread scan, message-ID search, or readback by ID that finds nothing;
- Gmail/Workspace audit-log absence or an eventual export;
- recipient confirmation that no message arrived;
- elapsed time or repeated failed readbacks;
- claim expiry, authority revocation, trigger disablement, or property changes;
- deleting or recreating the GAS project, deployment, or database row;
- an operator assertion, a digest, a credential, or a nonempty evidence reference;
- retrying the send and treating a later success as proof about the earlier attempt;
- fabricating a `gmail_id` or marking the outbox `sent` without provider evidence.

## Scope and verification

This is a design decision, not a test gap. No amount of integration testing can
establish a fact that the Gmail/GAS boundary does not expose. The existing
behavior remains unchanged: exact readback plus `record` is the only supported
block-clearing path; absence, pagination, duplicates, and failed readback remain
`uncertain`; and a blocked project cannot admit a new send or acceptance.

Any future change to this decision requires a new reviewed design, a provider
contract that satisfies the facts above, a separate recovery authority, and
native PostgreSQL evidence for exact binding, replay, divergence, sender
termination, and fail-closed ambiguity.
