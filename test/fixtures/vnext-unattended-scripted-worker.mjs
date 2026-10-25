import { access, appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [scenario, controlDirectory, trialId] = process.argv.slice(2);
const request = JSON.parse(await readFile(process.env.CT_VNEXT_REQUEST_FILE, 'utf8'));
if (process.env.CT_PILOT_DATABASE_URL || process.env.TEST_DATABASE_URL || process.env.POSTGRES_URL) {
  throw new Error('scripted trial worker must not receive database credentials');
}

const purpose = request.assignment?.purpose ?? 'execution';
const invocationPath = path.join(controlDirectory, 'worker-invocations.jsonl');
let previous = [];
try { previous = (await readFile(invocationPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const priorReviews = previous.filter(row => row.purpose === 'review').length;
const invocation = {
  trial_id: trialId,
  scenario,
  execution_id: request.execution.execution_id,
  work_unit_id: request.workUnit.work_unit_id,
  purpose,
  worker_kind: 'scripted-fixture',
  model_calls: 0,
  simulated_external_effects: purpose === 'execution' ? 1 : 0,
};
await appendFile(invocationPath, `${JSON.stringify(invocation)}\n`, { mode: 0o600 });

let result;
let workerFinishedMarker = null;
if (purpose === 'stewardship') {
  result = { proposal: `Scripted bounded proposal for ${trialId}.` };
} else if (purpose === 'review') {
  if (scenario === 'fresh-input' && priorReviews === 0) {
    result = { outcome: 'request_changes', summary: 'Scripted reviewer requests one bounded change.',
      requested_changes: 'Include the newest submitted input in the independently checked artifact.' };
  } else if (scenario === 'bounded-non-progress' && priorReviews < 2) {
    result = { outcome: 'request_changes', summary: `Scripted non-progress cycle ${priorReviews + 1}.`,
      requested_changes: `Apply bounded correction ${priorReviews + 1}.` };
  } else {
    result = { outcome: 'recommend_accept', summary: 'Scripted reviewer verified the exact artifact digest.' };
  }
} else if (purpose === 'execution') {
  const inputs = request.assignment_context?.pilot?.inputs ?? request.workUnit.pilot?.inputs ?? [];
  const latestInput = inputs.at(-1);
  const inputSequence = Number(latestInput?.input_seq ?? request.assignment?.input_seq ?? 0);
  const instruction = request.assignment?.instruction ?? null;
  const instructionDigest = createHash('sha256').update(JSON.stringify(instruction)).digest('hex');
  const effectKey = `${request.workUnit.work_unit_id}:${request.workUnit.work_revision}:${inputSequence}:${instructionDigest}`;

  if (scenario === 'surviving-worker' && Number(request.execution.attempt) === 1) {
    await writeFile(path.join(controlDirectory, 'worker-started.json'), JSON.stringify({
      pid: process.pid,
      execution_id: request.execution.execution_id,
      work_unit_id: request.workUnit.work_unit_id,
      effect_key: effectKey,
    }), { flag: 'wx', mode: 0o600 });
    const gate = path.join(controlDirectory, 'release-worker');
    for (;;) {
      try { await access(gate); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
    }
  }

  const artifact = [
    'SCRIPTED OFFLINE TRIAL ARTIFACT',
    `trial=${trialId}`,
    `work_unit=${request.workUnit.work_unit_id}`,
    `revision=${request.workUnit.work_revision}`,
    `input_seq=${inputSequence}`,
    `input=${latestInput?.message ?? ''}`,
    `instruction=${instruction?.requested_changes ?? instruction?.proposal ?? ''}`,
  ].join('\n');
  const bytes = Buffer.from(artifact, 'utf8');
  const digest = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(request.workspaceRoot, 'deliverable.txt'), bytes, { mode: 0o600 });
  await appendFile(path.join(controlDirectory, 'simulated-effects.jsonl'), `${JSON.stringify({
    trial_id: trialId,
    effect_kind: 'local-artifact-write',
    effect_key: effectKey,
    effect_digest: digest,
    execution_id: request.execution.execution_id,
    simulated: true,
  })}\n`, { mode: 0o600 });
  result = {
    objective_id: request.workUnit.objective_ref,
    disposition: 'done',
    summary: `Scripted offline worker produced a checked artifact for ${trialId}.`,
    outcome_evidence: [{ kind: 'file', path: 'deliverable.txt', sha256: digest }],
  };
  if (scenario === 'surviving-worker') workerFinishedMarker = { execution_id: request.execution.execution_id, artifact_digest: digest };
} else {
  throw new Error(`unexpected scripted trial purpose ${purpose}`);
}

await writeFile(process.env.CT_VNEXT_RESULT_FILE, JSON.stringify(result), { mode: 0o600 });
if (workerFinishedMarker) await writeFile(path.join(controlDirectory, 'worker-finished.json'), JSON.stringify(workerFinishedMarker), { flag: 'wx', mode: 0o600 });
