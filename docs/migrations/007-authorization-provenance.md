# vNext Migration 007 — Authorization Provenance

## Purpose

Migration 007 closes the A8 durable-identity gap for mutation-bearing Executions. It does not create or evaluate policy. The existing authorization authority remains responsible for making the authorization decision and determining its scope.

The runtime stores the exact authorization decision reference relied upon by each new Execution and by the current project mutation authority. The runtime's injected authorization verifier must resolve or verify that reference and reject a decision whose scope does not authorize the proposed Execution.

`authorizeTerminal` remains a separate terminal-completion decision. It is not reused as mutation authorization.

## Lifecycle rule

Authorization belongs to the Execution, not permanently to the Work Unit. A successor Execution receives its own decision reference and may use a renewed or narrower authorization. Fence advancement never changes authorization implicitly.

## Database enforcement

- New Execution writes require a non-empty authorization decision reference.
- Project mutation authority must carry the same reference as its Execution.
- Continuation and evidence rows retain their existing Work Unit and Execution identities, but PostgreSQL additionally enforces that the pair names the same Execution/Work Unit relationship.
- Existing historical Executions may remain NULL because they predate this invariant; new and updated Executions are fail-closed.

## Qualification boundary

A8 is not closed until tests demonstrate:

1. a trusted verifier rejects an unrelated authorization scope;
2. the exact decision reference survives Execution persistence/reload;
3. a successor Execution can carry a different decision reference;
4. a forged authority reference cannot diverge from its Execution;
5. continuation/evidence cannot pair one Work Unit with another Work Unit's Execution;
6. reconstruction and recovery preserve the per-Execution authorization reference.

Thread/conversation identity remains a deferred vertical-slice dependency and is not introduced into the Stage-2 kernel by this migration.
