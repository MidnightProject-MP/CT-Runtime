import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { S3EvidenceStore } from '../lib/s3-evidence.mjs';

const endpoint = process.env.TEST_S3_ENDPOINT;

test('S3-compatible evidence enforces metadata, retention, idempotency, checksum, and listing', { skip: !endpoint, timeout: 30000 }, async () => {
  const store = new S3EvidenceStore({
    endpoint,
    region: process.env.TEST_S3_REGION || 'us-east-1',
    bucket: process.env.TEST_S3_BUCKET,
    namespace: `integration-${crypto.randomUUID()}`,
    forcePathStyle: process.env.TEST_S3_PATH_STYLE === 'true',
    accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY
  });
  await store.reachable();
  const value = await store.put({ project: 'integration', executionId: 's3', attempt: 1, label: 'stdout', content: 'real-s3-integration' });
  try {
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
  } finally {
    await store.client.send(new DeleteObjectCommand({ Bucket: store.bucket, Key: value.objectKey }));
  }
});
