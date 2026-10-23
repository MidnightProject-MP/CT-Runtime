import { deriveCoordinatorStatus } from './coordinator-status.mjs';

// Aggregate view only. Each project keeps its own ledger and next action; this
// module does not infer authority or merge lifecycle state across projects.
export function deriveMultiProjectStatus(projects, { now = Date.now(), maxNonProgress = 2, capacity = null } = {}) {
  if (!Array.isArray(projects)) throw new TypeError('projects must be an array');
  const seen = new Set();
  const summaries = projects.map(entry => {
    if (!entry || typeof entry.project_id !== 'string' || !entry.project_id) throw new TypeError('project status requires project_id');
    if (seen.has(entry.project_id)) throw new TypeError(`duplicate project ${entry.project_id}`);
    seen.add(entry.project_id);
    if (!entry.ledger || typeof entry.ledger !== 'object') throw new TypeError(`ledger is required for ${entry.project_id}`);
    if (entry.ledger.project_id !== entry.project_id) throw new TypeError(`ledger project does not match ${entry.project_id}`);
    const status = deriveCoordinatorStatus(entry.ledger, { now, maxNonProgress });
    const objectives = status.objectives;
    return {
      project_id: entry.project_id,
      next_action: status.next_action,
      pending_decisions: status.pending_decisions,
      work_units: objectives.length,
      accepted: objectives.filter(objective => objective.accepted_completion).length,
      active: objectives.filter(objective => objective.active_attempts.length > 0).length,
      blocked: objectives.filter(objective => objective.blocked_reason || objective.uncertain_reason).length,
      review: objectives.filter(objective => objective.state === 'review').length,
      waiting: objectives.filter(objective => objective.state === 'waiting').length,
      terminal: objectives.filter(objective => objective.state === 'terminal').length,
      cancelled: objectives.filter(objective => objective.state === 'cancelled').length,
    };
  }).sort((a, b) => a.project_id.localeCompare(b.project_id));

  const totals = {
    projects: summaries.length,
    active: summaries.reduce((sum, project) => sum + project.active, 0),
    accepted: summaries.reduce((sum, project) => sum + project.accepted, 0),
    blocked: summaries.reduce((sum, project) => sum + project.blocked, 0),
    review: summaries.reduce((sum, project) => sum + project.review, 0),
    waiting: summaries.reduce((sum, project) => sum + project.waiting, 0),
    pending_decisions: summaries.reduce((sum, project) => sum + project.pending_decisions.length, 0),
  };
  const phase = totals.blocked > 0 ? 'blocked'
    : totals.active > 0 ? 'active'
    : totals.pending_decisions > 0 ? 'needs-review'
    : summaries.some(project => project.next_action.kind === 'dispatch') ? 'actionable'
    : summaries.length > 0 && summaries.every(project => project.terminal + project.cancelled === project.work_units) ? 'complete'
    : 'quiesced';
  return {
    generated_at: new Date(now).toISOString(),
    phase,
    capacity,
    totals,
    projects: summaries,
  };
}
