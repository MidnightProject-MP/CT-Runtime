const freezeDeep = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
  return value;
};

const bounded = (value, limit = 256) => typeof value === 'string' ? value.slice(0, limit) : value;
const metadata = (value = {}) => freezeDeep(Object.fromEntries(Object.entries(value).filter(([key, item]) =>
  /^(source_id|message_id|revision|event_id|execution_id|outbound_id|status|kind|type|observed_at|created_at)$/.test(key) && (typeof item === 'string' || Number.isSafeInteger(item))
).map(([key, item]) => [key, bounded(item)])));

export function receiptFact(input = {}) { return freezeDeep({ kind: 'receipt', ...metadata(input), received_at: input.received_at ?? new Date().toISOString() }); }
export function interpretationFact(input = {}) { return freezeDeep({ kind: 'interpretation', ...metadata(input), disposition: bounded(input.disposition), summary: bounded(input.summary, 500) }); }
export function executionFact(input = {}) { return freezeDeep({ kind: 'execution', ...metadata(input), state: bounded(input.state) }); }
export function deliveryFact(input = {}) { return freezeDeep({ kind: 'delivery', ...metadata(input), state: bounded(input.state), attempted_at: input.attempted_at ?? new Date().toISOString() }); }

/** Find received/active facts without interpreting or executing them. */
export async function discoverRecoverableEvents(store, { limit = 100 } = {}) {
  if (!store) throw new TypeError('store is required');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be an integer between 1 and 1000');
  const discover = store.discoverRecoverableEvents ?? store.discoverUnprocessedEvents;
  if (typeof discover !== 'function') throw new TypeError('store.discoverRecoverableEvents is required');
  const events = await discover.call(store, { limit });
  return Array.isArray(events) ? events.map((event) => freezeDeep({ ...event })) : [];
}
