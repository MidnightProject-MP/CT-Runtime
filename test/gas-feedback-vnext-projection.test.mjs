import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import fs from 'node:fs';

function loadProjection({ rows, graph } = {}) {
  const context = {
    CT_GAS: {
      json: (v) => JSON.stringify(v === undefined ? null : Array.isArray(v) ? v.map((x) => JSON.parse(context.CT_GAS.json(x))) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, JSON.parse(context.CT_GAS.json(v[k]))])) : v),
      sha256: (v) => crypto.createHash('sha256').update(String(v)).digest('hex'),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    SpreadsheetApp: {
      DeveloperMetadataVisibility: { PROJECT: 'PROJECT' },
      openById: () => ({ getSheetByName: () => new FakeSheet(rows, graph) }),
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL('../gas/gas_feedback_vnext_projection.js', import.meta.url), 'utf8'), context);
  return context.CT_GAS_FEEDBACK_VNEXT_PROJECTION;
}

class FakeMetadata {
  constructor(range, key, value) { this.range = range; this.key = key; this.value = String(value); }
  getKey() { return this.key; }
  getValue() { return this.value; }
  remove() { this.range.metadata = this.range.metadata.filter((x) => x !== this); }
}

class FakeRange {
  constructor(row, values) { this.row = row; this.values = values.slice(); this.metadata = []; this.failMetadataOnce = false; }
  getDeveloperMetadata() { return this.metadata; }
  addDeveloperMetadata(key, value) {
    if (this.failMetadataOnce) { this.failMetadataOnce = false; throw new Error('simulated crash after Sheet write'); }
    this.metadata.push(new FakeMetadata(this, key, value));
  }
  getValues() { return [this.values.slice()]; }
  getSheet() { return this.sheet; }
  setValues(values) { this.values = values[0].slice(); }
}

class FakeSheet {
  constructor(rows, graph) {
    this.rows = rows;
    this.graph = graph;
    Object.values(rows).forEach((range) => { range.sheet = this; });
  }
  getLastRow() { return Math.max(4, ...Object.keys(this.rows).map(Number)); }
  getRange(row, column, numRows, numColumns) {
    if (row === 4 && column === 1 && numColumns === 8) return { getValues: () => [[
      'Project (optional)','Message / objective','Status','Celestan update / question','Your reply','Last activity','Thread ID','Reply revision',
    ]] };
    if (column === 1 && numColumns === 8) return this.rows[row] || new FakeRange(row, ['', '', '', '', '', '', '', '']);
    if (column === 3 && numColumns === 2) return {
      setValues: (values) => {
        const range = this.rows[row];
        range.values[2] = values[0][0];
        range.values[3] = values[0][1];
      },
    };
    throw new Error(`unexpected range ${row},${column},${numRows},${numColumns}`);
  }
}

function evaluation(overrides = {}) {
  return {
    evaluation_id: 'feedback-evaluation:feedback-1:1',
    feedback_id: 'feedback-1',
    source_revision: 1,
    disposition: 'question_answered',
    summary: 'The question was answered.',
    response: 'Here is the answer.',
    receipt_event_id: 'human-feedback:feedback-1:1',
    evaluator_version: 'test-v1',
    ...overrides,
  };
}

function rowWithIdentity({ revision = 1, status = '', response = '' } = {}) {
  const row = new FakeRange(5, ['Project', 'Question', status, response, '', 'keep', 'thread-1', String(revision)]);
  row.addDeveloperMetadata('CT_FEEDBACK_ID', 'feedback-1');
  row.addDeveloperMetadata('CT_FEEDBACK_REVISION', String(revision));
  row.addDeveloperMetadata('CT_FEEDBACK_STATE_HASH', 'source-hash');
  return row;
}

test('first projection writes response/status exactly once', () => {
  const rows = { 5: rowWithIdentity() };
  const graph = { work_units: [{ id: 'wu-1' }], executions: [{ id: 'ex-1' }], continuations: [], wakes: [{ id: 'wake-1' }] };
  const projection = loadProjection({ rows, graph });
  const beforeGraph = structuredClone(graph);
  const before = rows[5].values.slice();
  const result = projection.project('sheet-1', 'Feedback', evaluation());
  assert.equal(result.status, 'created');
  assert.equal(rows[5].values[2], 'Answered');
  assert.equal(rows[5].values[3], 'Here is the answer.');
  assert.deepEqual(rows[5].values.slice(0, 2), before.slice(0, 2));
  assert.deepEqual(rows[5].values.slice(4), before.slice(4));
  assert.deepEqual(graph, beforeGraph);
  const metadata = Object.fromEntries(rows[5].metadata.map((m) => [m.getKey(), m.getValue()]));
  assert.equal(metadata.CT_FEEDBACK_PROJECTION_ID, 'feedback-projection:feedback-evaluation:feedback-1:1');
  assert.equal(metadata.CT_FEEDBACK_PROJECTION_EVALUATION, evaluation().evaluation_id);
  assert.ok(metadata.CT_FEEDBACK_PROJECTION_HASH);
});

test('retry is a no-op and does not change the Sheet', () => {
  const rows = { 5: rowWithIdentity() };
  const projection = loadProjection({ rows, graph: {} });
  const first = projection.project('sheet-1', 'Feedback', evaluation());
  const valuesAfterFirst = rows[5].values.slice();
  const metadataAfterFirst = rows[5].metadata.map((m) => [m.getKey(), m.getValue()]);
  const second = projection.project('sheet-1', 'Feedback', evaluation());
  assert.equal(first.projection_id, second.projection_id);
  assert.equal(second.status, 'existing');
  assert.deepEqual(rows[5].values, valuesAfterFirst);
  assert.deepEqual(rows[5].metadata.map((m) => [m.getKey(), m.getValue()]), metadataAfterFirst);
});

test('crash after Sheet write but before projection acknowledgment converges on retry', () => {
  const rows = { 5: rowWithIdentity() };
  rows[5].failMetadataOnce = true;
  const projection = loadProjection({ rows, graph: {} });
  assert.throws(() => projection.project('sheet-1', 'Feedback', evaluation()), /simulated crash/);
  assert.equal(rows[5].values[2], 'Answered');
  assert.equal(rows[5].values[3], 'Here is the answer.');
  const retry = projection.project('sheet-1', 'Feedback', evaluation());
  assert.equal(retry.status, 'created');
  assert.equal(rows[5].values[2], 'Answered');
  assert.equal(rows[5].values[3], 'Here is the answer.');
});

test('missing source row is an explicit projection failure with no graph mutation', () => {
  const rows = {};
  const graph = { work_units: [{ id: 'wu-1' }], executions: [{ id: 'ex-1' }], continuations: [{ id: 'c-1' }], wakes: [{ id: 'wake-1' }] };
  const projection = loadProjection({ rows, graph });
  const before = structuredClone(graph);
  assert.throws(() => projection.project('sheet-1', 'Feedback', evaluation()), /source row not found/);
  assert.deepEqual(graph, before);
});

test('changed human source revision refuses projection onto the wrong revision', () => {
  const rows = { 5: rowWithIdentity({ revision: 2 }) };
  const projection = loadProjection({ rows, graph: {} });
  assert.throws(() => projection.project('sheet-1', 'Feedback', evaluation()), /source revision changed/);
  assert.equal(rows[5].values[2], '');
  assert.equal(rows[5].values[3], '');
});

test('conflicting projection state is rejected rather than overwritten', () => {
  const rows = { 5: rowWithIdentity({ status: 'Answered', response: 'Different answer.' }) };
  const projection = loadProjection({ rows, graph: {} });
  assert.throws(() => projection.project('sheet-1', 'Feedback', evaluation()), /conflicting response/);
  assert.equal(rows[5].values[3], 'Different answer.');
});

test('existing projection with changed evaluation content is an integrity conflict', () => {
  const rows = { 5: rowWithIdentity() };
  const projection = loadProjection({ rows, graph: {} });
  projection.project('sheet-1', 'Feedback', evaluation());
  assert.throws(() => projection.project('sheet-1', 'Feedback', evaluation({ response: 'Changed answer.' })), /projection identity conflict/);
  assert.equal(rows[5].values[3], 'Here is the answer.');
});

test('all dispositions map to bounded human-facing statuses', () => {
  const expected = {
    acknowledged: 'Acknowledged',
    informational: 'Informational',
    needs_follow_up: 'Needs follow-up',
    suggests_new_work: 'New work suggested',
    relates_to_existing_work: 'Related to existing work',
    question_answered: 'Answered',
    no_action: 'No action',
  };
  const rows = {};
  const projection = loadProjection({ rows, graph: {} });
  for (const [disposition, status] of Object.entries(expected)) assert.equal(projection.statusFor(disposition), status);
});

test('invalid evaluation identity/disposition is rejected before any Sheet mutation', () => {
  const rows = { 5: rowWithIdentity() };
  const projection = loadProjection({ rows, graph: {} });
  assert.throws(() => projection.project('sheet-1', 'Feedback', evaluation({ evaluation_id: 'wrong' })), /evaluation identity is invalid/);
  assert.throws(() => projection.project('sheet-1', 'Feedback', evaluation({ disposition: 'invented' })), /invalid feedback evaluation disposition/);
  assert.equal(rows[5].values[2], '');
  assert.equal(rows[5].values[3], '');
});
