import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const text = async (name) => readFile(path.join(root, name), 'utf8');

test('Docker build preserves application directories and admits only Observer source files', async () => {
  const dockerfile = await text('Dockerfile');
  assert.match(dockerfile, /COPY lib\/ \.\/lib\//);
  assert.match(dockerfile, /COPY bin\/ \.\/bin\//);
  assert.match(dockerfile, /COPY migrations\/ \.\/migrations\//);
  assert.doesNotMatch(dockerfile, /^COPY\s+\.\s/m);
  assert.doesNotMatch(dockerfile, /git clone|sparse-checkout/);
  assert.equal([...dockerfile.matchAll(/raw\.githubusercontent\.com[^\n]+capabilities\/observer\/([^"\s]+)/g)].map((match) => match[1]).sort().join(','), 'observer.mjs,schema.mjs');
  assert.match(dockerfile, /OPENCODE_VERSION=1\.18\.25/);
  assert.match(dockerfile, /USER ctruntime/);
});

test('Docker context is allowlist-only', async () => {
  const ignore = await text('.dockerignore');
  assert.equal(ignore.split(/\r?\n/)[0], '**');
  for (const forbidden of ['README.md', 'STATE.md', 'test/', '.git', 'runtime-store']) assert.equal(ignore.includes(`!${forbidden}`), false);
});

test('deployment templates use the runtime entrypoint and authenticated Cloud Run v2 invocation', async () => {
  const cloud = await text('deploy/cloud-run.sh');
  const systemd = await text('deploy/oracle-systemd.service.example');
  assert.match(cloud, /gcloud run jobs "\$operation"/);
  assert.doesNotMatch(cloud, /--command=/);
  assert.match(cloud, /--args="scheduler,--model,/);
  assert.match(cloud, /run\.googleapis\.com\/v2\/projects\/\$\{PROJECT_ID\}\/locations\/\$\{REGION\}\/jobs\/\$\{JOB_NAME\}:run/);
  assert.match(cloud, /--oauth-service-account-email/);
  assert.match(systemd, /--read-only/);
  assert.match(systemd, /--tmpfs \/tmp:/);
  assert.match(systemd, / scheduler --model /);
});

test('CI has structurally valid indentation and required gates', async () => {
  const workflow = await text('.github/workflows/ci.yml');
  assert.equal(workflow.includes('\t'), false);
  for (const line of workflow.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    assert.equal((line.match(/^ */)[0].length % 2), 0, `odd YAML indentation: ${line}`);
  }
  for (const required of ['server /data', 'test:postgres', 'test:s3', 'outputs: type=cacheonly', 'linux/amd64,linux/arm64', '--read-only', 'needs:']) assert.match(workflow, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(workflow, /^\s+with:\s+\{/m);
  const cli = await text('bin/ct-runtime.mjs');
  assert.match(cli, /export-observer[\s\S]+exportObserver\(configured\.observerStore\)/);
});
