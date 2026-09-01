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

test('coordination unavailable fails closed and bridge exposes semantic boundaries only', () => {
  assert.throws(() => assertCoordination({ available: false }), CoordinationUnavailableError);
  const calls = [];
  const adapter = { available: true, createWorkOrder() {}, claim(v) { calls.push(['claim', v]); return v; }, checkpoint() {}, finalize() {}, reconstruct() {} };
  const bridge = createOpenCodeFederationBridge(adapter);
  assert.deepEqual(OPEN_CODE_SEMANTIC_BOUNDARIES, ['begin', 'checkpoint', 'defer', 'continue', 'finalize', 'lineage']);
  bridge.begin({ workOrderId: 'w' });
  assert.equal(calls[0][0], 'claim');
});
