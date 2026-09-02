import crypto from 'node:crypto';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson } from './config.mjs';
import { runProcess } from './runtime.mjs';

const TERMINAL = new Set(['success', 'failed', 'cancelled', 'crashed']);
const MAX_SEMANTIC_BYTES = 64 * 1024;

export async function observePostgres({ store, observerStore, semanticResultFile, reflection } = {}) {
  const foundry = await import(process.env.CT_RUNTIME_OBSERVER_MODULE || '../../CT-Foundry/capabilities/observer/observer.mjs');
  const output = [];
  for (const manifest of await store.manifestsAll()) {
    if (!TERMINAL.has(manifest.execution.status) || manifest.observer?.state === 'observed' || isObserverExecution(manifest)) continue;
    const executionId = manifest.execution.id;
    const evidenceRows = await store.evidenceFor(executionId);
    const semanticEvidence = typeof store.semanticEvidenceFor === 'function' ? (await store.semanticEvidenceFor(executionId, { limit: 100 }))[0] : undefined;
    const references = evidenceRows.map((item) => item.uri);
    const modelRuntimeTelemetry = await observerStore.modelTelemetryFor(executionId);
    const hostRows = await store.hostTelemetryFor(executionId);
    const execution = {
      executionId, project: manifest.execution.project, status: manifest.execution.status,
      startedAt: manifest.execution.startedAt, finishedAt: manifest.execution.finishedAt,
      ...(modelRuntimeTelemetry ? { modelRuntimeTelemetry } : {}),
      hostRuntimeTelemetry: hostRows.length ? { availability: 'available', records: hostRows } : { availability: 'unavailable', reason: 'not-exposed' }
    };
    const input = { execution, evidence: { source: 'ct-runtime', references, evidenceDigest: sha(canonicalJson(evidenceRows)), ...(semanticEvidence ? { semanticEvidenceEnvelope: semanticEvidence } : {}) }, ...(semanticEvidence ? { evidenceEnvelope: semanticEvidence } : {}) };
    let appended;
    try {
      if (await observerStore.has(executionId)) {
        const digest = await observerStore.getDigest(executionId);
        if (!semanticEvidence) {
          await observerStore.markSemanticEvidenceInsufficient(executionId);
          await store.event?.('semantic-evidence-insufficient', { executionId });
          output.push({ executionId, status: 'semantic-evidence-insufficient' });
          continue;
        }
        const join = foundry.createEvidenceJoin({ digest, envelope: semanticEvidence });
        const joined = await observerStore.appendJoin(join);
        appended = { digest, join, result: { status: 'duplicate', state: (await observerStore.getSemantic(executionId)) ? 'observed' : 'semantic-analysis-pending', task: joined.task } };
      } else appended = await foundry.digestAndAppend(observerStore, input);
      if (!semanticEvidence) { await store.event?.('semantic-evidence-insufficient', { executionId }); output.push({ executionId, status: 'semantic-evidence-insufficient' }); continue; }
      if (appended.result.state === 'observed') { output.push({ executionId, status: 'observed' }); continue; }
      const semantic = semanticResultFile
        ? await readBoundedJson(semanticResultFile)
        : reflection ? await invokeReflection(appended.result.task || foundry.createSemanticObservationTask(appended.digest, appended.join), reflection) : undefined;
      if (!semantic) { output.push({ executionId, status: 'semantic-analysis-pending' }); continue; }
      const result = await observerStore.appendSemantic(executionId, semantic);
      output.push({ executionId, status: result.status === 'duplicate' ? 'observed' : result.status });
    } catch (error) {
      if (appended) await observerStore.appendSemanticFailure(executionId, safeFailure(error), 1).catch(() => {});
      output.push({ executionId, status: 'semantic-analysis-pending', failure: safeFailure(error) });
    }
  }
  return output;
}

export async function exportObserver(observerStore) {
  const { joinedRecords } = await import(process.env.CT_RUNTIME_OBSERVER_MODULE || '../../CT-Foundry/capabilities/observer/observer.mjs');
  return canonicalJson(await joinedRecords(observerStore)) + '\n';
}

async function invokeReflection(task, reflection) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-observer-'));
  const taskFile = path.join(directory, 'task.json');
  const resultFile = path.join(directory, 'semantic.json');
  try {
    await writeFile(taskFile, canonicalJson(task), { mode: 0o600 });
    const prompt = `Read the Observer task from ${taskFile}. Write only the requested semantic JSON object to ${resultFile}. Do not start or observe another runtime execution.`;
    const args = ['run', ...(reflection.args || []), ...(reflection.model ? ['--model', reflection.model] : []), ...(reflection.agent ? ['--agent', reflection.agent] : []), prompt];
    const result = await runProcess({ command: reflection.command || 'opencode', args, env: { CT_RUNTIME_OBSERVER_TASK_FILE: taskFile, CT_RUNTIME_OBSERVER_RESULT_FILE: resultFile }, timeoutMs: reflection.timeoutMs || 300000, maxOutput: 4096 });
    if (result.error || result.timedOut || result.code !== 0) throw Object.assign(new Error(result.timedOut ? 'reflection timed out' : 'reflection provider failed'), { name: result.timedOut ? 'TimeoutError' : 'ProviderError' });
    return readBoundedJson(resultFile);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function readBoundedJson(target) {
  const handle = await open(target, 'r');
  try { const stat = await handle.stat(); if (stat.size > MAX_SEMANTIC_BYTES) throw Object.assign(new Error('semantic JSON exceeds 64 KiB'), { name: 'ValidationError' }); return JSON.parse(await handle.readFile('utf8')); }
  finally { await handle.close(); }
}

function isObserverExecution(manifest) { return manifest.execution.agent?.toLowerCase() === 'observer' || manifest.execution.wake_reason === 'observer' || manifest.execution.task?.toLowerCase().includes('observer reflection'); }
function safeFailure(error) {
  const classes = new Set(['ValidationError', 'SchemaError', 'TimeoutError', 'NetworkError', 'ProviderError', 'UnknownError']);
  const errorClass = classes.has(error?.name) ? error.name : error instanceof SyntaxError ? 'SchemaError' : 'UnknownError';
  const reason = errorClass === 'TimeoutError' ? 'timeout' : errorClass === 'ProviderError' ? 'provider-error' : 'semantic-observation-rejected';
  return { errorClass, reason, retryable: ['TimeoutError', 'NetworkError', 'ProviderError'].includes(errorClass) };
}
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
