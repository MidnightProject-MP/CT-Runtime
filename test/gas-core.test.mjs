import test from 'node:test';
import assert from 'node:assert/strict';
import { GAS_SHEETS, deterministicId, validateFreeModel, proveAcrossWakes, redact, boundedBudget, createClock, buildContinuation, validateContinuation } from '../gas/core.mjs';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createSemanticEvidenceEnvelope } from '../lib/semantic-evidence.mjs';
import { canonicalJson } from '../lib/config.mjs';

test('GAS source has no Node globals or module imports', async () => {
  const files = ['gas_core.js','gas_state.js','gas_trigger.js','gas_federation.js','gas_v8.js','gas_observer.js','gas_evidence.js','gas_agent_executor.js','gas_github.js','gas_actions.js'];
  for (const file of files) { const source = await readFile(new URL(`../gas/${file}`, import.meta.url), 'utf8'); assert.doesNotMatch(source, /\b(require|process|Buffer|import\s|export\s)\b/); }
});
test('schema, IDs, free-only model and bounded proof are deterministic', () => {
  assert.equal(GAS_SHEETS.length, 14); assert.equal(deterministicId('x', { b: 2, a: 1 }), deterministicId('x', { a: 1, b: 2 }));
  assert.throws(() => validateFreeModel('openrouter/foo/bar')); assert.equal(validateFreeModel('openrouter/foo/bar:free'), 'openrouter/foo/bar:free');
  assert.equal(proveAcrossWakes([], 1).step, 'A'); assert.equal(proveAcrossWakes([{ key: 'proof', state: 'checkpointed' }], 1).step, 'B');
  assert.equal(redact('token=abc', ['abc']), 'token=[REDACTED]');
});
test('cooperative clock admits no unsafe operation and bounds configuration', () => {
  assert.equal(boundedBudget(1), 30000); assert.equal(boundedBudget(999999), 300000); assert.equal(boundedBudget('bad'), 240000);
  let now = 1000; const clock = createClock(now, 30000, () => now);
  assert.equal(clock.canStart(19000), true); now += 11000; assert.equal(clock.canStart(11000), false); assert.equal(clock.signal(), 'stop');
});
test('semantic continuation validates and reconstructs without transcript fields', () => {
  const c = buildContinuation({ goal: 'g', completed: ['A'], decisions: ['d'], evidence: ['sha256:x'], provenance: ['drive'], outstanding: ['B'], next_operation: 'verify', reason: 'budget', resumed_from: 'execution-1', physical_execution_count: 2, work_order_id: 'order-1' });
  assert.equal(validateContinuation(c).work_order_id, 'order-1'); assert.equal(c.version, 1); assert.throws(() => validateContinuation({ ...c, next_operation: '' }));
});
test('GAS contracts document immutable Drive identity, retry deferral, Actions boundary and checkpoint budget', async () => {
  const readme = await readFile(new URL('../gas/README.md', import.meta.url), 'utf8');
  assert.match(readme, /Drive file ID/); assert.match(readme, /same model/); assert.match(readme, /never a scheduler/); assert.match(readme, /general_compute/); assert.match(readme, /quota_exhausted/); assert.match(readme, /not a default or standing fallback/);
});
test('execution bodies persist evidence without invoking semantic Observer', async () => {
  const execution = await readFile(new URL('../gas/gas_v8.js', import.meta.url), 'utf8');
  const federation = await readFile(new URL('../gas/gas_federation.js', import.meta.url), 'utf8');
  const trigger = await readFile(new URL('../gas/gas_trigger.js', import.meta.url), 'utf8');
  assert.doesNotMatch(execution, /CT_GAS_OBSERVER\.(pass|consume)/);
  assert.doesNotMatch(federation, /CT_GAS_OBSERVER\.(pass|consume)/);
  assert.match(execution, /storeEvidence\(/);
  assert.match(trigger, /observePendingEvidence\(/);
});
test('legacy inline observations are not re-enqueued by the inbox Observer', async () => {
  const observer = await readFile(new URL('../gas/gas_observer.js', import.meta.url), 'utf8');
  assert.match(observer, /folders\(\)\[1\]/);
  assert.doesNotMatch(observer, /observer_ledger.*inbox|inbox.*observer_ledger/);
});
test('historical OpenCode eligibility separates sanitized structure from rich recovery provenance', async () => {
  const observer = await readFile(new URL('../gas/gas_observer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(observer, /value\.substrate==='opencode-local-historical' \|\| !validSemanticEnvelope/);
  assert.match(observer, /f\.mode==='sanitized'/);
  assert.match(observer, /f\.sourceView==='sanitized-structural'/);
  assert.match(observer, /rich extraction is recovery-only/);
  assert.match(observer, /validated claim envelope is unavailable/);
  assert.match(observer, /celestan-legacy-artifact-classification-v1/);
  assert.match(observer, /semanticEligibility:'ineligible'/);
});

test('GAS admits sanitized historical structure only with a runtime-valid envelope', async () => {
  const context = vm.createContext({ console, JSON, Date, isFinite, PropertiesService: {}, CT_GAS_STATE: {}, CT_GAS_EVIDENCE: {}, CT_GAS_AGENT: {}, MimeType: {}, Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest(_algorithm, text) { return [...crypto.createHash('sha256').update(String(text)).digest()].map((byte) => byte > 127 ? byte - 256 : byte); } } });
  vm.runInContext(await readFile(new URL('../gas/gas_core.js', import.meta.url), 'utf8'), context);
  vm.runInContext(await readFile(new URL('../gas/gas_observer.js', import.meta.url), 'utf8'), context);
  const envelope = createSemanticEvidenceEnvelope({ lineage: { physicalExecutionId: 'historical-observer-1', workOrderId: 'work-1' }, sources: [{ sourceId: 'source-1', sourceClass: 'operator-supplied', reference: 'operator://claim-1', sha256: null, sourceExecutionId: null }], claims: [{ claimId: 'claim-1', claimType: 'objective', statement: 'Evaluate the historical execution.', supportSourceIds: ['source-1'] }] });
  const sanitized = { substrate: 'opencode-local-historical', evidenceFidelity: { mode: 'sanitized', sourceView: 'sanitized-structural', semanticEligibility: 'structural-only', rawSourceDocumentPersisted: false, derivedTextPersisted: false }, semanticEvidenceEnvelope: envelope };
  assert.equal(context.CT_GAS_OBSERVER.semanticEligibility(sanitized).eligible, true);
  assert.equal(context.CT_GAS_OBSERVER.semanticEligibility(JSON.parse(canonicalJson(sanitized))).eligible, true);
  assert.equal(context.CT_GAS_OBSERVER.semanticEligibility({ ...sanitized, semanticEvidenceEnvelope: undefined }).reason, 'validated claim envelope is unavailable');
  assert.equal(context.CT_GAS_OBSERVER.semanticEligibility({ ...sanitized, evidenceFidelity: { ...sanitized.evidenceFidelity, mode: 'rich', sourceView: 'ephemeral-unsanitized-rich-extraction', derivedTextPersisted: true } }).reason, 'rich extraction is recovery-only');
  assert.equal(context.CT_GAS_OBSERVER.validSemanticEnvelope({ ...envelope, sources: [{ ...envelope.sources[0], sourceClass: 'self-verified' }] }), false);
});

test('GAS Observer chunks a bounded semantic envelope within message limits', async () => {
  let request;
  const context = vm.createContext({ console, JSON, Date, isFinite, PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'minimax/minimax-m3:free' }) }, CT_GAS_STATE: {}, CT_GAS_EVIDENCE: {}, CT_GAS_AGENT: { execute(value) { request = value; return { status: 'complete', output: '{"schema":"celestan-semantic-observation-v1"}' }; } }, MimeType: {}, Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest(_algorithm, text) { return [...crypto.createHash('sha256').update(String(text)).digest()].map((byte) => byte > 127 ? byte - 256 : byte); } } });
  vm.runInContext(await readFile(new URL('../gas/gas_core.js', import.meta.url), 'utf8'), context);
  vm.runInContext(await readFile(new URL('../gas/gas_observer.js', import.meta.url), 'utf8'), context);
  const sources = [{ sourceId: 'source-1', sourceClass: 'mechanically-verified', reference: 'test://source', sha256: 'a'.repeat(64), sourceExecutionId: 'execution-1' }];
  const claims = Array.from({ length: 6 }, (_, index) => ({ claimId: `claim-${index}`, claimType: 'verification', statement: 'x'.repeat(700), supportSourceIds: ['source-1'] }));
  const semanticEvidenceEnvelope = createSemanticEvidenceEnvelope({ lineage: { physicalExecutionId: 'physical-1', workOrderId: 'work-1' }, sources, claims });
  const result = context.CT_GAS_OBSERVER.infer({ evidenceId: 'evidence-1', semanticEvidenceEnvelope }, { canStart: () => true });
  assert.equal(result.schema, 'celestan-semantic-observation-v1');
  assert.equal(request.maxTokens, 2048);
  assert.ok(request.messages.length > 2);
  assert.ok(request.messages.every((message) => message.content.length <= context.CT_GAS.MAX_MESSAGE));
});
