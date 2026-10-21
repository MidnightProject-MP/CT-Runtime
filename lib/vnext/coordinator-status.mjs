const iso = value => value == null ? null : new Date(value).toISOString();

function attemptView(execution, results) {
  const result = results.get(execution.execution_id);
  return {
    execution_id: execution.execution_id,
    state: execution.state,
    fence: execution.fence,
    attempt: execution.attempt,
    started_at: iso(execution.started_at),
    finished_at: iso(execution.finished_at),
    failure: execution.failure ?? null,
    result: result ? {
      disposition: result.turn?.disposition ?? null,
      summary: result.turn?.summary ?? null,
      recorded_at: iso(result.recorded_at),
    } : null,
  };
}

function latestCancellation(cancellations) {
  return cancellations
    .slice()
    .sort((a, b) => Number(b.work_revision) - Number(a.work_revision)
      || Date.parse(b.recorded_at) - Date.parse(a.recorded_at))[0] ?? null;
}

function workNextAction(work, details, eligibleId, now, assignments = null, maxNonProgress = 2) {
  if (details.block) return { kind: 'reconcile', work_unit_id: work.work_unit_id, reason: 'external-effect-uncertain' };
  if (details.cancellation?.pending) return { kind: 'wait', work_unit_id: work.work_unit_id, reason: 'cancellation-pending' };
  if (work.claim_execution_id) return { kind: 'wait', work_unit_id: work.work_unit_id, reason: 'attempt-running' };
  const pendingAssignment = assignments?.find(a => a.status === 'reported');
  if (pendingAssignment) return { kind: 'decide', purpose: pendingAssignment.purpose, work_unit_id: work.work_unit_id,
    assignment_id: pendingAssignment.assignment_id, reason: 'assignment-report-awaits-decision' };
  const queuedAssignment = assignments?.find(a => a.status === 'queued');
  if (queuedAssignment) return ['actionable','waiting'].includes(queuedAssignment.assignment_task_state)
    ? { kind: 'dispatch', purpose: queuedAssignment.purpose, work_unit_id: work.work_unit_id,
      assignment_id: queuedAssignment.assignment_id, reason: 'purpose-bound-assignment-ready' }
    : { kind: 'wait', purpose: queuedAssignment.purpose, work_unit_id: work.work_unit_id,
      assignment_id: queuedAssignment.assignment_id, reason: 'assignment-attempt-not-replayable' };
  if (work.state === 'terminal') return { kind: 'none', work_unit_id: work.work_unit_id, reason: 'accepted-complete' };
  if (work.state === 'cancelled') return { kind: 'none', work_unit_id: work.work_unit_id, reason: 'cancelled' };
  if (work.state === 'review') {
    if (details.reviewReady) {
      const review = assignments.filter(a => a.purpose === 'review' && a.subject_execution_id === work.last_execution_id
        && Number(a.work_revision) === Number(work.work_revision)).sort((a,b) => Date.parse(b.created_at)-Date.parse(a.created_at))[0];
      if (!review || review.status === 'queued') return { kind: 'dispatch', purpose: 'review', work_unit_id: work.work_unit_id, assignment_id: review?.assignment_id ?? null, reason: 'independent-review-required' };
      if (review.status === 'reported') return { kind: 'decide', purpose: 'review', work_unit_id: work.work_unit_id, assignment_id: review.assignment_id, reason: 'review-report-awaits-decision' };
      if (review.decision?.outcome === 'recommend_accept') return { kind: 'accept', work_unit_id: work.work_unit_id, reason: 'review-recommends-acceptance' };
      if (review.decision?.outcome === 'blocked') return { kind: 'input', work_unit_id: work.work_unit_id, reason: 'review-blocked-needs-input' };
      if (review.decision?.outcome === 'non_progress') {
        const count = assignments.filter(a => a.purpose === 'diagnosis' && ['decided','superseded'].includes(a.status) && a.decision).length;
        return count >= maxNonProgress
          ? { kind: 'reconsider', work_unit_id: work.work_unit_id, reason: 'reconsideration-exhausted' }
          : { kind: 'dispatch', purpose: 'diagnosis', work_unit_id: work.work_unit_id, reason: 'review-non-progress' };
      }
    }
    if (work.failure && assignments === null) return { kind: 'wait', work_unit_id: work.work_unit_id, reason: 'review-required' };
    const diagnosis = (assignments ?? []).filter(a => a.purpose === 'diagnosis' && a.subject_execution_id === work.last_execution_id)
      .sort((a,b) => Date.parse(b.created_at)-Date.parse(a.created_at))[0];
    if (work.failure && (!diagnosis || diagnosis.status === 'queued')) {
      const count = (assignments ?? []).filter(a => a.purpose === 'diagnosis' && ['decided','superseded'].includes(a.status) && a.decision).length;
      return count >= maxNonProgress
        ? { kind: 'reconsider', work_unit_id: work.work_unit_id, reason: 'reconsideration-exhausted' }
        : { kind: 'dispatch', purpose: 'diagnosis', work_unit_id: work.work_unit_id, reason: 'failure-needs-diagnosis' };
    }
    if (diagnosis?.status === 'reported') return { kind: 'decide', purpose: 'diagnosis', work_unit_id: work.work_unit_id, assignment_id: diagnosis.assignment_id, reason: 'diagnosis-report-awaits-decision' };
    return { kind: 'wait', work_unit_id: work.work_unit_id, reason: 'review-required' };
  }
  if (work.retry_after && Date.parse(work.retry_after) > now) return { kind: 'wait', work_unit_id: work.work_unit_id, reason: 'retry-not-due', due_at: iso(work.retry_after) };
  if (eligibleId === work.work_unit_id) {
    if (Number(work.latest_input_seq) > Number(work.consumed_input_seq)) return { kind: 'dispatch', work_unit_id: work.work_unit_id, reason: 'new-human-input' };
    if (work.next_wake_at && Date.parse(work.next_wake_at) <= now) return { kind: 'dispatch', work_unit_id: work.work_unit_id, reason: 'coordinator-due-time' };
    return { kind: 'dispatch', work_unit_id: work.work_unit_id, reason: 'continuation-due' };
  }
  if (details.continuation?.continuation?.mode === 'immediate') return { kind: 'wait', work_unit_id: work.work_unit_id, reason: 'continuation-not-due', due_at: iso(details.continuation.runnable_at) };
  if (work.state === 'waiting') {
    if (details.question) return { kind: 'input', work_unit_id: work.work_unit_id, reason: 'human-input-required' };
    if (work.next_wake_at) return { kind: 'wait', work_unit_id: work.work_unit_id, reason: 'waiting-until', due_at: iso(work.next_wake_at) };
    return { kind: 'wait', work_unit_id: work.work_unit_id, reason: 'waiting-for-condition' };
  }
  if (details.projectAuthorityHeld) return { kind: 'wait', work_unit_id: work.work_unit_id, reason: 'project-authority-held' };
  return { kind: 'wait', work_unit_id: work.work_unit_id, reason: 'not-eligible' };
}

export function deriveCoordinatorStatus(ledger, { now = Date.now(), maxNonProgress = 2 } = {}) {
  if (!ledger || typeof ledger.project_id !== 'string') throw new Error('coordinator ledger requires project_id');
  const works = ledger.works ?? [];
  const executions = ledger.executions ?? [];
  const results = new Map((ledger.results ?? []).map(row => [row.execution_id, row]));
  const accepted = new Map();
  for (const row of ledger.accepted ?? []) {
    const history = accepted.get(row.work_unit_id) ?? [];
    history.push(row);
    accepted.set(row.work_unit_id, history);
  }
  const evidence = new Map();
  for (const row of ledger.evidence ?? []) {
    const list = evidence.get(row.execution_id) ?? [];
    list.push(row.evidence);
    evidence.set(row.execution_id, list);
  }
  const cancellations = ledger.cancellations ?? [];
  const continuations = new Map((ledger.continuations ?? []).map(row => [row.work_unit_id, row]));
  const assignments = new Map();
  for (const row of ledger.assignments ?? []) {
    const list = assignments.get(row.work_unit_id) ?? [];
    list.push(row);
    assignments.set(row.work_unit_id, list);
  }
  const block = ledger.block ?? null;
  const projectAuthorityHeld = Boolean(ledger.authority && ledger.authority.project_id === ledger.project_id);
  const objectives = works.map(work => {
    const workExecutions = executions.filter(row => row.work_unit_id === work.work_unit_id);
    const workResults = new Map(workExecutions.filter(row => results.has(row.execution_id)).map(row => [row.execution_id, results.get(row.execution_id)]));
    const active = workExecutions.filter(row => ['created', 'running'].includes(row.state));
    const completed = workExecutions.filter(row => !['created', 'running'].includes(row.state));
    const recent = completed.slice().sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at)).slice(0, 10);
    const latestExecution = workExecutions.find(row => row.execution_id === work.last_execution_id)
      ?? workExecutions.slice().sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0]
      ?? null;
    const latestResult = latestExecution ? results.get(latestExecution.execution_id) ?? null : null;
    const completion = latestResult?.turn ?? work.last_turn ?? null;
    const evidenceRows = latestExecution ? evidence.get(latestExecution.execution_id) ?? [] : [];
    const workCancellations = cancellations.filter(row => row.work_unit_id === work.work_unit_id);
    const cancellation = latestCancellation(workCancellations);
    const completionClaim = completion?.disposition === 'done' ? {
      disposition: completion.disposition,
      summary: completion.summary ?? null,
      evidence_count: completion.outcome_evidence?.length ?? 0,
    } : null;
    const details = {
      block: block?.work_unit_id === work.work_unit_id ? block : null,
      cancellation: cancellation ? { ...cancellation, pending: cancellation.consumed_at == null } : null,
      question: work.continuation?.question ?? work.last_turn?.question ?? null,
      continuation: continuations.get(work.work_unit_id) ?? null,
      projectAuthorityHeld,
      reviewReady: completionClaim != null,
    };
    const workAssignments = assignments.get(work.work_unit_id) ?? [];
    const nextAction = workNextAction(work, details, ledger.eligible_id, now, ledger.assignments === undefined ? null : workAssignments, maxNonProgress);
    const acceptanceHistory = accepted.get(work.work_unit_id) ?? [];
    const currentAcceptanceSnapshot = ledger.acceptance_snapshots?.[work.work_unit_id] ?? null;
    const acceptedCompletion = work.state === 'terminal'
      && latestExecution?.execution_id === work.last_execution_id
      && Number(latestExecution.admission?.work_revision) === Number(work.work_revision)
      && currentAcceptanceSnapshot?.execution_id === latestExecution.execution_id
      && Number(currentAcceptanceSnapshot.work_revision) === Number(work.work_revision)
      ? acceptanceHistory.find(row => row.execution_id === latestExecution.execution_id
        && row.snapshotDigest === currentAcceptanceSnapshot.snapshot_digest) ?? null
      : null;
    const uncertainReason = details.block ? details.block.reason
      : work.failure?.reconciliation_required === true ? (work.failure.reason ?? 'external-effect-uncertain')
      : null;
    const waitingReason = work.state === 'waiting' ? (details.question ? 'human-input-required' : 'condition-not-met') : null;
    return {
      work_unit_id: work.work_unit_id,
      objective_ref: work.objective_ref,
      work_revision: Number(work.work_revision),
      state: work.state,
      active_attempts: active.map(row => attemptView(row, workResults)),
      completed_attempts: recent.map(row => attemptView(row, workResults)),
      attempt_count: workExecutions.length,
      latest_result: latestExecution ? {
        execution_id: latestExecution.execution_id,
        disposition: completion?.disposition ?? null,
        summary: completion?.summary ?? null,
        recorded_at: iso(latestResult?.recorded_at),
        evidence: evidenceRows.flat(),
      } : null,
      completion_claim: completionClaim,
      accepted_completion: acceptedCompletion ? {
        accepted: true,
        acceptance_ref: acceptedCompletion.acceptance_ref,
        execution_id: acceptedCompletion.execution_id,
        work_revision: Number(work.work_revision),
        snapshot_digest: acceptedCompletion.snapshotDigest,
        accepted_at: iso(acceptedCompletion.recorded_at),
      } : null,
      acceptance_history: acceptanceHistory.map(row => ({
        acceptance_ref: row.acceptance_ref,
        execution_id: row.execution_id,
        snapshot_digest: row.snapshotDigest ?? null,
        accepted_at: iso(row.recorded_at),
      })),
      waiting_reason: waitingReason,
      blocked_reason: details.block ? details.block.reason : null,
      uncertain_reason: uncertainReason,
      cancellation: details.cancellation ? {
        pending: details.cancellation.pending,
        decision_ref: details.cancellation.decision_ref,
        work_revision: Number(details.cancellation.work_revision),
      } : null,
      pending_continuation: details.continuation ? {
        id: Number(details.continuation.id),
        mode: details.continuation.continuation?.mode ?? null,
        next_action: details.continuation.continuation?.next_action ?? null,
        runnable_at: iso(details.continuation.runnable_at),
      } : null,
      human_decision_required: nextAction.kind === 'accept' ? 'accept'
        : nextAction.kind === 'input' ? 'respond'
        : nextAction.kind === 'reconcile' ? 'reconcile'
        : nextAction.kind === 'decide' ? 'assignment-decision'
        : nextAction.kind === 'reconsider' ? 'reconsider'
        : nextAction.reason === 'review-required' ? 'inspect'
        : null,
      next_eligible_action: nextAction,
      assignments: workAssignments.map(row => ({ assignment_id: row.assignment_id, assignment_digest: row.assignment_digest, report_digest: row.report_digest ?? null, purpose: row.purpose,
        status: row.status, model: row.model, agent: row.agent, subject_execution_id: row.subject_execution_id,
        subject_digest: row.subject_digest, report: row.report ?? null, decision: row.decision ?? null,
        assignment_task_state: row.assignment_task_state ?? null,
        created_at: iso(row.created_at), updated_at: iso(row.updated_at) })),
      failure: work.failure ?? null,
      retry_after: iso(work.retry_after),
    };
  });
  const pendingDecisions = objectives.flatMap(objective => objective.human_decision_required ? [{
    kind: objective.human_decision_required,
    work_unit_id: objective.work_unit_id,
    objective_ref: objective.objective_ref,
    assignment_id: objective.next_eligible_action.assignment_id ?? null,
    purpose: objective.next_eligible_action.purpose ?? null,
    reason: objective.next_eligible_action.reason,
  }] : []);
  let nextAction;
  if (block) nextAction = { kind: 'reconcile', work_unit_id: block.work_unit_id, reason: 'external-effect-uncertain' };
  else {
    const dispatch = objectives.find(objective => objective.next_eligible_action.kind === 'dispatch');
    const decide = objectives.find(objective => objective.next_eligible_action.kind === 'decide');
    const reconsider = objectives.find(objective => objective.next_eligible_action.kind === 'reconsider');
    const accept = objectives.find(objective => objective.next_eligible_action.kind === 'accept');
    const input = objectives.find(objective => objective.next_eligible_action.kind === 'input');
    const reconcile = objectives.find(objective => objective.next_eligible_action.kind === 'reconcile');
    const active = objectives.find(objective => objective.next_eligible_action.kind === 'wait' && objective.next_eligible_action.reason === 'attempt-running');
    const waiting = objectives.find(objective => objective.next_eligible_action.kind === 'wait');
    const finished = objectives.find(objective => objective.next_eligible_action.kind === 'none');
    nextAction = dispatch?.next_eligible_action
      ?? decide?.next_eligible_action
      ?? reconsider?.next_eligible_action
      ?? reconcile?.next_eligible_action
      ?? accept?.next_eligible_action
      ?? input?.next_eligible_action
      ?? active?.next_eligible_action
      ?? waiting?.next_eligible_action
      ?? finished?.next_eligible_action
      ?? { kind: 'none', work_unit_id: null, reason: 'no-work' };
  }
  return {
    project_id: ledger.project_id,
    generated_at: new Date(now).toISOString(),
    next_action: nextAction,
    pending_decisions: pendingDecisions,
    objectives,
  };
}
