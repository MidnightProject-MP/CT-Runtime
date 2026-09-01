import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCoordination, CoordinationUnavailableError, normalizeObserverLineage, PostgresFederationAdapter, redactFederation } from '../lib/federation.mjs';
import { createOpenCodeFederationBridge, OPEN_CODE_SEMANTIC_BOUNDARIES } from '../lib/opencode-federation-bridge.mjs';

test('federation contract normalizes lineage and redacts secrets', () => {
  const lineage = normalizeObserverLineage({ workOrderId: 'w', executionId: 'e', provider: 'gas', mode: 'background', checkpoint: { step: 1 } });
  assert.equal(lineage.schema, 'celestan-observer-lineage-v1');
  assert.equal(lineage.mode, 'background');
  assert.match(lineage.checkpointDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(redactFederation({ summary: 'token-1234' }, ['token-1234']), { summary: '[REDACTED]' });
  assert.deepEqual(redactFederation({ apiKey: 'not-in-secret-list', nested: { password: 'value' } }), { apiKey: '[REDACTED]', nested: { password: '[REDACTED]' } });
});

test('postgres claims allocate fences from the locked work-order counter', async () => {
  const calls = [];
  const execution = { execution_id: 'e1', work_order_id: 'w', provider: 'gas', mode: 'background', state: 'claimed', claim_owner: 'o', claim_fence: 7n, lease_until: new Date(Date.now() + 60000), repository: {}, lineage: {}, created_at: new Date(), updated_at: new Date() };
  const client = { query: async (text) => {
    calls.push(text);
    if (text === 'BEGIN' || text === 'COMMIT') return { rows: [] };
    if (text === 'ROLLBACK') return { rows: [] };
    if (text.includes('FROM federation_work_orders')) return { rows: [{ work_order_id: 'w', next_claim_fence: 6n }] };
    if (text.includes("state IN ('claimed','running')")) return { rows: [] };
    if (text.startsWith('UPDATE federation_work_orders')) return { rows: [{ next_claim_fence: 7n }] };
    if (text.startsWith('INSERT INTO federation_executions')) return { rows: [execution] };
    return { rows: [] };
  }, release() {} };
  const adapter = new PostgresFederationAdapter({ pool: { connect: async () => client } });
  const result = await adapter.claim({ workOrderId: 'w', executionId: 'e1', provider: 'gas', owner: 'o' });
  assert.equal(result.claim.fence, '7');
  assert.ok(calls.some((sql) => sql.startsWith('UPDATE federation_work_orders')));
  assert.ok(!calls.some((sql) => /max\s*\(claim_fence\)|federation_executions[^\n]+FOR UPDATE/i.test(sql)));
});

test('postgres rejects a second active background mutation claim', async () => {
  const calls = [];
  const active = { execution_id: 'e1', work_order_id: 'w', mode: 'background', state: 'running', lease_until: new Date(Date.now() + 60000) };
  const client = { query: async (text) => {
    calls.push(text);
    if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [] };
    if (text.includes('FROM federation_work_orders')) return { rows: [{ work_order_id: 'w', next_claim_fence: 1n }] };
    if (text.includes("state IN ('claimed','running')")) return { rows: [active] };
    throw new Error(`unexpected query: ${text}`);
  }, release() {} };
  const adapter = new PostgresFederationAdapter({ pool: { connect: async () => client } });
  await assert.rejects(() => adapter.claim({ workOrderId: 'w', executionId: 'e2', provider: 'gas', owner: 'o' }), { category: 'conflict' });
  assert.equal(calls.some((sql) => sql.startsWith('UPDATE federation_work_orders')), false);
  assert.equal(calls.some((sql) => sql.startsWith('INSERT INTO federation_executions')), false);
});

test('postgres mutation ownership is checked with the database clock', async () => {
  const calls = [];
  const client = { query: async (text) => { calls.push(text); if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [] }; return { rows: [] }; }, release() {} };
  const adapter = new PostgresFederationAdapter({ pool: { connect: async () => client } });
  await assert.rejects(() => adapter.renew('e1', { owner: 'o', fence: '1' }), { category: 'ownership-lost' });
  assert.match(calls.find((sql) => sql.includes('FROM federation_executions')), /lease_until>clock_timestamp\(\)/);
});

test('handoff retries return the original target by idempotency key', async () => {
  const calls = [];
  const target = { execution_id: 'e2', work_order_id: 'w', provider: 'gas', mode: 'background', state: 'claimed', claim_owner: 'o2', claim_fence: 2n, lease_until: new Date(Date.now() + 60000), repository: {}, lineage: {}, created_at: new Date(), updated_at: new Date() };
  const client = { query: async (text) => {
    calls.push(text);
    if (text === 'BEGIN' || text === 'COMMIT') return { rows: [] };
    if (text.includes('FROM federation_work_orders')) return { rows: [{ work_order_id: 'w' }] };
    if (text.includes('FROM federation_handoffs')) return { rows: [{ to_execution_id: 'e2' }] };
    if (text.includes('FROM federation_executions')) return { rows: [target] };
    throw new Error(`unexpected query: ${text}`);
  }, release() {} };
  const adapter = new PostgresFederationAdapter({ pool: { connect: async () => client } });
  const result = await adapter.handoff('e1', { handoffId: 'h1', provider: 'gas' });
  assert.equal(result.id, 'e2');
  assert.ok(calls.indexOf('SELECT * FROM federation_work_orders WHERE work_order_id=(SELECT work_order_id FROM federation_executions WHERE execution_id=$1) FOR UPDATE') < calls.indexOf('SELECT to_execution_id FROM federation_handoffs WHERE handoff_id=$1 AND from_execution_id=$2'));
});

test('handoff inserts the actual target execution id', async () => {
  const handoffParams = [];
  const current = { execution_id: 'e1', work_order_id: 'w', provider: 'gas', mode: 'background', state: 'running', claim_owner: 'o1', claim_fence: 1n, lease_until: new Date(Date.now() + 60000), repository: {}, lineage: {}, checkpoint: { step: 1 }, created_at: new Date(), updated_at: new Date() };
  const target = { execution_id: 'e2', work_order_id: 'w', provider: 'gas', mode: 'background', state: 'claimed', claim_owner: 'o2', claim_fence: 2n, lease_until: new Date(Date.now() + 60000), repository: {}, lineage: {}, created_at: new Date(), updated_at: new Date() };
  const client = { query: async (text, params) => {
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
    if (text.includes('FROM federation_handoffs')) return { rows: [] };
    if (text.includes('claim_owner=$2')) return { rows: [current] };
    if (text.includes("state IN ('claimed','running')")) return { rows: [] };
    if (text.startsWith('UPDATE federation_work_orders')) return { rows: [{ next_claim_fence: 2n }] };
    if (text.startsWith('INSERT INTO federation_executions')) return { rows: [target] };
    if (text.startsWith('INSERT INTO federation_handoffs')) { handoffParams.push(params); return { rows: [] }; }
    if (text.includes('FROM federation_work_orders')) return { rows: [{ work_order_id: 'w', next_claim_fence: 1n }] };
    if (text.startsWith('UPDATE federation_executions')) return { rows: [] };
    throw new Error(`unexpected query: ${text}`);
  }, release() {} };
  const adapter = new PostgresFederationAdapter({ pool: { connect: async () => client } });
  await adapter.handoff('e1', { handoffId: 'h1', provider: 'gas', owner: 'o2' }, { owner: 'o1', fence: '1' });
  assert.equal(handoffParams[0][3], 'e2');
});

test('concurrent same-handoff retries serialize before idempotency lookup', async () => {
  const target = { execution_id: 'e2', work_order_id: 'w', provider: 'gas', mode: 'background', state: 'claimed', claim_owner: 'o2', claim_fence: 2n, lease_until: new Date(Date.now() + 60000), repository: {}, lineage: {}, created_at: new Date(), updated_at: new Date() };
  let handoff;
  let lockedBy = null;
  let releaseLock;
  const waitForRelease = new Promise((resolve) => { releaseLock = resolve; });
  let clientNumber = 0;
  const makeClient = (number) => ({ query: async (text) => {
    if (text === 'BEGIN') return { rows: [] };
    if (text === 'COMMIT') { if (lockedBy === number) { lockedBy = null; releaseLock?.(); } return { rows: [] }; }
    if (text === 'ROLLBACK') return { rows: [] };
    if (text.includes('FROM federation_work_orders')) {
      if (lockedBy !== null && lockedBy !== number) await waitForRelease;
      lockedBy = number;
      return { rows: [{ work_order_id: 'w', next_claim_fence: 1n }] };
    }
    if (text.includes('FROM federation_handoffs')) return { rows: handoff ? [{ to_execution_id: 'e2' }] : [] };
    if (text.includes('FROM federation_executions WHERE execution_id=$1')) return { rows: [target] };
    if (text.includes('state IN (')) return { rows: [] };
    if (text.startsWith('UPDATE federation_work_orders')) return { rows: [{ next_claim_fence: 2n }] };
    if (text.startsWith('INSERT INTO federation_executions')) { handoff = true; return { rows: [target] }; }
    if (text.startsWith('INSERT INTO federation_handoffs')) { handoff = true; return { rows: [] }; }
    if (text.startsWith('UPDATE federation_executions')) return { rows: [] };
    throw new Error(`unexpected query: ${text}`);
  }, release() {} });
  const adapter = new PostgresFederationAdapter({ pool: { connect: async () => makeClient(++clientNumber) } });
  const first = adapter.handoff('e1', { handoffId: 'h1', provider: 'gas' });
  await new Promise((resolve) => setImmediate(resolve));
  const second = adapter.handoff('e1', { handoffId: 'h1', provider: 'gas' });
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((value) => value.id), ['e2', 'e2']);
});

test('coordination unavailable fails closed and bridge exposes semantic boundaries only', async () => {
  assert.throws(() => assertCoordination({ available: false }), CoordinationUnavailableError);
  const calls = [];
  const adapter = { available: true, createWorkOrder() {}, claim(v) { calls.push(['claim', v]); return v; }, checkpoint() {}, finalize() {}, reconstruct() {}, discoverResumableWork(v) { calls.push(['discover', v]); return { status: 'missing' }; }, takeoverResumableWork(v) { calls.push(['takeover', v]); return v; } };
  const bridge = createOpenCodeFederationBridge(adapter);
  assert.deepEqual(OPEN_CODE_SEMANTIC_BOUNDARIES, ['begin', 'checkpoint', 'defer', 'continue', 'finalize', 'discover', 'takeover', 'lineage']);
  await bridge.begin({ workOrderId: 'w' }); await bridge.discover({ workOrderId: 'w', project: 'p' }); await bridge.takeover({ workOrderId: 'w', repository: {} });
  assert.equal(calls[0][0], 'claim');
  assert.deepEqual(calls.map(([name]) => name), ['claim', 'discover', 'takeover']);
});

const gasContinuation = ({ state = 'running', leaseUntil = new Date(Date.now() - 60000), checkpointDigest = 'a'.repeat(64) } = {}) => ({
  execution_id: 'gas-exec', work_order_id: 'w', provider: 'gas', mode: 'background', state, claim_owner: 'gas-primary', claim_fence: 2n,
  lease_until: leaseUntil, repository: { ref: 'main', head: 'abc123' },
  checkpoint: { workOrderId: 'w', executionId: 'gas-exec', physicalExecutionId: 'gas-physical', continuationId: 'cont-1', nextOperation: 'interactive-reconstruction' },
  lineage: { parentExecutionId: 'open-exec-a', gas: { physicalExecutionId: 'gas-physical', continuationId: 'cont-1', checkpointDigest, canonicalCheckpointDigest: 'c'.repeat(64), evidence: [{ sha256: 'b'.repeat(64) }] } },
  recorded_checkpoint_digest: 'a'.repeat(64), current_checkpoint_digest: 'c'.repeat(64), created_at: new Date('2026-09-01T00:00:00Z'), updated_at: new Date('2026-09-01T00:01:00Z')
});

function takeoverHarness({ execution = gasContinuation(), project = 'ct-runtime' } = {}) {
  const state = { order: { work_order_id: 'w', project, repository: { ref: 'main', head: 'abc123' }, next_claim_fence: 2n }, executions: new Map([[execution.execution_id, execution]]), handoffs: new Map(), events: [], mutations: 0 };
  let lockOwner = null, releaseLock = null, clientSequence = 0;
  const query = async (clientId, text, params = []) => {
    if (text === 'BEGIN') return { rows: [] };
    if (text === 'COMMIT' || text === 'ROLLBACK') { if (lockOwner === clientId) { lockOwner = null; releaseLock?.(); releaseLock = null; } return { rows: [] }; }
    if (text.includes('FROM federation_work_orders WHERE work_order_id=$1 AND project=$2')) return { rows: state.order.work_order_id === params[0] && state.order.project === params[1] ? [state.order] : [] };
    if (text.includes('FROM federation_work_orders WHERE work_order_id=$1 FOR UPDATE')) {
      if (lockOwner !== null && lockOwner !== clientId) await new Promise((resolve) => { releaseLock = resolve; });
      lockOwner = clientId; return { rows: state.order.work_order_id === params[0] ? [state.order] : [] };
    }
    if (text.includes('FROM federation_handoffs WHERE handoff_id=$1')) return { rows: state.handoffs.has(params[0]) ? [state.handoffs.get(params[0])] : [] };
    if (text.includes("event_type='gas-checkpointed'") && !text.includes('FROM federation_executions e')) { const value = state.executions.get(params[1]); return { rows: value ? [{ checkpoint_digest: value.recorded_checkpoint_digest }] : [] }; }
    if (text.includes('SELECT *,lease_until>clock_timestamp() AS lease_active FROM federation_executions WHERE execution_id=$1')) { const value = state.executions.get(params[0]); return { rows: value ? [{ ...value, lease_active: ['claimed', 'running'].includes(value.state) && new Date(value.lease_until).getTime() > Date.now() }] : [] }; }
    if (text.includes('FROM federation_executions WHERE execution_id=$1')) return { rows: state.executions.has(params[0]) ? [state.executions.get(params[0])] : [] };
    if (text.includes("AND state IN ('claimed','running') AND lease_until>clock_timestamp()")) { const values = [...state.executions.values()].filter((value) => ['claimed', 'running'].includes(value.state) && new Date(value.lease_until).getTime() > Date.now()); return { rows: values.length ? [{ execution_id: values[0].execution_id }] : [] }; }
    if (text.includes('FROM federation_executions WHERE work_order_id=$1 ORDER BY claim_fence DESC NULLS LAST,created_at DESC,execution_id DESC LIMIT 1')) { const values = [...state.executions.values()].sort((a, b) => Number(b.claim_fence - a.claim_fence) || b.created_at - a.created_at || b.execution_id.localeCompare(a.execution_id)); return { rows: values.length ? [{ ...values[0] }] : [] }; }
    if (text.includes('FROM federation_executions e WHERE e.work_order_id=$1')) { const values = [...state.executions.values()].sort((a, b) => b.created_at - a.created_at || b.execution_id.localeCompare(a.execution_id)); return { rows: values.length ? [{ ...values[0] }] : [] }; }
    if (text.startsWith('UPDATE federation_executions SET state=')) { const value = state.executions.get(params[0]); value.state = 'handoff'; value.lease_until = null; state.mutations++; return { rows: [] }; }
    if (text.startsWith('UPDATE federation_work_orders SET next_claim_fence=')) { state.order.next_claim_fence++; state.mutations++; return { rows: [{ next_claim_fence: state.order.next_claim_fence }] }; }
    if (text.startsWith('INSERT INTO federation_executions')) { const value = { execution_id: params[0], work_order_id: params[1], provider: params[2], mode: 'foreground', state: 'claimed', claim_owner: params[3], claim_fence: BigInt(params[4]), lease_until: new Date(Date.now() + params[5]), repository: params[6], lineage: params[7], created_at: new Date(), updated_at: new Date() }; state.executions.set(value.execution_id, value); state.mutations++; return { rows: [value] }; }
    if (text.startsWith('INSERT INTO federation_handoffs')) { state.handoffs.set(params[0], { handoff_id: params[0], work_order_id: params[1], from_execution_id: params[2], to_execution_id: params[3], checkpoint: params[4], reason: 'interactive-takeover' }); state.mutations++; return { rows: [] }; }
    if (text.startsWith('INSERT INTO federation_events')) { state.events.push({ workOrderId: params[1], executionId: params[2], type: params[3], payload: params[4] }); state.mutations++; return { rows: [] }; }
    throw new Error(`unexpected query: ${text}`);
  };
  const pool = { query: (text, params) => query(0, text, params), connect: async () => { const clientId = ++clientSequence; return { query: (text, params) => query(clientId, text, params), release() {} }; } };
  return { adapter: new PostgresFederationAdapter({ pool }), state };
}

test('interactive discovery is repeatable, bounded, and read-only', async () => {
  const { adapter, state } = takeoverHarness();
  const first = await adapter.discoverResumableWork({ workOrderId: 'w', project: 'ct-runtime' });
  const second = await adapter.discoverResumableWork({ workOrderId: 'w', project: 'ct-runtime' });
  assert.deepEqual(first, second);
  assert.equal(first.status, 'resumable'); assert.equal(first.eligible, true); assert.equal(first.continuationId, 'cont-1'); assert.equal(first.lastAuthoritativeFence, '2');
  assert.equal(first.checkpoint, undefined); assert.equal(first.repository, undefined); assert.equal(state.mutations, 0);
  assert.deepEqual(await adapter.discoverResumableWork({ workOrderId: 'w', project: 'other-project' }), { status: 'missing', eligible: false, workOrderId: 'w', project: 'other-project' });
});

test('interactive discovery classifies active, completed, and corrupted continuations without takeover', async () => {
  const active = takeoverHarness({ execution: gasContinuation({ leaseUntil: new Date(Date.now() + 60000) }) });
  assert.equal((await active.adapter.discoverResumableWork({ workOrderId: 'w', project: 'ct-runtime' })).status, 'active');
  const completed = takeoverHarness({ execution: gasContinuation({ state: 'finalized' }) });
  assert.equal((await completed.adapter.discoverResumableWork({ workOrderId: 'w', project: 'ct-runtime' })).status, 'completed');
  const corrupted = takeoverHarness({ execution: gasContinuation({ checkpointDigest: 'invalid' }) });
  assert.equal((await corrupted.adapter.discoverResumableWork({ workOrderId: 'w', project: 'ct-runtime' })).status, 'continuation-invalid');
});

const takeoverInput = { workOrderId: 'w', project: 'ct-runtime', takeoverId: 'takeover-1', executionId: 'open-exec-c', owner: 'opencode-session', provider: 'opencode-local', repository: { ref: 'main', head: 'abc123' }, expectedContinuationId: 'cont-1', expectedFence: '2' };

test('explicit interactive takeover allocates one fresh foreground fence and is idempotent', async () => {
  const { adapter, state } = takeoverHarness();
  const first = await adapter.takeoverResumableWork(takeoverInput);
  const duplicate = await adapter.takeoverResumableWork(takeoverInput);
  assert.equal(first.status, 'taken-over'); assert.equal(duplicate.status, 'duplicate');
  assert.equal(first.workOrderId, 'w'); assert.equal(first.executionId, 'open-exec-c'); assert.equal(first.fence, '3'); assert.equal(first.continuationId, 'cont-1');
  assert.equal(first.observerLineage.executionId, 'open-exec-c'); assert.equal(first.observerLineage.parentExecutionId, 'gas-exec');
  assert.equal(state.executions.get('gas-exec').state, 'handoff'); assert.equal(state.executions.get('open-exec-c').mode, 'foreground');
  assert.equal(state.handoffs.get('takeover-1').from_execution_id, 'gas-exec'); assert.equal(state.events.length, 1);
  await assert.rejects(() => adapter.takeoverResumableWork({ ...takeoverInput, owner: 'different-owner' }), { category: 'conflict' });
});

test('concurrent identical interactive takeovers serialize to one authority', async () => {
  const { adapter, state } = takeoverHarness();
  const results = await Promise.all([adapter.takeoverResumableWork(takeoverInput), adapter.takeoverResumableWork(takeoverInput)]);
  assert.deepEqual(results.map((value) => value.status).sort(), ['duplicate', 'taken-over']);
  assert.equal([...state.executions.values()].filter((value) => value.mode === 'foreground').length, 1);
  assert.equal(state.order.next_claim_fence, 3n);
});

test('interactive takeover fails closed for live GAS, stale fence, repository drift, and stale safety wake', async () => {
  const active = takeoverHarness({ execution: gasContinuation({ leaseUntil: new Date(Date.now() + 60000) }) });
  await assert.rejects(() => active.adapter.takeoverResumableWork(takeoverInput), { category: 'active-conflict' });
  const stale = takeoverHarness();
  await assert.rejects(() => stale.adapter.takeoverResumableWork({ ...takeoverInput, expectedFence: '1' }), { category: 'stale-continuation' });
  const drift = takeoverHarness();
  await assert.rejects(() => drift.adapter.takeoverResumableWork({ ...takeoverInput, repository: { ref: 'main', head: 'changed' } }), { category: 'repository-drift' });
  const wake = takeoverHarness(); await wake.adapter.takeoverResumableWork(takeoverInput);
  await assert.rejects(() => wake.adapter.takeoverResumableWork({ ...takeoverInput, takeoverId: 'gas-safety-wake', executionId: 'gas-retry', owner: 'gas-primary', provider: 'gas' }), { category: 'active-conflict' });
});

test('completed work orders are reported but not reopened by takeover', async () => {
  const { adapter, state } = takeoverHarness({ execution: gasContinuation({ state: 'finalized' }) });
  const result = await adapter.takeoverResumableWork(takeoverInput);
  assert.equal(result.status, 'completed'); assert.equal(result.eligible, false); assert.equal(state.mutations, 0);
});

test('duplicate takeover does not return stale authority after foreground expiry or completion', async () => {
  const expired = takeoverHarness(); await expired.adapter.takeoverResumableWork(takeoverInput); expired.state.executions.get('open-exec-c').lease_until = new Date(Date.now() - 1000);
  assert.equal((await expired.adapter.takeoverResumableWork(takeoverInput)).status, 'expired');
  const completed = takeoverHarness(); await completed.adapter.takeoverResumableWork(takeoverInput); completed.state.executions.get('open-exec-c').state = 'finalized';
  assert.equal((await completed.adapter.takeoverResumableWork(takeoverInput)).status, 'completed');
});
