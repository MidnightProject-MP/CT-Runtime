import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Linux process group is the enforceable execution boundary for this pilot.
// Runtime database credentials are never inherited by the worker.
export function createCommandExecutor({ command, args = [], stateDirectory, envNames = [] }) {
  if (process.platform !== 'linux') throw new Error('pilot command executor requires Linux process groups');
  if (typeof command !== 'string' || !command || !path.isAbsolute(stateDirectory) || !Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new Error('explicit command, string args and absolute stateDirectory required');
  if (envNames.some(name => /DATABASE|POSTGRES|CT_PILOT/i.test(name))) throw new Error('runtime credentials must not be passed to the worker');
  return async (request) => {
    const directory = path.join(stateDirectory, request.execution.execution_id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const requestPath = path.join(directory, 'request.json');
    const resultPath = path.join(directory, 'result.json');
    await writeFile(requestPath, JSON.stringify(request, null, 2), { flag: 'wx', mode: 0o600 });
    const env = Object.fromEntries(['PATH','HOME','LANG','TMPDIR',...envNames].filter(n => process.env[n] !== undefined).map(n => [n,process.env[n]]));
    env.CT_VNEXT_REQUEST_FILE = requestPath;
    env.CT_VNEXT_RESULT_FILE = resultPath;
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: request.workspaceRoot, env, detached: true, stdio: 'ignore' });
      let timedOut = false;
      const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } } };
      const timer = setTimeout(() => { timedOut = true; kill(); }, request.timeoutMs);
      child.once('error', () => { clearTimeout(timer); reject(new Error('worker could not start')); });
      child.once('exit', (code) => {
        clearTimeout(timer);
        // Never leave descendants running after their launcher exits.
        kill();
        if (timedOut || code !== 0) reject(new Error(timedOut ? 'worker timed out; effects require reconciliation' : 'worker failed; effects require reconciliation'));
        else resolve();
      });
    });
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
      await writeFile(path.join(evidenceDirectory,filename),bytes,{flag:'wx',mode:0o600});
      index.push({...ref,retained_file:filename});
    }
    if (index.length) await writeFile(path.join(evidenceDirectory,'index.json'),JSON.stringify(index),{flag:'wx',mode:0o600});
    return result;
  };
}
