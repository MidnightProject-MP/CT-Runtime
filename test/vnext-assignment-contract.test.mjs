import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssignment, validateAssignment, validateAssignmentDecision, validateAssignmentReport } from '../lib/vnext/assignment-contract.mjs';
import { digest } from '../lib/vnext/operating-boundary.mjs';

const workUnit = {
  work_unit_id: 'objective-1', project_id: 'project-1', objective_ref: 'objective-1',
  work_revision: 3, last_execution_id: 'execution-2', pilot: { input_seq: 7 },
};
const profiles = {
  execution: { model: 'model-a', agent: 'builder', access_class: 'bounded-mutation', permissions: ['project:write'] },
  review: { model: 'model-b', agent: 'reviewer', access_class: 'read-only', permissions: ['project:read'] },
  diagnosis: { model: 'model-c', agent: 'diagnostician', access_class: 'read-only', permissions: ['project:read'] },
  stewardship: { model: 'model-d', agent: 'steward', access_class: 'read-only', permissions: ['project:read'] },
};

test('assignment identity binds purpose, revision, captured input and independent reviewer profile', () => {
  const assignment = createAssignment({ workUnit, purpose: 'review', profile: profiles.review,
    inputSeq: 7, subjectExecutionId: 'execution-2', subjectDigest: 'a'.repeat(64), executionProfile: profiles.execution,
    assignmentWorkUnitId: 'assignment-work-1' });
  assert.equal(validateAssignment(assignment), assignment);
  assert.equal(assignment.work_revision, 3);
  assert.equal(assignment.input_seq, 7);
  assert.equal(assignment.assignment_work_unit_id, 'assignment-work-1');
  assert.throws(() => validateAssignment({ ...assignment, agent: 'builder' }), /binding is invalid/);
  assert.throws(() => createAssignment({ workUnit, purpose: 'review', profile: { ...profiles.execution, access_class: 'read-only' },
    inputSeq: 7, executionProfile: profiles.execution }), /distinct model or agent/);
  assert.throws(() => createAssignment({ workUnit, purpose: 'review', profile: { ...profiles.review, access_class: 'bounded-mutation' },
    inputSeq: 7, executionProfile: profiles.execution }), /must use a read-only/);
});

test('reports are purpose-specific and decisions bind the exact assignment report and subject', () => {
  const assignment = createAssignment({ workUnit, purpose: 'review', profile: profiles.review,
    inputSeq: 7, subjectExecutionId: 'execution-2', subjectDigest: 'b'.repeat(64), executionProfile: profiles.execution });
  const report = validateAssignmentReport(assignment, {
    outcome: 'request_changes', summary: 'The finish condition is not met.', requested_changes: 'Add and verify the missing behavior.',
  });
  assert.throws(() => validateAssignmentReport(assignment, { ...report, accepted: true }), /unexpected key/);
  assert.throws(() => validateAssignmentReport(assignment, { outcome: 'request_changes', summary: 'Needs changes.' }), /requires requested_changes/);
  const decision = {
    ref: 'celestan-review-1', outcome: 'request_changes', assignment_id: assignment.assignment_id,
    assignment_digest: assignment.assignment_digest, report_digest: digest(report), subject_digest: assignment.subject_digest,
  };
  assert.deepEqual(validateAssignmentDecision(assignment, report, decision).decision, decision);
  assert.throws(() => validateAssignmentDecision(assignment, report, { ...decision, report_digest: 'c'.repeat(64) }), /stale or mismatched/);
});
