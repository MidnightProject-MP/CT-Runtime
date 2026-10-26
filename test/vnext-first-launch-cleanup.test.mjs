import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCleanupResults } from '../scripts/vnext-first-launch-cleanup.mjs';

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
