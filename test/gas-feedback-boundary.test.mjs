import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const CANONICAL_HEADER = ['Project (optional)', 'Message / objective', 'Status', 'Celestan update / question', 'Your reply', 'Last activity', 'Thread ID', 'Reply revision'];
const MALFORMED_WORK_ORDER_ID = 'feedback-work-order_fa0cdf76b1a3dce3e4a0dca04a626ee0';
const MALFORMED_WAKE_ID = 'wake_b5fb51881cb9ffdd6ef00eadd940266e';

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

async function loadFeedback({ grid, props = {}, withTrigger = false, seed = null }) {
  const sheet = makeSheet(grid);
  const store = { work_orders: [], wakes: [], observer_ledger: [] };
  if (seed) for (const [kind, rows] of Object.entries(seed)) store[kind].push(...rows);
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
    ScriptApp: { getScriptId: () => 'test-script-id' },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) },
    requestNextWake: () => { throw new Error('requestNextWake must be stubbed by the test'); },
  };
  vm.createContext(sandbox);
  const run = async (path) => vm.runInContext(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'), sandbox, { filename: path });
  await run('gas/gas_core.js');
  const CT_GAS = sandbox.CT_GAS;
  const wakeCalls = [];
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
    latestContinuation: () => null,
  };
  await run('gas/gas_feedback.js');
  if (withTrigger) {
    await run('gas/gas_trigger.js');
    sandbox.requestNextWake = (w) => { wakeCalls.push(w); return { id: 'captured-wake' }; };
  } else {
    sandbox.requestNextWake = (w) => { wakeCalls.push(w); return { id: 'captured-wake' }; };
  }
  return { ctx: sandbox, CT_GAS, sheet, store, wakeCalls, clock: { canStart: () => true } };
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

test('header row 4 is never admitted; row 5 objective is admitted at row 5', async () => {
  const { ctx, sheet, store, wakeCalls, clock } = await loadFeedback({
    grid: liveMirrorGrid(),
    props: { CT_GAS_FEEDBACK_SPREADSHEET_ID: 'feedback-sheet-id', CT_GAS_PROOF_MODEL: 'test/model:free' },
  });
  const result = ctx.CT_GAS_FEEDBACK.reconcile(clock);
  assert.equal(result.sheet.header_ok, true);
  assert.equal(result.admitted.length, 1);
  assert.deepStrictEqual([...result.admitted.map((a) => a.row)], [5]);
  assert.equal(result.admitted[0].status, 'accepted');
  assert.equal(store.work_orders.length, 1);
  assert.match(store.work_orders[0].payload.goal, /Verify the CT-Runtime wake pipeline/);
  assert.equal(wakeCalls.length, 1);
  assert.equal(wakeCalls[0].work_order_id, store.work_orders[0].id);
  // Acknowledgement and thread identity land on row 5 only; row 4 is byte-identical.
  assert.equal(sheet.grid[4][2], 'Accepted');
  assert.match(sheet.grid[4][6], /^thread_/);
  assert.deepEqual(sheet.grid[3], CANONICAL_HEADER);
  assert.ok(sheet.writes.every((w) => w.row !== 4), 'no write may target the header row');
});

test('duplicate poll admits nothing more and creates no second work order', async () => {
  const { ctx, store, clock } = await loadFeedback({
    grid: liveMirrorGrid(),
    props: { CT_GAS_FEEDBACK_SPREADSHEET_ID: 'feedback-sheet-id', CT_GAS_PROOF_MODEL: 'test/model:free' },
  });
  ctx.CT_GAS_FEEDBACK.reconcile(clock);
  const second = ctx.CT_GAS_FEEDBACK.reconcile(clock);
  assert.deepStrictEqual([...second.admitted], []);
  assert.equal(store.work_orders.length, 1);
});

test('a reply revision on the accepted row admits anew at the same row', async () => {
  const grid = liveMirrorGrid();
  const { ctx, store, clock } = await loadFeedback({
    grid,
    props: { CT_GAS_FEEDBACK_SPREADSHEET_ID: 'feedback-sheet-id', CT_GAS_PROOF_MODEL: 'test/model:free' },
  });
  ctx.CT_GAS_FEEDBACK.reconcile(clock);
  assert.equal(store.work_orders.length, 1);
  // Human bumps "Reply revision" to 2 on row 5.
  grid[4][7] = '2';
  const result = ctx.CT_GAS_FEEDBACK.reconcile(clock);
  assert.deepStrictEqual([...result.admitted.map((a) => a.row)], [5]);
  assert.equal(store.work_orders.length, 2);
  assert.equal(store.work_orders[1].payload.feedback_revision, 2);
  assert.equal(store.work_orders[1].payload.feedback_thread_id, store.work_orders[0].payload.feedback_thread_id);
});

test('reply rows carrying the admitted Thread ID join the same logical thread', async () => {
  const grid = liveMirrorGrid();
  const t = await loadFeedback({
    grid,
    props: { CT_GAS_FEEDBACK_SPREADSHEET_ID: 'feedback-sheet-id', CT_GAS_PROOF_MODEL: 'test/model:free' },
  });
  t.ctx.CT_GAS_FEEDBACK.reconcile(t.clock);
  const thread = t.sheet.grid[4][6];
  assert.match(thread, /^thread_/);
  grid.push(['CT-Runtime', 'Follow-up detail for the same objective', '', '', '', '', thread, '']);
  const result = t.ctx.CT_GAS_FEEDBACK.reconcile(t.clock);
  assert.deepStrictEqual([...result.admitted.map((a) => a.row)], [6]);
  assert.equal(t.store.work_orders.length, 2);
  const reply = t.store.work_orders[1];
  assert.equal(reply.payload.feedback_thread_id, thread);
  assert.match(reply.payload.goal, /Feedback thread:/);
});

test('a header-label row below the boundary is skipped by the header guard', async () => {
  const grid = liveMirrorGrid();
  grid.push([...CANONICAL_HEADER]);
  grid.push(['CT-Runtime', 'Second objective below a duplicated header', '', '', '', '', '', '']);
  const { ctx, clock } = await loadFeedback({
    grid,
    props: { CT_GAS_FEEDBACK_SPREADSHEET_ID: 'feedback-sheet-id', CT_GAS_PROOF_MODEL: 'test/model:free' },
  });
  const result = ctx.CT_GAS_FEEDBACK.reconcile(clock);
  assert.deepStrictEqual([...result.admitted.map((a) => a.row)], [5, 7]);
});

test('a sheet without the canonical header fails closed with no writes', async () => {
  const { ctx, sheet, store, clock } = await loadFeedback({
    grid: [
      ['Notes', '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', ''],
      ['', '', '', '', '', '', '', ''],
      ['Something', 'Else', 'Entirely', 'Different', 'Here', 'Today', 'Nope', 'Nada'],
      ['CT-Runtime', 'Objective that must not be admitted blind', '', '', '', '', '', ''],
    ],
    props: { CT_GAS_FEEDBACK_SPREADSHEET_ID: 'feedback-sheet-id', CT_GAS_PROOF_MODEL: 'test/model:free' },
  });
  const result = ctx.CT_GAS_FEEDBACK.reconcile(clock);
  assert.equal(result.sheet.header_ok, false);
  assert.deepStrictEqual([...result.admitted], []);
  assert.deepStrictEqual([...result.synced], []);
  assert.deepStrictEqual([...sheet.writes], []);
  assert.equal(store.work_orders.length, 0);
});

test('canonical JSON keeps ordinal key ordering', async () => {
  const { CT_GAS } = await loadFeedback({ grid: liveMirrorGrid(), props: {} });
  assert.equal(CT_GAS.json({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('requested work orders may transition to invalid for retirement', async () => {
  const { CT_GAS } = await loadFeedback({ grid: liveMirrorGrid(), props: {} });
  assert.equal(CT_GAS.transition('requested', 'invalid'), 'invalid');
});

test('fenced repair restores the header and retires exactly the malformed admission', async () => {
  const grid = liveMirrorGrid();
  grid[3][7] = 'Accepted';
  grid[3].push(MALFORMED_WORK_ORDER_ID, '2026-09-08T01:12:15.886Z', '2026-09-08T01:12:15.886Z', '', '');
  const { ctx, sheet, store, clock } = await loadFeedback({
    grid,
    props: { CT_GAS_FEEDBACK_SPREADSHEET_ID: 'feedback-sheet-id', CT_GAS_PROOF_MODEL: 'test/model:free' },
    withTrigger: true,
    seed: {
      work_orders: [{
        id: MALFORMED_WORK_ORDER_ID, kind: 'work_order', lifecycle: 'requested', revision: 1,
        payload: { goal: 'Last activity', project: 'Your reply', feedback_thread_id: 'Message / objective', feedback_message_id: 'Status', feedback_revision: 1 },
      }],
      wakes: [{
        id: MALFORMED_WAKE_ID, kind: 'wake', lifecycle: 'pending', revision: 1,
        payload: { work_order_id: MALFORMED_WORK_ORDER_ID, execution_id: 'x', continuation_id: 'y' },
      }],
    },
  });
  void clock;
  const result = ctx.CT_GAS_FEEDBACK.repairRow4Admission();
  assert.equal(result.status, 'repaired');
  assert.equal(result.work_order_id, MALFORMED_WORK_ORDER_ID);
  assert.equal(result.wake_id, MALFORMED_WAKE_ID);
  assert.equal(result.wake, 'retire');
  assert.deepEqual(sheet.grid[3].slice(0, 8), CANONICAL_HEADER);
  assert.deepEqual(sheet.grid[3].slice(8, 13), ['', '', '', '', '']);
  const order = store.work_orders[store.work_orders.length - 1];
  assert.equal(order.lifecycle, 'invalid');
  assert.equal(order.payload.retire_reason, 'feedback-header-row-misadmission');
  const wake = store.wakes[store.wakes.length - 1];
  assert.equal(wake.lifecycle, 'invalid');
  const audit = store.observer_ledger.filter((e) => e.kind === 'feedback_admission_repaired');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].payload.work_order_id, MALFORMED_WORK_ORDER_ID);
});

test('fenced repair refuses when the header no longer carries the malformed markers', async () => {
  const { ctx, store, sheet } = await loadFeedback({
    grid: liveMirrorGrid(),
    props: { CT_GAS_FEEDBACK_SPREADSHEET_ID: 'feedback-sheet-id', CT_GAS_PROOF_MODEL: 'test/model:free' },
    withTrigger: true,
    seed: {
      work_orders: [{
        id: MALFORMED_WORK_ORDER_ID, kind: 'work_order', lifecycle: 'requested', revision: 1,
        payload: { goal: 'Last activity', project: 'Your reply', feedback_thread_id: 'Message / objective', feedback_message_id: 'Status', feedback_revision: 1 },
      }],
      wakes: [{
        id: MALFORMED_WAKE_ID, kind: 'wake', lifecycle: 'pending', revision: 1,
        payload: { work_order_id: MALFORMED_WORK_ORDER_ID, execution_id: 'x', continuation_id: 'y' },
      }],
    },
  });
  assert.throws(() => ctx.CT_GAS_FEEDBACK.repairRow4Admission(), /does not carry the expected malformed admission markers/);
  assert.equal(store.work_orders.length, 1);
  assert.equal(store.work_orders[0].lifecycle, 'requested');
  assert.equal(store.wakes[0].lifecycle, 'pending');
  assert.deepStrictEqual([...sheet.writes], []);
});

test('historical header-label admission would have been caught: polluted row 4 admits nothing', async () => {
  const grid = liveMirrorGrid();
  grid[3][7] = 'Accepted';
  grid[3].push(MALFORMED_WORK_ORDER_ID, '2026-09-08T01:12:15.886Z', '2026-09-08T01:12:15.886Z', '', '');
  const { ctx, sheet, store, clock } = await loadFeedback({
    grid,
    props: { CT_GAS_FEEDBACK_SPREADSHEET_ID: 'feedback-sheet-id', CT_GAS_PROOF_MODEL: 'test/model:free' },
  });
  const result = ctx.CT_GAS_FEEDBACK.reconcile(clock);
  assert.equal(result.sheet.header_ok, false);
  assert.deepStrictEqual([...result.admitted], []);
  assert.deepStrictEqual([...result.synced], []);
  assert.deepStrictEqual([...sheet.writes], []);
  assert.equal(store.work_orders.length, 0);
  assert.ok(!store.work_orders.some((o) => o.payload.goal === 'Last activity'), 'header labels must not become a durable goal');
});

test('an 8-column human row cannot be read as a positional durable 13-field row', async () => {
  const source = await readFile(new URL('../gas/gas_feedback.js', import.meta.url), 'utf8');
  assert.match(source, /SHEET_HEADERS/);
  assert.match(source, /HEADER_ROW = 4/);
  assert.match(source, /DATA_FIRST_ROW = 5/);
  assert.match(source, /COL = \{ project:1, message:2, status:3, response:4, reply:5, activity:6, thread:7, revision:8 \}/);
  assert.match(source, /r\[COL\.project-1\]/);
  assert.doesNotMatch(source, /r\[0\],100\)\,message:text\(r\[1\]/);
  const { ctx, clock } = await loadFeedback({
    grid: liveMirrorGrid(),
    props: { CT_GAS_FEEDBACK_SPREADSHEET_ID: 'feedback-sheet-id', CT_GAS_PROOF_MODEL: 'test/model:free' },
  });
  const result = ctx.CT_GAS_FEEDBACK.reconcile(clock);
  const order = result.admitted.length ? ctx.CT_GAS_STATE.list('work_orders')[0] : null;
  assert.ok(order, 'row 5 admits one durable order');
  const payloadKeys = Object.keys(order.payload).sort();
  assert.deepStrictEqual(payloadKeys, ['feedback_fingerprint', 'feedback_message_id', 'feedback_revision', 'feedback_thread_id', 'goal', 'launch_context', 'model', 'physical_execution_count', 'project', 'reply_to', 'resume_context', 'step', 'work_order_id']);
  assert.equal(payloadKeys.length, 13);
  assert.equal(order.payload.step, 'feedback');
  assert.equal(order.payload.launch_context.source, 'feedback-sheet');
  assert.ok(!('message' in order.payload) || typeof order.payload.goal === 'string', 'durable goal derives semantically, never by positional column copy');
});
