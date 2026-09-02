import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/runtime.mjs';
import { exportOpenCodeSession, backfillOpenCodeEvidence } from '../lib/evidence-pipeline.mjs';
import { validateExecutionEvidence } from '../lib/execution-evidence.mjs';

const exported = { info: { id: 'ses_abc', model: { providerID: 'openai', id: 'gpt-5.6-luna' }, agent: 'build', directory: 'C:/work', summary: { additions: 1, deletions: 0, files: 1 }, time: { created: 1767225600000, updated: 1767225601000 }, tokens: { input: 40, output: 17 } }, messages: [
  { info: { role: 'user', agent: 'build', time: { created: 1767225600000 } }, parts: [{ type: 'text', text: 'Evaluate Nemotron; password=do-not-keep' }] },
  { info: { role: 'assistant', providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'medium', agent: 'planner', time: { created: 1767225600100, completed: 1767225600200 }, tokens: { input: 4, output: 2 } }, parts: [{ type: 'text', text: 'Plan ready' }] },
  { info: { role: 'assistant', providerID: 'openai', modelID: 'gpt-5.6-luna', agent: 'build', time: { created: 1767225600300, completed: 1767225600400 }, tokens: { input: 5, output: 3 } }, parts: [{ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'npm test --token do-not-keep', secret: 'drop' }, output: 'npm test passed', time: { start: 1767225600300, end: 1767225600350 } } }] },
  { info: { role: 'assistant', providerID: 'openrouter', modelID: 'nemotron-3.5-lightning-free', agent: 'reviewer', time: { created: 1767225600500, completed: 1767225600600 }, tokens: { input: 6, output: 4 } }, parts: [{ type: 'text', text: 'Reviewer finding: implementation is bounded.' }] },
  { info: { role: 'assistant', agent: 'build', time: { created: 1767225600700, completed: 1767225600800 }, tokens: { input: 2, output: 1 } }, parts: [{ type: 'retry' }, { type: 'text', text: 'Completed and verified.' }] }
] };

test('OpenCode export uses the supported sanitized CLI and creates historical evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-opencode-'));
  const store = new Store(root); const calls = [];
  const result = await exportOpenCodeSession({ sessionId: 'ses_abc', store, project: 'demo', run: async function run(command, args) { calls.push([command, args]); return { code: 0, stdout: `Exporting session: ses_abc\n${JSON.stringify(exported)}`, truncated: { stdout: false } }; } });
  assert.deepEqual(calls[0][1], ['export', 'ses_abc', '--sanitize']);
  const value = JSON.parse(await readFile(path.join(root, 'observer', 'inbox', `${encodeURIComponent(result.evidenceId)}-${result.sha256}.json`), 'utf8'));
  assert.equal(value.physicalExecutionId, undefined);
  assert.equal(value.provenance.sourceSessionId, 'ses_abc');
  assert.equal(value.promptContext, undefined);
  assert.equal(value.startedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(value.canonicalModel, undefined);
  assert.equal(value.modelAttribution.sessionDefaultRoute.identity.model, 'gpt-5.6-luna');
  assert.deepEqual(value.modelAttribution.assistantMessageRouteMetadata.aggregates.map((item) => item.identity.model).filter(Boolean).sort(), ['gpt-5.6-luna', 'gpt-5.6-sol', 'nemotron-3.5-lightning-free']);
  assert.equal(value.modelAttribution.assistantMessageRouteMetadata.aggregates.some((item) => item.identity.availability === 'unavailable'), true);
  assert.equal(value.evidenceFidelity.semanticEligibility, 'structural-only');
  assert.equal(value.semanticAvailability.completion.availability, 'unavailable');
  assert.equal(value.toolCalls[0].durationMs, 50);
  assert.equal(value.toolCalls[0].input.secret, undefined);
  assert.equal(validateExecutionEvidence(value).contentHash, result.sha256);
});

test('rich export is ephemeral, redacted, and creates an explicit idempotent revision', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-opencode-')); const store = new Store(root); const calls = [];
  const run = async (command, args) => { calls.push(args); return { code: 0, stdout: `Exporting session: ses_abc\n${JSON.stringify(exported)}`, truncated: { stdout: false } }; };
  const sanitized = await exportOpenCodeSession({ sessionId: 'ses_abc', store, project: 'demo', run });
  const rich = await exportOpenCodeSession({ sessionId: 'ses_abc', store, project: 'demo', run, extractionMode: 'rich' });
  const duplicate = await exportOpenCodeSession({ sessionId: 'ses_abc', store, project: 'demo', run, extractionMode: 'rich' });
  assert.deepEqual(calls[1], ['export', 'ses_abc']);
  assert.equal(rich.revision.number, sanitized.revision.number + 1);
  assert.equal(rich.revision.predecessorContentHash, sanitized.sha256);
  assert.equal(duplicate.status, 'duplicate');
  const value = JSON.parse(await readFile(path.join(root, 'observer', 'inbox', `${encodeURIComponent(rich.evidenceId)}-${rich.sha256}.json`), 'utf8'));
  assert.equal(value.evidenceFidelity.rawSourceDocumentPersisted, false);
  assert.equal(value.evidenceFidelity.derivedTextPersisted, true);
  assert.equal(value.evidenceFidelity.privacyBoundary, 'allowlisted-redacted-derived-facts');
  assert.equal(value.promptContext.includes('[REDACTED]'), true);
  assert.equal(JSON.stringify(value).includes('do-not-keep'), false);
  assert.equal(value.tests[0].result, 'observed');
  assert.equal(value.retries, 1);
  assert.match(value.completionClaim, /Completed and verified/);
});

test('OpenCode backfill lists sessions, skips canonical representations, and reports missing export', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-opencode-')); const store = new Store(root); const calls = [];
  const run = async (command, args) => { calls.push(args); if (args[0] === 'session') return { code: 0, stdout: JSON.stringify([{ id: 'ses_done' }, { id: 'ses_missing' }]), truncated: { stdout: false } }; return args[1] === 'ses_missing' ? { code: 1, stdout: '', stderr: 'not found' } : { code: 0, stdout: `Exporting session: ses_done\n${JSON.stringify(exported)}`, truncated: { stdout: false } }; };
  await exportOpenCodeSession({ sessionId: 'ses_done', store, project: 'demo', run });
  const result = await backfillOpenCodeEvidence({ store, project: 'demo', run });
  assert.equal(result.discovered, 2); assert.equal(result.exported, 1); assert.equal(result.results[0].status, 'unavailable');
  assert.deepEqual(calls.at(-1), ['export', 'ses_missing', '--sanitize']);
});

test('oversized or truncated exports are unavailable, not partially parsed', async () => {
  const result = await (await import('../lib/opencode-evidence.mjs')).readOpenCodeExport('ses_large', { run: async () => ({ code: 0, stdout: '{}', truncated: { stdout: true } }) });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /truncated/);
});
