# First Autonomous Objective Loop

## Status and authority

2026-09-08: **active milestone; first bounded local truthful-state guard implemented**.
This is not an autonomous objective success, a deployment, or a completed state migration.
CT-Runtime owns execution mechanics; Celestan owns task judgment, stopping decisions,
and `requested_next_wake`; Observer owns reflection and semantic interpretation.

This work was local only. The starting Git worktree was clean at `af2f48a`.
No commit, push, PR, stash, external service inspection, deployment, or live mutation
was performed. No runtime-state fixture was added to the repository.

## Source audit and bounded changes

| Surface | Source finding | Local disposition |
| --- | --- | --- |
| `gas/gas_state.js` | Entity mutations append full revisions; `list` exposes history, while `get` selects a latest revision. This is not one physical current row per entity. | Layout preserved. A single-lock capacity-wait operation checks current terminal state, persists the named wait and response, and appends a bounded factual `objective_capacity_wait` Chronicle entry when transitioning. Repeated unchanged waits do not add revisions or journal entries. |
| `gas/gas_trigger.js` | Recovery iterated historical work-order revisions, allowing obsolete checkpoint/deferred states to schedule recovery. Dispatch checked completed but not invalid orders. | Recovery deduplicates order IDs and consults current state. Objectives wait instead of scheduling diagnostic recovery; due objective wakes are retired. Completed/invalid orders and waiting diagnostics do not restart via due wakes. Existing terminal wake records are not treated as missing scheduling decisions. GitHub proof recovery remains separate. |
| `gas/gas_v8.js` | Generic wakes requested only “Return a bounded factual acknowledgement.” A later Drive verification marked the work order completed. The actual feedback goal was not executed. | Only explicit `execution_kind: acknowledgement_diagnostic` or the existing `launch_context.proof: gas-a-b` proof enters that path. Objective type and feedback provenance override diagnostic flags. The objective guard runs before physical execution creation and before continuation reconstruction/artifact verification, including legacy checkpoints. |
| `gas/gas_feedback.js` | Intake mapped an 8-column sheet to a separate durable payload, but claimed one physical execution at admission; completed records projected as Verified. Replies/revisions create more work orders. | New intake is typed `objective` with zero physical executions. Capacity-wait responses explain the missing executor and absence of verification. Legacy completed feedback is projected as Needs review without changing its terminal durable lifecycle. Conversation identity redesign is deferred. |
| `gas/gas_bootstrap.js` | A/B proof setup uses the explicit `gas-a-b` launch marker; `runCurrentGasProofWake` resumes that proof. GitHub dispatch/inspection has a separate `step: github` wait. | Existing diagnostic entry points remain distinct; they are not objective executors. No bootstrap or GitHub deployment authority changes. |
| `gas/gas_federation.js` | Advisory consumption takes canonical authority, writes transport evidence/local continuation, and submits a fenced checkpoint. It does not execute the objective. Previously its checkpoint claimed evidence persistence even when the evidence write failed. | Checkpoint completion labels are transport facts; evidence persistence is listed only when a reference exists. `objectiveExecuted` and `objectiveCompleted` are explicitly false. Canonical checkpoint/fence protocol remains unchanged. |
| `lib/gas-federation.mjs`, `lib/federation.mjs`, `lib/opencode-federation-bridge.mjs` | Notification acceptance/checkpointing, canonical claims, takeover, and explicit finalization are coordination boundaries. They are not a qualified objective-turn implementation or semantic completion verifier. | No Node coordination or SQL changes. Existing federation continuity evidence must not be presented as objective accomplishment. Host completion evidence validation remains a future gate. |

Feedback provenance is retained in existing work-order payloads even when a legacy
continuation says `next_operation: verify` or contains `completed: ['A model']`.
Those old fields and artifacts are preserved as history, not erased or promoted to
objective evidence. No unverified legacy terminal record is automatically reopened.

## Three bounded slices and acceptance gates

### 1. Truthful state

Implemented here: separate objectives from diagnostic acknowledgement, named
`execution_capacity` wait, useful sheet response, terminal non-reentry, and no
automatic objective execution retries while capacity is absent. Admission retains
one initial durable human wake; safety polling retires it rather than running the
diagnostic. Repeated polls still maintain the inbox/operational diagnostics; the
no-repeat claim concerns objective attempts and unchanged wait revisions, not zero
sheet or telemetry activity.

Remaining before this slice is complete:

- One current physical row per entity, with factual history in a separate journal.
- Explicit current continuation cursor and bounded attempt/deadline/backoff policy,
  including orphan/expired claims and scheduling failure. Diagnostic retries retain
  their existing behavior; this patch does not establish a universal retry bound.
- An isolated migration plan and proof using a copied, sanitized fixture: resolve
  duplicate revisions deterministically, preserve identity/evidence and terminal
  facts, reconcile counts/cursors/journal, exercise interruption and rerun, and
  establish rollback and a single-writer cutover fence before touching live state.
- Bound/index historical scans and add crash-window reconciliation. Sheets locking
  serializes writers but does not make the work-order write plus Chronicle append
  transactional; an interruption between them can leave a missing journal entry.
  Existing wake retirement also has best-effort event writes. These are not claimed
  solved by the local guard.

**No broad migration or live cutover is implemented or authorized here.**

### 2. Real Celestan turn

Connect a qualified host with explicit project, objective, model, agent, store,
capabilities, and repository identity. It must reconstruct the actual objective,
not substitute a proof prompt. Persist a typed turn result:

- `continue`: factual progress, current continuation cursor, and Celestan's validated
  requested next wake, with bounded retry accounting.
- `waiting`: named condition, useful human response/question, and the state-change
  signal required for resumption; no futile automatic retry.
- `done`: objective-specific completion evidence, verified against the current
  objective/cursor, and a current owner/fence guard at the terminal mutation.

Receipt of a model response, process exit, artifact hash verification, transport
checkpoint, or physical execution completion is insufficient by itself. A stale
turn must not update the cursor, append contradictory completion, or finalize after
another owner has taken over. End-to-end host/fence/completion proof remains undone.

### 3. Same-objective conversation events

Persist messages, replies, questions, and updates as idempotent events under one
objective. Separate event/reply revision from objective creation. Define explicit
new-objective versus continue-existing-objective behavior and bind sheet projection
to the exact objective/message cursor. Current reply revisions still admit new work
orders, and thread/revision lookup is not a complete conversation identity contract.
No change to that behavior is claimed in this slice.

## Migration/cutover proof (isolated, 2026-09-08)

`gas/gas_migrate.js` implements inert version-gated (`objective-state-v1`) reconstruction
plus a single-writer cutover fence; `test/gas-migration-proof.test.mjs` proves it against
copied-fixture semantics in VM doubles. No live state was touched and no cutover is active.

Pass conditions and results:

- **Identity.** An admitted feedback order reconstructs to the same stable objective id
  across repeated plans; unmapped sheet rows are listed, never manufactured into orders.
- **Journal reconciliation.** Legacy history is never rewritten. Terminal acknowledgement
  and artifact-verification records reconstruct to `needs-review`; every journal entry
  carries `objective_done: false`. Entity tables are untouched by migration (only
  `observer_ledger` journal rows and `schema` checkpoint/cutover rows are written).
- **Idempotent rerun.** A simulated crash between journal write and checkpoint update
  recovers on rerun via stable journal ids with zero duplicates; a clean rerun writes
  nothing. Dry runs write nothing.
- **Needs review.** Legacy completed/Verified diagnostic outcomes map to the explicit
  review disposition, never to accomplished objective. There is still no `done` value
  anywhere in the new semantics.
- **Single-writer cutover.** With a cutover naming an objective, legacy recovery performs
  no mutation, dispatch leaves its wake pending for the owning path, and execution
  starts nothing (`cutover-new-authority`). Unnamed objectives and absent cutovers keep
  exact legacy behavior.
- **Negative.** Forked revision chains are flagged with a deterministic winner; dangling
  references are flagged; unrecognizable rows fail closed to `needs-review`.

Remaining gaps: no new-writer execution path exists yet, so the fence currently guards a
door with nothing behind it; live cutover is not activated and must follow the host
proof; conversation cursors remain deferred by plan; the Sheets lock still does not make
multi-write transitions transactional (stable journal ids bound the damage, they do not
remove the window).

## Verification and limits of evidence

- `npm test` reported **230 tests, 226 passed, 0 failed, 4 skipped** (7 new migration-proof
  tests included). External database
  and S3 integration activation was disabled for this local run. The skipped Neon,
  Postgres runtime/Observer, and S3 tests provide no new live evidence.
- `test/gas-runtime.test.mjs` executes the real GAS state/trigger/V8 source in VM
  service doubles. New regressions cover real feedback intake and sheet projection,
  useful capacity wait, repeated safety polls, legacy verification checkpoint with
  conflicting diagnostic flags, generic fail-closed work, and completed/invalid
  historical revisions. No model/Drive objective work or physical execution occurs.
- Existing continuity, scarcity/fallback, Drive-root, and wake-fence tests now mark
  acknowledgement fixtures explicitly as diagnostics. Diagnostic A/B completion
  remains tested; a duplicate terminal call no longer creates a third execution.
- `test/gas-feedback-boundary.test.mjs` verifies the typed 14-field intake payload,
  zero physical executions at admission, and the unchanged human/header boundary.
- Federation contract tests pass, but the newly added transport fact labels do not
  constitute a live federation round trip or a dedicated injected-failure proof.
- `git diff --check` passed. Only local source, tests, and documentation were changed.

Live Sheets, Script Properties, trigger registry, latest workflow run, deployed code,
and qualified host capacity are **unknown in this session**. Historical STATE proof
records are not refreshed by these tests. Before any future external effect or live
blocker decision, inspect the newest workflow evidence and `diagnoseFeedbackInbox`
(Script ID and configured spreadsheet properties); configure/setup only on an
observed mismatch. Canonical GAS writes remain GitHub Actions-only. No local
`clasp push` is an operator path.
