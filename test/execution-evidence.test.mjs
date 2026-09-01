import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionEvidence, evidenceHash, validateExecutionEvidence } from '../lib/execution-evidence.mjs';
import { exportExecutionEvidence } from '../lib/evidence-export.mjs';

test('execution evidence is versioned, hashed, bounded, and factual', () => {
  const evidence = exportExecutionEvidence({ evidenceId: 'ev-1', physicalExecutionId: 'px-1', substrate: 'opencode-local', summary: 'tests failed', secret: 'must-not-export', tests: [{ name: 'unit', result: 'failed' }] });
  assert.equal(evidence.schema, 'celestan-execution-evidence-v1');
  assert.equal(evidence.secret, undefined);
  assert.equal(evidenceHash(evidence), evidence.contentHash);
  assert.equal(validateExecutionEvidence(evidence), evidence);
  assert.throws(() => validateExecutionEvidence({ ...evidence, summary: 'tampered' }), /hash mismatch/);
});

test('exporter allowlists fields and redacts nested credential-shaped keys', () => {
  const evidence = exportExecutionEvidence({ evidenceId: 'ev-2', physicalExecutionId: 'px-2', substrate: 'container', tokens: { input: 1 }, unrelated: 'drop' });
  assert.equal(evidence.unrelated, undefined);
  assert.equal(evidence.tokens.input, 1);
  assert.equal(exportExecutionEvidence({ evidenceId: 'ev-3', physicalExecutionId: 'px-3', substrate: 'gas', review: { githubToken: 'secret' } }).review.githubToken, undefined);
});
