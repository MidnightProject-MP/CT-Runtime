import crypto from 'node:crypto';

export const SEMANTIC_EVIDENCE_SCHEMA = 'celestan-semantic-evidence-envelope-v1';
export const SOURCE_CLASSES = Object.freeze(['operator-supplied', 'execution-reported', 'mechanically-verified', 'independently-reviewed', 'runtime-observed', 'provider-reported']);
export const CLAIM_TYPES = Object.freeze(['objective', 'execution-summary', 'completion', 'failure', 'verification', 'review-finding', 'rework', 'outcome', 'residual-uncertainty', 'other']);
const ENVELOPE = new Set(['schema', 'version', 'envelopeId', 'lineage', 'sources', 'claims', 'contentHash']);
const LINEAGE = new Set(['physicalExecutionId', 'workOrderId', 'sourceSessionId']);
const SOURCE = new Set(['sourceId', 'sourceClass', 'reference', 'sha256', 'sourceExecutionId']);
const CLAIM = new Set(['claimId', 'claimType', 'statement', 'supportSourceIds']);
const SHA = /^[a-f0-9]{64}$/;
const BAD = /[\r\n\0]/;

const fail = (message) => { throw new Error(`semantic evidence ${message}`); };
function text(value, name, max) { if (typeof value !== 'string' || !value || value.length > max || BAD.test(value)) fail(`${name} is invalid`); return value; }
function keys(value, allowed, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`); for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${name} has unknown field ${key}`); }
function unique(values, name) { const seen = new Set(); for (const value of values) { if (seen.has(value)) fail(`${name} contains duplicate IDs`); seen.add(value); } }
function secretCheck(value, secretValues) { if (secretValues.some((secret) => typeof secret === 'string' && secret.length > 0 && JSON.stringify(value).includes(secret))) fail('contains a supplied secret'); }

export function canonicalSemanticEvidence(value) {
  return JSON.stringify({ schema: value.schema, version: value.version, lineage: value.lineage, sources: value.sources, claims: value.claims });
}

export function validateSemanticEvidenceDraft(value, secretValues = []) {
  keys(value, new Set(['sources', 'claims']), 'draft');
  const sources = validateSources(value.sources, secretValues);
  const claims = validateClaims(value.claims, sources, secretValues);
  const draft = { sources, claims }; if (Buffer.byteLength(JSON.stringify(draft), 'utf8') > 64 * 1024) fail('draft exceeds 64 KiB'); return draft;
}

export const validateSemanticEvidenceDraftV1 = validateSemanticEvidenceDraft;

function validateSources(value, secretValues) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) fail('sources are invalid');
  const ids = value.map((source) => source?.sourceId); unique(ids, 'sources');
  return value.map((source, index) => {
    keys(source, SOURCE, `source[${index}]`);
    const out = { sourceId: text(source.sourceId, 'sourceId', 160), sourceClass: source.sourceClass, reference: text(source.reference, 'reference', 500), sha256: source.sha256 == null ? null : text(source.sha256, 'sha256', 64), sourceExecutionId: source.sourceExecutionId == null ? null : text(source.sourceExecutionId, 'sourceExecutionId', 160) };
    if (!SOURCE_CLASSES.includes(out.sourceClass)) fail('sourceClass is invalid');
    if (out.sha256 !== null && !SHA.test(out.sha256)) fail('sha256 is invalid');
    if (out.sourceClass === 'mechanically-verified' && !out.sha256) fail('mechanically-verified source requires sha256');
    if (out.sourceClass === 'independently-reviewed' && !out.sourceExecutionId) fail('independently-reviewed source requires sourceExecutionId');
    secretCheck(out, secretValues); return out;
  });
}
function validateClaims(value, sources, secretValues = []) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) fail('claims are invalid');
  const ids = value.map((claim) => claim?.claimId); unique(ids, 'claims'); const sourceIds = new Set(sources.map((s) => s.sourceId)); const used = new Set();
  const claims = value.map((claim, index) => { keys(claim, CLAIM, `claim[${index}]`); if (!Array.isArray(claim.supportSourceIds) || claim.supportSourceIds.length < 1 || claim.supportSourceIds.length > 20) fail('supportSourceIds are invalid'); unique(claim.supportSourceIds, 'supportSourceIds'); for (const id of claim.supportSourceIds) { if (!sourceIds.has(id)) fail('claim has dangling source'); used.add(id); } const out = { claimId: text(claim.claimId, 'claimId', 160), claimType: claim.claimType, statement: text(claim.statement, 'statement', 1000), supportSourceIds: [...claim.supportSourceIds] }; if (!CLAIM_TYPES.includes(out.claimType)) fail('claimType is invalid'); secretCheck(out, secretValues); return out; });
  if (used.size !== sourceIds.size) fail('sources must be used'); return claims;
}

export function validateSemanticEvidence(value, { secretValues = [], requireEnvelopeId = true } = {}) {
  keys(value, ENVELOPE, 'envelope');
  if (value.schema !== SEMANTIC_EVIDENCE_SCHEMA || value.version !== 1) fail('schema or version is invalid');
  keys(value.lineage, LINEAGE, 'lineage'); const lineage = {}; for (const key of LINEAGE) if (value.lineage[key] != null) lineage[key] = text(value.lineage[key], `lineage.${key}`, 160); if (!Object.keys(lineage).length) fail('lineage requires a physical execution, work order, or source session');
  const sources = validateSources(value.sources, secretValues); const claims = validateClaims(value.claims, sources, secretValues);
  for (const source of sources) if (source.sourceClass === 'independently-reviewed' && source.sourceExecutionId === lineage.physicalExecutionId) fail('independently-reviewed source must be distinct');
  if (typeof value.contentHash !== 'string' || !SHA.test(value.contentHash)) fail('contentHash is invalid');
  const contentHash = crypto.createHash('sha256').update(canonicalSemanticEvidence({ schema: value.schema, version: value.version, lineage, sources, claims })).digest('hex');
  const complete = { schema: value.schema, version: value.version, envelopeId: value.envelopeId, lineage, sources, claims, contentHash: value.contentHash };
  if (Buffer.byteLength(JSON.stringify(complete), 'utf8') > 64 * 1024) fail('envelope exceeds 64 KiB');
  if (value.contentHash !== contentHash) fail('contentHash does not match canonical content');
  const envelopeId = `sem_${contentHash.slice(0, 32)}`;
  if (requireEnvelopeId && value.envelopeId !== envelopeId) fail('envelopeId is invalid');
  secretCheck(value, secretValues);
  return { schema: SEMANTIC_EVIDENCE_SCHEMA, version: 1, envelopeId, lineage, sources, claims, contentHash };
}

export function createSemanticEvidenceEnvelope({ lineage, sources, claims, secretValues = [] } = {}) {
  const draft = validateSemanticEvidenceDraft({ sources, claims }, secretValues);
  const base = { schema: SEMANTIC_EVIDENCE_SCHEMA, version: 1, lineage, ...draft };
  keys(lineage, LINEAGE, 'lineage');
  const checkedLineage = {}; for (const key of LINEAGE) if (lineage?.[key] != null) checkedLineage[key] = text(lineage[key], `lineage.${key}`, 160); if (!Object.keys(checkedLineage).length) fail('lineage is empty');
  const contentHash = crypto.createHash('sha256').update(canonicalSemanticEvidence({ ...base, lineage: checkedLineage })).digest('hex');
  return validateSemanticEvidence({ ...base, lineage: checkedLineage, envelopeId: `sem_${contentHash.slice(0, 32)}`, contentHash }, { secretValues });
}

export const createSemanticEvidence = createSemanticEvidenceEnvelope;
export const validateEnvelope = validateSemanticEvidence;
export const createEnvelope = createSemanticEvidenceEnvelope;
export const validateDraft = validateSemanticEvidenceDraft;
