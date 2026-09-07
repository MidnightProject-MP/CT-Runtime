import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportExecutionEvidence } from './evidence-export.mjs';
import { canonicalJson } from './config.mjs';
import { auditSanitizedHistoricalEvidence, deliverHistoricalEvidence, listOpenCodeSessions, readHistoricalEvidenceFiles, readOpenCodeExport, representedHistoricalSessions, validateSemanticEnvelope, verifySemanticEnvelopeSources, writeLocalHistoricalEvidence } from './opencode-evidence.mjs';

const TERMINAL = new Set(['success', 'failed', 'cancelled', 'crashed']);
const INBOX = 'observer/inbox';

export async function exportExecution({ store, evidenceStore, executionId } = {}) {
  if (!store || typeof executionId !== 'string' || !executionId.trim()) throw new Error('execution and store are required');
  const manifest = await store.manifest(executionId);
  const evidence = exportExecutionEvidence(toEvidence(manifest));
  const content = Buffer.from(canonicalJson(evidence) + '\n');
  // Production stores must register the object with the execution manifest; otherwise
  // a successful object upload would be an orphan invisible to Observer.
  const delivery = typeof store.evidenceFor === 'function' && typeof store.evidence === 'function'
    ? await store.evidence(executionId, `observer-inbox-${evidence.contentHash.slice(0, 12)}`, content, undefined, 1)
    : evidenceStore?.put
      ? await evidenceStore.put({ project: manifest.execution.project, executionId, attempt: 1, label: 'observer-inbox', content, contentType: 'application/json', retentionClass: 'observer-ledger' })
      : await writeLocalInbox(store.root, evidence.evidenceId, evidence.contentHash, content);
  return { executionId, evidenceId: evidence.evidenceId, sha256: evidence.contentHash, status: TERMINAL.has(manifest.execution.status) ? 'exported' : 'exported-current', delivery };
}

export async function backfillEvidence({ store, evidenceStore } = {}) {
  if (!store) throw new Error('store is required');
  const results = [];
  for (const manifest of await store.manifestsAll()) {
    results.push(await exportExecution({ store, evidenceStore, executionId: manifest.execution.id }));
  }
  return { status: 'complete', exported: results.length, results };
}

export async function exportOpenCodeSession({ sessionId, store, evidenceStore, project, command, run, extractionMode = 'sanitized', semanticEnvelope, resolveSemanticSource } = {}) {
  if (extractionMode === 'rich' && semanticEnvelope !== undefined) throw new Error('semantic evidence is only attachable to sanitized historical evidence');
  const result = await readOpenCodeExport(sessionId, { command, run, extractionMode });
  if (result.status !== 'available') return result;
  if (!store?.root || typeof store.lock !== 'function') throw new Error('OpenCode revision guarantees require a durable local revision lookup');
  let revisedEvidence;
  let duplicateInfo = null;
  let isDuplicate = false;
  const release = await store.lock('opencode-revision-publication');
  try {
    const reusable = extractionMode === 'sanitized' && semanticEnvelope === undefined ? await reusableEnvelope(store, sessionId) : semanticEnvelope;
    const checkedEnvelope = reusable === undefined ? undefined : validateSemanticEnvelope(reusable, sessionId);
    if (checkedEnvelope) await verifySemanticEnvelopeSources(checkedEnvelope, resolveSemanticSource);
    const evidence = checkedEnvelope ? exportExecutionEvidence({ ...result.evidence, semanticEvidenceEnvelope: checkedEnvelope }) : result.evidence;
    if (extractionMode === 'sanitized') auditSanitizedHistoricalEvidence(evidence);
    const revised = await revisionFor(evidence, store);
    if (revised.duplicate) {
      isDuplicate = true;
      revisedEvidence = revised.evidence;
      duplicateInfo = revised.existing;
      await writeLocalHistoricalEvidence({ evidence: revisedEvidence, store, resolveSemanticSource });
    } else {
      revisedEvidence = revised.evidence;
      await writeLocalHistoricalEvidence({ evidence: revisedEvidence, store, resolveSemanticSource });
    }
  } finally { await release(); }
  let delivery;
  if (evidenceStore) {
    const content = Buffer.from(canonicalJson(revisedEvidence) + '\n');
    const remote = await evidenceStore.put({ project, executionId: revisedEvidence.provenance.sourceSessionId, attempt: 1, label: `opencode-${revisedEvidence.contentHash.slice(0, 12)}`, content, contentType: 'application/json', retentionClass: 'observer-ledger' });
    const local = { objectUri: `file://${path.join(store.root, INBOX, `${encodeURIComponent(revisedEvidence.evidenceId)}-${revisedEvidence.contentHash}.json`).replaceAll('\\', '/')}`, objectKey: `${INBOX}/${encodeURIComponent(revisedEvidence.evidenceId)}-${revisedEvidence.contentHash}.json`, bytes: content.length };
    delivery = { local, remote };
  }
  if (isDuplicate) {
    return { status: 'duplicate', sourceSessionId: sessionId, evidenceId: revisedEvidence.evidenceId, sha256: revisedEvidence.contentHash, revision: revisedEvidence.revision, existing: duplicateInfo, ...(delivery ? { delivery } : {}) };
  }
  return { status: 'exported', sourceSessionId: sessionId, evidenceId: revisedEvidence.evidenceId, sha256: revisedEvidence.contentHash, revision: revisedEvidence.revision, delivery };
}

export async function backfillOpenCodeEvidence({ store, evidenceStore, project, command, run, resolveSemanticSource } = {}) {
  const extractionMode = 'sanitized';
  const represented = store?.root ? await representedHistoricalSessions(store.root, extractionMode) : new Set();
  const sessions = await listOpenCodeSessions({ command, run });
  if (evidenceStore && !resolveSemanticSource && store?.root) {
    const semanticSessions = new Set((await readHistoricalEvidenceFiles(store.root)).filter((value) => value.evidenceFidelity?.extractorVersion === 2 && value.semanticEvidenceEnvelope).map((value) => value.provenance.sourceSessionId));
    if (sessions.some((sessionId) => semanticSessions.has(sessionId))) throw new Error('remote OpenCode backfill requires a durable source resolver for existing semantic evidence');
  }
  const results = []; let skippedCurrent = 0;
  for (const sessionId of sessions) {
    if (represented.has(sessionId) && !evidenceStore) { skippedCurrent++; continue; }
    results.push(await exportOpenCodeSession({ sessionId, store, evidenceStore, project, command, run, extractionMode, resolveSemanticSource }));
  }
  const counts = { discovered: sessions.length, attempted: results.length, exported: results.filter((r) => r.status === 'exported').length, duplicate: results.filter((r) => r.status === 'duplicate').length, unavailable: results.filter((r) => r.status === 'unavailable').length, skippedCurrent };
  return { status: 'complete', ...counts, results };
}

async function reusableEnvelope(store, sessionId) {
  const envelopes = new Map();
  for (const value of await readHistoricalEvidenceFiles(store.root)) {
    if (value.evidenceFidelity?.extractorVersion !== 2 || value.provenance.sourceSessionId !== sessionId || !value.semanticEvidenceEnvelope) continue;
    const checked = validateSemanticEnvelope(value.semanticEvidenceEnvelope, sessionId);
    envelopes.set(checked.contentHash, checked);
  }
  if (envelopes.size > 1) throw new Error('conflicting semantic envelopes for OpenCode session');
  return envelopes.values().next().value;
}

function toEvidence(manifest) {
  const execution = manifest.execution;
  const result = manifest.result || {};
  const references = (manifest.evidence?.raw || []).map(({ uri, sha256, label, bytes }) => ({ uri, sha256, label, bytes }));
  return {
    evidenceId: `execution-${execution.id}`,
    physicalExecutionId: execution.id,
    workOrderId: manifest.workOrder,
    substrate: 'ct-runtime',
    mode: execution.wake_reason,
    initiator: execution.agent,
    role: execution.agent,
    requestedModel: execution.model,
    startedAt: execution.startedAt || execution.createdAt,
    finishedAt: execution.finishedAt,
    durationMs: duration(execution.startedAt, execution.finishedAt),
    failures: manifest.failure ? [manifest.failure] : undefined,
    retries: manifest.attempts,
    summary: result.summary,
    artifactReferences: references,
    provenance: { source: 'ct-runtime', executionId: execution.id, status: execution.status },
    outcome: execution.status
  };
}

function duration(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return undefined;
  const value = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function writeLocalInbox(root, evidenceId, hash, content) {
  const directory = path.join(root, INBOX);
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${encodeURIComponent(evidenceId)}-${hash}.json`);
  try {
    const existing = await readFile(target);
    if (Buffer.compare(existing, content) !== 0) throw new Error('Observer inbox evidence conflict');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const temporary = `${target}.${process.pid}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target);
  }
  return { objectUri: pathToFileURL(target).href, objectKey: path.relative(root, target).replaceAll(path.sep, '/'), bytes: content.length };
}

async function revisionFor(evidence, store) {
  if (!store?.root) throw new Error('OpenCode revision guarantees require a local canonical inbox or durable revision lookup');
  const candidates = (await readHistoricalEvidenceFiles(store.root)).filter((value) => value.provenance?.sourceSessionId === evidence.provenance?.sourceSessionId).map((value) => ({ value, mtime: 0 }));
  candidates.sort((a, b) => {
    const ar = revisionNumber(a.value), br = revisionNumber(b.value);
    if (ar !== null && br !== null) return ar - br || String(a.value.contentHash).localeCompare(String(b.value.contentHash));
    if (ar === null && br === null) return a.mtime - b.mtime || String(a.value.contentHash).localeCompare(String(b.value.contentHash));
    return ar === null ? -1 : 1;
  });
  const same = candidates.find(({ value }) => comparable(value) === comparable(evidence));
  if (same) return { duplicate: true, evidence: same.value, existing: { contentHash: same.value.contentHash, revision: same.value.revision || { number: 1, reason: 'legacy-unversioned' } } };
  const predecessor = candidates.at(-1)?.value;
  const predecessorRevision = typeof predecessor?.revision === 'number' ? predecessor.revision : Number(predecessor?.revision?.number || 0);
  const revision = predecessorRevision + 1;
  const reason = evidence.evidenceFidelity?.mode === 'rich' ? 'richer-source' : 'extractor-upgrade';
  return { evidence: exportExecutionEvidence({ ...evidence, revision: { number: revision, ...(predecessor?.contentHash ? { predecessorContentHash: predecessor.contentHash } : {}), reason } }) };
}

function revisionNumber(value) { const number = typeof value?.revision === 'number' ? value.revision : Number(value?.revision?.number); return Number.isSafeInteger(number) && number > 0 ? number : null; }

function comparable(value) { const copy = JSON.parse(JSON.stringify(value)); delete copy.contentHash; delete copy.revision; return canonicalJson(copy); }
