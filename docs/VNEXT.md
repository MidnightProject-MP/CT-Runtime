# CT-Runtime vNext

The current Runtime is a research prototype, not a compatibility target.

**Preserve the knowledge. Stop preserving the architecture.**

The vNext acceptance target is a single autonomous outer loop: a Feedback wake
reconstructs one Work Unit, cognition may run one bounded disposable Execution,
and the resulting #22 turn is persisted as factual evidence plus continuation
or independently authorized terminal outcome. If no justified work exists,
the loop records quiescence and ends.

PR24 follow-up limits: the kernel performs only mechanical claim, fence, and
execution transitions; the outer loop awaits independent terminal authority
and settles only on an exact `true`. A turn's `objective_id` must equal the
Work Unit `objective_ref` before evidence verification or settlement. Claim,
turn, and failure persistence are transactional and fenced, including rollback
and protection against releasing a newer claim. The survivability slice adds
time-bounded claims, one-time event consumption, stale-claim takeover, and
bounded failure retry without allowing expiry to execute work by itself.

The corrected #24 acceptance boundary is therefore: a Work Unit can survive
successive executions while the participating process remains alive long enough
to settle; claim/execution creation and settlement are atomic, and execution
completion remains distinct from objective completion. It does not establish
unattended GAS operation or real Feedback ingress; those remain later
boundaries and require PostgreSQL CI proof before acceptance.

The kernel begins with exactly seven concepts: Work Unit, Execution, claim/fence,
Continuation, wake/event, evidence reference, and transition integrity.
Everything else has a presumption of deletion.

The archival branch `archive/pre-outer-loop-redesign` preserves the pre-vNext
merged implementation as the recovery point. No compatibility layer is required.
