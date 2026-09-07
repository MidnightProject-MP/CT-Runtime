import crypto from 'node:crypto';

export const EXECUTION_EVIDENCE_SCHEMA = 'celestan-execution-evidence-v1';
export const MAX_EVIDENCE_BYTES = 64 * 1024;

const SECRET_KEYS = /(?:token(?!s)|secret|password|api[_-]?key|credential|authorization|cookie|private[_-]?key|database[_-]?url)/i;

export function redactEvidence(value) {
  if (Array.isArray(value)) return value.slice(0, 100).map(redactEvidence);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEYS.test(key)).map(([key, child]) => [key, redactEvidence(child)]));
}

export function createExecutionEvidence(input = {}) {
  if (!input.evidenceId) throw new Error('evidenceId is required');
  if (!input.physicalExecutionId && !(input.substrate === 'opencode-local-historical' && input.provenance?.sourceSessionId)) throw new Error('evidenceId and physicalExecutionId are required');
  const evidence = redactEvidence({ ...input, schema: EXECUTION_EVIDENCE_SCHEMA, version: 1 });
  const serialized = canonicalJson(evidence);
  if (Buffer.byteLength(serialized) > MAX_EVIDENCE_BYTES) throw new Error('execution evidence exceeds 64 KiB');
  return { ...evidence, contentHash: sha256(serialized) };
}

export function validateExecutionEvidence(value) {
  if (!value || value.schema !== EXECUTION_EVIDENCE_SCHEMA || value.version !== 1) throw new Error('unsupported execution evidence schema');
  if (typeof value.evidenceId !== 'string' || (value.physicalExecutionId !== undefined && typeof value.physicalExecutionId !== 'string') || (!value.physicalExecutionId && !(value.substrate === 'opencode-local-historical' && value.provenance?.sourceSessionId))) throw new Error('evidence identity is invalid');
  if (value.contentHash !== evidenceHash(value)) throw new Error('execution evidence hash mismatch');
  return value;
}

export function evidenceHash(value) {
  const copy = { ...value };
  delete copy.contentHash;
  return sha256(canonicalJson(copy));
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${Array.from(value, (item) => item === undefined ? 'null' : canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, value[key]]);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
