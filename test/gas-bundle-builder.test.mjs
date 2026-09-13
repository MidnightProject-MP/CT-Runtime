import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const deployableFiles = [
  'appsscript.json',
  'gas_actions.js',
  'gas_agent_executor.js',
  'gas_bootstrap.js',
  'gas_chronicle.js',
  'gas_core.js',
  'gas_deploy.js',
  'gas_evidence.js',
  'gas_federation.js',
  'gas_feedback.js',
  'gas_github.js',
  'gas_migrate.js',
  'gas_observer.js',
  'gas_state.js',
  'gas_trigger.js',
  'gas_v8.js'
];

test('builds exactly the clasp deployment file set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ct-runtime-gas-bundle-'));
  const output = join(root, 'bundle.json');
  try {
    for (const name of deployableFiles) {
      const source = name === 'appsscript.json' ? '{"runtimeVersion":"V8"}' : 'function test() {}';
      await writeFile(join(root, name), source, 'utf8');
    }
    await writeFile(join(root, 'core.mjs'), 'import x from "x";', 'utf8');
    await writeFile(join(root, 'README.md'), '# readme', 'utf8');
    await writeFile(join(root, 'schema.md'), '# schema', 'utf8');

    await execFileAsync(process.execPath, ['scripts/build-gas-bundle.mjs', root, output], { cwd: process.cwd() });
    const bundle = JSON.parse(await readFile(output, 'utf8'));
    const names = bundle.files.map((file) => file.name).sort();

    assert.equal(bundle.files.length, 16);
    assert.deepEqual(names, [...deployableFiles].sort());
    assert.ok(!names.includes('core.mjs'));
    assert.ok(!names.includes('README.md'));
    assert.ok(!names.includes('schema.md'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
