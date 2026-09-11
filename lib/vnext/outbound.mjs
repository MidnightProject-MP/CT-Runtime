import { createHash } from 'node:crypto';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bound = (value) => typeof value === 'string' ? value.slice(0, 500) : value;
const safe = (value = {}) => Object.fromEntries(Object.entries(value).filter(([key, item]) =>
  /^(source_id|message_id|revision|event_id|execution_id|outbound_id|kind|type|status|attempt)$/.test(key) && (typeof item === 'string' || Number.isSafeInteger(item))
).map(([key, item]) => [key, bound(item)]));

export function outboundId({ source_id, message_id, revision, execution_id, kind = 'message' } = {}) {
  if (!source_id || !message_id || !Number.isSafeInteger(revision) || revision < 1) throw new TypeError('stable outbound identity fields are required');
  return `outbound-${hash({ source_id, message_id, revision, execution_id: execution_id ?? null, kind }).slice(0, 32)}`;
}

export async function deliverOutbound({ store, delivery, input, metadata = {} } = {}) {
  if (!store || typeof store.persistOutbound !== 'function') throw new TypeError('store.persistOutbound is required');
  if (typeof delivery !== 'function') throw new TypeError('delivery is required');
  const facts = safe({ ...input, ...metadata });
  const id = input?.outbound_id ?? outboundId(input);
  const record = { ...facts, outbound_id: id, status: 'pending', attempt: (input?.attempt ?? 0) + 1 };
  await store.persistOutbound(record); // durable intent precedes the external effect
  const result = await delivery(Object.freeze({ ...record }));
  if (typeof store.readbackOutbound === 'function') return reconcileOutbound({ store, outbound_id: id, result });
  if (typeof store.markOutboundDelivered === 'function') await store.markOutboundDelivered({ outbound_id: id, result: safe(result) });
  return { outbound_id: id, status: 'delivered', result: safe(result) };
}

export async function reconcileOutbound({ store, outbound_id, result } = {}) {
  if (!store || typeof store.readbackOutbound !== 'function') throw new TypeError('store.readbackOutbound is required');
  const existing = await store.readbackOutbound({ outbound_id });
  if (existing?.status === 'delivered' || existing?.delivered === true) return existing;
  if (result !== undefined && typeof store.markOutboundDelivered === 'function') {
    await store.markOutboundDelivered({ outbound_id, result: safe(result) });
    return { outbound_id, status: 'delivered', result: safe(result) };
  }
  return existing ?? { outbound_id, status: 'pending' };
}

export async function retryOutbound({ store, delivery, outbound_id, metadata = {} } = {}) {
  if (!store || typeof store.readbackOutbound !== 'function') throw new TypeError('store.readbackOutbound is required');
  const existing = await store.readbackOutbound({ outbound_id });
  if (existing?.status === 'delivered' || existing?.delivered === true) return existing;
  if (!existing) throw new Error(`unknown outbound: ${outbound_id}`);
  return deliverOutbound({ store, delivery, input: { ...existing, outbound_id }, metadata });
}
