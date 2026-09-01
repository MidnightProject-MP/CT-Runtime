import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { request } from '../lib/capabilities/registry.mjs';
import { resolveBinding } from '../lib/capabilities/bindings.mjs';

async function gasCore() {
  const source = await requireText('gas/gas_core.js');
  const context = { Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: (_, value) => [...createHash('sha256').update(String(value)).digest()] } };
  vm.runInNewContext(source, context);
  return context.CT_GAS;
}
const requireText = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('mocked GAS pure core rejects unsafe wake/messages and bounds model turns', async () => {
  const core = await gasCore();
  assert.throws(() => core.wake({ time: new Date().toISOString(), reason: 'http-request' }));
  assert.throws(() => core.messages([{ role: 'tool', content: 'x' }]));
  assert.throws(() => core.freeModel('openrouter/a/b'));
  assert.equal(core.freeModel('openrouter/a/b:free'), 'openrouter/a/b:free');
});

test('fake GAS clock refuses late work and preserves wake identity', async () => {
  const core = await gasCore(); let now=1000; const clock=core.clock(now,30000,()=>now); now=25000; let started=false;
  assert.equal(core.runGuard(clock,'model-request',5000,()=>{ started=true; return 'started'; }).status,'preempted'); assert.equal(started,false);
  const wake=core.wake({time:new Date(0).toISOString(),reason:'checkpoint',work_order_id:'order-a',execution_id:'exec-b',continuation_id:'cont-c',launch:{model:'same'},resume:{next:'verify'}});
  assert.equal(wake.work_order_id,'order-a'); assert.equal(wake.execution_id,'exec-b'); assert.equal(wake.continuation_id,'cont-c'); assert.match(wake.launch, /model/);
});

test('GAS mode resolves modes.gas and Node exposes it as remote metadata only', async () => {
  const env = { CT_RUNTIME_MODE: 'filesystem', CELESTAN_BINDINGS_JSON: JSON.stringify({ modes: { gas: { durable_state: 'gas' } } }) };
  assert.equal(resolveBinding('durable_state', { env, mode: 'gas' }), 'gas');
  const adapter = await request('durable_state', { env: { ...env, CT_RUNTIME_MODE: 'gas' } });
  assert.equal(adapter.remote, true);
  assert.deepEqual(adapter.operations, []);
});

test('GAS adapter sources enforce the review boundaries', async () => {
  const trigger = await requireText('gas/gas_trigger.js');
  const v8 = await requireText('gas/gas_v8.js');
  const github = await requireText('gas/gas_github.js');
  const actions = await requireText('gas/gas_actions.js');
  assert.doesNotMatch(trigger, /newTrigger\(['"]runWake/);
  assert.match(trigger, /slice\(0,3\)/);
  assert.doesNotMatch(v8, /doGet|doPost|http-request/);
  assert.match(v8, /verifyExisting/);
  assert.doesNotMatch(github, /return \{[\s\S]*call:/);
  assert.match(actions, /GITHUB_ACTION_WORKFLOW_ALLOWLIST/);
});
