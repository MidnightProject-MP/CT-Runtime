import { createHash } from 'node:crypto';

export function normalizeEmailAddress(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(text)) throw new Error('email address is invalid');
  return text;
}

export function receiptId({ mailboxId, providerMessageId }) {
  if (!mailboxId || !providerMessageId) throw new Error('mailboxId and providerMessageId are required');
  return `email-${createHash('sha256').update(`${mailboxId}\n${providerMessageId}`).digest('hex').slice(0, 48)}`;
}

export function parseInboundMessage(message, { mailboxId, allowedSender } = {}) {
  if (!message || typeof message !== 'object') throw new Error('message is required');
  const id = String(message.id || message.messageId || '');
  const threadId = String(message.threadId || id);
  if (!id || !threadId) throw new Error('provider message identity is required');
  const from = normalizeEmailAddress(message.from);
  const to = normalizeEmailAddress(message.to);
  if (allowedSender && from !== normalizeEmailAddress(allowedSender)) throw new Error('sender is not allowed');
  const body = String(message.body || '').trim();
  if (!body || body.length > 16000) throw new Error('email body must contain 1..16000 characters');
  const subject = String(message.subject || '(no subject)').trim().slice(0, 500);
  return { receiptId: receiptId({ mailboxId, providerMessageId: id }), mailboxId, providerMessageId: id, providerThreadId: threadId, from, to, subject, body };
}

export function replySubject(subject) {
  const value = String(subject || '(no subject)').trim();
  return /^re:/i.test(value) ? value : `Re: ${value}`;
}
