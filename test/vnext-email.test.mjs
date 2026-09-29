import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmailAddress, parseInboundMessage, receiptId, replySubject } from '../lib/vnext/email-message.mjs';
import { createGmailTransport } from '../lib/vnext/gmail-transport.mjs';

test('email identity is deterministic and normalized', () => {
  assert.equal(normalizeEmailAddress(' A@Example.COM '), 'a@example.com');
  assert.equal(receiptId({ mailboxId: 'main', providerMessageId: 'm1' }), receiptId({ mailboxId: 'main', providerMessageId: 'm1' }));
  assert.throws(() => normalizeEmailAddress('bad'));
});

test('inbound parsing enforces sender and bounded body', () => {
  const value = parseInboundMessage({ id: 'm1', threadId: 't1', from: 'A@example.com', to: 'bot@example.com', subject: 'Hello', body: ' Work ' }, { mailboxId: 'main', allowedSender: 'a@example.com' });
  assert.equal(value.body, 'Work'); assert.equal(value.providerThreadId, 't1');
  assert.throws(() => parseInboundMessage({ id: 'm2', from: 'other@example.com', to: 'bot@example.com', body: 'x' }, { mailboxId: 'main', allowedSender: 'a@example.com' }));
});

test('reply subject and transport authenticate through existing federation secret', async () => {
  assert.equal(replySubject('Re: Hello'), 'Re: Hello');
  let request;
  const transport = createGmailTransport({ url: 'https://example.test/exec', secret: 'secret', fetch: async (url, options) => { request = { url, options }; return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok' }) }; } });
  await transport('email-poll', { label: 'CT-Runtime' });
  assert.equal(request.options.method, 'POST'); assert.match(request.url.search, /timestamp=/); assert.match(request.url.search, /signature=/);
});
