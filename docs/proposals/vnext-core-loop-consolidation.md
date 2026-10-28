# vNext Core Loop — Consolidation and Improvement

**Status:** Proposed — audit required  
**Owner:** Celestan / vNext  
**Priority:** Core-loop reliability and effectiveness

## Objective

Improve vNext's ability to turn natural human goals into verified, durable progress while reducing unnecessary orchestration, model reasoning, execution overhead, and complexity.

Preserve the existing minimum loop and its separation of responsibilities:

- Celestan owns intent, substantive judgment, and learning.
- CT-Runtime owns deterministic coordination and durable execution mechanics.
- External capabilities and workers perform bounded work.
- Authoritative state and evidence survive individual executions.

## Improvement candidates

### 1. Outcome-driven Work Units

Evaluate whether Work Units consistently preserve intent, constraints, acceptance conditions, and required evidence across planning, implementation, revision, and completion.

**Reference:** Speck, Spec Kit.

### 2. Reliable execution handoffs

Evaluate whether disposable executions can resume across execution boundaries without losing authoritative context, work identity, or relevant evidence.

Audit the selected GAS-hosted email loop first. Treat Node/OpenCode, Execution Federation, GitHub Actions, and other execution hosts as comparative or reuse evidence, not required launch dependencies. Any proposed expansion beyond the selected GAS path must demonstrate a need in that path.

**Reference:** Execution Federation, durable continuation, Codex workflows.

### 3. Outcome convergence

Evaluate whether existing readiness and verification mechanisms distinguish successful execution from actual fulfillment of the intended outcome.

**Reference:** Spec-driven development, Executor–Tester workflows.

### 4. Capability discovery and reuse

Evaluate whether Celestan can efficiently discover, select, and compose existing external capabilities before commissioning new implementations.

**Reference:** Agent skills, Strands, Foundry.

### 5. Evidence-driven improvement

Evaluate whether Observer and Foundry can turn recurring execution failures, inefficiencies, and evidence gaps into tested improvements without introducing dependencies into the core loop.

**Reference:** Observer, Foundry, autonomous software factories.

## Required first action: implementation gap audit

Before implementing anything:

1. Inspect the current CT-Runtime code, tests, contracts, and project state, beginning with the selected GAS-hosted email loop.
2. Map each improvement candidate to existing mechanisms.
3. Classify each as already satisfied, partially satisfied, missing, or unnecessary.
4. Identify overlapping mechanisms that could be consolidated or removed.
5. Propose the smallest justified changes, ordered by expected impact and implementation cost.
6. Record evidence and uncertainties. Create a bounded implementation Work Unit only if the audit establishes a justified change; otherwise, explicitly record that no implementation is warranted.

Do not duplicate existing functionality or introduce new orchestration abstractions without demonstrated need.

## Success criteria

The improvements should measurably strengthen:

- Autonomous progress toward user objectives
- Cold-start continuity across executions
- Outcome correctness and verification
- Efficient capability and model utilization
- Recovery from interruption, failure, and changed circumstances
- Simplicity of the runtime and its operational contracts

## Architectural constraint

**Improve the existing loop before expanding it.**

Prefer consolidation, reuse, and simplification over new subsystems. Preserve the distinction between authoritative state, execution evidence, semantic continuation, and retrospective learning.

## Completion condition

The audit is complete when each candidate has an evidence-backed disposition, uncertainties and remaining limitations are recorded, and the need (or lack of need) for implementation is explicit. If a justified change is identified, define it as a bounded Work Unit for separate implementation and verification; implementation is not presumed by the audit mandate. Successful completion does not require implementing all five ideas.
