import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Isolated migration proof: copied-fixture semantics against the real GAS sources in
// VM service doubles. Nothing here touches live state; the migration entry point is
// exercised with explicit snapshots, and rerun/interruption behavior is proven by
// re-invocation, not by accidents of shared fixtures.
const files = ['gas_core.js', 'gas_state.js', 'gas_trigger.js', 'gas_federation.js', 'gas_evidence.js', 'gas_observer.js', 'gas_agent_executor.js', 'gas_v8.js', 'gas_migrate.js'];
async function source() { return (await Promise.all(files.map(f => readFile(new URL(`../gas/${f}`, import.meta.url), 'utf8')))).join('\n'); }
function harness({ now = 100000, budget = 300000 } = {}) {
  const props = new Map([['CT_GAS_SPREADSHEET_ID', 'sheet'], ['CT_GAS_DRIVE_ROOT_ID', 'root'], ['CT_GAS_PROOF_MODEL', 'openrouter/test:free'], ['CT_GAS_BUDGET_MS', String(budget)]]);
  const rows = new Map(), triggers = [], files = new Map(); let clock = now, fileCounter = 0;
  const sheet = name => ({ getLastRow: () => (rows.get(name) || []).length, appendRow: row => rows.get(name).push(row), getDataRange: () => ({ getValues: () => rows.get(name) || [] }) });
  class FakeDate extends Date { static now() { return clock; } }
  const context = { Date: FakeDate, console, Math, JSON, isNaN, isFinite, setTimeout };
  context.Utilities = { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: (_, value) => [...createHash('sha256').update(String(value)).digest()], newBlob: (x) => ({ x }), getUuid: () => 'uuid', sleep: () => {} };
  context.PropertiesService = { getScriptProperties: () => ({ getProperty: k => props.get(k) || null, setProperty: (k, v) => props.set(k, String(v)) }) };
  context.LockService = { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) };
  context.SpreadsheetApp = { openById: () => ({ getSheetByName: name => rows.has(name) ? sheet(name) : null, insertSheet: name => { rows.set(name, [['id', 'kind', 'lifecycle', 'execution_id', 'parent_id', 'worker_id', 'idempotency_key', 'payload_json', 'created_at', 'updated_at', 'schema_version', 'revision', 'supersedes', 'owner', 'fence', 'lease_until']]); return sheet(name); } }) };
  context.ScriptApp = { getProjectTriggers: () => triggers, newTrigger: handler => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => { triggers.push({ getHandlerFunction: () => handler, getTriggerSource: () => 'time', getUniqueId: () => `t${triggers.length}` }); } }) }) }) };
  context.DriveApp = { getFolderById: () => { throw new Error('no drive in migration proof'); }, getFileById: () => { throw new Error('no drive in migration proof'); } };
  context.UrlFetchApp = { fetch: () => { throw new Error('no network in migration proof'); } };
  vm.createContext(context); return { context, rows, props, setNow: n => { clock = n; } };
}
async function boot(options) { const h = harness(options); vm.runInContext(await source(), h.context); return h; }
function seedObjective(state, id, extra = {}) {
  return state.create('work_orders', { id, lifecycle: 'requested', payload: { execution_kind: 'objective', goal: 'real objective ' + id, step: 'feedback', feedback_thread_id: 'thread-' + id, feedback_revision: 1, physical_execution_count: 0, ...extra } });
}
function seedDiagnosticCompleted(state, id) {
  return state.create('work_orders', { id, lifecycle: 'completed', payload: { execution_kind: 'acknowledgement_diagnostic', goal: 'Continue bounded work', step: 'B', physical_execution_count: 1 } });
}

test('migration module is inert at load and version-gated', async () => {
  const h = await boot();
  assert.equal(h.context.CT_GAS_MIGRATION.VERSION, 'objective-state-v1');
  assert.equal((h.rows.get('schema') || []).length, 0, 'no checkpoint written at load');
  assert.equal((h.rows.get('observer_ledger') || []).length, 0, 'no journal written at load');
  assert.throws(() => h.context.CT_GAS_MIGRATION.runMigration({ version: 'bogus' }), /version gate mismatch/);
});

test('identity: admitted feedback reconstructs to the same stable objective, twice', async () => {
  const h = await boot(); const state = h.context.CT_GAS_STATE;
  seedObjective(state, 'order-stable');
  state.update('work_orders', 'order-stable', { lifecycle: 'waiting', payload: { wait_condition: 'execution_capacity' } });
  const snapshot = () => ({ work_orders: state.list('work_orders'), wakes: state.list('wakes'), executions: state.list('executions'), feedbackRows: [{ row: 5, thread: 'thread-order-stable', revision: 1 }] });
  const first = h.context.CT_GAS_MIGRATION.planMigration(snapshot());
  const second = h.context.CT_GAS_MIGRATION.planMigration(snapshot());
  assert.deepEqual(second, first);
  assert.equal(first.objectives.length, 1);
  assert.equal(first.objectives[0].id, 'order-stable');
  assert.equal(first.objectives[0].classification, 'objective');
  assert.equal(first.unmappedFeedback.length, 0);
  assert.equal(state.list('work_orders').filter(o => o.id === 'order-stable').length, 2, 'planning writes no rows; two rows are the seeded revisions');
});

test('journal reconciliation preserves history and never implies done', async () => {
  const h = await boot(); const state = h.context.CT_GAS_STATE;
  seedObjective(state, 'order-live');
  seedDiagnosticCompleted(state, 'order-legacy-ack');
  state.create('work_orders', { id: 'order-legacy-verify', lifecycle: 'completed', payload: { goal: 'old feedback goal', step: 'feedback', feedback_thread_id: 'thread-old', feedback_revision: 1, next_operation: 'verify', evidence_ref: { drive_file_id: 'old-file', sha256: 'old-hash' } } });
  const workRowsBefore = state.list('work_orders').length;
  const plan = h.context.CT_GAS_MIGRATION.planMigration({ work_orders: state.list('work_orders'), wakes: [], executions: [] });
  const byId = Object.fromEntries(plan.objectives.map(o => [o.id, o]));
  assert.equal(byId['order-legacy-ack'].disposition, 'needs-review');
  assert.equal(byId['order-legacy-verify'].disposition, 'needs-review');
  assert.equal(byId['order-live'].disposition, 'awaits-executor');
  assert.ok(plan.journal.every(e => e.objective_done === undefined || e.objective_done === false));
  const result = h.context.CT_GAS_MIGRATION.runMigration(plan, {});
  assert.equal(result.status, 'applied');
  assert.equal(state.list('work_orders').length, workRowsBefore, 'entity history untouched');
  assert.equal(state.get('work_orders', 'order-legacy-ack').lifecycle, 'completed', 'terminal record not reopened');
});

test('idempotent rerun across the journal/checkpoint crash window', async () => {
  const h = await boot(); const state = h.context.CT_GAS_STATE;
  seedObjective(state, 'order-a');
  seedObjective(state, 'order-b');
  const plan = h.context.CT_GAS_MIGRATION.planMigration({ work_orders: state.list('work_orders'), wakes: [], executions: [] });
  const first = h.context.CT_GAS_MIGRATION.runMigration(plan, {});
  assert.equal(first.writes, 2);
  const journalCount = () => state.list('observer_ledger').filter(r => r.kind === 'migration_reconstructed').length;
  assert.equal(journalCount(), 2);
  // Simulate interruption that lost the checkpoint update after journal writes:
  // roll the checkpoint back to a partial applied list, keep both journal rows.
  state.update('schema', 'objective-state-migration-v1', { payload: { version: 'objective-state-v1', applied: ['migration_reconstructed-objective-state-v1-order-a'], objective_done: false } });
  const rerun = h.context.CT_GAS_MIGRATION.runMigration(plan, {});
  assert.equal(journalCount(), 2, 'stable journal ids are not duplicated');
  assert.deepEqual(state.get('schema', 'objective-state-migration-v1').payload.applied.sort(), ['migration_reconstructed-objective-state-v1-order-a', 'migration_reconstructed-objective-state-v1-order-b']);
  const clean = h.context.CT_GAS_MIGRATION.runMigration(plan, {});
  assert.equal(clean.writes, 0, 'clean rerun is a no-op');
});

test('dry run and unmapped feedback invent nothing', async () => {
  const h = await boot(); const state = h.context.CT_GAS_STATE;
  seedObjective(state, 'order-known');
  const before = { work_orders: state.list('work_orders').length, ledger: state.list('observer_ledger').length, schema: state.list('schema').length };
  const plan = h.context.CT_GAS_MIGRATION.planMigration({
    work_orders: state.list('work_orders'), wakes: [], executions: [],
    feedbackRows: [{ row: 5, thread: 'thread-order-known', revision: 1 }, { row: 6, thread: 'thread-stranger', revision: 1 }]
  });
  assert.equal(plan.unmappedFeedback.length, 1);
  assert.equal(plan.unmappedFeedback[0].thread, 'thread-stranger');
  const dry = h.context.CT_GAS_MIGRATION.runMigration(plan, { dryRun: true });
  assert.equal(dry.writes, 0);
  assert.deepEqual({ work_orders: state.list('work_orders').length, ledger: state.list('observer_ledger').length, schema: state.list('schema').length }, before);
});

test('forked and malformed legacy chains fail closed to review, never to guesses', async () => {
  const h = await boot();
  const M = h.context.CT_GAS_MIGRATION;
  const base = (id, revision, supersedes, payload) => ({ id, kind: 'work_order', lifecycle: 'requested', revision, supersedes, updated_at: '2026-09-08T00:00:0' + revision + 'Z', payload });
  const forked = [
    base('order-fork', 1, '', { goal: 'g' }),
    base('order-fork', 2, 'order-fork', { goal: 'g2' }),
    { id: 'order-fork', kind: 'work_order', lifecycle: 'requested', revision: 2, supersedes: 'order-fork', updated_at: '2026-09-08T00:00:05Z', payload: { goal: 'g2-rival' } },
  ];
  const rebuilt = M.reconstructCurrent(forked);
  assert.equal(Object.keys(rebuilt.entities).length, 1);
  assert.equal(rebuilt.ambiguous.length, 1);
  assert.equal(rebuilt.ambiguous[0].notes[0].type, 'forked-chain');
  const malformed = [{ id: 'order-broken', kind: 'work_order', lifecycle: 'requested', revision: 1, supersedes: '', updated_at: '2026-09-08T00:00:01Z', payload: {} }];
  const plan = M.planMigration({ work_orders: forked.concat(malformed), wakes: [{ bad: true }], executions: [] });
  const byId = Object.fromEntries(plan.objectives.map(o => [o.id, o]));
  assert.equal(byId['order-broken'].disposition, 'needs-review', 'unrecognizable state fails closed');
  assert.ok(byId['order-fork'], 'forked entity still reconstructs deterministically');
  assert.ok(plan.ambiguous.length >= 1);
});

test('single-writer cutover: fenced objectives are untouched by every legacy path', async () => {
  const h = await boot(); const state = h.context.CT_GAS_STATE;
  seedObjective(state, 'order-fenced');
  state.create('wakes', { id: 'wake-fenced', lifecycle: 'pending', payload: { time: new Date(0).toISOString(), reason: 'human', work_order_id: 'order-fenced', execution_id: 'exec-fenced', continuation_id: 'cont-fenced', launch: {}, resume: {} } });
  const M = h.context.CT_GAS_MIGRATION;
  assert.equal(M.writerFor('order-fenced'), 'legacy', 'no cutover means legacy owns everything');
  M.setCutover(['order-fenced'], 'new');
  assert.equal(M.writerFor('order-fenced'), 'new');
  assert.equal(M.writerFor('order-other'), 'legacy', 'unnamed objectives stay legacy-owned');
  assert.equal(M.legacyAdvanceAllowed('order-fenced'), false);
  const revisionBefore = state.get('work_orders', 'order-fenced').revision;
  const direct = h.context.runWake({ work_order_id: 'order-fenced', execution_id: 'exec-fenced', continuation_id: 'cont-fenced', wake_id: 'wake-fenced' });
  assert.equal(direct.reason, 'cutover-new-authority');
  h.setNow(200000);
  h.context.gasSafetyWake();
  assert.equal(state.get('work_orders', 'order-fenced').revision, revisionBefore, 'recovery performed no wait mutation');
  assert.equal(state.get('wakes', 'wake-fenced').lifecycle, 'pending', 'due wake left for the owning path');
  assert.equal((h.rows.get('executions') || []).length, 0, 'no physical execution started');
});
