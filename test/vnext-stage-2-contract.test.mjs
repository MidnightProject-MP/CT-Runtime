import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalInputIdentity, revisionOccurrence, UNKNOWN_AUTHOR } from '../lib/vnext/human-input.mjs';
import { receiptFact, interpretationFact, executionFact, deliveryFact, discoverRecoverableEvents } from '../lib/vnext/coordinator.mjs';
import { outboundId, deliverOutbound, retryOutbound } from '../lib/vnext/outbound.mjs';

test('human input identity is stable, revision-aware, and immutable', () => {
  const input = { source_id: 'feedback-source-a', message_id: 'message-7', revision: 2, observed_at: '2026-09-11T00:00:00.000Z', content: 'redacted at the boundary' };
  assert.equal(canonicalInputIdentity(input), canonicalInputIdentity({ ...input, row: 999, content: 'different' }));
  const fact = revisionOccurrence(input);
  assert.equal(fact.author, UNKNOWN_AUTHOR);
  assert.equal(typeof fact.content_digest, 'string');
  assert.equal(Object.isFrozen(fact), true);
  assert.equal(Object.isFrozen(fact.author), true);
  assert.throws(() => { fact.revision = 3; }, TypeError);
  assert.notEqual(canonicalInputIdentity(input), canonicalInputIdentity({ ...input, revision: 3 }));
});

test('coordinator keeps receipt, interpretation, execution, and delivery facts separate', async () => {
  const receipt = receiptFact({ event_id: 'event-1', source_id: 'source-1' });
  assert.equal(receipt.kind, 'receipt');
  assert.equal(interpretationFact({ event_id: 'event-1' }).kind, 'interpretation');
  assert.equal(executionFact({ execution_id: 'exec-1' }).kind, 'execution');
  assert.equal(deliveryFact({ outbound_id: 'out-1' }).kind, 'delivery');
  const store = { discoverRecoverableEvents: async ({ limit }) => [{ event_id: 'event-1', limit }] };
  assert.deepEqual(await discoverRecoverableEvents(store), [{ event_id: 'event-1', limit: 100 }]);
});

test('outbound persists intent before delivery and retries without cognition', async () => {
  const rows = new Map(); const order = []; let calls = 0;
  const store = {
    persistOutbound: async (row) => { order.push('persist'); rows.set(row.outbound_id, { ...row }); },
    readbackOutbound: async ({ outbound_id }) => rows.get(outbound_id),
    markOutboundDelivered: async ({ outbound_id, result }) => { order.push('mark'); rows.set(outbound_id, { ...rows.get(outbound_id), status: 'delivered', result }); },
  };
  const input = { source_id: 's', message_id: 'm', revision: 1, execution_id: 'e', kind: 'reply' };
  assert.equal(outboundId(input), outboundId({ ...input }));
  const first = await deliverOutbound({ store, input, delivery: async () => { order.push('deliver'); calls += 1; throw new Error('transport down'); } }).catch(() => null);
  assert.equal(first, null); assert.deepEqual(order, ['persist', 'deliver']);
  const id = outboundId(input);
  const delivered = await retryOutbound({ store, outbound_id: id, delivery: async () => { order.push('deliver-retry'); calls += 1; return { provider_id: 'p' }; } });
  assert.equal(delivered.status, 'delivered'); assert.equal(calls, 2); assert.deepEqual(order, ['persist', 'deliver', 'persist', 'deliver-retry', 'mark']);
});
