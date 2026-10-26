import { access, appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [controlDirectory, trialId] = process.argv.slice(2);
if (!path.isAbsolute(controlDirectory) || !trialId) throw new Error('absolute control directory and trial id are required');
if (process.env.CT_PILOT_DATABASE_URL || process.env.TEST_DATABASE_URL || process.env.POSTGRES_URL) throw new Error('qualification worker received database credentials');
const request = JSON.parse(await readFile(process.env.CT_VNEXT_REQUEST_FILE, 'utf8'));
const purpose = request.assignment?.purpose ?? 'execution';
const invocationPath = path.join(controlDirectory, 'worker-invocations.jsonl');
await appendFile(invocationPath, `${JSON.stringify({
  trial_id: trialId,
  execution_id: request.execution.execution_id,
  work_unit_id: request.workUnit.work_unit_id,
  purpose,
  model_calls: 0,
})}\n`, { mode: 0o600 });

let result;
if (purpose === 'stewardship') {
  result = { proposal: `Bounded local qualification proposal for ${trialId}.` };
} else if (purpose === 'review') {
  result = { outcome: 'recommend_accept', summary: `Independent scripted review passed for ${trialId}.` };
} else if (purpose === 'execution') {
  const started = path.join(controlDirectory, 'worker-started.json');
  let firstExecution = false;
  try { await access(started); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(started, JSON.stringify({ pid: process.pid, execution_id: request.execution.execution_id,
      work_unit_id: request.workUnit.work_unit_id }), { flag: 'wx', mode: 0o600 });
    firstExecution = true;
  }
  if (firstExecution) {
    const gate = path.join(controlDirectory, 'release-worker');
    for (;;) {
      try { await access(gate); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
    }
  }
  const input = request.assignment_context?.pilot?.inputs?.at(-1)?.message ?? request.workUnit.pilot?.inputs?.at(-1)?.message ?? '';
  const artifact = `LOCAL FIRST-LAUNCH QUALIFICATION\ntrial=${trialId}\nwork_unit=${request.workUnit.work_unit_id}\ninput=${input}\n`;
  const bytes = Buffer.from(artifact, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(request.workspaceRoot, 'deliverable.txt'), bytes, { mode: 0o600 });
  const inputSeq = Number(request.assignment?.input_seq ?? request.workUnit.pilot?.input_seq ?? 0);
  await appendFile(path.join(controlDirectory, 'simulated-effects.jsonl'), `${JSON.stringify({
    effect_key: `${request.workUnit.work_unit_id}:${request.workUnit.work_revision}:${inputSeq}`,
    effect_digest: sha256,
    execution_id: request.execution.execution_id,
    simulated: true,
  })}\n`, { mode: 0o600 });
  result = {
    objective_id: request.workUnit.objective_ref,
    disposition: 'done',
    summary: `Checked scripted artifact for ${trialId}.`,
    outcome_evidence: [{ kind: 'file', path: 'deliverable.txt', sha256 }],
  };
  if (firstExecution) await writeFile(path.join(controlDirectory, 'worker-finished.json'), JSON.stringify({
    execution_id: request.execution.execution_id,
    artifact_sha256: sha256,
  }), { flag: 'wx', mode: 0o600 });
} else if (purpose === 'diagnosis') {
  result = { outcome: 'stop', summary: `No diagnosis required for ${trialId}.` };
} else {
  throw new Error(`unexpected qualification purpose ${purpose}`);
}

await writeFile(process.env.CT_VNEXT_RESULT_FILE, JSON.stringify(result), { mode: 0o600 });
