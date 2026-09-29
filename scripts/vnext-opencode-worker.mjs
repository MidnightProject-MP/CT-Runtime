// Runs one fresh OpenCode invocation; the parent pilot owns its process group.
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const [model, agent, executable = 'opencode'] = process.argv.slice(2);
if (!model || !agent) throw new Error('explicit model and agent required');
const request = JSON.parse(await readFile(process.env.CT_VNEXT_REQUEST_FILE, 'utf8'));
const prompt = `${request.instruction}\nRead the complete durable request at ${process.env.CT_VNEXT_REQUEST_FILE}.\nWrite ONLY the final objective-turn JSON to ${process.env.CT_VNEXT_RESULT_FILE}. Do not print or persist credentials. The result file is a report, not evidence by itself. The current objective_id is ${request.workUnit.objective_ref}.`;
const child = spawn(executable, ['run','--model',model,'--agent',agent,prompt], { stdio: 'ignore', env: process.env });
child.once('error', () => { process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
