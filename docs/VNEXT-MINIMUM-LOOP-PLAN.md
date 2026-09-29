# Celestan vNext MVP — minimum durable autonomous loop

Updated: 2026-09-27. Status: revised implementation plan, not an implementation or deployment claim.

This revision supersedes the 2026-09-17 executive-loop plan's mandatory delegation, stage-per-wake discipline, universal software quality-cycle qualification, and architecture-first completion sequence. It incorporates the user's new direction: complexity must earn its keep through operating evidence. Existing project requirements and authority limits remain binding.

The saved audit at `6fe20d7f80123f061916a5007e5d8845a952c39d` is historical evidence. Current repository, PR, deployment, schema, and authentication status were not reverified for this document update. Reconcile them before implementation; do not redo proven work or treat historical findings as current defects.

## 1. The milestone

> Make Celestan capable of repeatedly advancing one real project across disposable executions without the human having to restart or orchestrate it.

The next milestone is **Get Celestan alive. Then let Celestan help build Celestan.**

The MVP hypothesis is that continuity can live outside individual executions. Its proof is sustained useful operation, correct reconstruction, and recovery—not completion of a mature autonomous architecture.

## 2. The operating loop

1. Wake from a real scheduler or human-input signal.
2. Reconstruct Celestan's identity, entrusted scope, project state, unresolved effects, and relevant current facts.
3. Decide what useful progress is justified now.
4. Do or delegate one meaningful, bounded piece of work.
5. Check what actually happened against the intended outcome.
6. Persist what is true now, what was learned, what remains, and whether/when another inspection is needed.
7. Stop. A future execution resumes from durable sources.

One meaningful piece may include inspection, a small fix, and verification in the same turn. It need not stop at an artificial stage boundary. A wake may instead reconcile an earlier attempt, answer input, record a specific blocker, or conclude that nothing is currently justified. Do not manufacture work to keep the system busy.

The Goal → Understand → Break down → Choose → Do → Check rhythm informs judgment; it is not a compulsory sequence of stored stages.

## 3. Eight protected invariants

| Invariant | Minimum implementation obligation |
| --- | --- |
| Durable identity and project state | Canonical identity references, stable project/objective identity, entrusted scope, current state, and recoverable history survive process loss. |
| Cold reconstruction | A fresh process can locate those sources, understand prior actions and unresolved uncertainty, and choose its next action without hidden session context. |
| No duplicate ownership | Claims, revisions, and fencing reject conflicting or stale decisions. For the pilot, serialize substantive mutation within one project, including across distinct objectives. |
| Bounded execution | Enforce time/tool or cost limits outside the model where applicable; bound retries and recovery attempts. A stalled process cannot keep effective authority indefinitely. |
| Durable result recording | Persist results, evidence references, state changes, and next inspection eligibility consistently. Preserve attempt history. Crashes before settlement leave recoverable uncertainty rather than fabricated success. |
| A way to wake again | A deployed periodic supervisor discovers durable eligible work and missed signals. No dependency on a surviving chat or manually scheduled continuation. |
| A way to receive human input | One working interface records stable receipt/thread/revision identity, preserves input, and exposes durable responses and specific questions. Receipt is distinct from successful processing. |
| Evidence of actual outcomes | Bind evidence to the exact artifact or external operation. Distinguish attempted, observed, verified, incomplete, and uncertain results. Process success alone does not prove objective success. |

Existing authorization remains the ceiling. These invariants do not grant additional spending, destructive-action, merge, release, or production authority.

Database fencing does not stop an old external worker. Before overlapping takeover, establish that the previous worker is stopped, completed, or otherwise unable to continue conflicting effects. Inspect external reality before repeating an operation with an unknown outcome. Exactly-once external effects are not assumed.

## 4. The smallest operating envelope

Start with one entrusted project, one active substantive attempt, one execution backend, one durable store, one human interface, and one periodic wake source. Prefer already working components. Event-driven wakes are optional if polling meets the pilot's needs.

Celestan may act directly through existing capabilities or delegate through one already qualified bounded worker. Delegation is a choice, not a condition of being Celestan. Do not build a worker framework merely to enforce an executive/worker distinction. If the selected backend is asynchronous, its stable dispatch identity, run inspection, durable result, and uncertain-launch recovery are required for that path.

Runtime owns mechanical continuity: durable admission, ownership, bounds, settlement, and future inspection. Celestan owns substantive judgment: what matters, what to do, whether the evidence is sufficient, and what follows. Feedback transports input and responses; it does not become another orchestrator.

Reuse existing Work Units and execution records where useful. A logical objective retains its identity across attempts; each physical attempt has its own identity. This does not require defining a mature Work Unit lifecycle now.

## 5. Minimum recoverable information

These are information requirements, not new tables, services, or a mandatory schema redesign.

| Durable information | Minimum content |
| --- | --- |
| Identity and scope | Canonical identity/project references, objective, limits, authority, and a practical finish condition. |
| Current work | Stable logical ID, revision, current disposition, unfinished work, unresolved effects, and any active attempt. |
| Attempt | Unique execution ID, objective/project binding, ownership/fence, bounded intended action, start/outcome, and external run/operation references when needed. |
| Result and learning | What changed, evidence, verification result and limits, concise operational lesson, and remaining work. Preserve prior attempts rather than overwriting them. |
| Continuation | Next useful action or decision, reason, due time or observable wait condition, retry count/bound, or specific human question. |
| Human interaction | Stable receipt/revision/thread, full input, processing state, durable response, and response-delivery state. |

Use the existing canonical dispositions. Display meanings such as actionable, waiting, human-needed, complete, and uncertain need not become a second state machine. Record operational rationale, not private deliberation.

Settlement must not leave accepted progress with no recoverable future inspection. Use the existing transaction plus durable eligibility scanned by the supervisor, or an existing transactional outbox if necessary. Do not introduce both without need. A delivery retry must not repeat substantive work.

## 6. What changes from the previous plan

| Previous requirement | Revised treatment |
| --- | --- |
| One lead, one delegation, one stage, one judgment per wake | One justified bounded piece of progress per wake; direct work and delegation both valid. |
| Lead never implements | Removed. Preserve authority and verification boundaries without a universal role separation. |
| Mandatory dev → independent review → repair → QA qualification for MVP | Removed as a universal Runtime gate. Honor existing repository/project rules and choose verification proportional to the actual work. |
| Stage advancement waits for a later wake | Removed. A small inspect → fix → verify action may finish within one bounded execution. |
| Work-order/report/decision architecture for every task | Reuse a minimal attempt/result record; add delegation-specific fields only on the selected delegation path. |
| Full planning hierarchy and lifecycle design | Deferred until recurring operating problems justify them. |
| General conditions, capability selection, continuation and Observer systems | Use simple due times, known capabilities, durable notes, and existing evidence first. |
| Broad cleanup before declaring completion | Remove competing authority before activation; defer inert code and historical cleanup. |

Independent review can still be necessary for a particular change. Removing a universal pipeline does not waive branch protections, project instructions, or an already-required review. Verification remains mandatory; a successful worker report is not sufficient evidence by itself.

## 7. Implementation sequence

### Step 0 — Reconcile only the path we intend to run

Inspect current source, tests, deployed entry points, schema/grants, and the historical findings. Choose the pilot, execution backend, durable store, scheduler host, and human interface. Define a bounded first objective and its finish condition within existing authority.

For each relevant finding, record: current evidence; fixed/open/unverified; protected invariant affected; whether reachable on the selected path; and the smallest correction or exclusion proof. Preserve historical finding IDs. Reuse passing work, including prior atomicity and authority fixes if currently verified.

**Exit:** one concrete entry-to-result-to-next-wake path, known activation blockers, and a short implementation list. Do not begin a general architecture audit or reopen qualified work without a reason.

### Step 1 — Connect the minimum loop

Wire human receipt and/or durable due work to a real bounded caller. Load identity and project context, claim ownership, execute one justified action, verify it, persist the outcome and continuation, and return. Wire the periodic supervisor to discover the next eligible inspection and pending responses.

Fix only gaps required to uphold the eight invariants on this path. Reuse existing persistence and capabilities. Keep the candidate inactive while building and testing in isolation.

**Exit:** a fresh execution makes useful progress, ends, and a separate automatically triggered execution reconstructs and continues from the persisted result. The human does not supply an internal Work Unit ID or restart the process between turns.

### Step 2 — Prove continuity and essential recovery

Run focused integration tests against the selected real store/backend, using isolated destructive probes. Verify:

- Cold start after a completed turn reconstructs the same objective and evidence.
- Duplicate input/wakes and overlapping attempts, including different objectives on the same project, do not create competing mutation ownership.
- A crash after receipt leaves input eligible for processing; failed settlement does not accept half a state.
- A crash or lost response around an external effect causes inspection/reconciliation before retry.
- Expired ownership rejects stale settlement and cannot allow an old worker to keep conflicting write access during takeover.
- Persisted progress remains discoverable if an immediate wake signal is lost.
- Human follow-up resumes the same objective; response-delivery failure retries delivery without rerunning work.
- Execution and retry limits actually stop unproductive cycling; waiting work has a durable reason and a path to reinspection.

For a synchronous path, do not build asynchronous delegation merely to test it. Qualify that recovery only if the selected path uses it.

**Exit:** evidence for the protected invariants and truthful limitations. A unit test is not proof of deployed operation.

### Step 3 — Activate one exclusive path

Identify the exact release, schema, configuration, scheduler, and identity sources. Prove retired entry points cannot admit conflicting work and reconcile in-flight legacy effects. Verify authentication and business-level responses on the actual selected route; HTTP 200 or a mode flag alone is insufficient.

Enable the qualified path within existing deployment authority. If qualification fails, stop new admission, preserve evidence, and reconcile active effects. Do not automatically reactivate a competing legacy writer.

**Exit:** a real human message produces an observed bounded result and a future automatic wake, with no legacy orchestration participating. Inert legacy code may remain.

### Step 4 — Observe one real project for several days

Use SuperSimpleGames as the proposed pilot, subject to confirmed access and entrusted scope. A broad request such as “Improve SuperSimpleGames” should prompt Celestan to inspect current project evidence and choose a bounded improvement with a testable finish condition. It must not invent an endless mandate, disregard protected behavior, or require Anahi to choose every next action.

Recommended initial observation window: three consecutive days of scheduled operation, including multiple fresh executions, a controlled restart, and a human follow-up. Treat this duration as a trial parameter, not a permanent architecture rule. If the objective finishes earlier, verify stable quiet behavior and follow-up rather than manufacturing extra work.

Keep a small durable record of actions/results, reconstruction failures, duplicate/conflicting effects, recoveries, missed progress, human interventions, and recurring friction. Separate normal observation from manual rescue; a rescued run does not count as autonomous continuity.

**Exit:** the operational acceptance test below passes. If it fails, repair the observed cause and repeat the affected proof; do not respond by adding a generic subsystem without evidence.

## 8. Operational acceptance test

The MVP is complete when the human can entrust one real objective and later inspect evidence that:

1. Celestan woke repeatedly without manual restarts or turn-by-turn direction.
2. Each fresh execution recovered its identity, scope, prior outcomes, and relevant project facts.
3. It selected and completed useful bounded work, or waited/stopped for a justified reason.
4. Changes and completion claims were checked against actual results and exact artifacts.
5. Attempts and results remained durable across process loss, with no observed lost accepted state, duplicate logical effects, or competing mutation ownership.
6. Human input and replies were preserved, associated with the correct objective/thread, and surfaced faithfully.
7. It reached a verifiable bounded completion, a genuine blocker, or one specific request for missing human input. A blocker must include evidence of what is missing and why autonomous progress cannot continue.
8. The next action or reason to remain quiet is recoverable, with no busy loop or repeated request for orchestration.

Report the observed scope and limitations. Several days without failure support the MVP hypothesis; they do not prove universal reliability. Documentation, green unit tests, or a single manually launched successful turn are insufficient on their own.

## 9. Historical audit obligations under the smaller scope

Retain the earlier plan's finding references without treating all subsystems as launch dependencies.

| Historical findings | Disposition before pilot activation |
| --- | --- |
| F01, F13, F14 — identity, authority/history, atomic persistence | Verify the active path upholds these invariants; unresolved reachable defects block activation. |
| F03, F04, F15, F16 — routing, status, readback, target binding | Qualify the exact selected entry/control path. Unused paths may be excluded rather than rebuilt. |
| F05, F06–F09, F11–F12 — Feedback packaging, receipts, recovery, identity and projection | Qualify what the selected human interface uses. If Feedback is selected, these obligations remain; another interface is not an excuse to silently lose input. |
| F02 — missing production caller | The real caller, scheduler, and multi-wake pilot are the central deliverable. |
| F10 — legacy exclusion | No competing admission or unresolved overlapping effects at activation. |
| F18 — upgraded schema uncertainty | Establish actual schema and grants before relying on durable-store guarantees. |
| F17, F19, F20 — competing subsystems and dead contracts | Remove active conflicts and false activation gates. Defer inert cleanup. |

A finding can be deferred only with a concrete explanation of why it is outside the operating envelope and cannot compromise it. Simplification reduces scope; it does not relabel reachable safety defects as optional.

## 10. Let operating evidence justify the next architecture

Defer generic workflow engines, mandatory planning hierarchies, model/capability ranking, recursive or parallel delegation, universal review topology, generalized continuation compaction, Observer lifecycle expansion, and broad memory redesign.

| Repeated observation | Smallest improvement to investigate |
| --- | --- |
| Repository reconstruction repeatedly consumes the turn | A focused repository-inspection capability or reliable compact index. |
| Implementations pass self-checks but fail later examination | Independent review for that class of change, with measured benefit. |
| Continuations become too large or omit essential facts | A bounded reconstruction summary with source references. |
| Overlapping wakes expose an ownership gap | Repair the violated ownership invariant immediately. |
| Useful work stalls after persisted results | Repair durable wake eligibility or supervisor discovery immediately. |
| The same lesson repeatedly prevents a mistake | Promote it into a small durable instruction or capability. |

Celestan may identify and propose improvements to its own machinery from these records, then implement bounded changes within its authority and existing project controls. It cannot silently weaken its authority, ownership, or verification constraints. Observer and Foundry can later consume the same evidence without becoming prerequisites for collecting it.

The next implementation task is therefore to reconcile the selected path and close the smallest gap preventing **wake → useful checked progress → durable state → automatic future wake**. Architecture beyond that must justify its cost through reality.
