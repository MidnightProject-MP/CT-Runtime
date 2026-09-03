import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const files = ['gas_core.js', 'gas_state.js', 'gas_trigger.js', 'gas_federation.js', 'gas_evidence.js', 'gas_observer.js', 'gas_agent_executor.js', 'gas_v8.js'];
async function source() { return (await Promise.all(files.map(f => readFile(new URL(`../gas/${f}`, import.meta.url), 'utf8')))).join('\n'); }
function harness({ now = 100000, budget = 30000, fetch = () => { throw new Error('network'); } } = {}) {
  const props = new Map([['CT_GAS_SPREADSHEET_ID', 'sheet'], ['CT_GAS_DRIVE_ROOT_ID', 'root'], ['OPENROUTER_API_KEY', 'secret'], ['CT_GAS_PROOF_MODEL', 'openrouter/test:free'], ['CT_GAS_BUDGET_MS', String(budget)]]);
  const rows = new Map(), triggers = [], files = new Map(); let clock = now, fileCounter = 0;
  const sheet = name => ({ getLastRow: () => (rows.get(name) || []).length, appendRow: row => rows.get(name).push(row), getDataRange: () => ({ getValues: () => rows.get(name) || [] }) });
  class FakeDate extends Date { static now() { return clock; } }
  const context = { Date: FakeDate, console, Math, JSON, isNaN, isFinite, setTimeout };
  context.Utilities = { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: (_, value) => [...createHash('sha256').update(String(value)).digest()], newBlob: (x) => ({ x }), getUuid: () => 'uuid', sleep: () => {} };
  context.PropertiesService = { getScriptProperties: () => ({ getProperty: k => props.get(k) || null, setProperty: (k, v) => props.set(k, String(v)) }) };
  context.LockService = { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) };
  context.SpreadsheetApp = { openById: () => ({ getSheetByName: name => rows.has(name) ? sheet(name) : null, insertSheet: name => { rows.set(name, [['id','kind','lifecycle','execution_id','parent_id','worker_id','idempotency_key','payload_json','created_at','updated_at','schema_version','revision','supersedes','owner','fence','lease_until']]); return sheet(name); } }) };
  context.ScriptApp = { getProjectTriggers: () => triggers, newTrigger: handler => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => { triggers.push({ getHandlerFunction: () => handler, getTriggerSource: () => 'time', getUniqueId: () => `t${triggers.length}` }); } }) }) }) };
  const evidenceFolder = () => ({ getFoldersByName: () => ({ hasNext: () => false }), createFile: blob => { const id = `file-${++fileCounter}`; files.set(id, String(blob.x || '')); return { getId: () => id, setDescription: () => {} }; } });
  context.DriveApp = { getFolderById: () => ({ getFoldersByName: () => ({ hasNext: () => false }), createFolder: evidenceFolder }), getFileById: id => ({ getId: () => id, getBlob: () => ({ getDataAsString: () => files.get(id) || '' }) }) };
  context.UrlFetchApp = { fetch: (url, options) => String(url).includes('/models') ? ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ data: [{ id: 'openrouter/test:free', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } }, { id: 'test/provider:free', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } }] }) }) : fetch(url, options) };
  vm.createContext(context); return { context, rows, props, setNow: n => { clock = n; } };
}
async function boot(options) { const h = harness(options); vm.runInContext(await source(), h.context); return h; }
function wake(id = 'wake-1', continuation = 'cont-1', execution = 'exec-1', time = new Date(0).toISOString(), workOrder = 'order-1') { return { time, reason: 'checkpoint', work_order_id: workOrder, execution_id: execution, continuation_id: continuation, launch: { model: 'openrouter/test:free' }, resume: { step: 'A' }, wake_id: id, id }; }

test('low budget does not start model, Drive, or Observer and attempts emergency checkpoint', async () => {
  let called = 0; const h = await boot({ budget: 30000, fetch: () => { called++; throw new Error('must not fetch'); } });
  h.context.CT_GAS_STATE.create('work_orders', { id: 'order-1', lifecycle: 'requested', payload: { goal: 'g', step: 'A', physical_execution_count: 1 } });
  const result = h.context.runWake(wake());
  assert.notEqual(result.status, 'complete', JSON.stringify(result)); assert.equal(called, 0); assert.ok(h.rows.get('continuations')?.length > 1, JSON.stringify(result));
});

test('separate VM contexts reconstruct A then B from durable state', async () => {
  const h = await boot({ budget: 300000, fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }) });
  h.context.CT_GAS_STATE.create('work_orders', { id: 'order-1', lifecycle: 'requested', payload: { goal: 'g', step: 'A', physical_execution_count: 1 } });
  const first = h.context.runWake(wake()); assert.ok(['checkpointed', 'complete'].includes(first.status), JSON.stringify(first));
  const h2 = await boot({ budget: 300000, fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }) });
  for (const [k, v] of h.rows) h2.rows.set(k, v.map(x => [...x]));
  assert.equal(h2.context.CT_GAS_STATE.latestContinuation('order-1').work_order_id, 'order-1');
});

test('due wake routes its persisted identity and deferred retry retains it', async () => {
  const h = await boot({ budget: 30000 }); h.context.CT_GAS_STATE.create('work_orders', { id: 'order-1', lifecycle: 'requested', payload: { goal: 'g', step: 'A', physical_execution_count: 1 } });
  h.context.CT_GAS_STATE.schedule(wake()); const result = h.context.gasSafetyWake();
  assert.equal(result[0].work_order_id, 'order-1', JSON.stringify(result)); assert.match(result[0].execution_id, /^physical-execution_/);
});

test('one logical work order records three physical GAS executions and duplicate completion is harmless', async () => {
  const h = await boot({ budget: 300000, fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }) });
  h.context.CT_GAS_STATE.create('work_orders', { id: 'order-1', lifecycle: 'requested', payload: { goal: 'g', step: 'A', model: 'openrouter/test:free' } });
  const first = h.context.runWake(wake('wake-a', 'cont-a', 'seed-exec')); assert.equal(first.status, 'checkpointed', JSON.stringify(first) + ' ' + JSON.stringify(h.rows.get('observer_ledger')));
  const c1 = h.context.CT_GAS_STATE.latestContinuation('order-1');
  const second = h.context.runWake(wake('wake-b', c1.continuation_id, c1.execution_id, new Date(0).toISOString())); assert.equal(second.status, 'complete', JSON.stringify(second));
  const c2 = h.context.CT_GAS_STATE.latestContinuation('order-1');
  const third = h.context.runWake(wake('wake-c', c2.continuation_id, c2.execution_id, new Date(0).toISOString())); assert.equal(third.status, 'duplicate', JSON.stringify(third));
  const executions = (h.rows.get('executions') || []).slice(1).map(row => row[0]);
  assert.equal(new Set(executions).size, 3); assert.equal(h.context.CT_GAS_STATE.physicalExecutionCount('order-1'), 3);
  assert.ok((h.rows.get('model_telemetry') || []).slice(1).some(row => JSON.parse(row[7]).physical_execution_id));
});

test('telemetry appends repeated events and trigger ensure is idempotent', async () => {
  const h = await boot(); h.context.CT_GAS_STATE.telemetry({ execution_id: 'e', work_order_id: 'w', wake_id: 'z', continuation_id: 'c' }); h.context.CT_GAS_STATE.telemetry({ execution_id: 'e', work_order_id: 'w', wake_id: 'z', continuation_id: 'c' });
  assert.equal(h.rows.get('model_telemetry').length, 3); h.context.CT_GAS_TRIGGER.ensure(); h.context.CT_GAS_TRIGGER.ensure(); assert.equal(h.context.CT_GAS_TRIGGER.registry().length, 1);
});

test('duration preemption never requests general_compute', async () => {
  const h = await boot({ budget: 30000 }); h.context.CT_GAS_STATE.create('work_orders', { id: 'order-1', lifecycle: 'requested', payload: { goal: 'g', step: 'A', physical_execution_count: 1 } });
  h.context.runWake(wake()); const telemetry = (h.rows.get('model_telemetry') || []).slice(1); assert.ok(telemetry.every(r => !JSON.parse(r[7]).general_compute_requested));
});

test('continuations retain typed launch and resume context and exact model', async () => {
  const h = await boot({ budget: 30000 });
  h.context.CT_GAS_STATE.create('work_orders', { id: 'order-1', lifecycle: 'requested', payload: { goal: 'g', step: 'A', model: 'openrouter/selected:free', physical_execution_count: 1, launch_context: { model: 'openrouter/selected:free', agent: 'executor' }, resume_context: { step: 'A' } } });
  const result = h.context.runWake(wake('wake-typed', 'cont-typed'));
  assert.ok(['checkpointed', 'interrupted'].includes(result.status));
  const continuation = h.context.CT_GAS_STATE.latestContinuation('order-1');
  assert.equal(typeof continuation.launch_context, 'object');
  assert.equal(continuation.launch_context.model, 'openrouter/selected:free');
  assert.equal(continuation.resume_context.step, 'A');
});

test('fenced wake completion is an atomic compare-and-set', async () => {
  const h = await boot();
  h.context.CT_GAS_STATE.create('wakes', { id: 'wake-cas', lifecycle: 'pending', payload: wake('wake-cas', 'cont-cas') });
  h.context.CT_GAS_STATE.claim('wake-cas', 'owner-a', 'fence-a', new Date(200000).toISOString());
  assert.throws(() => h.context.CT_GAS_STATE.complete('wake-cas', { status: 'stale' }, 'owner-b', 'fence-b'), /fence mismatch/);
  assert.equal(h.context.CT_GAS_STATE.get('wakes', 'wake-cas').lifecycle, 'claimed');
  h.context.CT_GAS_STATE.complete('wake-cas', { status: 'ok' }, 'owner-a', 'fence-a');
  assert.equal(h.context.CT_GAS_STATE.get('wakes', 'wake-cas').lifecycle, 'completed');
});

test('expired wake claim can be taken over and stable continuation scheduling is idempotent', async () => {
  const h = await boot();
  h.context.CT_GAS_STATE.create('wakes', { id: 'wake-expired', lifecycle: 'pending', payload: wake('wake-expired', 'cont-expired') });
  h.context.CT_GAS_STATE.claim('wake-expired', 'owner-a', 'fence-a', new Date(1).toISOString());
  h.context.CT_GAS_STATE.claim('wake-expired', 'owner-b', 'fence-b', new Date(200000).toISOString());
  assert.equal(h.context.CT_GAS_STATE.get('wakes', 'wake-expired').owner, 'owner-b');
  const a = h.context.CT_GAS_STATE.schedule(wake('stable-a', 'same-cont', 'same-exec'));
  const b = h.context.CT_GAS_STATE.schedule(wake('stable-b', 'same-cont', 'same-exec'));
  assert.equal(a.id, b.id);
});

test('rate-limit deferral resumes the same logical work order with durable attempt state', async () => {
  let modelCalls = 0;
  const h = await boot({ budget: 300000, fetch: url => { if (String(url).includes('/chat/completions') && modelCalls++ === 0) return { getResponseCode: () => 429, getContentText: () => '{}' }; return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }; } });
  h.context.CT_GAS_STATE.create('work_orders', { id: 'order-rate', lifecycle: 'requested', payload: { goal: 'g', step: 'A', model: 'openrouter/test:free' } });
  const first = h.context.runWake(wake('wake-rate-a', 'cont-rate-a', 'seed-rate', new Date(0).toISOString(), 'order-rate')); assert.equal(first.status, 'checkpointed', JSON.stringify(first) + ' ' + JSON.stringify(h.rows.get('observer_ledger')));
  const c1 = h.context.CT_GAS_STATE.latestContinuation('order-rate'); assert.ok(c1, JSON.stringify(h.rows.get('continuations'))); assert.equal(c1.attempt, 1); assert.equal(c1.work_order_id, 'order-rate');
  const second = h.context.runWake(wake('wake-rate-b', c1.continuation_id, c1.execution_id, new Date(0).toISOString(), 'order-rate')); assert.equal(second.status, 'checkpointed');
  assert.equal(h.context.CT_GAS_STATE.physicalExecutionCount('order-rate'), 2); assert.equal(modelCalls, 2);
});

test('normalized inference telemetry distinguishes quota exhaustion from an ambiguous 429', async () => {
  let body = { error: { message: 'Free model daily quota exhausted', metadata: { reason: 'free_tier_daily_limit', provider_name: 'upstream-a' } } };
  const h = await boot({ budget: 300000, fetch: () => ({ getResponseCode: () => 429, getAllHeaders: () => ({ 'X-RateLimit-Remaining': '0' }), getContentText: () => JSON.stringify(body) }) });
  const request = { execution_id: 'logical-exec', physical_execution_id: 'physical-exec', work_order_id: 'order-telemetry', wake_id: 'wake-telemetry', continuation_id: 'cont-telemetry', model: 'openrouter/test:free', verify_price: true, maxTurns: 1, messages: [{ role: 'user', content: 'bounded' }], clock: h.context.CT_GAS.clock(100000, 300000), role: 'implementation-worker', task_purpose: 'scarcity-proof' };
  const exhausted = h.context.executeAgent(request);
  assert.equal(exhausted.status, 'blocked'); assert.equal(exhausted.failure_category, 'quota_exhausted');
  let telemetry = JSON.parse(h.rows.get('model_telemetry').at(-1)[7]);
  assert.equal(telemetry.work_order_id, 'order-telemetry'); assert.equal(telemetry.physical_execution_id, 'physical-exec');
  assert.equal(telemetry.requested_provider, 'openrouter'); assert.equal(telemetry.canonical_provider, 'openrouter'); assert.equal(telemetry.actual_provider, 'upstream-a');
  assert.equal(telemetry.failure_category, 'quota_exhausted'); assert.equal(telemetry.impossible_until_state_change, true); assert.equal(telemetry.retryable, false); assert.equal(telemetry.quota_remaining, '0');
  assert.equal('response' in telemetry, false); assert.equal(JSON.stringify(telemetry).includes('secret'), false);
  body = { error: { message: 'Too many requests' } };
  const limited = h.context.executeAgent({ ...request, physical_execution_id: 'physical-exec-2' });
  assert.equal(limited.status, 'deferred'); assert.equal(limited.failure_category, 'rate_limited');
});

test('free quota exhaustion transitions to an eligible model across physical executions with logical continuity', async () => {
  let calls = 0;
  const firstVm = await boot({ budget: 300000, fetch: () => calls++ === 0
    ? ({ getResponseCode: () => 429, getAllHeaders: () => ({ 'x-ratelimit-remaining': '0' }), getContentText: () => JSON.stringify({ error: { message: 'Free tier quota exhausted', metadata: { reason: 'daily_quota' } } }) })
    : ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ model: 'test/provider:free', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9, cost: 0 } }) }) });
  const launch = { model: 'openrouter/test:free', role: 'implementation-worker', task_purpose: 'continuity-under-scarcity', allow_free_fallback: true, eligible_models: ['test/provider:free'] };
  firstVm.context.CT_GAS_STATE.create('work_orders', { id: 'order-scarcity', lifecycle: 'requested', payload: { goal: 'g', step: 'A', model: launch.model, launch_context: launch, resume_context: { proof: 'scarcity' } } });
  const first = firstVm.context.runWake({ ...wake('wake-scarcity-a', 'cont-scarcity-a', 'seed-scarcity', new Date(0).toISOString(), 'order-scarcity'), launch });
  assert.equal(first.status, 'checkpointed', JSON.stringify(first)); assert.equal(first.reason, 'model-fallback');
  const continuation = firstVm.context.CT_GAS_STATE.latestContinuation('order-scarcity');
  assert.equal(continuation.work_order_id, 'order-scarcity'); assert.equal(continuation.launch_context.model, 'test/provider:free'); assert.match(continuation.decisions[0], /free-model-fallback/);

  const secondVm = await boot({ budget: 300000, fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ model: 'test/provider:free', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9, cost: 0 } }) }) });
  for (const [k, v] of firstVm.rows) secondVm.rows.set(k, v.map(row => [...row]));
  const second = secondVm.context.runWake(wake('wake-scarcity-b', continuation.continuation_id, continuation.execution_id, new Date(0).toISOString(), 'order-scarcity'));
  assert.equal(second.status, 'checkpointed', JSON.stringify(second)); assert.equal(second.step, 'A');
  assert.equal(secondVm.context.CT_GAS_STATE.latestContinuation('order-scarcity').work_order_id, 'order-scarcity');
  assert.equal(secondVm.context.CT_GAS_STATE.physicalExecutionCount('order-scarcity'), 2);
  const attempts = (secondVm.rows.get('model_telemetry') || []).slice(1).map(row => JSON.parse(row[7])).filter(row => row.operation === 'inference');
  assert.equal(attempts.length, 2); assert.equal(attempts[0].failure_category, 'quota_exhausted'); assert.equal(attempts[1].requested_provider, 'openrouter'); assert.equal(attempts[1].actual_model, 'test/provider:free'); assert.equal(attempts[1].fallback_path, 'openrouter/test:free->test/provider:free'); assert.equal(attempts[1].cost, 0);
});

test('quota exhaustion without fallback policy suspends without a futile automatic wake', async () => {
  const exhausted = () => ({ getResponseCode: () => 429, getContentText: () => JSON.stringify({ error: { message: 'Free quota exhausted', metadata: { reason: 'daily_quota' } } }) });
  const h = await boot({ budget: 300000, fetch: exhausted });
  h.context.CT_GAS_STATE.create('work_orders', { id: 'order-suspend', lifecycle: 'requested', payload: { goal: 'g', step: 'A', model: 'openrouter/test:free', launch_context: { model: 'openrouter/test:free' }, resume_context: {} } });
  const result = h.context.runWake(wake('wake-suspend', 'cont-suspend', 'seed-suspend', new Date(0).toISOString(), 'order-suspend'));
  assert.equal(result.status, 'checkpointed'); assert.equal(result.reason, 'model-suspended');
  assert.equal(h.context.CT_GAS_STATE.get('work_orders', 'order-suspend').lifecycle, 'waiting');
  const continuation = h.context.CT_GAS_STATE.latestContinuation('order-suspend'); assert.equal(continuation.wait_condition, 'model-quota');
  const pending = (h.rows.get('wakes') || []).slice(1).map(row => JSON.parse(row[7])).filter(row => row.continuation_id === continuation.continuation_id);
  assert.equal(pending.length, 0);
});

test('malformed due wake is invalidated and cannot starve a valid wake', async () => {
  const h = await boot();
  h.context.CT_GAS_STATE.create('wakes', { id: 'wake-invalid', lifecycle: 'pending', payload: { time: new Date(0).toISOString() } });
  h.context.CT_GAS_STATE.create('wakes', { id: 'wake-valid', lifecycle: 'pending', payload: wake('wake-valid', 'cont-valid') });
  const result = h.context.gasSafetyWake(); assert.equal(h.context.CT_GAS_STATE.get('wakes', 'wake-invalid').lifecycle, 'invalid'); assert.ok(result.length >= 1);
});

test('safety recovery retires wakes for completed work without creating an execution', async () => {
  const h = await boot();
  h.context.CT_GAS_STATE.create('work_orders', { id: 'order-completed', lifecycle: 'completed', payload: { goal: 'done' } });
  h.context.CT_GAS_STATE.create('wakes', { id: 'wake-completed', lifecycle: 'pending', payload: wake('wake-completed', 'cont-completed', 'exec-completed', new Date(0).toISOString(), 'order-completed') });
  const result = h.context.gasSafetyWake();
  assert.equal(result[0].reason, 'work-order-completed', JSON.stringify(result));
  assert.equal(h.context.CT_GAS_STATE.get('wakes', 'wake-completed').lifecycle, 'invalid');
  assert.equal((h.rows.get('executions') || []).length, 0);
});

test('missing-model recovery is retired and moves resumable work to waiting', async () => {
  const h = await boot();
  h.context.CT_GAS_STATE.create('work_orders', { id: 'order-unconfigured', lifecycle: 'deferred', payload: { goal: 'blocked' } });
  h.context.CT_GAS_STATE.create('wakes', { id: 'wake-unconfigured', lifecycle: 'pending', payload: { ...wake('wake-unconfigured', 'cont-unconfigured', 'exec-unconfigured', new Date(0).toISOString(), 'order-unconfigured'), launch: '{}' } });
  const result = h.context.gasSafetyWake();
  assert.equal(result[0].reason, 'selected-model-missing', JSON.stringify(result));
  assert.equal(h.context.CT_GAS_STATE.get('work_orders', 'order-unconfigured').lifecycle, 'waiting');
  assert.equal(h.context.CT_GAS_STATE.get('wakes', 'wake-unconfigured').lifecycle, 'invalid');
  assert.equal(h.context.gasSafetyWake().length, 0);
});

test('safety recovery retires a wake superseded by a newer continuation', async () => {
  const h = await boot();
  h.context.CT_GAS_STATE.create('work_orders', { id: 'order-stale', lifecycle: 'checkpointed', payload: { goal: 'resume', model: 'openrouter/test:free' } });
  h.context.CT_GAS_STATE.continuation({ goal: 'resume', completed: [], decisions: [], evidence: [], provenance: [], outstanding: ['A'], next_operation: 'model', reason: 'newer', resumed_from: 'exec-new', physical_execution_count: 1, work_order_id: 'order-stale', execution_id: 'exec-new', wake_id: 'wake-new', continuation_id: 'cont-new', launch_context: { model: 'openrouter/test:free' }, resume_context: {} });
  h.context.CT_GAS_STATE.create('wakes', { id: 'wake-stale', lifecycle: 'pending', payload: wake('wake-stale', 'cont-old', 'exec-old', new Date(0).toISOString(), 'order-stale') });
  const result = h.context.gasSafetyWake();
  assert.equal(result[0].reason, 'stale-continuation', JSON.stringify(result));
  assert.equal(h.context.CT_GAS_STATE.get('wakes', 'wake-stale').lifecycle, 'invalid');
  assert.equal((h.rows.get('executions') || []).length, 0);
});

test('general compute telemetry requires an exact capability reason', async () => {
  const h = await boot();
  assert.throws(() => h.context.CT_GAS_STATE.telemetry({ general_compute_requested: true }), /exact capability reason/);
  assert.throws(() => h.context.CT_GAS_STATE.telemetry({ general_compute_requested: true, capability_reason: 'duration' }), /exact capability reason/);
  h.context.CT_GAS_STATE.telemetry({ general_compute_requested: true, capability_reason: 'missing-shell-executor' });
});

test('latest continuation ordering is deterministic beyond timestamps', async () => {
  const h = await boot();
  const base = { goal: 'g', completed: [], decisions: [], evidence: [], provenance: [], outstanding: ['A'], next_operation: 'model', reason: 'test', resumed_from: 'exec', physical_execution_count: 1, work_order_id: 'order-order', execution_id: 'exec', wake_id: 'wake', launch_context: { model: 'openrouter/a:free' }, resume_context: {} };
  h.context.CT_GAS_STATE.continuation({ ...base, continuation_id: 'cont-z' });
  h.context.CT_GAS_STATE.continuation({ ...base, continuation_id: 'cont-a' });
  const rows = h.rows.get('continuations'); rows[rows.length - 1][9] = rows[rows.length - 2][9];
  assert.equal(h.context.CT_GAS_STATE.latestContinuation('order-order').continuation_id, 'cont-z');
});

test('Observer refuses a fresh bypass clock and adapters accept an active clock', async () => {
  const h = await boot();
  assert.throws(() => h.context.CT_GAS_OBSERVER.pass({ execution_id: 'e' }), /active clock/);
  const source = await readFile(new URL('../gas/gas_github.js', import.meta.url), 'utf8');
  assert.match(source, /function request\(method,path,body,clock\)/);
  assert.match(source, /own=clock\|\|/);
  const evidence = await readFile(new URL('../gas/gas_evidence.js', import.meta.url), 'utf8');
  assert.match(evidence, /verifyExisting\(fileId,hash,clock\)/);
});
