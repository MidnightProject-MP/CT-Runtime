import { createHash } from 'node:crypto';

export const UNKNOWN_AUTHOR = Object.freeze({ kind: 'unknown' });

const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
const text = (value, name) => {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  return value;
};
const freezeDeep = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
};

function authorOf(author) {
  if (author === undefined || author === null) return UNKNOWN_AUTHOR;
  if (typeof author === 'string') return Object.freeze({ kind: 'named', id: author });
  if (!author || typeof author !== 'object') throw new TypeError('author must be an object or string');
  return freezeDeep({ ...author });
}

function fields(input = {}) {
  const sourceId = input.source_id ?? input.sourceId ?? input.source?.id;
  const messageId = input.message_id ?? input.messageId ?? input.message?.id;
  const revision = input.revision ?? input.revision_number ?? input.revisionNumber ?? 1;
  const observedAt = input.observed_at ?? input.observedAt;
  const contentDigest = input.content_digest ?? input.contentDigest ?? (input.content === undefined ? undefined : digest(input.content));
  text(sourceId, 'source_id'); text(messageId, 'message_id'); text(observedAt, 'observed_at');
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('revision must be a positive integer');
  text(contentDigest, 'content_digest');
  return { source_id: sourceId, message_id: messageId, revision, observed_at: observedAt, author: authorOf(input.author), content_digest: contentDigest };
}

/** Stable occurrence identity; it deliberately excludes row position and content. */
export function canonicalInputIdentity(input) {
  const fact = fields(input);
  return `human-input:${encodeURIComponent(fact.source_id)}:${encodeURIComponent(fact.message_id)}:revision-${fact.revision}`;
}

/** Return the immutable, redacted fact for one observed human-input occurrence. */
export function revisionOccurrence(input) {
  const fact = fields(input);
  return freezeDeep({ ...fact, identity: canonicalInputIdentity(fact) });
}
