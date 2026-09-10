# First Autonomous Objective Loop

## Status and authority

2026-09-08: **active milestone; first bounded local truthful-state guard implemented**.
This is not an autonomous objective success, a deployment, or a completed state migration.
CT-Runtime owns execution mechanics; Celestan owns task judgment and stopping decisions;
Observer owns reflection and semantic interpretation. The objective-turn contract does not
own scheduling or Runtime orchestration.

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

- `continue`: factual progress and a **continuation** with `mode: immediate` naming
  the useful next direction. The turn contract does not choose a wake mechanism,
  retry policy, or scheduler representation.
- `waiting`: no presently justified work, plus a **continuation** with `mode: condition`
  naming the change in reality that would make continuation worthwhile. An optional
  question can explain what human input is needed. This is the same semantic concept
  as immediate continuation, not a second dependency/scheduling system.
- `done`: objective-specific completion evidence, verified against supplied facts.
  A done claim remains non-authoritative; downstream independent judgment decides
  whether it becomes authoritative completion.

The standalone `lib/objective-turn.mjs` contract intentionally has no dependency on
`lib/runtime.mjs`, does not persist turns, schedule wakes, resolve conditions, or
finalize Work Units. Receipt of a model response, process exit, artifact hash
verification, transport checkpoint, or physical execution completion is insufficient
by itself. A stale turn must not update a cursor, append contradictory completion,
or finalize after another owner has taken over. End-to-end host/fence/completion proof
remains undone.

### 3. Same-objective conversation events

Persist messages, replies, questions, and updates as idempotent events under one
objective. Separate event/reply revision from objective creation. Define explicit
new-objective versus continue-existing-objective behavior and bind sheet projection
to the exact objective/message cursor. Current reply revisions still admit new work
orders, and thread/revision lookup is not a complete conversation identity contract.
No change to that behavior is claimed in this slice.

## Migration/cutover proof (isolated fixture semantics, 2026-09-08)

`gas/gas_migrate.js` implements inert version-gated (`objective-state-v1`) reconstruction
plus entry-path cutover checks; `test/gas-migration-proof.test.mjs` exercises copied,
sanitized fixture semantics in VM doubles. This is not a full current-row migration,
does not fence already in-flight writers, and is not a live copy or cutover proof.

Pass conditions and results:

- **Identity.** An admitted feedback order reconstructs to the same stable objective id
  across repeated plans; unmapped sheet rows are listed, never manufactured into orders.
- **Journal reconciliation.** Legacy history is never rewritten. Terminal acknowledgement
  and artifact-verification records reconstruct to `needs-review`; every journal entry
  carries `objective_done: false`. Entity tables are untouched by migration (only
  `observer_ledger` journal rows and `schema` checkpoint/cutover rows are written).
- **Rerun boundary.** Stable journal ids prevent duplicate journal rows after a simulated
  crash, but reruns still write checkpoint rows/churn. This does not prove a clean rerun
  is mutation-free. Dry runs write nothing.
- **Needs review.** Legacy completed/Verified diagnostic outcomes map to the explicit
  review disposition, never to accomplished objective. There is still no `done` value
  anywhere in the new semantics.
- **Entry-path cutover check.** With a cutover naming an objective, the exercised legacy
  recovery and dispatch entry paths perform no mutation or execution start
  (`cutover-new-authority`). This is not in-flight writer fencing; unnamed objectives
  and absent cutovers retain legacy behavior.
- **Negative.** Forked revision chains are flagged with an ambiguity marker, dangling
  references are flagged, and unrecognizable rows fail closed to `needs-review`.
  An ambiguous winner is not safe promotion authority.

Remaining gaps: no new-writer execution path exists yet, so the fence currently guards a
door with nothing behind it; live cutover is not activated and must follow the host proof;
conversation cursors remain deferred by plan; the Sheets lock still does not make
multi-write transitions transactional (stable journal ids bound the damage, they do not
remove the window).

## Historical reported live evidence (2026-09-08, post-Slice-1)

`gas-live-inspect.yml` (PRs #20, #21) runs read-only `inspectFeedbackObjectives`
through the shared clasp gate: disposition facts only, zero writes, no content.

- 21:52 UTC (pre-tick): row-5 order `feedback-work-order_cdf3...` is `completed`
  with 49 physical executions — it finished via the pre-Slice-1 artifact path before
  deploy, so the capacity-wait gate does not and must not apply to it.
- 21:58 UTC (after the 21:57 post-deploy tick): order still `completed`, executions
  still 49 (zero new), polls quiet (`admitted_count: 0`, header ok), and row 5
  projects `Needs review` — the false-completion projection is gone live.
- The raw historical wake-revision listing contains 51 rows referencing the completed
  order and 6 referencing the invalid malformed order. Those are revision counts, not
  57 current active wakes; current-wake deduplication and retire counts were not exposed
  by this inspection, so no claim about a drain rate is made here.
- Cutover authority is `legacy` everywhere: no cutover active, as intended.
- NOT yet proven live: the `execution_capacity` wait transition itself — no
  nonterminal objective exists. It awaits the next admitted objective or the
  qualified-host connection (which will exercise it truthfully when capacity is
  absent).

## Qualified host draft contract (not host proof)

Northflank remains the production-route host but its live proof explicitly requires
human authorization (token, project, image, secret groups), so the first proof targets
this machine with no new auth or spending. `lib/objective-turn.mjs` now defines a pure
turn contract with bounded identifiers/evidence, realpath-contained evidence integrity
checks, and a minimal reply projection as a draft contract. These checks verify supplied
facts; they do not persist turns, fence owners, schedule wakes, or authorize a done claim.
The filesystem completion journal and synthetic process fixture were removed.
The local contract assumes a trusted, quiescent workspace during evidence verification;
it is not a concurrent hostile-filesystem sandbox. Still open: binding a GAS-waiting
objective to a local turn across systems, scheduler integration for quiescence, host
qualification, and the production-route authorization decision.

## Verification and limits of evidence

- **CI passed on the current reshaped head `673d3dc` (September 10, 2026): both the push and pull-request jobs are green.** This verifies the reshaped branch at CI level; the skipped external database/S3 integrations still do not establish new Neon, Postgres, S3, or live-service evidence.
- `test/objective-turn-proof.test.mjs` covers the standalone continuation boundary,
  malformed continuation shapes, symlink escape, evidence hash mismatch, successful
  and failed execution-manifest evidence, and the non-authoritative done projection.
- `test/gas-runtime.test.mjs` executes the real GAS state/trigger/V8 source in VM
  service doubles. Existing regressions cover real feedback intake and sheet projection,
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
- `git diff --check` passed on the current reshaped head. Only local source, tests, and documentation were changed.

Live Sheets, Script Properties, trigger registry, latest workflow run, deployed code,
and qualified host capacity are **unknown in this session**. Historical live reports and
STATE proof records are not refreshed by these tests. Host qualification and atomic
fencing remain unproven. Before any future external effect or live
blocker decision, inspect the newest workflow evidence and `diagnoseFeedbackInbox`
(Script ID and configured spreadsheet properties); configure/setup only on an
observed mismatch. Canonical GAS writes remain GitHub Actions-only. No local
`clasp push` is an operator path.
