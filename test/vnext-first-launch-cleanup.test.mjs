import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCleanupResults, verifyCleanupOperation } from '../scripts/vnext-first-launch-cleanup.mjs';

test('cleanup failure makes the qualification result fail and names failed resources', () => {
  const report = { result: 'PASS' };
  applyCleanupResults(report, { database: false, runtime_role: true, systemd_cleanup_verified: false, temporary_state: true });
  assert.equal(report.result, 'failed');
  assert.equal(report.failure, 'cleanup verification failed');
  assert.deepEqual(report.cleanup.failures, ['database', 'systemd_cleanup_verified']);
});

test('intentional state retention and resources not created are explicit non-failures', () => {
  const report = { result: 'PASS' };
  applyCleanupResults(report, { database: true, role: true, systemd: 'not-created', state: 'retained' });
  assert.equal(report.result, 'PASS');
  assert.equal(report.cleanup.status, 'passed');
  assert.deepEqual(report.cleanup.failures, []);
});

test('cleanup operation exceptions and failed postconditions remain visible', async () => {
  const report = { result: 'PASS' };
  const operationFailure = await verifyCleanupOperation(async () => { throw new Error('injected drop failure'); }, async () => true);
  const postconditionFailure = await verifyCleanupOperation(async () => {}, async () => false);
  applyCleanupResults(report, {
    database: operationFailure.ok,
    database_details: operationFailure,
    temporary_state: postconditionFailure.ok,
    temporary_state_details: postconditionFailure,
  });
  assert.equal(report.result, 'failed');
  assert.deepEqual(report.cleanup.failures, ['database', 'temporary_state']);
  assert.deepEqual(report.cleanup.database_details, { ok: false, operation_succeeded: false, postcondition_verified: true });
  assert.deepEqual(report.cleanup.temporary_state_details, { ok: false, operation_succeeded: true, postcondition_verified: false });
});
