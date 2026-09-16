# Celestan vNext MVP — Authoritative Completion Plan

**Status:** authoritative implementation and qualification plan

**Purpose:** provide the repository-tracked sequence for completing and activating the Celestan vNext MVP.

## Core cutover rule

Build and qualify the complete vNext replacement while legacy remains authoritative. Only after the replacement is demonstrably activation-ready do we independently exclude legacy and activate vNext.

There must be no interval in which legacy authority has been removed while the replacement is incomplete.

## Final MVP definition

MVP is complete when a human can write ordinary Feedback and the system autonomously carries it through:

```text
Feedback
  -> durable receipt
  -> durable detection / wake
  -> Celestan coordinator
  -> interpret project + evidence
  -> no work OR justified work
  -> Work Unit
  -> mutation authority
  -> Execution
  -> one bounded worker
  -> result + external-effect refs
  -> canonical settlement
  -> Complete / Continue / Wait / Human-needed
  -> Feedback projection
```

An interrupted attempt must safely continue through a successor Execution without stale settlement or unreconciled duplicate external effects.

---

## Stage 0 — Audit closure map

Map every blocking audit finding to a concrete gate and permanent regression test where feasible. This is bookkeeping, not another architecture review.

The map must explicitly cover:

- assembled arm/control-plane routing;
- quiescence client handling of HTTP-200 business failures;
- signed requests bound to receiving script/deployment identity;
- deployment verification that reads HEAD before claiming HEAD equality;
- cross-WU Execution binding;
- monotonic fencing and stale settlement;
- crash takeover/retry bounds and explicit lease-expiry semantics;
- durable project/thread references;
- durable authority-decision references;
- mandatory transactional store APIs with no weaker fallback path;
- conflicting-content/same-event-ID parity between memory and PostgreSQL;
- immutable receipt RPC/index/real HTTP argument compatibility;
- all four Feedback adapters in the production bundle;
- Feedback reply preservation;
- stable Feedback identity across uncertain writes;
- polling beyond the first twelve rows;
- projection revision advancement and partial-write recovery;
- actual upgraded DB schema/grants, including orphan migration baseline;
- every reachable legacy admission path;
- the missing production outer-loop caller.

**Gate rule:** every blocker has an owner, acceptance test, and stage.

---

## Stage 1 — Control-plane and deployment consolidation

Make “what we test” equal “what we ship.”

### 1A. Production bundle correctness

Build the exact assembled GAS bundle and test it, not merely source modules.

Prove:

```text
self-deploy-*            -> CT_GAS_DEPLOY
arm-vnext-cutover        -> CT_GAS_DEPLOY
quiesce-legacy-autonomy  -> CT_GAS_DEPLOY
assert-legacy-quiesced   -> CT_GAS_DEPLOY

ordinary federation ops  -> only their intended path
```

Include all four intended replacement Feedback adapters. A source file outside the authoritative bundle does not count as deployed.

### 1B. Control-request identity

Privileged signed requests must be bound to the intended receiving script/deployment identity. Wrong-script and wrong-deployment replay must fail closed.

### 1C. Business-result semantics

Distinguish HTTP transport success from operation success. An HTTP 200 carrying `REQUIRES_VNEXT`, `LEGACY_NOT_QUIESCED`, rejection, or another business failure must be interpreted according to the operation contract.

### 1D. Deployment truth

Do not assert `HEAD == LIVE == desired` unless HEAD was independently read.

A deployment receipt binds:

- source commit;
- workflow run;
- desired bundle hash;
- GAS version;
- deployment ID;
- observed HEAD;
- observed LIVE.

**Gate 1:** exact assembled artifact passes routing/identity/deployment tests and self-deployment still works.

---

## Stage 2 — Durable kernel integrity

Repair only responsibilities that genuinely belong in Runtime.

### 2A. Stable identity

Every durable object carries the identity required to prevent accidental cross-binding:

- project ID;
- thread/conversation ID where applicable;
- Work Unit ID;
- Execution ID;
- authority-decision/reference ID;
- fence/claim generation.

An Execution born under W1 cannot subsequently be persisted against W2.

### 2B. Transactional stores are mandatory

Any state transition requiring atomicity must use the transactional store contract. Remove weaker compatibility/fallback paths that can create half-transitions, bypass fencing, separate claim from Execution creation, or settle against stale state.

For the MVP, claim + Execution creation is atomic. If the transaction fails after a conceptual claim point, neither the accepted claim nor the Execution exists.

### 2C. Monotonic fencing

Once W1 advances from fence 5 to fence 6, E1/fence 5 can never settle again and E2/fence 6 is current authority. Fence regression is mechanically impossible.

Test persistence, settlement, continuation, takeover, and failure paths.

### 2D. Project mutation authority

Use:

> At most one current mutation authority per project. Mutation authority belongs to an active Execution claim, not permanently to a Work Unit.

Authority is acquired when an eligible WU is atomically claimed into an Execution; released on settlement, expiration, or explicit revocation. Waiting/Human-needed WUs do not retain mutation authority while dormant. Another eligible WU may proceed only when no current project mutation authority exists.

Test races between two different Work Units in one project.

### 2E. Terminal non-reactivation

Once a WU is terminal, stale wakes and continuations cannot reactivate it.

**Gate 2:** memory and PostgreSQL implementations agree on these invariants.

---

## Stage 3 — Receipt, event, and recovery integrity

Recovery must work both before and after a Work Unit exists.

### 3A. Feedback receipt durability

If a source write succeeds, the receipt commits, and the response disappears, retry recovers the same stable receipt identity rather than manufacturing another logical message.

A follow-up reply remains associated with the same durable thread while receiving its own revision/message identity.

### 3B. Event conflict semantics

Same event ID + same content is idempotent.

Same event ID + conflicting content is a deterministic conflict/error.

Memory and PostgreSQL behave identically.

### 3C. Pre-WU recovery

A durable receipt can exist without an evaluation or Work Unit. Such a receipt remains discoverable as unevaluated durable work.

Recovery cannot rely solely on Work Unit recovery.

### 3D. Post-WU recovery

```text
W1 -> E1 -> lease expires/crash -> takeover -> E2 / newer fence
```

Recovery attempts count toward an explicit bound. Lease expiry has defined semantics; it is not merely an age check.

When the recovery limit is exhausted, persist a Human-needed / Needs-review outcome with actionable diagnostics.

### 3E. External effects

Do not promise general exactly-once side effects.

For the MVP worker require:

- stable ID for each intended external effect;
- provider idempotency where available;
- authoritative inspection before retry where idempotency is unavailable;
- no overlapping mutation after takeover where preventable;
- durable unresolved state when an uncertain effect cannot safely be reconciled.

The truthful contract is:

> One logical Work Unit; distinct Execution attempts; one authoritative Runtime settlement; external effects deduplicated or reconciled through their authoritative system.

**Gate 3:** fault injection proves no lost receipt/work and bounded, fenced recovery.

---

## Stage 4 — Faithful Feedback subsystem

Prove the complete replacement Feedback path:

- all replacement GAS adapters are in the real bundle;
- immutable receipt RPC uses the real index/schema and actual HTTP parameter names;
- replies are preserved;
- stable identity survives uncertain writes;
- polling progresses beyond twelve rows;
- cursor/progress cannot permanently strand later rows;
- no-work evaluations persist without creating a WU;
- projection advances revisions correctly;
- partial projection/metadata writes retry safely;
- projection retry does not redo substantive work.

The durable human model is:

```text
Feedback evidence -> Receipt -> Evaluation -> optional Work Unit -> durable result -> Projection
```

Not every Receipt creates a Work Unit.

**Gate 4:** Feedback A/B/C works faithfully under retries and multi-revision threads.

---

## Stage 5 — Name the autonomy mechanism

Provide one bounded mechanical pump, conceptually:

```text
runVnextPump()
```

It only discovers durable opportunities:

- unevaluated Feedback receipts;
- due continuation/wait conditions;
- expired claims eligible for recovery;
- pending projection retries.

For each opportunity it emits/adopts a durable wake and invokes the coordinator.

It does **not**:

- decide what work matters;
- create substantive Work Units directly;
- choose workers;
- interpret Feedback;
- judge completion.

One simple periodic trigger is sufficient for MVP, supplemented by event-driven invocation where already available. Durable records, not cron delivery, are authoritative; a missed trigger is repaired by the next pump.

**Gate 5:** a missed pump invocation may delay work but cannot lose it permanently.

---

## Stage 6 — Build the complete replacement path, disabled

The missing production outer-loop caller is an implementation blocker, not a reason to leave the replacement incomplete.

Ownership:

| Component | Owns |
|---|---|
| Celestan coordinator | interpret evidence, reconstruct semantic context, select/create justified work, choose capability, judge worker result |
| Runtime | identities, claims/fences, executions, authority validation, atomic transitions, waits, recovery eligibility |
| Worker | bounded authorized substantive action and external-effect refs |
| Feedback adapter | human evidence ingress and durable response projection |

`runCelestanTurn()` coordinates these responsibilities without moving Celestan judgment into the Runtime kernel.

### Canonical state mapping

Do not create a second state machine.

- **Complete:** WU becomes terminal.
- **Continue:** same WU remains non-terminal/actionable; durable continuation creates another opportunity.
- **Waiting:** WU remains non-terminal; continuation condition persists; no current mutation authority.
- **Human-needed:** specialized waiting condition + human-visible question; no current mutation authority.
- **Execution failed/recoverable:** Execution is terminal-failed; WU remains recoverable.
- **Recovery exhausted/uncertain external effect:** WU becomes Needs-review/Human-needed under the same canonical model.

### One MVP worker

Input:

```text
project
work_unit
execution
objective
authority
context/evidence refs
fence
external-effect identities
```

Output:

```text
result
evidence refs
effect refs
continuation suggestion
execution disposition
```

The worker never directly schedules itself or creates successor Executions.

**Gate 6:** complete replacement path exists, but autonomous production admission remains disabled.

---

## Stage 7 — Isolated complete vertical-slice qualification

Before touching legacy authority, qualify the complete new system against real-compatible infrastructure.

Use isolated PostgreSQL/Neon infrastructure for destructive races and fault injection, including the actual Data API argument and database-role boundary.

Inspect production schema/grants separately, including the orphan migration baseline. Do not assume migration files describe production reality.

Required traces:

1. No-work Feedback -> durable Evaluation + response, no WU.
2. Real work -> WU/E1/worker/settlement/response.
3. Follow-up reply -> same thread + revision-2 projection.
4. Receipt committed, response lost -> safe retry.
5. Projection partially acknowledged -> projection recovery only.
6. Two different WUs race for one project -> one mutation authority.
7. Wrong-project Execution -> reject.
8. Insufficient-authority Execution -> reject.
9. E1 crashes -> E2 takeover -> same WU/newer fence.
10. E1 attempts stale settlement -> reject.
11. External mutation succeeds, settlement is lost -> inspect/reconcile, do not blindly repeat.
12. Terminal WU receives stale wake -> remains terminal.
13. Recovery bound exhausted -> actionable Human-needed/Needs-review.
14. Polling beyond twelve rows -> later Feedback still advances.
15. Conflicting same-event ID -> deterministic failure in both stores.

**Release-qualification gate:** only after all required traces pass is the replacement activation-ready.

---

## Stage 8 — Deploy replacement while still disabled

Ship the qualified replacement to production while:

```text
vNext implementation = deployed
vNext autonomous admission = OFF
legacy authority = unchanged
```

Read back:

- correct GAS bundle;
- correct DB schema/grants;
- intended adapters present;
- coordinator/pump version present;
- activation remains disabled.

---

## Stage 9 — Prove legacy exclusion before activating vNext

A stored marker alone does not prove exclusion.

Independently verify:

- normal legacy scheduler admission is blocked;
- direct execution path is blocked;
- legacy recovery is blocked;
- federation/alternate admission cannot independently mutate;
- known GAS trigger is absent;
- trigger recreation does not restore authority;
- no live legacy writer exists;
- every other audit-identified mutation surface is disabled.

Test retired entrypoints first in a safe/isolation mode so a broken guard cannot launch real production work.

Then perform the live cutover operation:

```text
arm-vnext-cutover
  -> VNEXT_ARMED

quiesce legacy
  -> LEGACY_QUIESCED

assert
  -> LEGACY_QUIESCED
```

The conclusion is:

> Quiescence marker + independently verified exclusion conditions = legacy authority closed.

---

## Stage 10 — Activate vNext admission

The authority transition is:

```text
replacement deployed + qualified
          -> legacy independently excluded
          -> legacy quiescence asserted
          -> vNext admission enabled
```

There is no incomplete-replacement interval.

---

## Stage 11 — Bounded live MVP qualification

Production proves integration, not destructive fault-injection mechanics.

Run a small predetermined set:

- **Live A — no work:** natural Feedback -> receipt -> evaluation -> visible response, no WU.
- **Live B — real bounded work:** natural Feedback -> WU -> E1 -> actual useful external result -> settlement -> visible response.
- **Live C — follow-up:** human reply -> same durable thread -> new revision -> correct continuation/result.
- **Live D — Waiting/Human-needed:** Celestan identifies a legitimate missing condition, asks, then resumes after response.
- **Live E — controlled interruption:** only when safely inducible without risking destructive duplicate external effects; otherwise retain the destructive mechanics proof from isolated qualification.

Throughout:

```text
legacy operational mutations = 0
```

---

## Stage 12 — MVP declaration

Declare the MVP complete only when there is evidence for all of the following:

- durable natural-language Feedback ingress;
- durable processing before a WU exists;
- autonomous detection without “continue”;
- correct project/thread reconstruction;
- durable authority decision;
- legitimate no-work behavior;
- Work Unit identity surviving executions;
- only one current project mutation authority;
- cross-WU persistence rejected;
- monotonic fencing;
- stale settlement rejected;
- bounded E1 -> E2 recovery;
- recovery exhaustion surfaced visibly;
- external effects reconciled rather than falsely claimed exactly-once;
- waiting/human continuation;
- Feedback revision/reply/projection;
- production bundle equal to qualified bundle;
- production schema/grants understood;
- legacy mutation authority actually excluded;
- vNext as the only autonomous admission path;
- one real useful objective reaching a human-visible outcome.

Then, and only then:

> Celestan is operating on vNext within the MVP envelope.

---

## Explicitly outside MVP

These are not prerequisites for MVP completion:

- Observer semantic lifecycle;
- Work Unit Convergence;
- expanded Federation;
- multiple workers;
- multi-agent orchestration;
- sophisticated model routing;
- generalized capability registry;
- general exactly-once side effects;
- arbitrary project systems;
- Script Properties cleanup;
- complete historical code deletion;
- full self-improvement loop;
- production-scale HA.

The intended kernel remains lean: durable WUs, Executions, claims/fences, wakes, waits/continuations, evidence refs, and transactional transition integrity. Cognition and external-system truth remain outside Runtime.

---

## Gate policy

> Passed gates stay closed unless new evidence invalidates them; new evidence reopens only the affected gate.

This preserves forward progress without pretending later evidence cannot overturn a premise.

## Authoritative sequence

```text
Audit coverage
  -> control-plane consolidation
  -> kernel / receipt / recovery integrity
  -> faithful Feedback
  -> autonomy pump
  -> complete disabled vertical slice
  -> isolated qualification
  -> deploy disabled
  -> legacy exclusion
  -> vNext activation
  -> bounded live qualification
  -> MVP
```

This document supersedes the earlier cutover and MVP completion sequencing. It does not supersede already-established architectural contracts unless a later gate produces evidence that invalidates one.
