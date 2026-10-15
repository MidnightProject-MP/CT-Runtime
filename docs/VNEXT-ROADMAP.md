# Celestan vNext — Execution Roadmap

Governing dependency map. Derived from the approved design baseline, the Phase 0
transition-authority/lineage map, and the review of #76 / the local Phase 1
follow-on. This document defines *what must be true*, not what is done.

**Current phase: Change 1 and Change 2 below. Do not start Change 3+ work ahead
of them.**

## Ownership boundary

| Component | Responsibility |
| --- | --- |
| Celestan | Interpret the objective, choose bounded work, assess results, propose continuation/reconsideration, decide substantive completion within authority. |
| Runtime coordinator | Discover eligible work, enforce authority and limits, reserve resources, dispatch, reconcile, apply guarded transitions. **No LLM calls in coordinator logic.** |
| Execution backend | Run one bounded assignment; expose launch identity, status, cancellation, result. |
| Existing vNext ledger | Authoritative work, attempts, ownership, handoffs, decisions, uncertainty, acceptance. |
| Email / Feedback | Durable input and output adapters. |
| Observer | Reflection and semantic interpretation from recorded evidence. |

Stewardship, execution, review and diagnosis are initially **assignment purposes
on the same execution mechanism**, not four orchestration systems.

## Change 1 — Make the canonical handoff faithful and safe (`#76`)

The canonical handoff is a *translation boundary*. Its job is to preserve meaning
across the three current worker dialects without inventing guarantees.

Invariants:
- Evidence capability, supplied evidence references, integrity verification,
  and acceptance are **separate facts**. None may be inferred from another.
- Evidence-free completion never becomes evidence-complete.
- Work/execution/fence/revision binding stays in trusted runtime context and is
  never asserted by a worker.
- Technical failure stays distinct from a semantic wait.
- Every wake or successor suggestion is a **proposal**, never an authority.
- Valid current outputs from all three current dialects normalize correctly.

## Change 2 — One guarded settlement and decision boundary

- Route the operating path through canonical handoff settlement.
- Persist attempt outcome, evidence references, continuation proposal, and work
  disposition **atomically**.
- Separate successful execution from accepted work.
- Add an explicit **acceptance transition** operating on settled reviewable work,
  bound to objective/work revision, exact result and evidence, authorized
  decision identity, and current requirements. That decision is **verified at
  the authoritative boundary**, not inferred from execution identity.
- Preserve continuation proposals durably **without stranding them**: they must
  remain discoverable by the coordinator after restart.
- Preserve execution authority, fencing, and reconciliation protections.
- Apply equivalent behavior to the active GAS path through a **forward**
  migration; never rewrite historical migrations.

## Milestone 1 — one reliable coordination core

**A. Close the baseline.** Finish #71 → #72 → #75 in dependency order, including
the targeted input-watermark correction and outstanding qualification. Produce a
compact authority map: input admission, work creation/revision, claim and
resource reservation, launch, settlement, continuation admission, acceptance,
reconciliation — authoritative writer and transaction for each.
*Exit: no ambiguity about which component may change each authoritative fact.*

**B. Handoff and guarded decisions.** Changes 1 and 2 above. Add only the
bounded-work information the first operating path needs.
*Exit: attempts are disposable; work identity, requirements and decisions
survive them.*

**C. Make dispatch recoverable.** Persist launch intent and a stable dispatch
identity before launch, bound to one attempt and approved assignment. Recover
backend run identity after a lost launch response. Reconcile pending launches and
running attempts after coordinator restart. Distinguish definitely-not-launched,
running, completed, unknown. Preserve uncertainty.
*Exit: a crash around launch does not lose the attempt or cause blind relaunch.*

**D. Enforce lifetime and resource authority.** Enforce deadlines outside the
worker process. Reserve concurrency and applicable cost/tool budgets atomically.
Retain project mutation exclusion by default. Require stop confirmation,
effective revocation, or reconciliation before conflicting takeover. Check
revision and cancellation at dispatch, settlement, and effect admission.

*Milestone 1 exit: authorized work can be claimed, launched, and reconciled
under stable identity without blind duplication or overlapping mutation
authority.*

## Milestone 2 — complete the autonomous loop

**A. One recurring, LLM-free coordinator.** Each pass: inspect durable state →
reconcile uncertain launches/effects → collect and settle finished attempts →
identify eligible assignments or pending decisions → check authority and
resources → dispatch bounded work → persist operational status and stop.
Missed notifications must not lose work; periodic scanning is the recovery path.

**B. Bounded Celestan assignment purposes.** Stewardship (bounded next-work
proposals), Execution (result, evidence, remaining work, uncertainties), Review
(assessment against finish conditions), Diagnosis (cause, evidence, justified
recovery/reconsideration proposal). Explicit model/agent selection and
purpose-specific permissions.

**C. Continuation, interruption, reconsideration.** Continuation of the same work
across attempts; human answers and changed requirements; cancellation and
supersession; blocked dependencies; provider failures; repeated unsuccessful
approaches. Separate technical retry from a substantive decision to try again.

**D. Controlled parallelism.** Start with independent projects and compatible
read-only work. Reserve all required resources atomically. A role name or
separate worker process does not establish independence.

**E. Objective completion and status.** Review against the original objective and
current authorized revision. Expose a ledger-derived view: objective/revision,
active assignments and attempts, what changed and evidence, waiting reason or
unresolved uncertainty, next eligible action and why, completion claim versus
accepted completion, specific human input needed.

## Milestone 3 — prove reliability, remove duplication

**A. Recovery matrix.** Crash before/after launch; lost launch or settlement
response; overlapping wakes; coordinator dies while worker survives; cancellation
or changed requirements; provider timeout/outage; uncertain external action;
repeated unsuccessful work; lost notification; new input during execution.

**B. Recheck safeguards.** Project-level serialization and stale fencing;
execution authorization provenance; immutable migrations and restricted database
roles; target validation before credential transmission; intake pagination and
poison-message handling; delivery receipts and no-blind-resend; secret-safe
diagnostics; exact-artifact release identity and readback.

**C. Repeated unattended trials.** Isolated, genuinely useful objective with a
clear finish condition. Record useful accepted outcomes, recovery time, duplicate
or conflicting effects, lost or stranded work, unnecessary model calls, repeated
non-progress, human coordination/rescue, stable quiet behavior after completion.
Human-rescued runs must be identified explicitly.

**D. Reversible cutover.** Stop old admission → inventory and reconcile
in-flight work and effects → verify artifact/schema/permissions/scheduler →
enable one coordinator → observe with a tested pause path. Rollback stops new
admission first and preserves reconciliation access; it must not reactivate a
competing writer while old effects remain unresolved.

**E. Retire superseded orchestration.** Remove duplicate admission and
scheduling decisions first, then obsolete adapters, triggers, commands, docs.
Close #68/#69 after preserving unique required content.

## Tracked findings carried forward

| # | Finding | Status |
| --- | --- | --- |
| F1 | `deploy/gas-email/schema.sql` failure/expiry records the **latest** input sequence rather than the failed attempt's **captured** sequence, so new input arriving after the snapshot is suppressed until more input arrives. | Open — targeted correction on the GAS path. |
| F2 | Release controls not operationally complete: `gas-production` has no protection rules or deployment-branch policy; no tag-targeted ruleset. Green CI does not establish the independent release approval #71 describes. | Open — repository configuration. |

## Management rules

- A PR delivers a coherent, reviewable behavior or safeguard — not a mechanical
  phase slice.
- Each new behavior arrives with its prerequisite protection.
- Reopen the next one or two changes after each accepted increment.
- Track code-complete, integration-proven, and operationally-proven separately.
- Retire duplicate authority as paths converge; defer harmless cleanup until it
  earns its cost.
