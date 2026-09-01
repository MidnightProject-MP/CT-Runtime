import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { S3EvidenceStore } from '../lib/s3-evidence.mjs';

// TEST_S3_* is CI's explicit path. Runtime bindings require a separate conformance opt-in.
const settingsPrefix = process.env.TEST_S3_ENDPOINT ? 'TEST_S3' : process.env.CT_RUNTIME_S3_CONFORMANCE === 'true' ? 'CT_RUNTIME_S3' : undefined;
const setting = (name) => settingsPrefix && process.env[`${settingsPrefix}_${name}`];
const endpoint = setting('ENDPOINT');

function missing() { const error = new Error('missing'); error.name = 'NoSuchKey'; error.$metadata = { httpStatusCode: 404 }; return error; }

function memoryClient() {
  const calls = [];
  const objects = new Map();
  return {
    calls,
    objects,
    async send(command) {
      const name = command.constructor.name;
      calls.push({ name, input: command.input });
      if (name === 'GetObjectCommand') {
        const object = objects.get(command.input.Key);
        if (!object) throw missing();
        return { Body: object.Body, ContentLength: object.Body.length, ContentType: object.ContentType, Metadata: object.Metadata };
      }
      if (name === 'PutObjectCommand') {
        if (command.input.IfNoneMatch === '*' && objects.has(command.input.Key)) {
          const error = new Error('conditional request failed'); error.name = 'PreconditionFailed'; error.$metadata = { httpStatusCode: 412 }; throw error;
        }
        objects.set(command.input.Key, command.input); return {};
      }
      if (name === 'ListObjectsV2Command') return { Contents: [...objects.entries()].map(([Key, value]) => ({ Key, Size: value.Body.length })) };
      if (name === 'HeadObjectCommand') {
        const object = objects.get(command.input.Key);
        if (!object) throw missing();
        return { ContentLength: object.Body.length, ContentType: object.ContentType, Metadata: object.Metadata };
      }
      return {};
    }
  };
}

test('S3 put prefers atomic conditional PUT and verifies supported writes', async () => {
  const client = memoryClient();
  const store = new S3EvidenceStore({ bucket: 'bucket', client });
  const input = { project: 'p', executionId: 'e', attempt: 1, label: 'stdout', content: 'test' };
  const first = await store.put(input);
  assert.deepEqual(client.calls.map(({ name }) => name), ['PutObjectCommand', 'GetObjectCommand']);
  assert.equal(client.calls[0].input.IfNoneMatch, '*');
  assert.equal(client.calls[0].input.ChecksumSHA256, undefined);
  assert.equal(client.calls[1].input.Range, 'bytes=0-4');
  assert.equal(client.calls[1].input.ChecksumMode, undefined);

  const second = await store.put(input);
  assert.equal(second.objectKey, first.objectKey);
  assert.deepEqual(client.calls.map(({ name }) => name), ['PutObjectCommand', 'GetObjectCommand', 'PutObjectCommand', 'GetObjectCommand']);
});

test('S3 conditional conflict verifies the existing deterministic object', async () => {
  const client = memoryClient();
  const store = new S3EvidenceStore({ bucket: 'bucket', client });
  const input = { project: 'p', executionId: 'e', attempt: 1, label: 'stdout', content: 'test' };
  const first = await store.put(input);
  client.calls.length = 0;
  const second = await store.put(input);
  assert.equal(second.objectKey, first.objectKey);
  assert.deepEqual(client.calls.map(({ name }) => name), ['PutObjectCommand', 'GetObjectCommand']);
});

test('explicit unsupported conditional header falls back only after rechecking the key', async () => {
  const client = memoryClient();
  const send = client.send.bind(client);
  let rejected = false;
  client.send = async (command) => {
    if (command.constructor.name === 'PutObjectCommand' && command.input.IfNoneMatch === '*') {
      client.calls.push({ name: 'PutObjectCommand', input: command.input });
      rejected = true;
      const error = new Error('If-None-Match header is not implemented'); error.name = 'NotImplemented'; error.$metadata = { httpStatusCode: 501 }; throw error;
    }
    assert.ok(rejected, 'fallback must follow the rejected conditional request');
    return send(command);
  };
  const store = new S3EvidenceStore({ bucket: 'bucket', client });
  await store.put({ project: 'p', executionId: 'e', attempt: 1, label: 'stdout', content: 'test' });
  assert.deepEqual(client.calls.map(({ name }) => name), ['PutObjectCommand', 'GetObjectCommand', 'PutObjectCommand', 'GetObjectCommand']);
  assert.equal(client.calls[2].input.IfNoneMatch, undefined);
});

test('unsupported conditional fallback does not overwrite a conflict observed by its recheck', async () => {
  let putCalls = 0;
  const client = { async send(command) {
    if (command.constructor.name === 'PutObjectCommand') {
      putCalls += 1;
      const error = new Error('unsupported conditional header'); error.name = 'InvalidRequest'; error.$metadata = { httpStatusCode: 400 }; throw error;
    }
    return { Body: Buffer.from('evil'), ContentLength: 4, ContentType: 'text/plain', Metadata: {} };
  } };
  const store = new S3EvidenceStore({ bucket: 'bucket', client });
  await assert.rejects(() => store.put({ project: 'p', executionId: 'e', attempt: 1, label: 'stdout', content: 'test' }), (error) => error.code === 'S3EvidenceConflict');
  assert.equal(putCalls, 1);
});

test('S3 verification converts 416 into an evidence conflict', async () => {
  const client = { async send(command) {
    if (command.constructor.name === 'PutObjectCommand') return {};
    const error = new Error('range not satisfiable'); error.name = 'RangeNotSatisfiable'; error.$metadata = { httpStatusCode: 416 }; throw error;
  } };
  const store = new S3EvidenceStore({ bucket: 'bucket', client });
  await assert.rejects(() => store.put({ project: 'p', executionId: 'e', attempt: 1, label: 'stdout', content: 'test' }), (error) => error.code === 'S3EvidenceConflict');
});

test('S3 verification destroys an unconsumed body on an early length mismatch', async () => {
  let destroyed = false;
  const body = { destroy() { destroyed = true; }, async *[Symbol.asyncIterator]() { yield Buffer.from('test'); } };
  const client = { async send(command) { return command.constructor.name === 'PutObjectCommand' ? {} : { Body: body, ContentLength: 5 }; } };
  const store = new S3EvidenceStore({ bucket: 'bucket', client });
  await assert.rejects(() => store.put({ project: 'p', executionId: 'e', attempt: 1, label: 'stdout', content: 'test' }), (error) => error.code === 'S3EvidenceConflict');
  assert.equal(destroyed, true);
});

test('internally created S3 client requests checksum middleware only when required', async (t) => {
  const store = new S3EvidenceStore({ bucket: 'bucket' });
  t.after(() => store.client.destroy());
  assert.equal(await store.client.config.requestChecksumCalculation(), 'WHEN_REQUIRED');
  assert.equal(await store.client.config.responseChecksumValidation(), 'WHEN_REQUIRED');
});

test('S3 put rejects conflicting existing content without overwriting it', async () => {
  const client = memoryClient();
  const store = new S3EvidenceStore({ bucket: 'bucket', client });
  const input = { project: 'p', executionId: 'e', attempt: 1, label: 'stdout', content: 'test' };
  const result = await store.put(input);
  const existing = client.objects.get(result.objectKey);
  existing.Body = Buffer.from('evil');
  client.calls.length = 0;

  await assert.rejects(() => store.put(input), /S3 evidence conflict/);
  assert.deepEqual(client.calls.map(({ name }) => name), ['PutObjectCommand', 'GetObjectCommand']);
  assert.equal(client.objects.get(result.objectKey).Body.toString(), 'evil');
});

test('S3 list uses plain HEAD for metadata', async () => {
  const client = memoryClient();
  const store = new S3EvidenceStore({ bucket: 'bucket', client });
  await store.put({ project: 'p', executionId: 'e', attempt: 1, label: 'stdout', content: 'test' });
  client.calls.length = 0;

  const listed = await store.list();
  assert.equal(listed.candidates.length, 1);
  assert.deepEqual(client.calls.map(({ name }) => name), ['ListObjectsV2Command', 'HeadObjectCommand']);
  assert.equal(client.calls[1].input.ChecksumMode, undefined);
});

test('S3 ambiguous PUT failure can be established by verified readback', async () => {
  const client = memoryClient();
  const send = client.send.bind(client);
  client.send = async (command) => {
    if (command.constructor.name !== 'PutObjectCommand') return send(command);
    await send(command);
    const error = new Error('connection closed');
    error.code = 'ECONNRESET';
    throw error;
  };
  const store = new S3EvidenceStore({ bucket: 'bucket', client });

  const result = await store.put({ project: 'p', executionId: 'e', attempt: 1, label: 'stdout', content: 'test' });
  assert.equal(result.bytes, 4);
  assert.deepEqual(client.calls.map(({ name }) => name), ['PutObjectCommand', 'GetObjectCommand']);
});

test('S3 ambiguous PUT preserves the original failure when readback is missing', async () => {
  const putError = Object.assign(new Error('connection closed'), { code: 'ECONNRESET' });
  const client = {
    async send(command) {
      if (command.constructor.name === 'PutObjectCommand') throw putError;
      throw missing();
    }
  };
  const store = new S3EvidenceStore({ bucket: 'bucket', client });
  await assert.rejects(
    () => store.put({ project: 'p', executionId: 'e', attempt: 1, label: 'stdout', content: 'test' }),
    (error) => error === putError
  );
});

test('S3 ambiguous PUT reports a verified readback mismatch as a conflict', async () => {
  let put;
  const client = {
    async send(command) {
      if (command.constructor.name === 'GetObjectCommand') {
        return { Body: Buffer.from('evil'), ContentLength: 4, ContentType: put.ContentType, Metadata: put.Metadata };
      }
      put = command.input;
      throw Object.assign(new Error('connection closed'), { code: 'ECONNRESET' });
    }
  };
  const store = new S3EvidenceStore({ bucket: 'bucket', client });
  await assert.rejects(
    () => store.put({ project: 'p', executionId: 'e', attempt: 1, label: 'stdout', content: 'test' }),
    (error) => error.code === 'S3EvidenceConflict'
  );
});

test('S3-compatible evidence enforces metadata, retention, idempotency, body verification, and listing', { skip: !endpoint, timeout: 30000 }, async () => {
  const namespace = `integration-${crypto.randomUUID()}`;
  const store = new S3EvidenceStore({
    endpoint,
    region: setting('REGION') || 'us-east-1',
    bucket: setting('BUCKET'),
    namespace,
    forcePathStyle: setting('PATH_STYLE') === 'true',
    accessKeyId: setting('ACCESS_KEY_ID'),
    secretAccessKey: setting('SECRET_ACCESS_KEY')
  });
  let operationError;
  let putAttempted = false;
  try {
    await store.reachable();
    putAttempted = true;
    const value = await store.put({ project: 'integration', executionId: 's3', attempt: 1, label: 'stdout', content: 'real-s3-integration' });
    assert.equal(value.bytes, Buffer.byteLength('real-s3-integration'));
    assert.match(value.objectUri, /^s3:\/\//);
    assert.equal(value.metadata['retention-policy-version'], '1');
    assert.equal((await store.put({ project: 'integration', executionId: 's3', attempt: 1, label: 'stdout', content: 'real-s3-integration' })).objectKey, value.objectKey);
    await assert.rejects(() => store.put({ project: 'integration', executionId: 's3', attempt: 1, label: 'stdout', content: 'x', retentionClass: 'legal-hold' }), /retentionClass/);
    await assert.rejects(() => store.put({ project: 'integration', executionId: 's3', attempt: 1, label: 'stdout', content: 'x', metadata: { sha256: 'override' } }), /protected/);
    const listed = await store.list();
    const candidate = listed.candidates.find((item) => item.objectKey === value.objectKey);
    assert.equal(candidate.bytes, String(value.bytes));
    assert.equal(candidate.sha256, value.sha256);
    const reconciliation = await store.reconcileOrphans([{ objectKey: value.objectKey, bytes: String(value.bytes), sha256: value.sha256 }], { objects: listed });
    assert.equal(reconciliation.referenced.length, 1);
    assert.deepEqual(reconciliation.destructiveActions, []);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (putAttempted) {
      try {
        const listed = await store.list({ prefix: `${namespace}/`, includeMetadata: false });
        await Promise.all(listed.candidates.map(({ objectKey }) => store.client.send(new DeleteObjectCommand({ Bucket: store.bucket, Key: objectKey }))));
      } catch (cleanupError) {
        if (!operationError) throw cleanupError;
      }
    }
  }
});
