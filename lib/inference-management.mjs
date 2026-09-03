import crypto from 'node:crypto';

export const INFERENCE_FAILURE_CLASSES = Object.freeze([
  'rate_limited',
  'quota_exhausted',
  'insufficient_balance',
  'model_unavailable',
  'provider_unavailable',
  'context_exceeded',
  'malformed_or_invalid_request',
  'transient_provider_error',
  'model/output_failure',
  'unknown'
]);

const FAILURE_SET = new Set(INFERENCE_FAILURE_CLASSES);
const RETRYABLE_FAILURES = new Set(['rate_limited', 'model_unavailable', 'provider_unavailable', 'transient_provider_error']);
const FOUNDRY_FAILURES = Object.freeze({
  rate_limited: 'provider-limit',
  quota_exhausted: 'provider-limit',
  insufficient_balance: 'authentication-account-billing',
  model_unavailable: 'provider-capacity',
  provider_unavailable: 'provider-capacity',
  context_exceeded: 'context-pressure',
  malformed_or_invalid_request: 'protocol-schema-tool-call',
  transient_provider_error: 'provider-capacity',
  'model/output_failure': 'model-output-quality',
  unknown: 'unknown'
});

const MAX_TEXT = 500;
const safeText = (value, field, maximum = MAX_TEXT) => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\0\r\n]/.test(value)) throw new Error(`${field} must be a bounded safe string`);
  return value;
};
const optionalText = (value, field, maximum) => value === undefined || value === null ? undefined : safeText(value, field, maximum);
const finite = (value, field) => { if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be a non-negative finite number`); return value; };
const measured = (value, field, fields) => {
  if (value === undefined) return { availability: 'unavailable', reason: 'not-measured' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  if (value.availability === 'unavailable') return { availability: 'unavailable', reason: optionalText(value.reason, `${field}.reason`, 120) || 'not-measured' };
  if (value.availability !== 'available') throw new Error(`${field}.availability must be available or unavailable`);
  const out = { availability: 'available' };
  for (const name of fields) if (value[name] !== undefined) out[name] = finite(value[name], `${field}.${name}`);
  if (Object.keys(out).length === 1) throw new Error(`${field} has no measurement`);
  if (value.currency !== undefined) out.currency = safeText(value.currency, `${field}.currency`, 16).toLowerCase();
  return out;
};

export function parseProviderModelReference(reference, { transport = 'opencode' } = {}) {
  const exact = safeText(reference, 'model reference', 300);
  const slash = exact.indexOf('/');
  return {
    transport: safeText(transport, 'transport', 80),
    provider: slash > 0 ? exact.slice(0, slash) : 'unspecified',
    model: slash > 0 && slash < exact.length - 1 ? exact.slice(slash + 1) : exact,
    reference: exact,
    providerExplicit: slash > 0
  };
}

export function normalizeInferenceFailure(value) {
  const text = `${value?.status || ''} ${value?.code || ''} ${value?.name || ''} ${value?.message || value || ''}`.toLowerCase();
  const failureClass =
    /insufficient[_ -]?(?:balance|credit)|payment required|billing/.test(text) ? 'insufficient_balance' :
    /quota[_ -]?(?:exhausted|exceeded)|usage limit|credit limit/.test(text) ? 'quota_exhausted' :
    /context.{0,20}(?:exceed|length|limit|window)|too many tokens|maximum context/.test(text) ? 'context_exceeded' :
    /rate[_ -]?limit|too many requests|\b429\b/.test(text) ? 'rate_limited' :
    /model.{0,20}(?:unavailable|not found|capacity)|no available model/.test(text) ? 'model_unavailable' :
    /provider.{0,20}(?:unavailable|down|offline)|service unavailable/.test(text) ? 'provider_unavailable' :
    /invalid request|malformed|bad request|\b400\b|validation|contract/.test(text) ? 'malformed_or_invalid_request' :
    /bad gateway|gateway timeout|internal server error|overloaded|\b50[0234]\b|temporar/.test(text) ? 'transient_provider_error' :
    /output failure|invalid output|empty response|response schema/.test(text) ? 'model/output_failure' : 'unknown';
  return { class: failureClass, retryable: RETRYABLE_FAILURES.has(failureClass), foundryCategory: FOUNDRY_FAILURES[failureClass] };
}

export function mapFailureToFoundry(failureClass) {
  if (!FAILURE_SET.has(failureClass)) throw new Error('unsupported normalized inference failure class');
  return FOUNDRY_FAILURES[failureClass];
}

export function createInferenceRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('inference record input must be an object');
  const startedAt = new Date(input.startedAt).toISOString();
  const finishedAt = new Date(input.finishedAt).toISOString();
  const latencyMs = finite(input.latencyMs ?? Date.parse(finishedAt) - Date.parse(startedAt), 'latencyMs');
  const route = parseProviderModelReference(input.modelReference, { transport: input.transport || 'opencode' });
  const failure = input.failure ? normalizeFailureInput(input.failure) : null;
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 100) throw new Error('attempt must be a bounded positive integer');
  if (input.maxRetries !== undefined && (!Number.isSafeInteger(input.maxRetries) || input.maxRetries < 0 || input.maxRetries > 100)) throw new Error('maxRetries must be a bounded non-negative integer');
  return {
    schema: 'celestan-runtime-inference-v1',
    recordId: optionalText(input.recordId, 'recordId', 180) || `inf-${crypto.randomUUID()}`,
    logical: { workOrder: safeText(input.workOrder, 'workOrder', 500), executionId: safeText(input.executionId, 'executionId', 180) },
    identity: { agent: safeText(input.agent, 'agent', 160), role: optionalText(input.role, 'role', 160) || safeText(input.agent, 'agent', 160) },
    task: { purpose: safeText(input.taskPurpose, 'task purpose', 500) },
    route,
    timing: { startedAt, finishedAt, latencyMs },
    retry: { attempt: input.attempt, retries: input.attempt - 1, maxRetries: input.maxRetries ?? 0 },
    fallback: input.fallback?.used === true ? { used: true, from: optionalText(input.fallback.from, 'fallback.from', 300) } : { used: false },
    outcome: failure ? 'failure' : 'success',
    failure,
    usage: {
      tokens: measured(input.tokens, 'tokens', ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'total']),
      context: measured(input.context, 'context', ['used', 'limit']),
      cost: measured(input.cost, 'cost', ['amount']),
      quota: measured(input.quota, 'quota', ['remaining', 'limit'])
    }
  };
}

function normalizeFailureInput(value) {
  if (typeof value === 'string') {
    if (!FAILURE_SET.has(value)) throw new Error('unsupported normalized inference failure class');
    return { class: value, retryable: RETRYABLE_FAILURES.has(value), foundryCategory: FOUNDRY_FAILURES[value] };
  }
  if (FAILURE_SET.has(value.class)) return { class: value.class, retryable: RETRYABLE_FAILURES.has(value.class), foundryCategory: FOUNDRY_FAILURES[value.class] };
  return normalizeInferenceFailure(value);
}

export const INFERENCE_ADAPTER_CONTRACT = Object.freeze({
  required: Object.freeze(['name', 'transport', 'invocationEnabled', 'candidate', 'normalizeReference'])
});

const adapters = new Map();
export function registerInferenceAdapter(adapter) {
  for (const field of INFERENCE_ADAPTER_CONTRACT.required) if (adapter?.[field] === undefined) throw new Error(`inference adapter missing ${field}`);
  if (typeof adapter.normalizeReference !== 'function') throw new Error('inference adapter normalizeReference must be a function');
  const frozen = Object.freeze({ ...adapter, candidate: Object.freeze({ ...adapter.candidate }) });
  adapters.set(safeText(adapter.name, 'adapter name', 80), frozen);
  return frozen;
}
export function inferenceAdapters() { return [...adapters.values()]; }
export function getInferenceAdapter(name) { return adapters.get(name); }

registerInferenceAdapter({
  name: 'opencode', transport: 'opencode', invocationEnabled: true,
  candidate: { availability: 'configured-route', locality: 'transport-dependent', cost: { availability: 'unavailable', reason: 'not-measured' }, scarcity: 'unknown', evidence: 'observations-required' },
  normalizeReference: (reference) => parseProviderModelReference(reference, { transport: 'opencode' })
});
registerInferenceAdapter({
  name: 'ollama-local-candidate', transport: 'ollama', invocationEnabled: false,
  candidate: { availability: 'unverified', locality: 'local', cost: { availability: 'unavailable', reason: 'host-cost-not-measured' }, scarcity: 'unknown', model: 'unspecified', evidence: 'none' },
  normalizeReference: (reference) => parseProviderModelReference(reference, { transport: 'ollama' })
});

export function aggregateOperationalCatalog({ staticFacts = [], observedRecords = [] } = {}) {
  const catalog = new Map();
  for (const fact of staticFacts) {
    const route = fact.route || parseProviderModelReference(fact.reference, { transport: fact.transport || 'opencode' });
    const item = candidate(catalog, route);
    item.staticFacts.push({ availability: fact.availability || 'unknown', scarcity: fact.scarcity || 'unknown', cost: fact.cost || { availability: 'unavailable', reason: 'not-measured' }, source: optionalText(fact.source, 'static fact source', 120) || 'static' });
  }
  for (const record of observedRecords) {
    if (record?.schema !== 'celestan-runtime-inference-v1') continue;
    const item = candidate(catalog, record.route);
    item.sampleSize++;
    if (record.outcome === 'success') item.successes++;
    else item.failures++;
    const purpose = record.task?.purpose || 'unknown';
    const evidence = item.taskEvidence[purpose] ||= { sampleSize: 0, successes: 0, failures: 0 };
    evidence.sampleSize++;
    if (record.outcome === 'success') evidence.successes++; else evidence.failures++;
    if (record.usage?.cost?.availability === 'available') { item.measuredCostSamples++; item.measuredCostTotal += record.usage.cost.amount; item.costCurrency ||= record.usage.cost.currency; }
    if (record.usage?.quota?.availability === 'available') item.latestQuota = record.usage.quota;
  }
  return [...catalog.values()].map((item) => ({
    ...item,
    successRate: item.sampleSize ? item.successes / item.sampleSize : null,
    measuredCost: item.measuredCostSamples ? { availability: 'available', average: item.measuredCostTotal / item.measuredCostSamples, currency: item.costCurrency, sampleSize: item.measuredCostSamples } : { availability: 'unavailable', reason: 'not-measured', sampleSize: 0 },
    uncertainty: item.sampleSize ? (item.sampleSize < 3 ? 'high' : item.sampleSize < 10 ? 'medium' : 'lower') : 'unobserved'
  }));
}

function candidate(catalog, route) {
  const key = `${route.transport}\0${route.provider}\0${route.model}`;
  if (!catalog.has(key)) catalog.set(key, { key, route: { transport: route.transport, provider: route.provider, model: route.model, reference: route.reference }, staticFacts: [], sampleSize: 0, successes: 0, failures: 0, taskEvidence: {}, measuredCostSamples: 0, measuredCostTotal: 0, costCurrency: undefined, latestQuota: undefined });
  return catalog.get(key);
}

export function stageBShadowRecommendation({ establishedReference, transport = 'opencode', taskPurpose, catalog = [] } = {}) {
  const establishedRoute = parseProviderModelReference(establishedReference, { transport });
  const established = catalog.find((item) => sameRoute(item.route, establishedRoute));
  const eligible = catalog.filter((item) => {
    if (sameRoute(item.route, establishedRoute)) return true;
    const evidence = item.taskEvidence?.[taskPurpose];
    const unavailable = item.staticFacts?.some((fact) => ['unavailable', 'disabled'].includes(fact.availability));
    return evidence?.sampleSize >= 2 && evidence.successes / evidence.sampleSize >= 0.7 && item.latestQuota?.remaining !== 0 && !unavailable;
  });
  const recommended = eligible.sort((left, right) => resourceRank(left) - resourceRank(right) || right.sampleSize - left.sampleSize || left.key.localeCompare(right.key))[0] || established;
  return {
    schema: 'celestan-runtime-inference-recommendation-v1', stage: 'B', shadow: true,
    establishedRoute, executionRoute: establishedRoute,
    recommendedRoute: recommended?.route || establishedRoute,
    changed: Boolean(recommended && !sameRoute(recommended.route, establishedRoute)),
    reason: recommended ? 'least-scarce-costly-task-supported-candidate' : 'insufficient-candidate-evidence',
    evidence: recommended ? { taskPurpose, task: recommended.taskEvidence?.[taskPurpose] || { sampleSize: 0, successes: 0, failures: 0 }, overallSampleSize: recommended.sampleSize, uncertainty: recommended.uncertainty } : { taskPurpose, task: { sampleSize: 0, successes: 0, failures: 0 }, overallSampleSize: 0, uncertainty: 'unobserved' }
  };
}

function resourceRank(item) {
  const latest = item.staticFacts?.at(-1);
  const staticScarcity = ({ abundant: 0, low: 0.2, medium: 0.5, high: 0.8, scarce: 0.9, exhausted: 1, unknown: 0.5 })[latest?.scarcity] ?? 0.5;
  const quotaScarcity = item.latestQuota?.availability === 'available' && item.latestQuota.limit > 0 ? 1 - item.latestQuota.remaining / item.latestQuota.limit : 0.5;
  const staticCost = latest?.cost?.availability === 'available' && Number.isFinite(latest.cost.amount) ? latest.cost.amount : null;
  const cost = item.measuredCost?.availability === 'available' ? item.measuredCost.average : staticCost ?? 1e6;
  return Math.max(staticScarcity, quotaScarcity) * 1e9 + cost;
}
function sameRoute(left, right) { return left?.transport === right.transport && left?.provider === right.provider && left?.model === right.model; }

// Foundry is the authority for these signals. Runtime only consumes an already
// reviewed, narrowly scoped advisory; it neither derives nor activates one.
const ROUTING_SIGNAL_SCHEMA = 'celestan-future-routing-signal-v1';
const SIGNAL_DIRECTIONS = new Set(['negative', 'positive']);
const SIGNAL_EFFECTS = new Set(['lower-preference', 'restore-default']);
const SHA256 = /^[a-f0-9]{64}$/;
const SIGNAL_FIELDS = ['schema', 'signalId', 'contentHash', 'status', 'subject', 'direction', 'proposedEffect', 'scopeLimit', 'reviewId', 'consolidationId', 'findingId', 'candidateIds', 'observationIds', 'observationEvidenceHashes', 'evidenceIds', 'envelopeIds', 'citedClaimIds', 'supersedesSignalIds', 'supersessionMode', 'acceptedAt'];
const SCOPE_FIELDS = ['globalDemotion', 'unrelatedWorkUnassessed', 'boundedWorkerUsePermitted', 'project'];
const SIGNAL_MODES = new Set(['restore', 'narrow', 'replace']);

function signalId(value, field) { return safeText(value, field, 180); }
function rejectUnknown(value, allowed, field) { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${field} contains unknown field ${key}`); }
function immutableIds(value, field, { required = true } = {}) {
  if (value === undefined && !required) return Object.freeze([]);
  if (!Array.isArray(value) || (required && value.length === 0)) throw new Error(`${field} must be a non-empty array of immutable IDs`);
  const ids = value.map((id, index) => signalId(id, `${field}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new Error(`${field} must not contain duplicate IDs`);
  return Object.freeze(ids);
}
function hashIds(value, field) {
  const ids = immutableIds(value, field);
  if (ids.some((id) => !SHA256.test(id))) throw new Error(`${field} must contain SHA256 hashes`);
  return ids;
}
const stableCanonical = (value) => Array.isArray(value)
  ? `[${value.map(stableCanonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableCanonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
function canonicalSignalBody(signal) {
  return { schema: signal.schema, status: signal.status, subject: signal.subject, direction: signal.direction, proposedEffect: signal.proposedEffect, scopeLimit: signal.scopeLimit, reviewId: signal.reviewId, consolidationId: signal.consolidationId, findingId: signal.findingId, candidateIds: signal.candidateIds, observationIds: signal.observationIds, observationEvidenceHashes: signal.observationEvidenceHashes, evidenceIds: signal.evidenceIds, envelopeIds: signal.envelopeIds, citedClaimIds: signal.citedClaimIds, supersedesSignalIds: signal.supersedesSignalIds, supersessionMode: signal.supersessionMode, acceptedAt: signal.acceptedAt };
}

export function validateFutureRoutingSignal(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('future routing signal must be an object');
  rejectUnknown(input, SIGNAL_FIELDS, 'future routing signal');
  if (input.schema !== ROUTING_SIGNAL_SCHEMA || input.status !== 'active') throw new Error('future routing signal schema or status is invalid');
  if (!input.subject || typeof input.subject !== 'object' || Array.isArray(input.subject)) throw new Error('future routing signal subject is required');
  rejectUnknown(input.subject, ['model', 'role', 'taskClass'], 'future routing signal subject');
  const subject = Object.freeze({ model: safeText(input.subject.model, 'future routing signal subject.model', 300), role: safeText(input.subject.role, 'future routing signal subject.role', 160), taskClass: safeText(input.subject.taskClass, 'future routing signal subject.taskClass', 160) });
  if ([subject.model, subject.role, subject.taskClass].some((value) => value === '*' || value.toLowerCase() === 'global')) throw new Error('future routing signal cannot use global wildcards');
  if (!subject.model.includes('/')) throw new Error('future routing signal subject.model must be provider-qualified');
  if (!input.scopeLimit || typeof input.scopeLimit !== 'object' || Array.isArray(input.scopeLimit)) throw new Error('future routing signal scopeLimit is required');
  rejectUnknown(input.scopeLimit, SCOPE_FIELDS, 'future routing signal scopeLimit');
  if (input.scopeLimit.globalDemotion !== false || input.scopeLimit.unrelatedWorkUnassessed !== true || input.scopeLimit.boundedWorkerUsePermitted !== true) throw new Error('future routing signal scopeLimit safety invariants are invalid');
  const project = optionalText(input.scopeLimit.project, 'future routing signal scopeLimit.project', 180);
  if (project === '*' || project?.toLowerCase() === 'global') throw new Error('future routing signal cannot use global project wildcard');
  const scopeLimit = Object.freeze({ globalDemotion: false, unrelatedWorkUnassessed: true, boundedWorkerUsePermitted: true, ...(project === undefined ? {} : { project }) });
  if (!SIGNAL_DIRECTIONS.has(input.direction)) throw new Error('future routing signal direction is invalid');
  if (!SIGNAL_EFFECTS.has(input.proposedEffect) || (input.direction === 'negative' && input.proposedEffect !== 'lower-preference') || (input.direction === 'positive' && input.proposedEffect !== 'restore-default')) throw new Error('future routing signal proposedEffect is invalid');
  if (!SIGNAL_MODES.has(input.supersessionMode) || (input.direction === 'positive' && !['restore', 'narrow'].includes(input.supersessionMode)) || (input.direction === 'negative' && input.supersessionMode !== 'replace')) throw new Error('future routing signal supersessionMode is invalid');
  const acceptedAt = new Date(input.acceptedAt).toISOString();
  if (acceptedAt !== input.acceptedAt) throw new Error('future routing signal acceptedAt must be canonical ISO');
  const supersedesSignalIds = immutableIds(input.supersedesSignalIds, 'future routing signal supersedesSignalIds', { required: false });
  if (input.direction === 'positive' && supersedesSignalIds.length === 0) throw new Error('positive future routing signal must supersede a signal');
  const normalized = { schema: ROUTING_SIGNAL_SCHEMA, signalId: signalId(input.signalId, 'future routing signal signalId'), status: 'active', subject, direction: input.direction, proposedEffect: input.proposedEffect, scopeLimit, reviewId: signalId(input.reviewId, 'future routing signal reviewId'), consolidationId: signalId(input.consolidationId, 'future routing signal consolidationId'), findingId: signalId(input.findingId, 'future routing signal findingId'), candidateIds: immutableIds(input.candidateIds, 'future routing signal candidateIds'), observationIds: immutableIds(input.observationIds, 'future routing signal observationIds'), observationEvidenceHashes: hashIds(input.observationEvidenceHashes, 'future routing signal observationEvidenceHashes'), evidenceIds: immutableIds(input.evidenceIds, 'future routing signal evidenceIds'), envelopeIds: immutableIds(input.envelopeIds, 'future routing signal envelopeIds'), citedClaimIds: immutableIds(input.citedClaimIds, 'future routing signal citedClaimIds'), supersedesSignalIds, supersessionMode: input.supersessionMode, acceptedAt };
  if (!/^rps_[a-f0-9]{32}$/.test(input.signalId)) throw new Error('future routing signal signalId is malformed');
  if (!SHA256.test(input.contentHash)) throw new Error('future routing signal contentHash is malformed');
  const contentHash = crypto.createHash('sha256').update(stableCanonical(canonicalSignalBody(normalized))).digest('hex');
  if (input.contentHash !== contentHash) throw new Error('future routing signal contentHash does not match canonical content');
  if (input.signalId !== `rps_${contentHash.slice(0, 32)}`) throw new Error('future routing signal signalId is not deterministic');
  return Object.freeze({ ...normalized, contentHash });
}

export const normalizeFutureRoutingSignal = validateFutureRoutingSignal;

function matchingSignal(signal, context) {
  return signal.subject.model === context.model && signal.subject.role === context.role && signal.subject.taskClass === context.taskClass &&
    (signal.scopeLimit.project === undefined || signal.scopeLimit.project === context.project);
}

function routeMatchesModel(route, model) {
  return route?.reference === model ||
    (typeof route?.provider === 'string' && typeof route?.model === 'string' && route.provider !== 'unspecified' && `${route.provider}/${route.model}` === model) ||
    (typeof route?.model === 'string' && route.model.includes('/') && route.model === model);
}

function validateSignalSnapshot(signals) {
  const ids = new Set();
  for (const signal of signals) {
    if (ids.has(signal.signalId)) throw new Error('future routing signal snapshot contains duplicate signal IDs');
    ids.add(signal.signalId);
  }
  const visiting = new Set(); const visited = new Set();
  const visit = (id) => { if (visiting.has(id)) throw new Error('future routing signal supersession cycle'); if (visited.has(id)) return; visiting.add(id); const signal = signals.find((item) => item.signalId === id); for (const target of signal?.supersedesSignalIds || []) if (ids.has(target)) visit(target); visiting.delete(id); visited.add(id); };
  for (const signal of signals) {
    if (signal.supersessionMode === 'narrow' && signal.supersedesSignalIds.some((id) => !ids.has(id))) throw new Error('narrow supersession target is missing from active snapshot');
    for (const targetId of signal.supersedesSignalIds) {
      const target = signals.find((item) => item.signalId === targetId);
      if (!target) {
        if (signal.supersessionMode === 'narrow') throw new Error('narrow supersession target is missing from active snapshot');
        continue;
      }
      const sameSubject = ['model', 'role', 'taskClass'].every((key) => target.subject[key] === signal.subject[key]);
      const sameScope = stableCanonical(target.scopeLimit) === stableCanonical(signal.scopeLimit);
      const unscopedNegative = target.direction === 'negative' && target.proposedEffect === 'lower-preference' && target.scopeLimit.project === undefined;
      const compatible = signal.supersessionMode === 'narrow'
        ? signal.direction === 'positive' && signal.proposedEffect === 'restore-default' && signal.scopeLimit.project !== undefined && unscopedNegative && sameSubject
        : signal.supersessionMode === 'restore'
          ? signal.direction === 'positive' && signal.proposedEffect === 'restore-default' && target.direction === 'negative' && target.proposedEffect === 'lower-preference' && sameSubject && sameScope
          : target.direction === signal.direction && target.proposedEffect === signal.proposedEffect && sameSubject && sameScope;
      if (!compatible) throw new Error('supersession target is incompatible');
    }
    visit(signal.signalId);
  }
}

export function lookupRoutingPolicy({ signals = [], context } = {}) {
  if (!Array.isArray(signals)) throw new Error('routing policy signals must be an array');
  const normalized = signals.map(validateFutureRoutingSignal);
  validateSignalSnapshot(normalized);
  if (!context || typeof context !== 'object' || Array.isArray(context) ||
      typeof context.model !== 'string' || !context.model || typeof context.role !== 'string' || !context.role ||
      typeof context.taskClass !== 'string' || !context.taskClass ||
      (context.project !== undefined && context.project !== null && (typeof context.project !== 'string' || !context.project))) return [];
  return normalized.filter((signal) => matchingSignal(signal, context));
}

export function applyRoutingPolicySignals({ routes, signals = [], context } = {}) {
  if (!Array.isArray(routes)) throw new Error('routes must be an array');
  const matching = lookupRoutingPolicy({ signals, context });
  const negatives = new Map(matching.filter((signal) => signal.direction === 'negative').map((signal) => [signal.signalId, signal]));
  const restored = new Set(matching.filter((signal) => signal.direction === 'positive').flatMap((signal) => signal.supersedesSignalIds));
  const demotedModels = new Set([...negatives].filter(([id]) => !restored.has(id)).map(([, signal]) => signal.subject.model));
  if (!demotedModels.size) return [...routes];
  const retained = routes.filter((route) => ![...demotedModels].some((model) => routeMatchesModel(route, model)));
  const demoted = routes.filter((route) => [...demotedModels].some((model) => routeMatchesModel(route, model)));
  const reason = 'advisory: Foundry future-routing signal lower-preference';
  return [...retained, ...demoted.map((route) => ({ ...route, advisoryReason: route.advisoryReason ? `${route.advisoryReason}; ${reason}` : reason }))];
}
