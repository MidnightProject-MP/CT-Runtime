import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, loadConfig, sha256 } from '../lib/config.mjs';
import { buildChildEnv, invoke } from '../lib/runtime.mjs';
import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/runtime.mjs';
import { S3EvidenceStore } from '../lib/s3-evidence.mjs';
import { hostTelemetry, unavailableHostTelemetry } from '../lib/host-telemetry.mjs';

test('canonical identity is stable independent of object key order', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.equal(sha256({ b: 2, a: 1 }), sha256({ a: 1, b: 2 }));
});

test('production configuration fails closed and filesystem mode stays explicit', () => {
  assert.throws(() => loadConfig({ CT_RUNTIME_MODE: 'production' }), /DATABASE_URL/);
  assert.equal(loadConfig({ CT_RUNTIME_MODE: 'filesystem' }).mode, 'filesystem');
});

test('S3 evidence is capped, content addressed, and verifies protected object fields', async () => {
  const calls = [];
  let put;
  const client = { send: async (command) => {
    calls.push(command.input);
    if (command.constructor.name === 'GetObjectCommand') {
      if (!put) { const error = new Error('missing'); error.name = 'NoSuchKey'; throw error; }
      return { Body: put.Body, ContentLength: put.Body.length, ContentType: put.ContentType, Metadata: put.Metadata };
    }
    put = command.input;
    return {};
  } };
  const evidence = new S3EvidenceStore({ bucket: 'bucket', client });
  const result = await evidence.put({ project: 'p', executionId: 'e', attempt: 1, label: 'stdout', content: Buffer.alloc(64 * 1024 + 1, 'x') });
  assert.equal(result.bytes, 64 * 1024); assert.equal(result.truncated, true); assert.match(result.objectKey, /stdout-/); assert.equal(calls.length, 2);
  assert.equal(put.IfNoneMatch, '*');
  assert.equal(put.Metadata['retention-policy-version'], '1');
  await assert.rejects(() => evidence.put({ project: 'p', executionId: 'e', attempt: 1, label: 'stdout', content: 'test', metadata: { task: 'secret-bearing text' } }), /metadata is not accepted/);
});

test('host telemetry is separate and cost defaults unavailable', () => {
  assert.equal(unavailableHostTelemetry().availability, 'unavailable');
  assert.equal(hostTelemetry().cost.availability, 'unavailable');
  assert.equal(hostTelemetry().schema, 'celestan-runtime-host-telemetry-v1');
});

test('child environment excludes infrastructure secrets and handoff is ephemeral', async () => {
  assert.equal(buildChildEnv({ SAFE_FLAG: 'yes', CT_SECRET: 'secret' }, ['CT_SECRET']).SAFE_FLAG, 'yes');
  assert.throws(() => buildChildEnv({ DATABASE_URL: 'postgres://secret' }), /denied/);
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-')));
  await store.createManifest({ executionId: 'ephemeral', project: 'p', task: 't', model: 'm', agent: 'a' });
  const result = await invoke({ store, executionId: 'ephemeral', command: process.execPath, commandArgs: ['-e', "require('fs').writeFileSync(process.env.CT_RUNTIME_RESULT_FILE, JSON.stringify({status:'complete',summary:'ok',requested_next_wake:null}))"], maxRetries: 0 });
  assert.equal(result.status, 'success');
  assert.equal((await readdir(store.results)).length, 0);
});
