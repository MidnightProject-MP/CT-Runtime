import { createHash } from 'node:crypto';

/** The adapter has no trustworthy author field until one is explicitly supplied. */
export const UNKNOWN_AUTHOR = Object.freeze({ kind: 'unknown' });

function digest(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function timestamp(value, name) {
  requiredText(value, name);
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${name} must be a canonical ISO timestamp`);
  }
  return value;
}

function freeze(value) {
  return Object.freeze(value);
}

function sourceId(sourceKey) {
  return `feedback-source_${digest(sourceKey)}`;
}

function messageId(source, messageKey) {
  return `feedback-message_${digest(`${source.id}\0${messageKey}`)}`;
}

function occurrenceId(message, revision) {
  return `feedback-revision_${digest(`${message.id}\0${revision}`)}`;
}

/**
 * Create the stable identity for one configured input source. `sourceKey` is
 * an adapter-owned, immutable key (not a sheet row number).
 */
export function createSourceIdentity(sourceKey) {
  sourceKey = requiredText(sourceKey, 'sourceKey');
  return freeze({ kind: 'feedback-source', key: sourceKey, id: sourceId(sourceKey) });
}

function authorValue(author) {
  if (author === undefined) return UNKNOWN_AUTHOR;
  if (!author || author.kind !== 'unknown' || Object.keys(author).length !== 1) {
    throw new TypeError('author must be { kind: "unknown" }');
  }
  return UNKNOWN_AUTHOR;
}

function makeOccurrence(message, revision, content, observedAt) {
  return freeze({
    id: occurrenceId(message, revision),
    revision,
    content: requiredText(content, 'content'),
    observedAt: timestamp(observedAt, 'observedAt'),
  });
}

/**
 * Create a message identity and its first immutable revision occurrence.
 * `messageKey` must come from a stable source record/event identity; content
 * is deliberately never used as identity.
 */
export function createFeedbackInput({ source, messageKey, content, observedAt, author } = {}) {
  if (!source || source.kind !== 'feedback-source' || source.id !== sourceId(source.key)) {
    throw new TypeError('source must be a valid source identity');
  }
  messageKey = requiredText(messageKey, 'messageKey');
  const message = freeze({
    kind: 'feedback-message',
    key: messageKey,
    id: messageId(source, messageKey),
    sourceId: source.id,
  });
  const input = {
    source,
    message,
    author: authorValue(author),
    firstObservedAt: timestamp(observedAt, 'observedAt'),
    revisions: freeze([makeOccurrence(message, 1, content, observedAt)]),
  };
  return validateFeedbackInput(freeze(input));
}

/** Append a new immutable revision without changing the prior input. */
export function appendRevision(input, { content, observedAt } = {}) {
  validateFeedbackInput(input);
  const revision = input.revisions.length + 1;
  const next = {
    ...input,
    revisions: freeze([...input.revisions, makeOccurrence(input.message, revision, content, observedAt)]),
  };
  return validateFeedbackInput(freeze(next));
}

/** Throw on malformed identity data; return the same value when valid. */
export function validateFeedbackInput(input) {
  if (!input || !Object.isFrozen(input) || !Object.isFrozen(input.source) || !Object.isFrozen(input.message)) {
    throw new TypeError('feedback input and identities must be immutable');
  }
  const { source, message } = input;
  if (source.kind !== 'feedback-source' || source.id !== sourceId(source.key)) throw new TypeError('invalid source identity');
  if (message.kind !== 'feedback-message' || message.sourceId !== source.id || message.id !== messageId(source, message.key)) {
    throw new TypeError('invalid message identity');
  }
  authorValue(input.author);
  timestamp(input.firstObservedAt, 'firstObservedAt');
  if (!Array.isArray(input.revisions) || !Object.isFrozen(input.revisions) || input.revisions.length < 1) throw new TypeError('at least one immutable revision is required');
  input.revisions.forEach((revision, index) => {
    if (!Object.isFrozen(revision) || revision.revision !== index + 1 || revision.id !== occurrenceId(message, revision.revision)) {
      throw new TypeError('revisions must be contiguous immutable occurrences');
    }
    requiredText(revision.content, 'revision content');
    timestamp(revision.observedAt, 'revision observedAt');
  });
  if (input.revisions[0].observedAt !== input.firstObservedAt) throw new TypeError('first observation timestamp must be preserved');
  return input;
}
