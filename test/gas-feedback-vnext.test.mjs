import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import fs from 'node:fs';

function loadAdapter() {
  const rows = new Map();
  let uuid = 0;
  const context = {
    CT_GAS: {
      MAX_MESSAGE: 4000,
      OPERATION_BUDGETS: { stateWrite: 1 },
      bound: (v, n) => String(v ?? '').slice(0, n || 64000),
      json: (v) => JSON.stringify(v === undefined ? null : Array.isArray(v) ? v.map((x) => JSON.parse(context.CT_GAS.json(x))) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, JSON.parse(context.CT_GAS.json(v[k]))])) : v),
      sha256: (v) => crypto.createHash('sha256').update(String(v)).digest('hex'),
    },
    Utilities: { getUuid: () => `uuid-${++uuid}` },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    SpreadsheetApp: {
      DeveloperMetadataVisibility: { PROJECT: 'PROJECT' },
      openById: (id) => ({ getSheetByName: (name) => ({ getRange: (row) => rows.get(Number(row)) }) }),
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL('../gas/gas_feedback_vnext.js', import.meta.url), 'utf8'), context);
  return { adapter: context.CT_GAS_FEEDBACK_VNEXT, rows };
}

class FakeRange {
  constructor(row) { this.row = row; this.metadata = []; }
  getDeveloperMetadata() { return this.metadata; }
  addDeveloperMetadata(key, value) { this.metadata.push(new FakeMetadata(this, key, value)); }
}
class FakeMetadata {
  constructor(range, key, value) { this.range = range; this.key = key; this.value = String(value); }
  getKey() { return this.key; }
  getValue() { return this.value; }
  remove() { this.range.metadata = this.range.metadata.filter((x) => x !== this); }
}

function clock() { return { canStart: () => true }; }
function bundle(rows) { return { spreadsheet_id: 'sheet-1', sheet_name: 'Feedback', rows }; }
function item(row, message, reply = '', project = '') { return { row, message, reply, project, thread: '' }; }

async function ingest(adapter, rows, events) {
  return adapter.ingest(clock(), bundle(rows), (event) => events.push(event));
}

test('new feedback row receives stable F1/R1 across repeated rereads', async () => {
  const { adapter, rows } = loadAdapter();
  rows.set(5, new FakeRange(5));
  const events = [];
  for (let i = 0; i < 20; i++) await ingest(adapter, [item(5, 'hello')], events);
  assert.equal(events.length, 20);
  assert.equal(new Set(events.map((e) => e.feedback_id)).size, 1);
  assert.equal(new Set(events.map((e) => e.source_revision)).size, 1);
  assert.equal(new Set(events.map((e) => e.event_id)).size, 1);
  assert.equal(events[0].source_revision, 1);
});

test('editing the source keeps feedback id and advances exactly one revision', async () => {
  const { adapter, rows } = loadAdapter();
  rows.set(5, new FakeRange(5));
  const events = [];
  await ingest(adapter, [item(5, 'A')], events);
  await ingest(adapter, [item(5, 'B')], events);
  for (let i = 0; i < 20; i++) await ingest(adapter, [item(5, 'B')], events);
  assert.equal(new Set(events.map((e) => e.feedback_id)).size, 1);
  assert.deepEqual([...new Set(events.map((e) => e.source_revision))], [1, 2]);
  assert.equal(events.at(-1).event_id, `${events[0].event_id.split(':').slice(0, -1).join(':')}:2`);
});

test('a second row gets a distinct feedback identity', async () => {
  const { adapter, rows } = loadAdapter();
  rows.set(5, new FakeRange(5));
  rows.set(6, new FakeRange(6));
  const events = [];
  await ingest(adapter, [item(5, 'A'), item(6, 'B')], events);
  assert.equal(new Set(events.map((e) => e.feedback_id)).size, 2);
  assert.deepEqual(events.map((e) => e.source_revision), [1, 1]);
});

test('partial metadata fails closed and copied identity conflicts', async () => {
  const { adapter, rows } = loadAdapter();
  rows.set(5, new FakeRange(5));
  rows.set(6, new FakeRange(6));
  rows.get(5).addDeveloperMetadata('CT_FEEDBACK_ID', 'same-id');
  rows.get(5).addDeveloperMetadata('CT_FEEDBACK_REVISION', '1');
  rows.get(5).addDeveloperMetadata('CT_FEEDBACK_STATE_HASH', 'hash');
  const events = [];
  await assert.rejects(() => ingest(adapter, [item(5, 'A')], events), /feedback adapter state is malformed/);
  rows.get(6).addDeveloperMetadata('CT_FEEDBACK_ID', 'same-id');
  rows.get(6).addDeveloperMetadata('CT_FEEDBACK_REVISION', '1');
  rows.get(6).addDeveloperMetadata('CT_FEEDBACK_STATE_HASH', adapter.stateHash(item(6, 'B')));
  await assert.rejects(() => ingest(adapter, [item(6, 'B'), item(5, 'A')], events), /feedback identity conflict/);
});
