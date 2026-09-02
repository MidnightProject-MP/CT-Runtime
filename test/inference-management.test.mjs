import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, invoke } from '../lib/runtime.mjs';
import { aggregateOperationalCatalog, createInferenceRecord, getInferenceAdapter, INFERENCE_FAILURE_CLASSES, mapFailureToFoundry, normalizeInferenceFailure, parseProviderModelReference, stageBShadowRecommendation } from '../lib/inference-management.mjs';

const at = '2026-08-31T10:00:00.000Z';
const record = (reference, purpose, outcome = 'success', extra = {}) => createInferenceRecord({ workOrder: 'work-identity', executionId: extra.executionId || 'run-identity', agent: 'luna', role: 'implementation-worker', taskPurpose: purpose, modelReference: reference, attempt: 1, maxRetries: 0, startedAt: at, finishedAt: '2026-08-31T10:00:01.000Z', failure: outcome === 'failure' ? (extra.failure || 'unknown') : null, cost: extra.cost, quota: extra.quota });

test('failure taxonomy is exact, mapped to Foundry, and terminal account/request/context failures do not retry', () => {
  assert.deepEqual(INFERENCE_FAILURE_CLASSES, ['rate_limited', 'quota_exhausted', 'insufficient_balance', 'model_unavailable', 'provider_unavailable', 'context_exceeded', 'malformed_or_invalid_request', 'transient_provider_error', 'model/output_failure', 'unknown']);
  const cases = [
    ['quota exceeded', 'quota_exhausted', 'provider-limit'],
    ['insufficient balance', 'insufficient_balance', 'authentication-account-billing'],
    ['invalid request', 'malformed_or_invalid_request', 'protocol-schema-tool-call'],
    ['maximum context length exceeded', 'context_exceeded', 'context-pressure']
  ];
  for (const [message, expected, foundry] of cases) { const failure = normalizeInferenceFailure(new Error(message)); assert.equal(failure.class, expected); assert.equal(failure.retryable, false); assert.equal(mapFailureToFoundry(expected), foundry); }
  assert.equal(normalizeInferenceFailure(new Error('429 rate limited')).retryable, true);
});

test('provider/model parsing and adapters do not assume OpenRouter or invoke local Ollama', () => {
  assert.deepEqual(parseProviderModelReference('vertex/google/gemini'), { transport: 'opencode', provider: 'vertex', model: 'google/gemini', reference: 'vertex/google/gemini', providerExplicit: true });
  assert.equal(parseProviderModelReference('local-model').provider, 'unspecified');
  assert.equal(getInferenceAdapter('opencode').invocationEnabled, true);
  assert.equal(getInferenceAdapter('ollama-local-candidate').invocationEnabled, false);
  assert.equal(getInferenceAdapter('ollama-local-candidate').candidate.availability, 'unverified');
});

test('catalog keeps sample uncertainty and task evidence; Stage B remains shadow-only', () => {
  const observed = [
    record('provider/current', 'implementation'),
    record('provider/cheap', 'implementation', 'success', { cost: { availability: 'available', amount: 0.1, currency: 'usd' }, quota: { availability: 'available', remaining: 90, limit: 100 } }),
    record('provider/cheap', 'implementation', 'success', { executionId: 'run-2', cost: { availability: 'available', amount: 0.1, currency: 'usd' }, quota: { availability: 'available', remaining: 90, limit: 100 } })
  ];
  const catalog = aggregateOperationalCatalog({ staticFacts: [{ reference: 'provider/current', availability: 'configured', scarcity: 'unknown', source: 'runtime' }], observedRecords: observed });
  const cheap = catalog.find((item) => item.route.reference === 'provider/cheap');
  assert.equal(cheap.sampleSize, 2); assert.equal(cheap.taskEvidence.implementation.sampleSize, 2); assert.equal(cheap.uncertainty, 'high'); assert.equal(cheap.measuredCost.sampleSize, 2);
  const shadow = stageBShadowRecommendation({ establishedReference: 'provider/current', taskPurpose: 'implementation', catalog });
  assert.equal(shadow.shadow, true); assert.equal(shadow.stage, 'B'); assert.equal(shadow.executionRoute.reference, 'provider/current'); assert.equal(shadow.recommendedRoute.reference, 'provider/cheap'); assert.equal(shadow.changed, true);
});

test('shadow ranking respects static scarcity after task-specific sufficiency', () => {
  const observed = ['provider/scarce', 'provider/scarce', 'provider/abundant', 'provider/abundant'].map((reference, index) => record(reference, 'review', 'success', { executionId: `run-${index}` }));
  const catalog = aggregateOperationalCatalog({ staticFacts: [{ reference: 'provider/current', scarcity: 'high' }, { reference: 'provider/scarce', scarcity: 'scarce', cost: { availability: 'available', amount: 0 } }, { reference: 'provider/abundant', scarcity: 'abundant', cost: { availability: 'available', amount: 1 } }], observedRecords: observed });
  const shadow = stageBShadowRecommendation({ establishedReference: 'provider/current', taskPurpose: 'review', catalog });
  assert.equal(shadow.executionRoute.reference, 'provider/current'); assert.equal(shadow.recommendedRoute.reference, 'provider/abundant');
});

test('every process attempt persists safe normalized telemetry with logical identity continuity', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-inference-')));
  await store.createManifest({ executionId: 'run-identity', workOrder: 'work-identity', project: 'demo', task: 'bounded implementation', model: 'provider/model', agent: 'luna' });
  const secret = 'never-persist-this-secret';
  const script = "process.stderr.write(process.env.PRIVATE_TOKEN); process.exitCode=1";
  const result = await invoke({ store, executionId: 'run-identity', command: process.execPath, commandArgs: ['-e', script], model: 'provider/model', agent: 'luna', task: `bounded implementation ${secret}`, env: { PRIVATE_TOKEN: secret }, secretNames: ['PRIVATE_TOKEN'], maxRetries: 0 });
  assert.equal(result.status, 'failed');
  const records = await store.inferenceRecords({ executionId: 'run-identity' });
  assert.equal(records.length, 1); assert.equal(records[0].logical.workOrder, 'work-identity'); assert.equal(records[0].logical.executionId, 'run-identity'); assert.equal(records[0].identity.agent, 'luna'); assert.equal(records[0].retry.attempt, 1); assert.equal(records[0].route.reference, 'provider/model');
  const raw = await readFile(path.join(store.root, 'inference.ndjson'), 'utf8');
  assert.equal(raw.includes(secret), false); assert.equal(raw.includes('process.stderr'), false);
});

test('missing model handoff is a nonretryable normalized output failure', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-inference-output-')));
  await store.createManifest({ executionId: 'run-output', workOrder: 'work-output', project: 'demo', task: 'return contract', model: 'provider/model', agent: 'luna' });
  const result = await invoke({ store, executionId: 'run-output', command: process.execPath, commandArgs: ['-e', 'process.exitCode=0'], maxRetries: 2 });
  assert.equal(result.status, 'failed'); assert.equal(result.attempts, 1);
  const records = await store.inferenceRecords({ executionId: 'run-output' });
  assert.equal(records.length, 1); assert.equal(records[0].failure.class, 'model/output_failure'); assert.equal(records[0].failure.retryable, false); assert.equal(records[0].failure.foundryCategory, 'model-output-quality');
});
