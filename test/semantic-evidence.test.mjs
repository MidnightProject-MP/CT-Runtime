import test from 'node:test';
import assert from 'node:assert/strict';
import { createSemanticEvidenceEnvelope, validateSemanticEvidence, validateSemanticEvidenceDraft, SOURCE_CLASSES } from '../lib/semantic-evidence.mjs';

const envelope = (sourceClass) => createSemanticEvidenceEnvelope({ lineage: { physicalExecutionId: 'physical-1', workOrderId: 'work-1' }, sources: [{ sourceId: 'source-1', sourceClass, reference: 'test://source', sha256: 'a'.repeat(64), sourceExecutionId: sourceClass === 'independently-reviewed' ? 'review-1' : 'physical-1' }], claims: [{ claimId: 'claim-1', claimType: 'verification', statement: 'bounded statement', supportSourceIds: ['source-1'] }] });

test('semantic evidence accepts every source classification and round-trips its hash', () => {
  for (const sourceClass of SOURCE_CLASSES) assert.deepEqual(validateSemanticEvidence(envelope(sourceClass)), envelope(sourceClass));
});

test('semantic evidence drafts reject unknown fields, dangling sources, and unsafe text', () => {
  const draft = { sources: [{ sourceId: 's', sourceClass: 'execution-reported', reference: 'x', sha256: null, sourceExecutionId: 'p' }], claims: [{ claimId: 'c', claimType: 'other', statement: 'x', supportSourceIds: ['s'] }] };
  assert.throws(() => validateSemanticEvidenceDraft({ ...draft, transcript: 'no' }), /unknown/);
  assert.throws(() => validateSemanticEvidenceDraft({ ...draft, claims: [{ ...draft.claims[0], supportSourceIds: ['missing'] }] }), /dangling/);
  assert.throws(() => validateSemanticEvidenceDraft({ ...draft, claims: [{ ...draft.claims[0], statement: 'x\n' }] }), /invalid/);
  assert.throws(() => validateSemanticEvidenceDraft({ sources: [], claims: [] }), /sources/);
  assert.throws(() => validateSemanticEvidenceDraft({ ...draft, claims: [{ ...draft.claims[0], supportSourceIds: [] }] }), /supportSourceIds/);
});

test('mechanical and reviewer source invariants are enforced', () => {
  assert.throws(() => validateSemanticEvidenceDraft({ sources: [{ sourceId: 's', sourceClass: 'mechanically-verified', reference: 'x', sha256: null, sourceExecutionId: 'p' }], claims: [{ claimId: 'c', claimType: 'other', statement: 'x', supportSourceIds: ['s'] }] }), /sha256/);
  const reviewed = envelope('independently-reviewed');
  assert.throws(() => validateSemanticEvidence({ ...reviewed, sources: [{ ...reviewed.sources[0], sourceExecutionId: 'physical-1' }] }), /distinct/);
});

test('runtime envelopes bind directly to the Foundry Observer join contract', async () => {
  const foundry = await import('../../CT-Foundry/capabilities/observer/schema.mjs');
  const value = envelope('execution-reported');
  const digest = foundry.createDigest({ execution: { executionId: 'physical-1', project: 'fixture', status: 'success' }, evidence: { references: [] } });
  const join = foundry.createEvidenceJoin({ digest, envelope: value });
  assert.deepEqual(join.claimReferences, [`${value.envelopeId}:claim-1`]);
  assert.equal(foundry.createSemanticObservationTask(digest, join).evidencePackage.structuralContext.semanticAuthority, 'none');
});
