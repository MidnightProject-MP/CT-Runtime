import test from 'node:test';
import assert from 'node:assert/strict';
import { GAS_SHEETS, deterministicId, validateFreeModel, proveAcrossWakes, redact, boundedBudget, createClock, buildContinuation, validateContinuation } from '../gas/core.mjs';
import { readFile } from 'node:fs/promises';

test('GAS source has no Node globals or module imports', async () => {
  const files = ['gas_core.js','gas_state.js','gas_trigger.js','gas_v8.js','gas_observer.js','gas_evidence.js','gas_agent_executor.js','gas_github.js','gas_actions.js'];
  for (const file of files) { const source = await readFile(new URL(`../gas/${file}`, import.meta.url), 'utf8'); assert.doesNotMatch(source, /\b(require|process|Buffer|import\s|export\s)\b/); }
});
test('schema, IDs, free-only model and bounded proof are deterministic', () => {
  assert.equal(GAS_SHEETS.length, 13); assert.equal(deterministicId('x', { b: 2, a: 1 }), deterministicId('x', { a: 1, b: 2 }));
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
  assert.match(readme, /Drive file ID/); assert.match(readme, /same model/); assert.match(readme, /never a scheduler/); assert.match(readme, /general_compute/);
});
