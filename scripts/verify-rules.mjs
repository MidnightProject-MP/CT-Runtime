export const requiredSuites = [
  'test/postgres.integration.test.mjs',
  'test/observer.integration.test.mjs',
  'test/vnext-neon.integration.test.mjs',
  'test/vnext-a9-postgres.integration.test.mjs',
  'test/vnext-pilot.integration.test.mjs',
  'test/vnext-coordinator.integration.test.mjs',
  'test/vnext-coordinator-cli.integration.test.mjs',
  'test/vnext-multi-project.integration.test.mjs',
  'test/phase1-operating-boundary.test.mjs',
  'test/vnext-recoverable-dispatch.integration.test.mjs',
  'test/vnext-cancellation.integration.test.mjs',
  'test/vnext-feedback-evaluation.integration.test.mjs',
  'test/vnext-project-authority-owner.integration.test.mjs',
  'test/vnext-project-authority.integration.test.mjs',
  'test/vnext-project-authority-upgrade.integration.test.mjs',
  'test/vnext-concurrency.integration.test.mjs',
  'test/vnext-postgres-isolation.integration.test.mjs',
];

export function parseTap(output) {
  const counts = { tests: 0, pass: 0, fail: 0, skipped: 0 };
  for (const match of String(output ?? '').matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gm)) counts[match[1]] = Number(match[2]);
  return counts;
}

export function targetIssue(suite) {
  if (!suite) return 'targeted verification needs at least one suite path';
  if (!requiredSuites.includes(suite)) return `unsupported targeted suite ${suite} (choose one of the required native PostgreSQL suites)`;
  return null;
}

// Required suites must actually execute their native PostgreSQL tests. Skips
// are only tolerated when a suite declares how many it expects; the broad
// local pass may carry its usual platform/environment skips.
export function coverageIssue(label, counts, expectedSkips = 0) {
  if (counts.tests === 0) return `${label} executed no tests`;
  if (counts.skipped > expectedSkips) return `${label} skipped ${counts.skipped} test${counts.skipped === 1 ? '' : 's'} but only ${expectedSkips} expected`;
  return null;
}

export function verificationVerdict(results) {
  const issues = [];
  let skipped = 0;
  for (const result of results) {
    const counts = parseTap(result.output);
    skipped += counts.skipped;
    if (result.code !== 0) issues.push(`${result.label}: step failed`);
    if (result.coverage === 'required') {
      const issue = coverageIssue(result.label, counts, result.expectedSkips ?? 0);
      if (issue) issues.push(issue);
    } else if (result.coverage === 'broad') {
      const issue = coverageIssue(result.label, counts, Number.POSITIVE_INFINITY);
      if (issue) issues.push(issue);
    }
  }
  return { issues, skipped, pass: issues.length === 0 };
}
