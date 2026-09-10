# CT-Runtime vNext: outer-loop proof

This branch intentionally does **not** migrate the existing Runtime architecture.
The merged pre-vNext system is preserved in Git history and on the archival
branch `archive/pre-outer-loop-redesign`. The new path is a research prototype.

## Acceptance criterion

One Feedback-triggered wake must be able to reconstruct one canonical Work Unit,
run bounded disposable executions across later wakes, and end in either:

- truthful terminal state, only after independently authorized completion; or
- truthful quiescence, with an immediate continuation or a named future condition.

Execution success alone never establishes objective completion.

## Kernel

Only these concepts enter vNext initially:

1. **Work Unit** — one canonical durable logical-work identity.
2. **Execution** — one disposable bounded attempt.
3. **Claim/fence** — exclusive mutation authority; stale executions cannot mutate.
4. **Continuation** — the #22 semantic boundary: immediate or condition.
5. **Wake/event** — an append-only indication that reality may have changed.
6. **Evidence reference** — factual provenance, not copied project truth.
7. **Transition integrity** — mechanical invariants enforced independently of cognition.

Everything else has a presumption of deletion.

## Explicit non-goals

The vNext path does not depend on or invoke:

- the old Runtime scheduler or `requested_next_wake`;
- Federation advisories, handoffs, or takeover ceremony;
- pre-created executions from Feedback;
- Observer or Foundry processing;
- Work Unit Convergence or a GitHub truth mirror;
- OpenCode host execution;
- Northflank or other compute providers;
- model/provider routing;
- project-system abstractions;
- publishing/Chronicle machinery.

Those systems remain available only as historical/research material until the
new loop proves which pieces, if any, deserve salvage.

## Outer loop

```text
wake
  ↓
reconstruct
  ↓
is justified work available?
  ├─ no → record condition / quiesce → END
  └─ yes
       ↓
     claim Work Unit
       ↓
     create Execution
       ↓
     bounded cognition
       ↓
     validate #22 turn
       ↓
     persist evidence + continuation + mechanics
       ↓
     END
```

The reference implementation under `lib/vnext/` is deliberately small and
uses an in-memory store only to prove the state machine. It is not presented as
production persistence. A durable adapter should implement the same narrow
port over a clean schema rather than wrapping the old tables.

## Salvage rule

The old implementation is not a compatibility target. Its durable knowledge
and proven invariants are the assets; its architecture is not. Reuse a piece
only when it is obviously simpler than rewriting it and does not pull old
semantics back into the new kernel.
