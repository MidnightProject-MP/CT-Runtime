import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const gate = fileURLToPath(new URL('../.github/scripts/clasp-run-gate.sh', import.meta.url));
const FALSE_GREEN = 'Unable to run script function. Please make sure you have permission to run the script function.';

function runGate({ logName, label, requires, failOns = [], stubJs }) {
  const dir = mkdtempSync(join(tmpdir(), 'clasp-gate-'));
  const log = join(dir, logName);
  const stub = join(dir, 'stub.mjs');
  writeFileSync(stub, stubJs);
  const args = [gate, log, label];
  for (const r of requires) args.push('--require', r);
  for (const f of failOns) args.push('--fail-on', f);
  args.push('--', process.execPath, stub);
  const result = spawnSync('bash', args, { encoding: 'utf8' });
  return { ...result, log };
}

test('false-green Execution API output fails the gate despite exit 0', () => {
  const r = runGate({
    logName: 'false-green.log',
    label: 'configureFeedbackInbox',
    requires: ['spreadsheet_id'],
    stubJs: `console.log(${JSON.stringify(FALSE_GREEN)});`,
  });
  assert.notEqual(r.status, 0);
  assert.match((r.stderr || '') + (r.stdout || ''), /semantic failure/);
});

test('missing semantic payload fails the gate despite exit 0', () => {
  const r = runGate({
    logName: 'missing-payload.log',
    label: 'diagnoseFeedbackInbox',
    requires: ['script_id', 'expected-spreadsheet-id'],
    stubJs: `console.log(JSON.stringify({script_id:'x'}));`,
  });
  assert.notEqual(r.status, 0);
  assert.match((r.stderr || '') + (r.stdout || ''), /expected result payload/);
});

test('nonzero exit fails the gate', () => {
  const r = runGate({
    logName: 'nonzero.log',
    label: 'setupFeedbackSheet',
    requires: ['spreadsheet_id'],
    stubJs: `console.log('spreadsheet_id'); process.exit(3);`,
  });
  assert.equal(r.status, 3);
});

test('expected payload passes the gate', () => {
  const r = runGate({
    logName: 'good.log',
    label: 'repairFeedbackHeaderRowAdmission',
    requires: ['repaired', 'work-order-1', 'wake-1'],
    stubJs: `console.log(JSON.stringify({status:'repaired',work_order_id:'work-order-1',wake_id:'wake-1'}));`,
  });
  assert.equal(r.status, 0);
});

test('gate script refuses to run without required payload contract', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clasp-gate-'));
  const log = join(dir, 'no-require.log');
  const stub = join(dir, 'stub.mjs');
  writeFileSync(stub, `console.log('hi');`);
  const r = spawnSync('bash', [gate, log, 'label', '--', process.execPath, stub], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
});

test('workflows route clasp execution and GAS administration through explicit gates', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['.github/workflows/gas-feedback-repair.yml', '.github/workflows/gas-live-inspect.yml']) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(text, /clasp-run-gate\.sh/);
    assert.doesNotMatch(text, /PIPESTATUS/);
    assert.ok(!/^[\s]*clasp run/m.test(text), `${file} must not invoke bare clasp run`);
  }
  const deploy = await readFile(new URL('../.github/workflows/gas-clasp-deploy.yml', import.meta.url), 'utf8');
  assert.match(deploy, /tokens\.default/);
  assert.match(deploy, /gas-admin-call\.mjs/);
  assert.match(deploy, /CT_GAS_ADMIN_SECRET/);
  assert.doesNotMatch(deploy, /clasp run/);
  const health = await readFile(new URL('../.github/workflows/gas-auth-health.yml', import.meta.url), 'utf8');
  assert.match(health, /clasp show-file-status --json/);
  assert.match(health, /reauthorization-required/);
  assert.doesNotMatch(health, /clasp run/);
});
