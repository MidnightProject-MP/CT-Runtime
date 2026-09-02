import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/runtime.mjs';
import { exportExecution, backfillEvidence } from '../lib/evidence-pipeline.mjs';
import { validateExecutionEvidence } from '../lib/execution-evidence.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-evidence-'));
  const store = new Store(root);
  await store.createManifest({ executionId: 'exec-1', project: 'demo', task: 'bounded', model: 'model', agent: 'agent', wake_reason: 'user' });
  await store.updateManifest('exec-1', { execution: { status: 'success', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z' }, result: { summary: 'completed' } });
  await store.evidence('exec-1', 'stdout', 'safe output');
  return { root, store };
}

test('normal export writes a hashed Observer inbox package and is idempotent', async () => {
  const { root, store } = await fixture();
  const first = await exportExecution({ store, executionId: 'exec-1' });
  const second = await exportExecution({ store, executionId: 'exec-1' });
  assert.equal(second.sha256, first.sha256);
  const packagePath = path.join(root, 'observer', 'inbox', `${encodeURIComponent('execution-exec-1')}-${first.sha256}.json`);
  const value = JSON.parse(await readFile(packagePath, 'utf8'));
  assert.equal(validateExecutionEvidence(value).contentHash, first.sha256);
  assert.equal(value.summary, 'completed');
});

test('backfill exports every local manifest without semantic observation', async () => {
  const { store } = await fixture();
  const result = await backfillEvidence({ store });
  assert.equal(result.exported, 1);
  assert.equal(result.results[0].status, 'exported');
});
