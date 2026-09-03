import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, invoke } from '../lib/runtime.mjs';
import { aggregateOperationalCatalog, applyRoutingPolicySignals, createInferenceRecord, getInferenceAdapter, INFERENCE_FAILURE_CLASSES, lookupRoutingPolicy, mapFailureToFoundry, normalizeFutureRoutingSignal, normalizeInferenceFailure, parseProviderModelReference, stageBShadowRecommendation } from '../lib/inference-management.mjs';

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

const routingContext = { model: 'provider/model-a', role: 'implementation-worker', taskClass: 'implementation', project: 'demo' };
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
const routingSignal = (overrides = {}) => {
  const signal = {
    schema: 'celestan-future-routing-signal-v1', status: 'active',
    subject: { model: 'provider/model-a', role: 'implementation-worker', taskClass: 'implementation' }, direction: 'negative', proposedEffect: 'lower-preference',
    scopeLimit: { globalDemotion: false, unrelatedWorkUnassessed: true, boundedWorkerUsePermitted: true }, reviewId: 'review-a', consolidationId: 'consolidation-a', findingId: 'finding-a', candidateIds: ['candidate-a'], observationIds: ['observation-a'], observationEvidenceHashes: ['a'.repeat(64)], evidenceIds: ['evidence-a'], envelopeIds: ['envelope-a'], citedClaimIds: ['claim-a'], supersedesSignalIds: [], supersessionMode: 'replace', acceptedAt: '2026-08-31T10:00:00.000Z', ...overrides
  };
  const body = { ...signal }; delete body.signalId; delete body.contentHash;
  if (signal.contentHash === undefined) signal.contentHash = createHash('sha256').update(stable(body)).digest('hex');
  if (signal.signalId === undefined) signal.signalId = `rps_${signal.contentHash.slice(0, 32)}`;
  return normalizeFutureRoutingSignal(signal);
};

test('future routing lookup requires exact model, role, task class, and optional project scope', () => {
  const signal = routingSignal();
  assert.equal(lookupRoutingPolicy({ signals: [signal], context: routingContext }).length, 1);
  for (const change of [{ model: 'provider/model-b' }, { role: 'review-worker' }, { taskClass: 'review' }]) {
    assert.deepEqual(lookupRoutingPolicy({ signals: [signal], context: { ...routingContext, ...change } }), []);
  }
  assert.equal(lookupRoutingPolicy({ signals: [signal], context: { ...routingContext, project: 'other' } }).length, 1);
  assert.equal(lookupRoutingPolicy({ signals: [routingSignal({ scopeLimit: { globalDemotion: false, unrelatedWorkUnassessed: true, boundedWorkerUsePermitted: true, project: 'demo' } })], context: { ...routingContext, project: 'demo' } }).length, 1);
  assert.equal(lookupRoutingPolicy({ signals: [signal], context: undefined }).length, 0);
});

test('future routing signals demote without filtering, preserve a sole route, and restore baseline only by supersession', () => {
  const routes = [{ model: 'provider/model-a', label: 'a' }, { model: 'provider/model-b', label: 'b' }];
  const negative = routingSignal();
  const demoted = applyRoutingPolicySignals({ routes, signals: [negative], context: routingContext });
  assert.deepEqual(demoted.map((route) => route.model), ['provider/model-b', 'provider/model-a']);
  assert.match(demoted[1].advisoryReason, /lower-preference/);
  assert.deepEqual(applyRoutingPolicySignals({ routes: [routes[0]], signals: [negative], context: routingContext }), [{ ...routes[0], advisoryReason: 'advisory: Foundry future-routing signal lower-preference' }]);
  const restored = routingSignal({ direction: 'positive', proposedEffect: 'restore-default', supersessionMode: 'restore', supersedesSignalIds: [negative.signalId] });
  assert.deepEqual(applyRoutingPolicySignals({ routes, signals: [negative, restored], context: routingContext }), routes);
});

test('future routing uses provider-qualified identity and narrow project restoration', () => {
  const routes = [{ reference: 'provider/model-a', model: 'model-a' }, { reference: 'other/model-a', model: 'model-a' }];
  const negative = routingSignal();
  const restore = routingSignal({ direction: 'positive', proposedEffect: 'restore-default', supersessionMode: 'narrow', scopeLimit: { globalDemotion: false, unrelatedWorkUnassessed: true, boundedWorkerUsePermitted: true, project: 'demo' }, supersedesSignalIds: [negative.signalId] });
  assert.deepEqual(applyRoutingPolicySignals({ routes, signals: [negative, restore], context: routingContext }), routes);
  assert.deepEqual(applyRoutingPolicySignals({ routes, signals: [negative, restore], context: { ...routingContext, project: 'other' } }).map((route) => route.reference), ['other/model-a', 'provider/model-a']);
  assert.equal(applyRoutingPolicySignals({ routes, signals: [negative], context: routingContext })[0].advisoryReason, undefined);
  assert.deepEqual(applyRoutingPolicySignals({ routes: [routes[0]], signals: [negative], context: routingContext }).map((route) => route.reference), ['provider/model-a']);
  assert.throws(() => lookupRoutingPolicy({ signals: [routingSignal({ subject: { model: 'model-a', role: 'implementation-worker', taskClass: 'implementation' } })], context: routingContext }), /provider-qualified/);
});

test('future routing accepts the Foundry golden producer vector', () => {
  const golden = {
    schema: 'celestan-future-routing-signal-v1', signalId: 'rps_f7fd8e8523eb01f7377c8dc5e1fbaa0a', contentHash: 'f7fd8e8523eb01f7377c8dc5e1fbaa0a6fb530931110b44e8abef8fabc81ddb8', status: 'active',
    subject: { model: 'provider/model-golden', role: 'implementation-worker', taskClass: 'implementation' }, direction: 'negative', proposedEffect: 'lower-preference',
    scopeLimit: { globalDemotion: false, unrelatedWorkUnassessed: true, boundedWorkerUsePermitted: true }, reviewId: 'rpr_golden', consolidationId: 'rcon_golden', findingId: 'rf_golden', candidateIds: ['rpc_golden'], observationIds: ['obs_golden'], observationEvidenceHashes: ['a'.repeat(64)], evidenceIds: ['evidence_golden'], envelopeIds: ['envelope_golden'], citedClaimIds: ['claim_golden'], supersedesSignalIds: [], supersessionMode: 'replace', acceptedAt: '2026-08-31T10:00:00.000Z'
  };
  assert.deepEqual(normalizeFutureRoutingSignal(golden), golden);
});

test('future routing rejects incompatible present narrow, restore, and replace targets', () => {
  const negative = routingSignal();
  const scopedNegative = routingSignal({ scopeLimit: { globalDemotion: false, unrelatedWorkUnassessed: true, boundedWorkerUsePermitted: true, project: 'other' } });
  assert.throws(() => lookupRoutingPolicy({ signals: [scopedNegative, routingSignal({ direction: 'positive', proposedEffect: 'restore-default', supersessionMode: 'narrow', scopeLimit: { globalDemotion: false, unrelatedWorkUnassessed: true, boundedWorkerUsePermitted: true, project: 'demo' }, supersedesSignalIds: [scopedNegative.signalId] })] }), /incompatible/);
  assert.throws(() => lookupRoutingPolicy({ signals: [negative, routingSignal({ direction: 'positive', proposedEffect: 'restore-default', supersessionMode: 'restore', scopeLimit: { globalDemotion: false, unrelatedWorkUnassessed: true, boundedWorkerUsePermitted: true, project: 'demo' }, supersedesSignalIds: [negative.signalId] })] }), /incompatible/);
  const positive = routingSignal({ direction: 'positive', proposedEffect: 'restore-default', supersessionMode: 'restore', supersedesSignalIds: [negative.signalId] });
  assert.throws(() => lookupRoutingPolicy({ signals: [positive, routingSignal({ supersedesSignalIds: [positive.signalId] })] }), /incompatible/);
});

test('future routing rejects duplicate, cyclic, and dangling narrow supersession edges', () => {
  const first = routingSignal();
  const second = routingSignal({ direction: 'positive', proposedEffect: 'restore-default', supersessionMode: 'narrow', supersedesSignalIds: [first.signalId] });
  assert.throws(() => lookupRoutingPolicy({ signals: [first, first], context: routingContext }), /duplicate/);
  assert.throws(() => lookupRoutingPolicy({ signals: [second], context: routingContext }), /missing/);
  const cycleA = { signalId: 'rps_' + 'a'.repeat(32), supersedesSignalIds: ['rps_' + 'b'.repeat(32)] };
  const cycleB = { signalId: 'rps_' + 'b'.repeat(32), supersedesSignalIds: [cycleA.signalId] };
  assert.throws(() => lookupRoutingPolicy({ signals: [cycleA, cycleB], context: routingContext }), /subject|signal/);
});

test('future routing rejects malformed, wildcard, and global-blacklist-style signals', () => {
  assert.throws(() => routingSignal({ subject: { model: '*', role: 'implementation-worker', taskClass: 'implementation' } }), /global wildcards/);
  assert.throws(() => routingSignal({ proposedEffect: 'blacklist' }), /proposedEffect/);
  assert.throws(() => routingSignal({ contentHash: 'f'.repeat(64) }), /contentHash/);
  assert.throws(() => routingSignal({ unknown: true }), /unknown field/);
  assert.throws(() => routingSignal({ scopeLimit: { globalDemotion: true, unrelatedWorkUnassessed: true, boundedWorkerUsePermitted: true } }), /safety invariants/);
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
