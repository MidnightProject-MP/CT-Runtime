import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJobPayload, createNorthflankClient, validateRuntimeSecretNames } from '../lib/capabilities/northflank.mjs';
import { resolveBinding } from '../lib/capabilities/bindings.mjs';
import { CAPABILITIES } from '../lib/capabilities/definitions.mjs';

const image = `registry.example/ct-runtime@sha256:${'a'.repeat(64)}`;

test('Northflank payload matches the documented job schema', () => {
  const payload = buildJobPayload({ name: 'ct-wake', image, cron: '*/5 * * * *', activeDeadlineSeconds: 90, secretGroupIds: ['runtime-group'], providerSecretNames: ['OPENROUTER_API_KEY'], runtimeEnvironment: { CT_RUNTIME_MODE: 'production', CT_RUNTIME_FREE_ONLY: 'true' } });
  assert.deepEqual(payload.billing, { deploymentPlan: 'nf-compute-20' });
  assert.deepEqual(payload.deployment, { docker: { configType: 'default' }, storage: { ephemeralStorage: { storageSize: 1 } }, external: { imagePath: image } });
  assert.deepEqual(payload.runtimeEnvironment, { CT_RUNTIME_MODE: 'production', CT_RUNTIME_FREE_ONLY: 'true' });
  assert.deepEqual(payload.settings, { backoffLimit: 0, runOnSourceChange: 'never', activeDeadlineSeconds: 90, cron: { schedule: '*/5 * * * *', suspended: false, concurrencyPolicy: 'forbid' } });
  for (const key of ['containers', 'deploymentPlan', 'jobSettings', 'storage', 'schedule', 'volumes']) assert.equal(key in payload, false, key);
  assert.equal(JSON.stringify(payload).includes('runtime-group'), false);
  assert.equal(JSON.stringify(payload).includes('secret-value'), false);
  assert.equal('secretGroupIds' in payload, false);
  assert.equal('providerSecretNames' in payload, false);
  assert.equal('customEntrypoint' in payload.deployment.docker, false);
});

test('Northflank accepts only documented Docker config types', () => {
  assert.deepEqual(buildJobPayload({ name: 'default-job', image, secretGroupIds: ['group-1'] }).deployment.docker, { configType: 'default' });
  assert.deepEqual(buildJobPayload({ name: 'custom-job', image, secretGroupIds: ['group-1'], customEntrypoint: '/app/start' }).deployment.docker, { configType: 'customEntrypoint', customEntrypoint: '/app/start' });
  assert.throws(() => buildJobPayload({ name: 'array-job', image, secretGroupIds: ['group-1'], customEntrypoint: ['/app/start'] }), /non-empty string/);
});

test('secret allowlist rejects values and infrastructure aliases', () => {
  assert.throws(() => validateRuntimeSecretNames(['OPENROUTER_API_KEY', 'bad-name']), /invalid provider secret/);
  assert.throws(() => validateRuntimeSecretNames(['DATABASE_URL']), /infrastructure secret/);
  assert.throws(() => buildJobPayload({ name: 'x', image: 'registry.example/ct-runtime:latest', secretGroupIds: ['x'] }), /immutable/);
  assert.throws(() => buildJobPayload({ name: 'x', image }), /secretGroupIds/);
  assert.throws(() => buildJobPayload({ name: 'x', image, runtimeEnvironment: { API_TOKEN: 'secret-value' }, secretGroupIds: ['x'] }), /credentials/);
});

test('Northflank client uses bounded API paths, bearer transport, and redacted errors', async () => {
  const calls = [];
  const transport = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => url.endsWith('/runs') ? { data: { runId: 'run-1', runName: 'run' } } : { data: { status: 'SUCCESS', logs: 'x'.repeat(20) } } }; };
  const client = createNorthflankClient({ token: 'never-persist-this', projectId: 'project-1', secretGroupIds: ['group-1'], transport, maxLogBytes: 8 });
  const created = await client.createJob({ name: 'job', image, runtimeEnvironment: { CT_RUNTIME_MODE: 'production' } });
  assert.deepEqual(created, { status: 'SUCCESS', logs: 'xxxxxxxxxxxxxxxxxxxx' });
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.deployment.docker, { configType: 'default' });
  assert.equal('secretGroupIds' in body, false);
  assert.equal('providerSecretNames' in body, false);
  assert.deepEqual(await client.runJob('job'), { id: 'run-1', runName: 'run' });
  const logs = await client.getLogs('job', 'run');
  assert.equal(calls[0].url, 'https://api.northflank.com/v1/projects/project-1/jobs');
  assert.equal(calls[0].options.headers.authorization, 'Bearer never-persist-this');
  assert.equal(logs.logs.length, 8);
  assert.equal(calls[2].url, 'https://api.northflank.com/v1/projects/project-1/jobs/job/logs?runId=run&type=runtime&queryType=range');
  assert.deepEqual(client.config.requiredRuntimeSecretNames, ['CT_RUNTIME_DATABASE_URL', 'CT_RUNTIME_S3_ACCESS_KEY_ID', 'CT_RUNTIME_S3_SECRET_ACCESS_KEY']);
  assert.deepEqual(client.config.secretGroupIds, ['group-1']);
  assert.deepEqual(client.validateSecretGroupRestriction({ jobId: 'job' }).secretGroupIds, ['group-1']);
  const failing = createNorthflankClient({ token: 'token', projectId: 'p', secretGroupIds: ['g'], transport: async () => ({ ok: false, status: 500, json: async () => ({ secret: 'must-not-leak' }) }) });
  await assert.rejects(failing.getJob('j'), (error) => error.status === 500 && error.code === 'NORTHFLANK_HTTP_ERROR' && !error.message.includes('must-not-leak'));
});

test('polling is bounded and scheduler/compute remain separate capability contracts', async () => {
  let polls = 0;
  const client = createNorthflankClient({ token: 't', projectId: 'p', secretGroupIds: ['g'], maxPolls: 2, pollIntervalMs: 0, transport: async () => { polls++; return { ok: true, status: 200, json: async () => ({ data: { status: 'RUNNING' } }) }; } });
  await assert.rejects(client.pollRun('j', 'r'), /polling bound/);
  assert.equal(polls, 2);
  assert.notEqual(CAPABILITIES.scheduler, CAPABILITIES.disposable_compute);
  assert.equal(resolveBinding('disposable_compute', { env: { CT_RUNTIME_MODE: 'production' } }), 'northflank_sandbox');
  assert.equal(resolveBinding('scheduler', { env: { CT_RUNTIME_MODE: 'production' } }), 'northflank');
  assert.equal(resolveBinding('disposable_compute', { env: { CT_RUNTIME_MODE: 'filesystem' } }), 'filesystem');
});
