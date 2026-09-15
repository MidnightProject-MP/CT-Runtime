import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const repoRoot = new URL('..', import.meta.url);

function runCli(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/ct-runtime.mjs', command, ...args], {
      cwd: new URL(repoRoot).pathname,
      env: { ...process.env, CT_AUTONOMY_MODE: 'vnext' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('legacy CLI admission paths retire before creating a store or mutating state', async () => {
  for (const command of ['run', 'wake', 'schedule', 'scheduler', 'recover']) {
    const result = await runCli(command, ['--store', '/tmp/ct-runtime-vnext-retirement-test']);
    assert.equal(result.code, 0, `${command}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), { status: 'RETIRED_VNEXT', command, autonomy_mode: 'vnext' });
    assert.equal(result.stderr, '');
  }
});

test('GAS safety wake and trigger scheduling retire before touching legacy state', async () => {
  const source = await readFile(new URL('../gas/gas_trigger.js', import.meta.url), 'utf8');
  const properties = new Map([['CT_AUTONOMY_MODE', 'vnext']]);
  const triggers = [];
  const context = {
    Date,
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) || null, setProperty: (key, value) => properties.set(key, String(value)) }) },
    ScriptApp: { getProjectTriggers: () => triggers, newTrigger: () => { throw new Error('legacy trigger creation must not occur'); } },
    LockService: { getScriptLock: () => ({ waitLock: () => { throw new Error('legacy lock must not be acquired'); }, releaseLock: () => {} }) },
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  assert.deepEqual(context.gasSafetyWake(), [{ status: 'RETIRED_VNEXT', operation: 'gasSafetyWake', autonomy_mode: 'vnext' }]);
  assert.deepEqual(context.CT_GAS_TRIGGER.schedule({}), { status: 'RETIRED_VNEXT', operation: 'trigger-schedule', autonomy_mode: 'vnext' });
  assert.equal(triggers.length, 0);
});
