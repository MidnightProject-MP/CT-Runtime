import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../lib/vnext/memory-store.mjs';
import { canonicalEvent, eventsEquivalent } from '../lib/vnext/event-integrity.mjs';

test('canonical events ignore incidental object key ordering', () => {
  const a = { type: 'external_input.received', event_id: 'e1', payload: { z: 2, a: 1 } };
  const b = { event_id: 'e1', payload: { a: 1, z: 2 }, type: 'external_input.received' };
  assert.equal(eventsEquivalent(a, b), true);
  assert.equal(canonicalEvent(a), canonicalEvent(b));
});

test('memory store consumes a new event once and treats the equivalent replay as duplicate', async () => {
  const store = createMemoryStore();
  const event = { type: 'external_input.received', event_id: 'e1', payload: { a: 1, b: 2 } };
  assert.equal((await store.appendEvent(event)).consumed, true);
  assert.equal((await store.appendEvent({ event_id: 'e1', payload: { b: 2, a: 1 }, type: 'external_input.received' })).consumed, false);
  assert.equal(store.snapshot().events.length, 1);
});

test('memory store rejects same event id with divergent payload', async () => {
  const store = createMemoryStore();
  await store.appendEvent({ type: 'external_input.received', event_id: 'e2', payload: { value: 'A' } });
  await assert.rejects(
    () => store.appendEvent({ type: 'external_input.received', event_id: 'e2', payload: { value: 'B' } }),
    (error) => error.code === 'EVENT_INTEGRITY_CONFLICT' && error.event_id === 'e2',
  );
});

test('memory store rejects same event id with divergent type', async () => {
  const store = createMemoryStore();
  await store.appendEvent({ type: 'external_input.received', event_id: 'e3', payload: { value: 'A' } });
  await assert.rejects(
    () => store.appendEvent({ type: 'wake.inspected', event_id: 'e3', payload: { value: 'A' } }),
    (error) => error.code === 'EVENT_INTEGRITY_CONFLICT' && error.event_id === 'e3',
  );
});
