import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/runtime.mjs';
import { exportOpenCodeSession, backfillOpenCodeEvidence } from '../lib/evidence-pipeline.mjs';
import { deliverHistoricalEvidence, listOpenCodeSessions, auditSanitizedHistoricalEvidence, parseExport, readHistoricalEvidenceFiles, readOpenCodeExport } from '../lib/opencode-evidence.mjs';
import { createSemanticEvidenceEnvelope } from '../lib/semantic-evidence.mjs';
import { exportExecutionEvidence } from '../lib/evidence-export.mjs';
import { evidenceHash, validateExecutionEvidence } from '../lib/execution-evidence.mjs';
import { canonicalJson } from '../lib/config.mjs';

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
  assert.equal(value.toolCalls[0].input, undefined);
  const serialized = JSON.stringify(value);
  for (const text of ['Evaluate Nemotron', 'Plan ready', 'npm test', 'Completed and verified', 'do-not-keep', 'C:/work']) assert.equal(serialized.includes(text), false);
  for (const field of ['failures', 'repository', 'promptContext', 'summary', 'completionClaim']) assert.equal(value[field], undefined);
  for (const tool of value.toolCalls) for (const field of ['input', 'error', 'output']) assert.equal(tool[field], undefined);
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
  const run = async (command, args) => { calls.push(args); if (args[0] === 'db') return { code: 0, stdout: JSON.stringify([{ id: 'ses_done' }, { id: 'ses_missing' }]), truncated: { stdout: false } }; return args[1] === 'ses_missing' ? { code: 1, stdout: '', stderr: 'not found' } : { code: 0, stdout: `Exporting session: ses_done\n${JSON.stringify({ ...exported, info: { ...exported.info, id: 'ses_done' } })}`, truncated: { stdout: false } }; };
  await exportOpenCodeSession({ sessionId: 'ses_done', store, project: 'demo', run });
  const result = await backfillOpenCodeEvidence({ store, project: 'demo', run });
  assert.equal(result.discovered, 2); assert.equal(result.exported, 0); assert.equal(result.unavailable, 1); assert.equal(result.skippedCurrent, 1); assert.equal(result.results[0].status, 'unavailable');
  assert.deepEqual(calls.at(-1), ['export', 'ses_missing', '--sanitize']);
});

test('oversized or truncated exports are unavailable, not partially parsed', async () => {
  const result = await (await import('../lib/opencode-evidence.mjs')).readOpenCodeExport('ses_large', { run: async () => ({ code: 0, stdout: '{}', truncated: { stdout: true } }) });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /truncated/);
});

const sourceBytes = (suffix) => `durable semantic source ${suffix}`;
const semanticFor = (sessionId, suffix = 'one') => createSemanticEvidenceEnvelope({ lineage: { sourceSessionId: sessionId }, sources: [{ sourceId: `src-${suffix}`, sourceClass: 'execution-reported', reference: `ref-${suffix}`, sha256: crypto.createHash('sha256').update(sourceBytes(suffix)).digest('hex') }], claims: [{ claimId: `claim-${suffix}`, claimType: 'other', statement: `bounded ${suffix}`, supportSourceIds: [`src-${suffix}`] }] });
const resolveSemanticSource = (source) => sourceBytes(source.sourceId.replace(/^src-/, ''));
const successfulRun = (document = exported) => async (command, args) => ({ code: 0, stdout: `Exporting session: ${args[1]}\n${JSON.stringify({ ...document, info: { ...document.info, id: args[1] } })}`, truncated: { stdout: false } });

test('all-project discovery uses fixed read-only db query and deduplicates', async () => {
  const calls = []; const ids = await listOpenCodeSessions({ run: async (command, args) => { calls.push([command, args]); return { code: 0, stdout: JSON.stringify([{ id: 'ses_z' }, { id: 'ses_a' }, { id: 'ses_z' }]), truncated: { stdout: false } }; } });
  assert.deepEqual(calls[0][1], ['db', 'SELECT id FROM session ORDER BY time_created, id', '--format', 'json']); assert.deepEqual(ids, ['ses_a', 'ses_z']);
});

test('invalid database session row fails closed', async () => {
  await assert.rejects(() => listOpenCodeSessions({ run: async () => ({ code: 0, stdout: JSON.stringify([{ id: 'ses_ok' }, { name: 'missing' }]), truncated: { stdout: false } }) }), /invalid session ID/);
});

test('sanitized audit rejects every unknown field and rich fidelity', async () => {
  const base = parseExport(exported, 'ses_abc');
  for (const field of ['transcript', 'messages', 'text', 'content', 'payload', 'command', 'error', 'path']) {
    const { contentHash: ignored, ...withoutHash } = base; const bad = { ...withoutHash, [field]: 'secret mocked text' }; bad.contentHash = evidenceHash(bad);
    assert.throws(() => auditSanitizedHistoricalEvidence(bad), /unknown field/);
  }
  const { contentHash: ignored, ...withoutHash } = base; const nested = { ...withoutHash, tokens: { ...base.tokens, payload: 'raw transcript' } }; nested.contentHash = evidenceHash(nested);
  assert.throws(() => auditSanitizedHistoricalEvidence(nested), /unknown field/);
  for (const mutation of [{ initiator: 'raw prompt secret=leak' }, { toolCalls: [{ name: 'npm test --token secret', status: 'completed' }] }, { turns: 1.5 }]) {
    const { contentHash: oldHash, ...document } = base; const bad = { ...document, ...mutation }; bad.contentHash = evidenceHash(bad); assert.throws(() => auditSanitizedHistoricalEvidence(bad), /invalid/);
  }
  for (const mutation of [{ initiator: 'C:/Users/private/secret' }, { provider: 'https://private.example/token' }, { toolCalls: [{ name: 'C:/work/secret.txt', status: 'completed' }] }]) { const { contentHash: oldHash, ...document } = base; const bad = { ...document, ...mutation }; bad.contentHash = evidenceHash(bad); assert.throws(() => auditSanitizedHistoricalEvidence(bad), /invalid/); }
  const rich = parseExport(exported, 'ses_abc', 'rich');
  assert.throws(() => auditSanitizedHistoricalEvidence(rich), /fidelity/);
});

test('unsafe source metadata is persisted only as opaque identifiers', () => {
  const value = parseExport({ ...exported, info: { ...exported.info, agent: 'C:/Users/private/secret', model: { providerID: 'https://private.example/token', id: 'password:do-not-persist' } }, messages: [{ info: { role: 'assistant', providerID: 'safe', modelID: 'safe-model' }, parts: [{ type: 'tool', tool: 'C:/work/secret.txt', state: { status: 'output transcript' } }] }] }, 'ses_abc');
  const serialized = JSON.stringify(value); for (const text of ['C:/Users', 'https://', 'password:', 'C:/work', 'output transcript']) assert.equal(serialized.includes(text), false); auditSanitizedHistoricalEvidence(value);
});

test('export identity must exactly match the requested session', async () => {
  assert.throws(() => parseExport(exported, 'ses_other'), /session mismatch/);
  await assert.rejects(() => readOpenCodeExport('ses_other', { run: async () => ({ code: 0, stdout: JSON.stringify(exported), truncated: { stdout: false } }) }), /session mismatch/);
  assert.throws(() => parseExport({ info: { id: 'ses_abc' } }, 'ses_abc'), /structure is invalid/);
});

test('legacy sanitized evidence is re-extracted while current evidence is skipped', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-opencode-')); const store = new Store(root); const current = await exportOpenCodeSession({ sessionId: 'ses_abc', store, run: successfulRun() });
  const file = path.join(root, 'observer', 'inbox', `${encodeURIComponent(current.evidenceId)}-${current.sha256}.json`); const value = JSON.parse(await readFile(file, 'utf8'));
  const legacy = exportExecutionEvidence({ ...value, evidenceFidelity: { ...value.evidenceFidelity, extractorVersion: 1 } }); const legacyFile = path.join(root, 'observer', 'inbox', `${encodeURIComponent(legacy.evidenceId)}-${legacy.contentHash}.json`); await writeFile(file, JSON.stringify(legacy)); await rename(file, legacyFile);
  let exports = 0; const result = await backfillOpenCodeEvidence({ store, run: async (command, args) => { if (args[0] === 'db') return { code: 0, stdout: JSON.stringify([{ id: 'ses_abc' }]), truncated: { stdout: false } }; exports++; return successfulRun()(command, args); } });
  assert.equal(result.skippedCurrent, 0); assert.equal(result.exported, 1); assert.equal(exports, 1);
});

test('hash-backed exact-session semantic envelope is carried forward', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-opencode-')); const store = new Store(root); const envelope = semanticFor('ses_abc');
  await exportOpenCodeSession({ sessionId: 'ses_abc', store, semanticEnvelope: envelope, resolveSemanticSource, run: successfulRun() });
  const changed = { ...exported, info: { ...exported.info, tokens: { input: 41, output: 17 } } }; const result = await exportOpenCodeSession({ sessionId: 'ses_abc', store, resolveSemanticSource, run: successfulRun(changed) });
  const value = JSON.parse(await readFile(path.join(root, 'observer', 'inbox', `${encodeURIComponent(result.evidenceId)}-${result.sha256}.json`), 'utf8')); assert.equal(value.semanticEvidenceEnvelope.contentHash, envelope.contentHash);
});

test('semantic envelope without durable hashes is rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-opencode-')); const store = new Store(root); const envelope = createSemanticEvidenceEnvelope({ lineage: { sourceSessionId: 'ses_abc' }, sources: [{ sourceId: 's', sourceClass: 'operator-supplied', reference: 'r', sha256: null }], claims: [{ claimId: 'c', claimType: 'other', statement: 'x', supportSourceIds: ['s'] }] });
  await assert.rejects(() => exportOpenCodeSession({ sessionId: 'ses_abc', store, semanticEnvelope: envelope, run: successfulRun() }), /require sha256/);
});

test('semantic envelope sources are independently resolved and hashed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-opencode-')); const store = new Store(root); const envelope = semanticFor('ses_abc');
  await assert.rejects(() => exportOpenCodeSession({ sessionId: 'ses_abc', store, semanticEnvelope: envelope, run: successfulRun() }), /source resolver/);
  await assert.rejects(() => exportOpenCodeSession({ sessionId: 'ses_abc', store, semanticEnvelope: envelope, resolveSemanticSource: () => 'tampered', run: successfulRun() }), /source hash mismatch/);
});

test('semantic envelope session mismatch is rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-opencode-')); await assert.rejects(() => exportOpenCodeSession({ sessionId: 'ses_abc', store: new Store(root), semanticEnvelope: semanticFor('ses_other'), run: successfulRun() }), /session mismatch/);
});

test('conflicting reusable semantic envelopes fail closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-opencode-')); const store = new Store(root); const first = await exportOpenCodeSession({ sessionId: 'ses_abc', store, semanticEnvelope: semanticFor('ses_abc', 'one'), resolveSemanticSource, run: successfulRun() });
  const second = parseExport(exported, 'ses_abc'); const conflicting = exportExecutionEvidence({ ...second, semanticEvidenceEnvelope: semanticFor('ses_abc', 'two') }); await deliverHistoricalEvidence({ evidence: conflicting, store, resolveSemanticSource });
  await assert.rejects(() => exportOpenCodeSession({ sessionId: 'ses_abc', store, resolveSemanticSource, run: successfulRun() }), /conflicting semantic envelopes/); assert.ok(first.sha256);
});

test('corrupted current canonical artifact fails closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-opencode-')); const store = new Store(root); const dir = path.join(root, 'observer', 'inbox'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'opencode-session-corrupt.json'), '{not-json');
  await assert.rejects(() => backfillOpenCodeEvidence({ store, run: async () => ({ code: 0, stdout: '[]', truncated: { stdout: false } }) }), /JSON is invalid/);
  const tampered = parseExport(exported, 'ses_abc'); tampered.turns++;
  await writeFile(path.join(dir, 'opencode-session-corrupt.json'), JSON.stringify(tampered));
  await assert.rejects(() => readHistoricalEvidenceFiles(root), /hash mismatch/);
});

test('canonical filename and deterministic evidence identity are enforced', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-opencode-')); const store = new Store(root); const result = await exportOpenCodeSession({ sessionId: 'ses_abc', store, run: successfulRun() }); const dir = path.join(root, 'observer', 'inbox'); const file = path.join(dir, `${encodeURIComponent(result.evidenceId)}-${result.sha256}.json`);
  await rename(file, path.join(dir, `opencode-session-wrong-${result.sha256}.json`));
  await assert.rejects(() => backfillOpenCodeEvidence({ store, run: async () => ({ code: 0, stdout: '[]', truncated: { stdout: false } }) }), /canonical name is invalid/);
  const value = parseExport(exported, 'ses_abc'); const { contentHash: ignored, ...withoutHash } = value; const bad = { ...withoutHash, evidenceId: 'opencode-session-wrong' }; bad.contentHash = evidenceHash(bad); assert.throws(() => auditSanitizedHistoricalEvidence(bad), /identity is invalid/);
});

test('backfill continues after unavailable exports and reports truthful counts', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-opencode-'))); const seen = []; const result = await backfillOpenCodeEvidence({ store, run: async (command, args) => { seen.push(args); if (args[0] === 'db') return { code: 0, stdout: JSON.stringify([{ id: 'ses_bad' }, { id: 'ses_good' }]), truncated: { stdout: false } }; return args[1] === 'ses_bad' ? { code: 1, stdout: '' } : successfulRun()(command, args); } });
  assert.equal(result.attempted, 2); assert.equal(result.unavailable, 1); assert.equal(result.exported, 1); assert.equal(result.duplicate, 0); assert.equal(result.skippedCurrent, 0); assert.equal(seen.length, 3);
});

test('direct sanitized delivery audits before persistence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-opencode-')); const store = new Store(root); const value = parseExport(exported, 'ses_abc'); const { contentHash: ignored, ...withoutHash } = value; const bad = { ...withoutHash, command: 'must reject' }; bad.contentHash = evidenceHash(bad);
  await assert.rejects(() => deliverHistoricalEvidence({ evidence: bad, store }), /unknown field/); await assert.rejects(() => readFile(path.join(root, 'observer', 'inbox'), 'utf8'));
});

test('remote delivery retains a local canonical index for idempotent backfill', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-opencode-')); const store = new Store(root); let puts = 0;
  const evidenceStore = { put: async () => ({ objectUri: `s3://test/${++puts}` }) };
  const run = async (command, args) => args[0] === 'db' ? { code: 0, stdout: JSON.stringify([{ id: 'ses_abc' }]), truncated: { stdout: false } } : successfulRun()(command, args);
  const first = await backfillOpenCodeEvidence({ store, evidenceStore, run }); const second = await backfillOpenCodeEvidence({ store, evidenceStore, run });
  assert.equal(first.exported, 1); assert.equal(second.duplicate, 1); assert.equal(second.skippedCurrent, 0); assert.equal(puts, 2);
});

test('enabling remote delivery after a local backfill publishes the canonical artifact', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-opencode-')); const store = new Store(root); let puts = 0;
  const run = async (command, args) => args[0] === 'db' ? { code: 0, stdout: JSON.stringify([{ id: 'ses_abc' }]), truncated: { stdout: false } } : successfulRun()(command, args);
  await backfillOpenCodeEvidence({ store, run }); const result = await backfillOpenCodeEvidence({ store, evidenceStore: { put: async () => ({ objectUri: `s3://test/${++puts}` }) }, run });
  assert.equal(result.duplicate, 1); assert.equal(result.skippedCurrent, 0); assert.equal(puts, 1);
});

test('remote rerun cannot strip existing semantic evidence without its source resolver', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-opencode-')); const store = new Store(root); await exportOpenCodeSession({ sessionId: 'ses_abc', store, semanticEnvelope: semanticFor('ses_abc'), resolveSemanticSource, run: successfulRun() });
  const run = async (command, args) => args[0] === 'db' ? { code: 0, stdout: JSON.stringify([{ id: 'ses_abc' }]), truncated: { stdout: false } } : successfulRun()(command, args);
  await assert.rejects(() => backfillOpenCodeEvidence({ store, evidenceStore: { put: async () => ({}) }, run }), /requires a durable source resolver/);
  const result = await backfillOpenCodeEvidence({ store, evidenceStore: { put: async () => ({}) }, resolveSemanticSource, run }); assert.equal(result.duplicate, 1);
});

test('rich extraction cannot attach semantic evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-opencode-')); await assert.rejects(() => exportOpenCodeSession({ sessionId: 'ses_abc', store: new Store(root), extractionMode: 'rich', semanticEnvelope: semanticFor('ses_abc'), run: successfulRun() }), /only attachable to sanitized/);
});

test('canonical hashes retain legacy ordinal JSON ordering and undefined roundtrips', async () => {
  // Literal pre-reconciliation JSON, including keys whose locale ordering differs.
  const legacy = '{"evidenceId":"legacy","physicalExecutionId":"run-legacy","schema":"celestan-execution-evidence-v1","summary":{"Z":1,"_":2,"a":3,"é":4},"version":1}';
  const value = JSON.parse(legacy);
  const hash = crypto.createHash('sha256').update(legacy).digest('hex');
  assert.equal(canonicalJson(value), legacy);
  assert.equal(evidenceHash(value), hash);
  validateExecutionEvidence({ ...value, contentHash: hash });
  const input = { ...value, summary: { Z: undefined, _: [undefined, , { a: undefined, Z: 1 }], a: null } };
  const roundtrip = JSON.parse(JSON.stringify(input));
  assert.equal(canonicalJson(input), canonicalJson(roundtrip));
  assert.equal(evidenceHash(input), evidenceHash(roundtrip));
  const evidence = exportExecutionEvidence(input);
  validateExecutionEvidence(JSON.parse(JSON.stringify(evidence)));
  // A persisted pre-v2 historical artifact must remain readable, not be treated as corrupt.
  const historical = '{"evidenceId":"opencode-session-legacy","provenance":{"historical":true,"source":"opencode-cli-export","sourceSessionId":"ses_legacy"},"schema":"celestan-execution-evidence-v1","substrate":"opencode-local-historical","summary":{"Z":1,"_":2,"a":3,"é":4},"version":1}';
  const legacyHash = crypto.createHash('sha256').update(historical).digest('hex');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-opencode-'));
  const dir = path.join(root, 'observer', 'inbox'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `opencode-session-legacy-${legacyHash}.json`), historical.slice(0, -1) + `,"contentHash":"${legacyHash}"}`);
  assert.equal((await readHistoricalEvidenceFiles(root))[0].contentHash, legacyHash);
});

test('malformed export diagnostics never echo source payloads', async () => {
  const run = async () => ({ code: 0, stdout: '{"password":"canary-private" broken}', truncated: { stdout: false } });
  const result = await readOpenCodeExport('ses_abc', { run });
  assert.equal(result.status, 'unavailable');
  assert.equal(JSON.stringify(result).includes('canary-private'), false);
  await assert.rejects(() => listOpenCodeSessions({ run }), (error) => !error.message.includes('canary-private') && /invalid JSON/.test(error.message));
});

test('nested session lineage and invalid extraction modes fail closed', () => {
  for (const messages of [[{ info: { role: 'assistant', sessionID: 'ses_other' }, parts: [] }], [{ info: { role: 'assistant' }, parts: [{ type: 'text', sessionID: 'ses_other' }] }]]) {
    assert.throws(() => parseExport({ ...exported, messages }, 'ses_abc'), /session mismatch/);
  }
  assert.throws(() => parseExport(exported, 'ses_abc', 'typo'), /extraction mode/);
  assert.throws(() => parseExport({ ...exported, messages: [null] }, 'ses_abc'), /structure is invalid/);
});

test('closed metadata audit rejects route text and null semantic envelopes', () => {
  const base = parseExport(exported, 'ses_abc');
  for (const mutation of [{ modelAttribution: { ...base.modelAttribution, sessionDefaultRoute: { ...base.modelAttribution.sessionDefaultRoute, availability: 'private transcript' } } }, { semanticEvidenceEnvelope: null }]) {
    const bad = { ...base, ...mutation }; bad.contentHash = evidenceHash(bad);
    assert.throws(() => auditSanitizedHistoricalEvidence(bad));
  }
});

test('direct export cannot silently strip previously attached semantic evidence', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-opencode-')));
  await exportOpenCodeSession({ sessionId: 'ses_abc', store, semanticEnvelope: semanticFor('ses_abc'), resolveSemanticSource, run: successfulRun() });
  await assert.rejects(() => exportOpenCodeSession({ sessionId: 'ses_abc', store, run: successfulRun() }), /source resolver/);
});

test('concurrent revisions preserve immutable predecessor lineage', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-opencode-')));
  const results = await Promise.all([40, 41, 42].map((input) => exportOpenCodeSession({ sessionId: 'ses_abc', store, run: successfulRun({ ...exported, info: { ...exported.info, tokens: { input, output: 17 } } }) })));
  results.sort((a, b) => a.revision.number - b.revision.number);
  assert.deepEqual(results.map((r) => r.revision.number), [1, 2, 3]);
  for (let i = 1; i < results.length; i++) assert.equal(results[i].revision.predecessorContentHash, results[i - 1].sha256);
  for (const result of results) validateExecutionEvidence(JSON.parse(await readFile(path.join(store.root, 'observer', 'inbox', `${result.evidenceId}-${result.sha256}.json`), 'utf8')));
});

test('paused remote publisher does not fork revision lineage', async () => {
  const store = new Store(await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-opencode-')));
  // Establish baseline revision 1
  const base = await exportOpenCodeSession({ sessionId: 'ses_abc', store, run: successfulRun({ ...exported, info: { ...exported.info, tokens: { input: 40, output: 17 } } }) });
  assert.equal(base.revision.number, 1);
  let remoteCalls = 0;
  const delayedEvidenceStore = {
    put: async (arg) => {
      remoteCalls++;
      // Simulate slow remote that would exceed lock TTL if held inside critical section
      // Increased delay to avoid flakiness on slower CI; local write is outside remote.
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { objectUri: `s3://test/${remoteCalls}`, objectKey: arg.label, bytes: arg.content.length };
    }
  };
  const firstInput = 41, secondInput = 42;
  const firstPromise = exportOpenCodeSession({ sessionId: 'ses_abc', store, evidenceStore: delayedEvidenceStore, run: successfulRun({ ...exported, info: { ...exported.info, tokens: { input: firstInput, output: 17 } } }) });
  // Wait for first's local revision to be durably written (remote still delayed) before starting second.
  // Polling avoids brittle fixed sleeps and races on slower runners.
  const pollDeadline = Date.now() + 2000;
  while (Date.now() < pollDeadline) {
    const files = await readHistoricalEvidenceFiles(store.root);
    if (files.length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Ensure the local file exists before proceeding; timeout prevents deadlock.
  {
    const files = await readHistoricalEvidenceFiles(store.root);
    if (files.length < 2) throw new Error('timed out waiting for first local revision to appear');
  }
  const secondPromise = exportOpenCodeSession({ sessionId: 'ses_abc', store, evidenceStore: delayedEvidenceStore, run: successfulRun({ ...exported, info: { ...exported.info, tokens: { input: secondInput, output: 17 } } }) });
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  const revisions = [first.revision.number, second.revision.number].sort((a, b) => a - b);
  assert.deepEqual(revisions, [2, 3]);
  assert.notEqual(first.sha256, second.sha256);
  // Predecessor chain must be linear, not forked from same parent
  const ordered = [first, second].sort((a, b) => a.revision.number - b.revision.number);
  assert.equal(ordered[0].revision.predecessorContentHash, base.sha256);
  assert.equal(ordered[1].revision.predecessorContentHash, ordered[0].sha256);
  assert.equal(remoteCalls, 2);
  // Local inbox must contain three distinct revisions
  const files = await readHistoricalEvidenceFiles(store.root);
  assert.equal(files.length, 3);
  assert.deepEqual(files.map((f) => f.revision.number).sort((a, b) => a - b), [1, 2, 3]);
});
