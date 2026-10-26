import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import { existsSync } from 'node:fs';
import { rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const removedCommands = ['run', 'wake', 'schedule', 'scheduler', 'recover'];

function runCli(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/ct-runtime.mjs', command, ...args], {
      cwd: repoRoot,
      env: { ...process.env },
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

test('removed legacy autonomous commands fail before creating a store', async () => {
  for (const command of removedCommands) {
    const store = path.join(os.tmpdir(), `ct-runtime-removed-${command}-${process.pid}`);
    await rm(store, { recursive: true, force: true });
    const result = await runCli(command, ['--store', store]);
    assert.equal(result.code, 2, `${command}: ${result.stderr}`);
    assert.match(result.stderr, /bin\/vnext-pilot\.mjs/);
    assert.equal(existsSync(store), false, `${command} created a store before failing`);
  }
});

test('help points to the vNext pilot and omits removed command surfaces', async () => {
  const result = await runCli('--help');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /bin\/vnext-pilot\.mjs/);
  assert.match(result.stdout, /vnext-pilot\.mjs migrate --config/);
  for (const command of removedCommands) {
    assert.doesNotMatch(result.stdout, new RegExp(`${command} --store`));
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

  assert.deepEqual(JSON.parse(JSON.stringify(context.gasSafetyWake())), [{ status: 'RETIRED_VNEXT', operation: 'gasSafetyWake', autonomy_mode: 'vnext' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.CT_GAS_TRIGGER.schedule({}))), { status: 'RETIRED_VNEXT', operation: 'trigger-schedule', autonomy_mode: 'vnext' });
  assert.equal(triggers.length, 0);
});
