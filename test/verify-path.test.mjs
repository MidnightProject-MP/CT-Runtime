import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTap, targetIssue, verificationVerdict } from '../scripts/verify-rules.mjs';

const tap = (tests, pass, fail, skipped) => `# tests ${tests}\n# pass ${pass}\n# fail ${fail}\n# skipped ${skipped}\n`;

test('targeted verification only accepts required native PostgreSQL suites', () => {
  assert.equal(targetIssue('test/vnext-pilot.integration.test.mjs'), null);
  assert.match(targetIssue('test/s3.integration.test.mjs'), /unsupported targeted suite/);
  assert.match(targetIssue('test/not-a-suite.test.mjs'), /unsupported targeted suite/);
});

test('a zero-test required suite can never produce PASS', () => {
  const verdict = verificationVerdict([{ label: 'suite', code: 0, output: tap(0, 0, 0, 0), coverage: 'required' }]);
  assert.equal(verdict.pass, false);
  assert.match(verdict.issues.join('\n'), /executed no tests/);
});

test('an entirely skipped required suite can never produce PASS', () => {
  const verdict = verificationVerdict([{ label: 'suite', code: 0, output: tap(4, 0, 0, 4), coverage: 'required' }]);
  assert.equal(verdict.pass, false);
  assert.match(verdict.issues.join('\n'), /skipped 4 tests/);
});

test('declared required skips are distinct from missing required coverage', () => {
  assert.equal(verificationVerdict([{ label: 'local tests', code: 0, output: tap(10, 7, 0, 3), coverage: 'broad' }]).pass, true);
  assert.equal(verificationVerdict([{ label: 'local tests', code: 0, output: tap(0, 0, 0, 0), coverage: 'broad' }]).pass, false);
  assert.equal(verificationVerdict([{ label: 'suite', code: 0, output: tap(5, 4, 0, 1), coverage: 'required', expectedSkips: 1 }]).pass, true);
  assert.equal(verificationVerdict([{ label: 'suite', code: 0, output: tap(5, 3, 0, 2), coverage: 'required', expectedSkips: 1 }]).pass, false);
});

test('a failed required step can never produce PASS even with full counts', () => {
  const verdict = verificationVerdict([{ label: 'suite', code: 1, output: tap(4, 3, 1, 0), coverage: 'required' }]);
  assert.equal(verdict.pass, false);
  assert.match(verdict.issues.join('\n'), /step failed/);
});

test('parseTap reads the TAP summary rather than narrative output', () => {
  assert.deepEqual(parseTap('not ok 1 - x\n# tests 3\n# pass 2\n# fail 1\n# skipped 0\n'), { tests: 3, pass: 2, fail: 1, skipped: 0 });
});
