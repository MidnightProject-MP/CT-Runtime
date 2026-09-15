import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const legacyPath = new URL('../gas/gas_feedback.js', import.meta.url);
const vnextPaths = [
  '../gas/gas_feedback_vnext.js',
  '../gas/gas_feedback_vnext_transport.js',
  '../gas/gas_feedback_vnext_projection.js',
];
const FORBIDDEN_LEGACY = [
  'CT_GAS_STATE.create',
  'CT_GAS_STATE.list',
  'requestNextWake',
  'feedback-work-order',
  'feedback-execution',
  'feedback-continuation',
  'findOrder',
  'resolveOrder',
  'function admission',
];

test('legacy Feedback orchestration is retired while vNext adapters remain', async () => {
  await assert.rejects(() => readFile(legacyPath, 'utf8'), { code: 'ENOENT' });
  for (const path of vnextPaths) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    for (const token of FORBIDDEN_LEGACY) assert.equal(source.includes(token), false, `${path} must not contain ${token}`);
  }
});

test('vNext Feedback adapters stop at evidence, judgment, and projection', async () => {
  const receipt = await readFile(new URL('../gas/gas_feedback_vnext.js', import.meta.url), 'utf8');
  const transport = await readFile(new URL('../gas/gas_feedback_vnext_transport.js', import.meta.url), 'utf8');
  const projection = await readFile(new URL('../gas/gas_feedback_vnext_projection.js', import.meta.url), 'utf8');

  assert.match(receipt, /external_input\.received/);
  assert.match(transport, /CT_GAS_FEEDBACK_VNEXT\.ingest/);
  assert.match(projection, /feedback-projection:/);
  assert.match(projection, /CT_FEEDBACK_PROJECTION_ID/);

  for (const [name, source] of [['receipt', receipt], ['transport', transport], ['projection', projection]]) {
    assert.doesNotMatch(source, /work_orders|executions|continuations|requestNextWake|CT_GAS_STATE\.create|CT_GAS_STATE\.update|CT_GAS_STATE\.schedule/, `${name} must not control the execution graph`);
  }
});
