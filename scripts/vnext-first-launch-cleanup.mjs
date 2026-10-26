export function applyCleanupResults(report, outcomes) {
  const failures = Object.entries(outcomes)
    .filter(([, outcome]) => outcome === false || outcome === 'failed')
    .map(([name]) => name);
  report.cleanup = {
    ...outcomes,
    status: failures.length ? 'failed' : 'passed',
    failures,
  };
  if (failures.length) {
    report.result = 'failed';
    report.failure = report.failure
      ? `${report.failure}; cleanup verification failed`
      : 'cleanup verification failed';
  }
  return report;
}
