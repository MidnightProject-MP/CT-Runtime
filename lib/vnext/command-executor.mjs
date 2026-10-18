import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readRunIdentity } from './process-identity.mjs';

// Linux process group is the enforceable execution boundary for this pilot.
// Runtime database credentials are never inherited by the worker.
export function createCommandExecutor({ command, args = [], stateDirectory, envNames = [] }) {
  if (process.platform !== 'linux') throw new Error('pilot command executor requires Linux process groups');
  if (typeof command !== 'string' || !command || !path.isAbsolute(stateDirectory) || !Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new Error('explicit command, string args and absolute stateDirectory required');
  if (envNames.some(name => /DATABASE|POSTGRES|CT_PILOT/i.test(name))) throw new Error('runtime credentials must not be passed to the worker');
  return async (request, hooks = {}) => {
    if (hooks.onSpawn !== undefined && typeof hooks.onSpawn !== 'function') throw new Error('onSpawn hook must be a function');
    const directory = path.join(stateDirectory, request.execution.execution_id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const requestPath = path.join(directory, 'request.json');
    await writeFile(requestPath, JSON.stringify(request, null, 2), { flag: 'wx', mode: 0o600 });
    const env = Object.fromEntries(['PATH','HOME','LANG','TMPDIR',...envNames].filter(n => process.env[n] !== undefined).map(n => [n,process.env[n]]));
    env.CT_VNEXT_REQUEST_FILE = requestPath;
    env.CT_VNEXT_RESULT_FILE = path.join(directory, 'result.json');
    const child = spawn(command, args, { cwd: request.workspaceRoot, env, detached: true, stdio: 'ignore' });
    // Attach exit/error handlers before any identity work so a fast worker
    // cannot exit before the attempt is observed.
    const exited = new Promise((resolve) => {
      child.once('error', (error) => resolve({ error }));
      child.once('exit', (code) => resolve({ code }));
    });
    let timedOut = false;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, request.timeoutMs);
    // Durable launch identity: the local record is written and the store hook
    // is awaited before the attempt is allowed to run to completion, so a crash
    // at any later point leaves only records recovery can classify.
    let launchFailure = null;
    if (child.pid != null) {
      try {
        const identity = (await readRunIdentity(child.pid)) ?? { pid: child.pid, pgid: child.pid, start_ticks: null, boot_id: null, started_at: new Date().toISOString() };
        await writeFile(path.join(directory, 'identity.json'), JSON.stringify(identity, null, 2), { flag: 'wx', mode: 0o600 });
        if (typeof hooks.onSpawn === 'function') await hooks.onSpawn(identity);
      } catch (error) { launchFailure = error; kill(); }
    }
    const outcome = await exited;
    clearTimeout(timer);
    // Never leave descendants running after their launcher exits.
    kill();
    if (launchFailure) throw new Error('dispatch identity was not recorded; effects require reconciliation');
    if (outcome.error) throw new Error('worker could not start');
    if (timedOut) throw new Error('worker timed out; effects require reconciliation');
    if (outcome.code !== 0) throw new Error('worker failed; effects require reconciliation');
    return collectWorkerResult({ request, directory });
  };
}

// Result ingestion is shared with crash recovery: it only needs the written
// request and the attempt directory, and it is replay-tolerant, because a
// crash between retention and settlement must not strand the attempt.
export async function collectWorkerResult({ request, directory }) {
  const resultPath = path.join(directory, 'result.json');
  if ((await stat(resultPath)).size > 65536) throw new Error('worker result exceeds 64 KiB');
  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  // Retain the cited bytes even if a later turn changes the working file.
  const evidenceDirectory = path.join(directory, 'evidence');
  const root = await realpath(request.workspaceRoot);
  const index = [];
  if (result.outcome_evidence !== undefined && (!Array.isArray(result.outcome_evidence) || result.outcome_evidence.length > 32)) throw new Error('invalid evidence list');
  for (const ref of result.outcome_evidence ?? []) {
    if (ref.kind !== 'file') continue;
    if (typeof ref.path !== 'string' || path.isAbsolute(ref.path) || ref.path.split(/[\\/]/).includes('..')) throw new Error('invalid evidence path');
    const source = await realpath(path.resolve(root,ref.path));
    const relative = path.relative(root,source);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('evidence escapes project');
    if ((await stat(source)).size > 16 * 1024 * 1024) throw new Error('evidence file exceeds 16 MiB');
    const bytes = await readFile(source);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== ref.sha256) throw new Error('evidence hash mismatch');
    await mkdir(evidenceDirectory,{recursive:true,mode:0o700});
    const filename = `${index.length}-${hash}`;
    try {
      await writeFile(path.join(evidenceDirectory,filename),bytes,{flag:'wx',mode:0o600});
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Retention already ran for this attempt; the content-addressed name
      // makes an existing file provably identical.
    }
    index.push({...ref,retained_file:filename});
  }
  if (index.length) {
    const indexPath = path.join(evidenceDirectory,'index.json');
    try {
      await writeFile(indexPath,JSON.stringify(index),{flag:'wx',mode:0o600});
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = JSON.parse(await readFile(indexPath, 'utf8'));
      if (JSON.stringify(existing) !== JSON.stringify(index)) throw new Error('retained evidence index conflict');
    }
  }
  return result;
}
