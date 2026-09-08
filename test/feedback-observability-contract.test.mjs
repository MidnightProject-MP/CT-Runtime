import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const CANONICAL_HEADER = ['Project (optional)', 'Message / objective', 'Status', 'Celestan update / question', 'Your reply', 'Last activity', 'Thread ID', 'Reply revision'];
const FORBIDDEN_CONTENT_KEYS = ['message', 'goal', 'objective', 'response', 'reply', 'project'];

function signedDigest(value) {
  return [...createHash('sha256').update(String(value)).digest()].map((b) => (b > 127 ? b - 256 : b));
}

function makeSheet(grid) {
  const writes = [];
  const cell = (r, c) => (grid[r - 1] && grid[r - 1][c - 1] != null ? grid[r - 1][c - 1] : '');
  return {
    grid,
    writes,
    getLastRow: () => grid.length,
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(r + i, c + j))),
        setValue: (v) => {
          while (grid.length < r) grid.push([]);
          while (grid[r - 1].length < c) grid[r - 1].push('');
          grid[r - 1][c - 1] = v;
          writes.push({ row: r, col: c, value: v });
        },
      };
    },
  };
}

function liveMirrorGrid() {
  return [
    ['CT Feedback inbox', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', ''],
    ['Add new requests below row 4. Do not edit the header.', '', '', '', '', '', '', ''],
    [...CANONICAL_HEADER],
    ['CT-Runtime', 'Verify the CT-Runtime wake pipeline end to end', '', '', '', '', '', ''],
  ];
}

async function loadSafetyWake({ grid, props = {} }) {
  const sheet = makeSheet(grid);
  const store = { work_orders: [], wakes: [], observer_ledger: [] };
  const wakeCalls = [];
  const sandbox = {
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (_alg, value) => signedDigest(value),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
      }),
    },
    ScriptApp: {
      getScriptId: () => 'test-script-id',
      getProjectTriggers: () => [{
        getHandlerFunction: () => 'gasSafetyWake',
        getTriggerSource: () => 'CLOCK',
        getUniqueId: () => 'trigger-1',
      }],
      newTrigger: () => { throw new Error('newTrigger must not be called when a safety trigger exists'); },
    },
    LockService: { getScriptLock: () => ({ waitLock: () => true, releaseLock: () => {} }) },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) },
    console,
  };
  vm.createContext(sandbox);
  const run = async (path) => vm.runInContext(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'), sandbox, { filename: path });
  await run('gas/gas_core.js');
  const CT_GAS = sandbox.CT_GAS;
  sandbox.CT_GAS_STATE = {
    list: (kind) => store[kind] || [],
    get: (kind, id) => (store[kind] || []).filter((r) => r.id === id).pop() || null,
    create: (kind, row) => { const full = { ...row, kind, revision: 1 }; (store[kind] = store[kind] || []).push(full); return full; },
    update: (kind, id, patch) => {
      const rows = (store[kind] || []).filter((r) => r.id === id);
      if (!rows.length) throw new Error('record not found');
      const old = rows[rows.length - 1];
      if (patch.lifecycle) CT_GAS.transition(old.lifecycle, patch.lifecycle);
      const next = { ...old, ...patch, id, kind, revision: Number(old.revision || 0) + 1, supersedes: id, payload: { ...(old.payload || {}), ...(patch.payload || {}) } };
      store[kind].push(next);
      return next;
    },
    invalid: (id, reason) => sandbox.CT_GAS_STATE.update('wakes', id, { lifecycle: 'invalid', payload: { invalid_reason: reason } }),
    event: (kind, payload) => { const row = { id: `evt_${store.observer_ledger.length + 1}`, kind, payload }; store.observer_ledger.push(row); return row; },
    schedule: (w) => { const row = { id: `w_${store.wakes.length + 1}`, kind: 'wake', lifecycle: 'pending', payload: w }; store.wakes.push(row); return row; },
    claim: (id) => (store.wakes || []).filter((r) => r.id === id).pop() || null,
    complete: (id) => (store.wakes || []).filter((r) => r.id === id).pop() || null,
    latestContinuation: () => null,
  };
  await run('gas/gas_feedback.js');
  await run('gas/gas_trigger.js');
  sandbox.requestNextWake = (w) => { wakeCalls.push(w); return sandbox.CT_GAS_TRIGGER.schedule(w, CT_GAS.clock(Date.now(), CT_GAS.BUDGET_MS)); };
  return { ctx: sandbox, sheet, store, wakeCalls, props };
}

function payloadOf(store, kind) {
  const row = store.observer_ledger.filter((e) => e.kind === kind).pop();
  return row ? row.payload : null;
}

function assertNoMessageContent(payload, where) {
  for (const key of FORBIDDEN_CONTENT_KEYS) {
    assert.equal(key in payload, false, `${where} must not emit ${key}`);
  }
  const text = JSON.stringify(payload);
  assert.doesNotMatch(text, /Verify the CT-Runtime wake pipeline/, `${where} must not emit message content`);
}

test('feedback poll emits additive boundary-safe diagnostics from real code', async () => {
  const { ctx, store } = await loadSafetyWake({
    grid: liveMirrorGrid(),
    props: { CT_GAS_FEEDBACK_SPREADSHEET_ID: 'feedback-sheet-id', CT_GAS_PROOF_MODEL: 'test/model:free' },
  });
  ctx.gasSafetyWake();
  const started = payloadOf(store, 'feedback_poll_started');
  const result = payloadOf(store, 'feedback_poll_result');
  assert.ok(started, 'started event exists');
  assert.ok(result, 'result event exists');
  assert.equal(started.operation, 'feedback-poll');
  assert.equal(started.source, 'feedback-sheet');
  assert.equal(started.trigger, 'gasSafetyWake');
  assert.equal(started.script_id, 'test-script-id');
  assert.equal(started.feedback_spreadsheet_configured, true);
  assert.equal(started.feedback_sheet_name, 'Feedback');
  assert.equal(started.trigger_handlers, 1);
  assert.equal(started.general_compute_requested, false);
  assertNoMessageContent(started, 'started');

  assert.equal(result.operation, 'feedback-poll');
  assert.equal(result.source, 'feedback-sheet');
  assert.equal(result.trigger, 'gasSafetyWake');
  assert.equal(result.header_ok, true);
  assert.equal(result.header_row, 4);
  assert.equal(result.admitted_count, 1);
  assert.deepStrictEqual([...result.admitted_rows], [5]);
  assert.equal(result.admitted_work_order_ids.length, 1);
  assert.equal(result.failed_count, 0);
  assert.equal(result.synced_count, 1);
  assert.equal(result.general_compute_requested, false);
  assert.equal(result.admitted_count, result.admitted_rows.length);
  assert.equal(result.admitted_count, result.admitted_work_order_ids.length);
  const [workOrderId] = result.admitted_work_order_ids;
  assert.ok(store.work_orders.some((o) => o.id === workOrderId), 'admitted id resolves to a durable work order');
  assertNoMessageContent(result, 'result');
});

test('fail-closed sheet still emits additive diagnostics with no admissions', async () => {
  const { ctx, store } = await loadSafetyWake({
    grid: [
      ['Notes', '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', ''],
      ['Something', 'Else', 'Entirely', 'Different', 'Here', 'Today', 'Nope', 'Nada'],
      ['CT-Runtime', 'Objective that must not be admitted blind', '', '', '', '', '', ''],
    ],
    props: { CT_GAS_FEEDBACK_SPREADSHEET_ID: 'feedback-sheet-id', CT_GAS_PROOF_MODEL: 'test/model:free' },
  });
  ctx.gasSafetyWake();
  const result = payloadOf(store, 'feedback_poll_result');
  assert.ok(result, 'result event exists for fail-closed sheet');
  assert.equal(result.header_ok, false);
  assert.deepStrictEqual([...result.admitted_rows], []);
  assert.deepStrictEqual([...result.admitted_work_order_ids], []);
  assert.equal(result.admitted_count, 0);
  assert.equal(store.work_orders.length, 0);
  assertNoMessageContent(result, 'fail-closed result');
});

test('feedback poll error diagnostics stay bounded and omit message content', async () => {
  const { ctx, store } = await loadSafetyWake({
    grid: liveMirrorGrid(),
    props: { CT_GAS_PROOF_MODEL: 'test/model:free' },
  });
  ctx.gasSafetyWake();
  const error = payloadOf(store, 'feedback_poll_error');
  assert.ok(error, 'error event exists when spreadsheet property is missing');
  assert.equal(error.operation, 'feedback-poll');
  assert.equal(error.source, 'feedback-sheet');
  assert.equal(error.trigger, 'gasSafetyWake');
  assert.ok(error.error.length <= 400);
  assertNoMessageContent(error, 'error');
  assert.equal(error.general_compute_requested, false);
});
