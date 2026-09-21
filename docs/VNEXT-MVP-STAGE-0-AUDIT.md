# Celestan vNext MVP — Stage 0 Audit Closure Map

**Status:** Stage 0 traceability index
**Authority:** `docs/VNEXT-MVP-COMPLETION-PLAN.md`
**Scope:** closure mapping only. This document does not add architecture or activate/change production authority.

Stage 0 maps each blocking audit finding to its required invariant, release gate, regression evidence, and implementation owner. A finding remains **Open** until the named evidence exists and the corresponding gate is explicitly closed.

| Finding | Required invariant | Gate | Regression evidence | Implementation owner | Status |
|---|---|---|---|---|---|
| A1. Assembled arm/control-plane routing | Qualified assembled GAS bundle routes each privileged operation through the intended authenticated control path; tested artifact equals shipped artifact | Stage 1 — Control plane | Assembled-bundle routing test covering `self-deploy-*`, `arm-vnext-cutover`, `quiesce-legacy-autonomy`, `assert-legacy-quiesced`, plus ordinary federation routing | Stage 1 | Open |
| A2. HTTP-200 business failures | HTTP transport success is not treated as operation success; `REQUIRES_VNEXT`, `LEGACY_NOT_QUIESCED`, rejection, and equivalent business failures remain failures at the client boundary | Stage 1 — Control plane | Client tests with HTTP 200 + business-failure payloads | Stage 1 | Open |
| A3. Request/deployment identity binding | Privileged signed requests are bound to the intended receiving script/deployment; wrong-script and wrong-deployment replay fails closed | Stage 1 — Control plane | Signed-request adversarial tests for correct identity, wrong script, wrong deployment, replay | Stage 1 | Open |
| A4. Deployment HEAD verification | Deployment receipt never claims `HEAD == LIVE == desired` unless HEAD was independently read; receipt records source commit, workflow, desired hash, GAS version, deployment ID, observed HEAD, observed LIVE | Stage 1 — Control plane | Deployment readback/receipt tests that distinguish independently observed HEAD from LIVE | Stage 1 | Open |
| A5. Cross-WU Execution binding | An Execution can never be persisted, settled, continued, or otherwise authorized against a different Work Unit than the one under which it was created | Stage 2 — Kernel | Memory + PostgreSQL adversarial cross-WU persistence/settlement tests | Stage 2 | Open |
| A6. Fence regression / stale settlement | Claim generations are strictly monotonic; an older fence can never regain authority or settle after a newer fence exists | Stage 2 — Kernel | Memory + PostgreSQL stale-settlement, continuation, takeover, and fence-regression probes | Stage 2 | Open |
| A7. Project mutation authority race | At most one current mutation authority exists per project and it belongs to an active Execution claim; dormant Waiting/Human-needed WUs hold none | Stage 2 — Kernel | Two different WUs racing for one project; release/expiration/revocation probes | Stage 2 | Open |
| A8. Stable durable identity references | Durable objects retain required project ID, thread/conversation ID where applicable, Work Unit ID, Execution ID, verifiable authority-decision/reference provenance for each mutation-bearing Execution, and fence/claim generation; Work Unit/Execution provenance is compound-validated | Stage 2 — Kernel | Memory + PostgreSQL lifecycle tests for authorization verification, per-Execution renewal/recovery, forged authority references, and cross-WU continuation/evidence pairs; thread/conversation remains a vertical-slice dependency | Stage 2 | Open |
| A9. Transactional-store fallback | Atomic transitions use only the transactional store contract; no weaker fallback can create half-transitions, bypass fencing, or separate claim from Execution creation | Stage 2 — Kernel | Injected transaction failure proves neither accepted claim nor Execution survives a failed atomic operation; static/API coverage proves weaker fallback is unreachable | Stage 2 | Open |
| A10. Terminal non-reactivation | Terminal WUs cannot be reactivated by stale wakes, continuations, retries, or takeover paths | Stage 2 — Kernel | Terminal-WU stale-wake/continuation adversarial tests in both stores | Stage 2 | Open |
| A11. Same-event-ID conflicting content | Same event ID + same canonical content is idempotent; same ID + conflicting content is deterministic conflict/error with identical store behavior | Stage 3 — Recovery | Memory + PostgreSQL parity tests for identical and conflicting re-emission | Stage 3 | Open |
| A12. Stable Feedback receipt identity across uncertain writes | Source write/receipt commit/response loss/retry converges on one logical receipt/message identity rather than manufacturing duplicates | Stage 3 — Recovery | Source-success/response-loss/retry fault injection and identity assertions | Stage 3 | Open |
| A13. Pre-WU recovery | A committed Feedback receipt remains discoverable as unevaluated work even if failure occurs before Evaluation or WU creation | Stage 3 — Recovery | Crash between receipt commit and evaluation/WU creation; recovery discovers and processes receipt | Stage 3 | Open |
| A14. Post-WU recovery bounds and lease semantics | Lease expiry has explicit semantics; takeover creates a newer Execution/fence; recovery attempts are bounded; exhaustion becomes actionable Human-needed/Needs-review | Stage 3 — Recovery | E1 crash/lease-expiry → E2 takeover tests, retry-bound exhaustion tests, diagnostics assertions | Stage 3 | Open |
| A15. External-effect uncertainty | Runtime makes no general exactly-once claim; external effects have stable identities and are deduplicated or reconciled through provider/authoritative inspection, with unresolved state when necessary | Stage 3 — Recovery | Mutation-success/settlement-loss reconciliation test; takeover overlap prevention; unresolved-effect persistence | Stage 3 | Open |
| A16. Immutable receipt RPC/index/HTTP compatibility | Receipt RPC uses the real deployed index/schema and actual HTTP parameter names; immutable event identity/content rules are preserved end-to-end | Stage 4 — Feedback | Real-compatible RPC/integration test against actual index/schema/HTTP arguments | Stage 4 | Open |
| A17. Four replacement Feedback adapters missing/mis-bundled | All four intended replacement Feedback adapters are present in the authoritative production bundle and are behaviorally callable | Stage 4 — Feedback | Assembled bundle manifest test + adapter contract tests for every adapter | Stage 4 | Open |
| A18. Feedback reply preservation | Follow-up replies stay on the same durable thread while receiving their own revision/message identity | Stage 4 — Feedback | Multi-revision thread test with reply ingestion and projection assertions | Stage 4 | Open |
| A19. Polling strands rows after first twelve | Feedback polling progresses beyond the first 12 rows and cannot permanently strand later messages | Stage 4 — Feedback | Dataset >12 rows with assertion that later Feedback is eventually received/processed | Stage 4 | Open |
| A20. Projection revision / partial-write recovery | Projection revisions advance monotonically and partial metadata/projection writes retry safely without repeating substantive work | Stage 4 — Feedback | Partial-write/ack-loss fault injection; retry produces next correct revision without duplicate substantive execution | Stage 4 | Open |
| A21. Missing production outer-loop caller | A complete vNext replacement path exists from durable opportunity through coordinator, WU, Execution, worker, settlement, and response, while autonomous production admission remains disabled until qualification | Stage 6–7 — Vertical slice | Isolated end-to-end qualification covering no-work, real work, follow-up, wait/human-needed, and interruption/recovery traces | Stage 6–7 | Open |
| A22. Autonomy pump / durable opportunity discovery | One bounded mechanical pump discovers unevaluated receipts, due continuations/waits, expired recoverable claims, and projection retries without making substantive decisions; missed triggers are repaired by later discovery | Stage 5 — Autonomy | Missed-pump test proving durable opportunity remains discoverable and is processed by a later pump | Stage 5 | Open |
| A23. Production schema/grants not independently established | Production schema and database grants match the qualified vNext contract; orphan migration baseline is understood rather than inferred from migration files | Stage 7–8 — Qualification/deploy | Isolated real-role DB tests plus independent production schema/grant readback and migration-baseline check | Stage 7–8 | Open |
| A24. Every reachable legacy admission surface | Before vNext activation, every autonomous legacy writer/admission path is independently blocked: scheduler, direct execution, recovery, federation/alternate admission, known GAS triggers, recreated triggers, and every audit-identified mutation surface | Stage 9 — Legacy exclusion | Safe retired-entrypoint tests + independent live exclusion checks; legacy operational mutations remain zero | Stage 9 | Open |
| A25. Exact assembled artifact equals qualified/shipped artifact | The artifact subjected to routing/identity/qualification is the artifact deployed/read back; source-only tests cannot substitute for assembled-bundle evidence | Stage 1, 7–8 | Build hash/manifest equality plus deployment readback of bundle contents/version | Stage 1, 7–8 | Open |

## Gate ownership summary

| Gate | Closure condition | Findings |
|---|---|---|
| Stage 1 — Control plane | Exact assembled artifact passes routing, identity, business-result, and deployment-truth tests; self-deployment remains functional | A1–A4, A25 |
| Stage 2 — Kernel | Memory and PostgreSQL agree on identity, transactionality, fencing, mutation authority, and terminal-state invariants | A5–A10 |
| Stage 3 — Recovery | Receipt/event semantics and pre/post-WU recovery are durable, bounded, fenced, and externally reconcilable | A11–A15 |
| Stage 4 — Feedback | Replacement adapters and receipt/thread/projection behavior are faithful under retries and multi-revision input | A16–A20 |
| Stage 5 — Autonomy | Mechanical pump discovers all durable opportunities without owning Celestan judgment | A22 |
| Stage 6–7 — Vertical slice | Complete replacement path exists disabled and passes isolated end-to-end qualification | A21, plus all prior gates |
| Stage 7–8 — Production readiness | Actual production schema/grants and deployed artifact are independently verified against qualified state | A23, A25 |
| Stage 9 — Legacy exclusion | Every legacy autonomous mutation/admission surface is independently excluded before vNext activation | A24 |

## Traceability rule for subsequent repair PRs

Every repair PR must name the Stage 0 finding IDs it closes. Its description must identify:

1. the invariant being repaired;
2. the exact regression evidence added or strengthened;
3. the gate whose acceptance criteria are thereby satisfied;
4. any remaining evidence required before that gate can close.

A green unit test does not close a finding unless it is the evidence named by this ledger or a later, explicitly equivalent regression proof.

**Stage 0 status:** map recorded; no gate is closed by this document.