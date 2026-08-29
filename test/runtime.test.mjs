import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, classifyFailure, invoke, observePending, recover, redact, resolveExecutable, runProcess, runScheduler, validateCelestanResult, validateNextWake, validateTopology } from '../lib/runtime.mjs';

const fixture = path.join(process.cwd(), 'test', 'fixture-runner.mjs');
const base = (store, extra = {}) => store.createManifest({ executionId: extra.executionId || 'run-1', project: 'demo', task: 'test task', model: 'provider/model', agent: 'build', ...extra });
const observerPath = path.resolve('../CT-Foundry/capabilities/observer/observer.mjs');
const wake = { time: '2030-01-01T00:00:00Z', reason: 'self_scheduled', priority: 'low', project: 'demo' };
const execFileAsync = promisify(execFile);

test('atomic manifest creation is idempotent under concurrent duplicate calls', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-')));
  const results = await Promise.all(Array.from({ length: 12 }, () => base(store)));
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal((await store.manifestsAll()).length, 1);
});

test('topology requires existing parents, rejects cycles, and links child atomically', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-')));
  assert.throws(() => validateTopology({ rootId: 'r', parentId: 'r', childIds: [] }, 'r'), /root cannot/);
  await assert.rejects(() => base(store, { executionId: 'child', topology: { rootId: 'root', parentId: 'root', childIds: [] } }), /does not exist/);
  await base(store, { executionId: 'root' });
  await base(store, { executionId: 'child', topology: { rootId: 'root', parentId: 'root', childIds: [] } });
  assert.deepEqual((await store.manifest('root')).topology.childIds, ['child']);
});

test('wake contract and failure classes are bounded', () => {
  assert.deepEqual(validateNextWake(wake), wake);
  assert.throws(() => validateNextWake({ ...wake, extra: true }), /unexpected/);
  assert.deepEqual(classifyFailure({ code: 'ETIMEDOUT' }), { category: 'timeout', retryable: true });
  assert.deepEqual(classifyFailure(new Error('cancelled')), { category: 'cancellation', retryable: false });
});

test('actual timeout retries exactly the configured bounded count and persists attribution', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-'))); await base(store);
  const result = await invoke({ store, executionId: 'run-1', command: process.execPath, commandArgs: [fixture], model: 'm', agent: 'a', task: 't', env: { TIMEOUT: '1' }, timeoutMs: 20, maxRetries: 2 });
  assert.equal(result.status, 'failed'); assert.equal(result.attempts, 3); assert.deepEqual((await store.manifest('run-1')).failure, { category: 'timeout', retryable: true });
});

test('child actually prints inherited secret and output is redacted and truncated', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-'))); await base(store);
  const result = await invoke({ store, executionId: 'run-1', command: process.execPath, commandArgs: [fixture], model: 'm', agent: 'a', task: 't', env: { CT_SECRET: 'top-secret-value', OUTPUT_SIZE: '70000' }, secretNames: ['CT_SECRET'], maxRetries: 0, resultFile: path.join(store.root, 'result.json') });
  assert.equal(result.status, 'success'); assert.equal(result.result.stdout.includes('top-secret-value'), false); assert.equal(result.result.truncated.stdout, true); assert.equal((await store.manifest('run-1')).output.stdoutTruncated, true);
  const raw = await readFile(path.join(store.root, 'raw', (await readdir(path.join(store.root, 'raw'))).find((x) => x.includes('stdout'))), 'utf8'); assert.equal(raw.includes('top-secret-value'), false);
});

test('strict result handoff persists response and schedules only validated request', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-'))); await base(store);
  const result = await invoke({ store, executionId: 'run-1', command: process.execPath, commandArgs: [fixture], model: 'm', agent: 'a', task: 't', env: { NEXT_WAKE: JSON.stringify(wake) }, maxRetries: 0 });
  assert.equal(result.handoff.requested_next_wake.project, 'demo'); assert.deepEqual((await store.manifest('run-1')).result, result.handoff); assert.equal((await readdir(path.join(store.root, 'schedules'))).length, 1);
  assert.throws(() => validateCelestanResult({ status: 'complete', summary: 'x', requested_next_wake: null, secret: 'x' }), /exactly/);
});

test('missing or invalid result is a safe contract failure and never schedules', async () => {
  for (const mode of ['missing', 'invalid']) { const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-'))); await base(store); const result = await invoke({ store, executionId: 'run-1', command: process.execPath, commandArgs: [fixture], model: 'm', agent: 'a', task: 't', env: { RESULT_MODE: mode }, maxRetries: 0 }); assert.equal(result.status, 'failed'); assert.deepEqual((await store.manifest('run-1')).failure, { category: 'validation', retryable: false }); assert.equal(await existsDir(path.join(store.root, 'schedules')), false); }
});

test('recovery preserves crash facts and requeues bounded work without fake success', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-'))); await base(store); await store.updateManifest('run-1', { execution: { status: 'running', startedAt: new Date(0).toISOString() } });
  const result = await recover({ store, staleMs: 1 }); assert.equal(result.success, false); assert.deepEqual(result.requeued, ['run-1']); assert.equal((await store.manifest('run-1')).execution.status, 'requeued'); assert.equal((await store.manifest('run-1')).recovery.status, 'requeued'); assert.equal((await store.manifest('run-1')).failure.category, 'crash');
});

test('due scheduler launches configured bootstrap and duplicate scheduler call is harmless', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-'))); await store.schedule({ ...wake, time: new Date(Date.now() - 1000).toISOString() });
  const options = { command: process.execPath, commandArgs: [fixture], model: 'm', agent: 'a', task: 'bootstrap', maxRetries: 0 };
  const first = await runScheduler({ store, invokeOptions: options }); assert.equal(first.launched.length, 1); assert.equal(first.launched[0].status, 'success'); assert.equal((await runScheduler({ store, invokeOptions: options })).launched.length, 0); assert.equal((await store.manifestsAll()).length, 1);
});

test('Observer completion, pending invalid semantic, and duplicate observation are idempotent', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-'))); await base(store); await store.updateManifest('run-1', { execution: { status: 'success', finishedAt: new Date().toISOString() } });
  assert.equal((await observePending({ store, observerPath }))[0].status, 'processed'); assert.equal((await store.manifest('run-1')).observer.state, 'pending');
  const semanticFile = path.join(store.root, 'semantic.json'); await writeFile(semanticFile, JSON.stringify({ schema: 'celestan-semantic-observation-v1', executionId: 'run-1', status: 'complete', summary: 'Observed fixture', confidence: 0.9, signals: [] }));
  const complete = await observePending({ store, observerPath, semanticResultFile: semanticFile }); assert.equal(complete[0].status, 'observed'); assert.equal((await store.manifest('run-1')).observer.state, 'observed');
  const bad = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-'))); await base(bad); await bad.updateManifest('run-1', { execution: { status: 'failed', finishedAt: new Date().toISOString() } }); const badFile = path.join(bad.root, 'bad.json'); await writeFile(badFile, JSON.stringify({ nope: true })); const pending = await observePending({ store: bad, observerPath, semanticResultFile: badFile }); assert.equal(pending[0].status, 'semantic-analysis-pending'); assert.equal((await bad.manifest('run-1')).observer.state, 'pending');
});

test('telemetry is append-only and process termination is distinct', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-'))); await store.telemetry({ executionId: 'x', availability: 'unavailable', reason: 'not-exposed' }); assert.match(await readFile(path.join(store.root, 'telemetry.ndjson'), 'utf8'), /unavailable/);
  const result = await runProcess({ command: process.execPath, args: ['-e', 'setTimeout(()=>{},1000)'], timeoutMs: 20 }); assert.equal(result.terminated, true); assert.equal(result.timedOut, true);
});

test('stale takeover fences the old owner and schedule identity is stable', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-'))); await base(store);
  const first = await store.lease('run-1', 'first', 5); await new Promise((resolve) => setTimeout(resolve, 15)); const second = await store.lease('run-1', 'second', 5);
  assert.equal(second.acquired, true); assert.notEqual(first.fence, second.fence); await assert.rejects(() => store.updateManifest('run-1', { execution: { status: 'success' } }, first), /fencing/); await store.release('run-1', second);
  const due = { ...wake, time: new Date(Date.now() - 1000).toISOString() }; const scheduled = await store.schedule(due, { model: 'm', agent: 'a', task: 't', env: { SECRET_VALUE: 'must-not-persist' } }); const duplicate = await store.schedule(due, { model: 'm', agent: 'a', task: 't', env: { SECRET_VALUE: 'must-not-persist' } }); assert.equal(duplicate.status, 'duplicate'); assert.equal(scheduled.schedule.executionId, duplicate.schedule.executionId); const files = await Promise.all((await readdir(store.root)).filter((x) => x.endsWith('.ndjson')).map((x) => readFile(path.join(store.root, x), 'utf8'))); assert.equal(files.some((x) => x.includes('must-not-persist')), false);
});

test('continue requires a wake, failed handoff is not success, and each attempt has a clean result path', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-'))); await base(store);
  const script = "require('fs').writeFileSync(process.env.CT_RUNTIME_RESULT_FILE, JSON.stringify({status:'continue',summary:'continue',requested_next_wake:{time:'2030-01-01T00:00:00Z',reason:'retry',priority:'low',project:'demo'}}))";
  const result = await invoke({ store, executionId: 'run-1', command: process.execPath, commandArgs: ['-e', script], model: 'm', agent: 'a', task: 't', maxRetries: 0 }); assert.equal(result.status, 'success'); assert.equal((await readdir(path.join(store.root, 'schedules'))).length, 1); assert.match(result.reference.uri, /stdout-attempt-1/);
  const failedStore = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-'))); await base(failedStore, { executionId: 'other' }); const failed = await invoke({ store: failedStore, executionId: 'other', command: process.execPath, commandArgs: [fixture], model: 'm', agent: 'a', task: 't', env: { HANDOFF_STATUS: 'failed' }, maxRetries: 0 }); assert.equal(failed.status, 'failed'); assert.equal((await failedStore.manifest('other')).execution.status, 'failed');
});

test('scheduler closes a terminal deterministic manifest after a claim without reinvoking', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-'))); const scheduled = await store.schedule({ ...wake, time: new Date(Date.now() - 1000).toISOString() }, { model: 'm', agent: 'a', task: 't', command: process.execPath });
  await store.createManifest({ executionId: scheduled.schedule.executionId, workOrder: scheduled.schedule.workOrder, project: 'demo', task: 't', model: 'm', agent: 'a' }); await store.updateManifest(scheduled.schedule.executionId, { execution: { status: 'success', finishedAt: new Date().toISOString() } });
  const result = await runScheduler({ store, invokeOptions: { command: 'not-a-command', model: 'm', agent: 'a', task: 'must-not-run' } }); assert.equal(result.failures.length, 0); assert.equal(result.launched[0].reinvoked, false); assert.equal((await store.manifestsAll()).length, 1);
});

test('scheduler reports a reclaimed terminal failure without reinvoking', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-'))); const scheduled = await store.schedule({ ...wake, time: new Date(Date.now() - 1000).toISOString() }, { model: 'm', agent: 'a', task: 't' });
  await store.createManifest({ executionId: scheduled.schedule.executionId, workOrder: scheduled.schedule.workOrder, project: 'demo', task: 't', model: 'm', agent: 'a' }); await store.updateManifest(scheduled.schedule.executionId, { execution: { status: 'failed', finishedAt: new Date().toISOString() } });
  const result = await runScheduler({ store, invokeOptions: { command: 'not-a-command', model: 'm', agent: 'a', task: 'must-not-run' } }); assert.equal(result.success, false); assert.equal(result.failures[0].status, 'failed'); assert.equal(result.launched[0].reinvoked, false); const schedule = JSON.parse(await readFile(store.file(path.join(store.root, 'schedules'), scheduled.schedule.key), 'utf8')); assert.equal(schedule.state, 'failed');
});

test('schedule completion rejects a stale claim owner in the crash window', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-'))); const scheduled = await store.schedule({ ...wake, time: new Date(Date.now() - 1000).toISOString() }, { model: 'm', agent: 'a', task: 't' }); const claimed = (await store.claimSchedules())[0]; const target = store.file(path.join(store.root, 'schedules'), claimed.key); await store.atomic(target, { ...claimed, claimOwner: 'new-owner' }); await assert.rejects(() => store.completeSchedule(claimed, 'completed', claimed.claimOwner), /ownership/);
});

test('heartbeat fence loss aborts the child and does not write stale terminal state', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-'))); await base(store); store.heartbeat = async () => { throw new Error('lost fencing ownership'); };
  const result = await invoke({ store, executionId: 'run-1', command: process.execPath, commandArgs: ['-e', 'setTimeout(()=>{},5000)'], model: 'm', agent: 'a', task: 't', maxRetries: 0, heartbeatIntervalMs: 100 }); assert.equal(result.failure.category, 'ownership-lost'); assert.equal(result.process.terminated, true); const manifest = await store.manifest('run-1'); assert.equal(manifest.execution.status, 'running'); assert.equal(manifest.execution.finishedAt, undefined);
});

test('bounded single-handle reads reject oversized result and semantic files', async () => {
  const resultStore = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-'))); await base(resultStore); const result = await invoke({ store: resultStore, executionId: 'run-1', command: process.execPath, commandArgs: [fixture], model: 'm', agent: 'a', task: 't', env: { RESULT_SIZE: 'large' }, maxRetries: 0 }); assert.equal(result.status, 'failed'); assert.equal((await resultStore.manifest('run-1')).failure.category, 'validation');
  const semanticStore = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-'))); await base(semanticStore); await semanticStore.updateManifest('run-1', { execution: { status: 'success', finishedAt: nowForTest() } }); const semantic = path.join(semanticStore.root, 'semantic.json'); await writeFile(semantic, JSON.stringify({ schema: 'celestan-semantic-observation-v1', executionId: 'run-1', status: 'complete', summary: 'x'.repeat(70000), confidence: 0.9, signals: [] })); const pending = await observePending({ store: semanticStore, observerPath, semanticResultFile: semantic }); assert.equal(pending[0].status, 'semantic-analysis-pending');
});

test('recover rebuilds authoritative parent links and rejects supplied childIds', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-'))); await base(store, { executionId: 'root' }); await base(store, { executionId: 'child', topology: { rootId: 'root', parentId: 'root', childIds: [] } }); const root = await store.manifest('root'); root.topology.childIds = ['forged']; await store.atomic(store.file(store.manifests, 'root'), root); await recover({ store }); assert.deepEqual((await store.manifest('root')).topology.childIds, ['child']); await assert.rejects(() => base(store, { executionId: 'bad', topology: { rootId: 'root', parentId: 'root', childIds: ['child'] } }), /authoritative/);
});

test('direct run --id consumes a requeued manifest without changing execution identity', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-'))); await base(store); await store.updateManifest('run-1', { execution: { status: 'requeued', startedAt: new Date(0).toISOString() } });
  await execFileAsync(process.execPath, ['bin/ct-runtime.mjs', 'run', '--store', store.root, '--id', 'run-1', '--opencode', process.execPath, '--opencode-arg', fixture, '--max-retries', '0']); const manifest = await store.manifest('run-1'); assert.equal(manifest.execution.id, 'run-1'); assert.equal(manifest.execution.status, 'success');
});

function nowForTest() { return new Date().toISOString(); }

test('Windows executable resolution never shells caller arguments', async () => {
  if (process.platform === 'win32') { assert.match(await resolveExecutable('opencode'), /opencode\.exe$/i); await assert.rejects(() => resolveExecutable('arbitrary.cmd'), /only opencode/); }
});

async function existsDir(target) { try { await readdir(target); return true; } catch { return false; } }
