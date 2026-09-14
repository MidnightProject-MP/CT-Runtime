function normalize(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('event payload contains non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
}

export function canonicalEvent(event) {
  if (!event || typeof event.type !== 'string' || !event.type) throw new Error('event.type is required');
  if (typeof event.event_id !== 'string' || !event.event_id) throw new Error('event.event_id is required');
  return JSON.stringify(normalize(event));
}

export function eventsEquivalent(a, b) {
  return canonicalEvent(a) === canonicalEvent(b);
}

export function eventIntegrityConflict(event, existing) {
  const error = new Error(`event integrity conflict for event_id ${event.event_id}`);
  error.code = 'EVENT_INTEGRITY_CONFLICT';
  error.event_id = event.event_id;
  error.existing = existing;
  error.incoming = event;
  return error;
}
