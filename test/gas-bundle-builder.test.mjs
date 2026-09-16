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
  'gas_cutover.js',
  'gas_deploy.js',
  'gas_deploy_qualify.js',
  'gas_evidence.js',
  'gas_federation.js',
  'gas_feedback.js',
  'gas_feedback_vnext.js',
  'gas_feedback_vnext_projection.js',
  'gas_feedback_vnext_transport.js',
  'gas_github.js',
  'gas_migrate.js',
  'gas_observer.js',
  'gas_state.js',
  'gas_trigger.js',
  'gas_v8.js',
  'gas_vnext_events.js',
  'gas_zz_a_dispatch.js',
  'gas_zz_auth_trace.js'
];

const canonicalDeployableFiles = deployableFiles.map((name) =>
  name === 'appsscript.json' ? 'appsscript' : name.replace(/\.js$/i, '')
);

test('builds exactly the qualified production GAS deployment file set', async () => {
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

    assert.equal(bundle.files.length, 23);
    assert.deepEqual(names, [...canonicalDeployableFiles].sort());
    assert.ok(names.includes('gas_feedback_vnext'));
    assert.ok(names.includes('gas_feedback_vnext_projection'));
    assert.ok(names.includes('gas_feedback_vnext_transport'));
    assert.ok(names.includes('gas_vnext_events'));
    assert.ok(names.includes('gas_deploy_qualify'));
    assert.ok(names.includes('gas_zz_a_dispatch'));
    assert.ok(names.includes('gas_zz_auth_trace'));
    assert.ok(!names.includes('core'));
    assert.ok(!names.includes('core.mjs'));
    assert.ok(!names.includes('README.md'));
    assert.ok(!names.includes('schema.md'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
