/* Objective-state migration proof (isolated, explicit invocation only).
   This file defines reconstruction and cutover machinery; it performs no writes at load
   and is never invoked by the scheduler, dispatch, or feedback paths. The only entry
   point is runObjectiveStateMigration(), which operates on explicitly supplied state
   (live lists or a copied fixture) and refuses to run unless its version gate matches.
   Legacy rows are never rewritten: history stays where it is, and migration facts are
   appended under stable identities so rerun after interruption is idempotent.
   Conversation cursors are deliberately out of scope here; this proof covers identity,
   disposition, journal reconciliation, and single-writer cutover only. */
var CT_GAS_MIGRATION = (function () {
  var VERSION = 'objective-state-v1';
  var CUTOVER_ID = 'objective-state-cutover-v1';
  var CHECKPOINT_ID = 'objective-state-migration-v1';
  var JOURNAL_KIND = 'migration_reconstructed';

  function payloadOf(record) { return (record && record.payload) || {}; }
  function launchOf(record) { return payloadOf(record).launch_context || {}; }
  function resumeOf(record) { return payloadOf(record).resume_context || {}; }
  function hasFeedbackProvenance(record) {
    var p = payloadOf(record), launch = launchOf(record), resume = resumeOf(record);
    return Boolean(p.feedback_message_id || p.feedback_thread_id || p.step === 'feedback' ||
      launch.source === 'feedback-sheet' || resume.source === 'feedback-sheet');
  }
  function hasDiagnosticMarker(record) {
    var p = payloadOf(record);
    return p.execution_kind === 'acknowledgement_diagnostic' || launchOf(record).proof === 'gas-a-b';
  }
  /* Mirrors the runtime diagnostic boundary without duplicating its evolution: the live
     guard stays authoritative; this is the reconstruction-time reading of the same rule. */
  function isDiagnostic(record) {
    if (payloadOf(record).execution_kind === 'objective') return false;
    if (hasFeedbackProvenance(record)) return false;
    return hasDiagnosticMarker(record);
  }
  /* Rebuild one current record per logical id from raw revision rows. A fork (two rows
     superseding the same parent) or a dangling supersedes reference is flagged, never
     guessed past: the winner is deterministic (revision, then updated_at, then row id)
     and the ambiguity stays visible on the result. */
  function reconstructCurrent(rows) {
    var byId = {}, entities = {}, ambiguous = [];
    (rows || []).forEach(function (row) {
      if (!row || !row.id) return;
      (byId[row.id] = byId[row.id] || []).push(row);
    });
    Object.keys(byId).forEach(function (id) {
      var chain = byId[id].slice().sort(function (a, b) {
        return (Number(a.revision || 0) - Number(b.revision || 0)) ||
          (String(a.updated_at || '') < String(b.updated_at || '') ? -1 : String(a.updated_at || '') > String(b.updated_at || '') ? 1 : 0) ||
          (String(a.id) < String(b.id) ? -1 : 1);
      });
      var children = {}, notes = [];
      chain.forEach(function (row) {
        var key = String(Number(row.revision || 0));
        (children[key] = children[key] || []).push(row);
        var parent = row.supersedes || '';
        if (parent && parent !== id) {
          var known = false;
          for (var i = 0; i < chain.length; i++) {
            if (String(chain[i].revision) === String(parent)) { known = true; break; }
          }
          if (!known) notes.push({ type: 'dangling-supersedes', revision: row.revision, supersedes: parent });
        }
      });
      Object.keys(children).forEach(function (revision) {
        if (children[revision].length > 1) notes.push({ type: 'forked-chain', revision: Number(revision), updated_at: children[revision].map(function (r) { return r.updated_at; }) });
      });
      var winner = chain[chain.length - 1];
      entities[id] = winner;
      if (notes.length) ambiguous.push({ id: id, winner_revision: winner.revision, notes: notes });
    });
    return { entities: entities, ambiguous: ambiguous };
  }
  /* Classification under the new semantics. Terminal records can never emerge as done:
     no guarded completion exists yet, so every terminal legacy record is needs-review.
     Nonterminal feedback work is objective; nonterminal diagnostics stay diagnostic;
     anything unrecognized fails closed to needs-review, never to a fresh objective. */
  function classify(record) {
    if (!record) return 'unknown';
    if (hasFeedbackProvenance(record) || payloadOf(record).execution_kind === 'objective') {
      return (record.lifecycle === 'completed' || record.lifecycle === 'invalid') ? 'needs-review' : 'objective';
    }
    if (isDiagnostic(record)) return record.lifecycle === 'completed' ? 'needs-review' : 'acknowledgement_diagnostic';
    return 'needs-review';
  }
  function dispositionFor(record, classification) {
    if (classification === 'objective') return 'awaits-executor';
    if (classification === 'acknowledgement_diagnostic') return 'diagnostic-history';
    return 'needs-review';
  }
  /* Pure plan: stable objective entries keyed by existing order id, journal entries with
     stable ids, and feedback-row mapping that resolves to existing orders or lists the
     row as unmapped. Planning invents nothing and writes nothing. */
  function planMigration(snapshot) {
    snapshot = snapshot || {};
    var orders = reconstructCurrent(snapshot.work_orders || []);
    var wakes = reconstructCurrent(snapshot.wakes || []);
    var executions = reconstructCurrent(snapshot.executions || []);
    var objectives = [], journal = [], unmappedFeedback = [];
    Object.keys(orders.entities).forEach(function (id) {
      var record = orders.entities[id], classification = classify(record);
      objectives.push({
        id: id,
        classification: classification,
        lifecycle: record.lifecycle,
        disposition: dispositionFor(record, classification),
        feedback_thread_id: payloadOf(record).feedback_thread_id || null,
        feedback_revision: Number(payloadOf(record).feedback_revision || 1),
        wait_condition: payloadOf(record).wait_condition || null
      });
      journal.push({
        id: JOURNAL_KIND + '-' + VERSION + '-' + id,
        kind: JOURNAL_KIND,
        work_order_id: id,
        classification: classification,
        disposition: dispositionFor(record, classification),
        source_lifecycle: record.lifecycle,
        source_revision: record.revision
      });
    });
    (snapshot.feedbackRows || []).forEach(function (row) {
      var match = null;
      for (var i = 0; i < objectives.length; i++) {
        var o = objectives[i];
        if (o.feedback_thread_id && String(o.feedback_thread_id) === String(row.thread) &&
          Number(o.feedback_revision) === Number(row.revision || 1)) { match = o.id; break; }
      }
      if (!match) unmappedFeedback.push({ row: row.row, thread: row.thread || null, revision: Number(row.revision || 1) });
    });
    objectives.sort(function (a, b) { return String(a.id) < String(b.id) ? -1 : 1; });
    journal.sort(function (a, b) { return String(a.id) < String(b.id) ? -1 : 1; });
    return {
      version: VERSION,
      objectives: objectives,
      journal: journal,
      unmappedFeedback: unmappedFeedback,
      ambiguous: orders.ambiguous.concat(wakes.ambiguous, executions.ambiguous)
    };
  }
  function checkpoint() {
    try { return CT_GAS_STATE.get('schema', CHECKPOINT_ID); } catch (_) { return null; }
  }
  function appliedIds() {
    var cp = checkpoint();
    return (cp && cp.payload && Array.isArray(cp.payload.applied)) ? cp.payload.applied : [];
  }
  function recordProgress(applied) {
    var body = { version: VERSION, applied: applied.slice().sort(), objective_done: false };
    var existing = null;
    try { existing = CT_GAS_STATE.get('schema', CHECKPOINT_ID); } catch (_) { existing = null; }
    if (!existing) CT_GAS_STATE.create('schema', { id: CHECKPOINT_ID, kind: 'migration_checkpoint', payload: body });
    else CT_GAS_STATE.update('schema', CHECKPOINT_ID, { payload: body });
  }
  /* Applies a plan. Each journal entry carries a stable id, so an interrupted run can
     simply rerun: already-applied entries are skipped, and re-creating an applied
     entry returns the existing row instead of duplicating it. */
  function runMigration(plan, opts) {
    if (!plan || plan.version !== VERSION) throw new Error('migration refused: version gate mismatch');
    opts = opts || {};
    if (opts.dryRun) return { status: 'planned', version: VERSION, objectives: plan.objectives.length, journal: plan.journal.length, unmapped: plan.unmappedFeedback.length, ambiguous: plan.ambiguous.length, writes: 0 };
    var done = {};
    appliedIds().forEach(function (id) { done[id] = true; });
    var writes = 0;
    plan.journal.forEach(function (entry) {
      if (done[entry.id]) return;
      CT_GAS_STATE.create('observer_ledger', {
        id: entry.id,
        kind: entry.kind,
        execution_id: '',
        payload: {
          work_order_id: entry.work_order_id,
          classification: entry.classification,
          disposition: entry.disposition,
          source_lifecycle: entry.source_lifecycle,
          source_revision: entry.source_revision,
          migration_version: VERSION,
          objective_done: false
        }
      });
      writes++;
      done[entry.id] = true;
    });
    recordProgress(Object.keys(done));
    return { status: 'applied', version: VERSION, objectives: plan.objectives.length, writes: writes, unmapped: plan.unmappedFeedback.length, ambiguous: plan.ambiguous.length };
  }
  /* Single-writer cutover. Absent a cutover record the legacy path owns everything
     (today's behavior, unchanged). Once a cutover names new-authority objectives, the
     legacy path must not advance them; objectives not named stay legacy-owned. */
  function cutoverRecord() {
    try { return CT_GAS_STATE.get('schema', CUTOVER_ID); } catch (_) { return null; }
  }
  function writerFor(objectiveId) {
    var cutover = cutoverRecord();
    if (!cutover || !cutover.payload || cutover.payload.version !== VERSION) return 'legacy';
    var owned = cutover.payload.objectives || [];
    return owned.indexOf(objectiveId) >= 0 ? (cutover.payload.authority || 'new') : 'legacy';
  }
  function setCutover(objectiveIds, authority) {
    var body = { version: VERSION, authority: authority || 'new', objectives: (objectiveIds || []).slice().sort() };
    var existing = null;
    try { existing = CT_GAS_STATE.get('schema', CUTOVER_ID); } catch (_) { existing = null; }
    if (!existing) CT_GAS_STATE.create('schema', { id: CUTOVER_ID, kind: 'migration_cutover', payload: body });
    else CT_GAS_STATE.update('schema', CUTOVER_ID, { payload: body });
    return body;
  }
  function legacyAdvanceAllowed(objectiveId) { return writerFor(objectiveId) === 'legacy'; }
  return {
    VERSION: VERSION,
    reconstructCurrent: reconstructCurrent,
    classify: classify,
    planMigration: planMigration,
    runMigration: runMigration,
    writerFor: writerFor,
    setCutover: setCutover,
    legacyAdvanceAllowed: legacyAdvanceAllowed
  };
}());
/* Explicit entry only. Never called by the scheduler, dispatch, or feedback paths. */
function runObjectiveStateMigration(input) {
  input = input || {};
  var snapshot = input.snapshot || {
    work_orders: CT_GAS_STATE.list('work_orders'),
    wakes: CT_GAS_STATE.list('wakes'),
    executions: CT_GAS_STATE.list('executions'),
    feedbackRows: []
  };
  var plan = CT_GAS_MIGRATION.planMigration(snapshot);
  return CT_GAS_MIGRATION.runMigration(plan, { dryRun: input.dryRun !== false });
}
