#!/usr/bin/env node
import { Store, invoke, observePending, recover, runScheduler, validateNextWake, validateWakeReason } from '../lib/runtime.mjs';

const args = process.argv.slice(2);
const command = args[0];
const values = (name) => args.flatMap((v, i) => v === name ? [args[i + 1]] : []).filter((v) => v !== undefined);
const opt = (name, fallback) => values(name)[0] ?? fallback;
const help = () => console.log(`CT-Runtime: filesystem-backed Celestan execution mechanics

Commands:
  run --store PATH --project NAME --model MODEL --agent AGENT --task TEXT [--cwd PATH] [--opencode BIN] [--opencode-arg ARG]
  schedule --store PATH --time ISO --reason REASON --priority NAME --project NAME [--model MODEL --agent AGENT --task TEXT --cwd PATH --observer PATH]
  scheduler --store PATH --model MODEL --agent AGENT --task TEXT [--cwd PATH] [--observer PATH] [--opencode BIN]
  recover --store PATH [--stale-ms N]
  observe-pending --store PATH --observer PATH [--semantic-result FILE]
  wake --store PATH --reason REASON
  status | inspect --id ID

The scheduler launches due wakes once, using only its caller-supplied launch values.
Each run must write the exact CT_RUNTIME_RESULT_FILE JSON handoff. Runtime schedules
only its validated requested_next_wake. State is retained in the selected store.`);
if (!command || command === '--help') { help(); process.exit(command ? 0 : 2); }

try {
  const store = new Store(opt('--store'));
  if (command === 'run') {
    const requestedId = opt('--id');
    const existing = requestedId ? await store.manifest(requestedId).catch(() => null) : null;
    const result = existing ? { manifest: existing, created: false } : await store.createManifest({ executionId: requestedId, project: opt('--project'), task: opt('--task'), model: opt('--model'), agent: opt('--agent'), cwd: opt('--cwd'), wake_reason: opt('--reason', 'user'), topology: opt('--parent') || opt('--root') ? { rootId: opt('--root', requestedId), parentId: opt('--parent'), childIds: [] } : undefined });
    console.log(JSON.stringify(result));
    if (result.created || ['requeued', 'manifested', 'retrying'].includes(result.manifest.execution.status)) { const run = await invoke({ store, executionId: result.manifest.execution.id, command: opt('--opencode', process.env.OPENCODE_BIN || 'opencode'), commandArgs: values('--opencode-arg'), model: opt('--model', result.manifest.execution.model), agent: opt('--agent', result.manifest.execution.agent), task: opt('--task', result.manifest.execution.task), cwd: opt('--cwd', result.manifest.execution.cwd), env: Object.fromEntries(values('--env').map((v) => v.split('='))), secretNames: values('--secret-name'), timeoutMs: Number(opt('--timeout', '3600000')), dryRun: args.includes('--dry-run'), resultFile: opt('--result-file'), maxRetries: Number(opt('--max-retries', '2')) }); console.log(JSON.stringify(run)); if (run.status !== 'success') process.exitCode = 1; }
  } else if (command === 'wake') { const reason = validateWakeReason(opt('--reason')); const wake = { time: new Date().toISOString(), reason, priority: opt('--priority', 'normal'), project: opt('--project') }; const scheduled = await store.schedule(wake, { command: opt('--opencode', process.env.OPENCODE_BIN || 'opencode'), model: opt('--model'), agent: opt('--agent'), task: opt('--task'), cwd: opt('--cwd'), observerPath: opt('--observer') }); console.log(JSON.stringify({ status: 'enqueued', ...scheduled }));
  } else if (command === 'schedule') { console.log(JSON.stringify(await store.schedule({ time: opt('--time'), reason: opt('--reason'), priority: opt('--priority', 'normal'), project: opt('--project') }, { command: opt('--opencode'), model: opt('--model'), agent: opt('--agent'), task: opt('--task'), cwd: opt('--cwd'), observerPath: opt('--observer') })));
  } else if (command === 'scheduler') { const scheduler = await runScheduler({ store, invokeOptions: { command: opt('--opencode', process.env.OPENCODE_BIN || 'opencode'), model: opt('--model'), agent: opt('--agent'), task: opt('--task'), cwd: opt('--cwd'), observerPath: opt('--observer'), resultFile: opt('--result-file'), dryRun: args.includes('--dry-run'), maxRetries: Number(opt('--max-retries', '2')) } }); console.log(JSON.stringify(scheduler)); if (!scheduler.success) process.exitCode = 1;
  } else if (command === 'recover') console.log(JSON.stringify(await recover({ store, staleMs: Number(opt('--stale-ms', '300000')) })));
  else if (command === 'status') console.log(JSON.stringify({ manifests: await store.manifestsAll() }));
  else if (command === 'inspect') console.log(JSON.stringify(await store.manifest(opt('--id')), null, 2));
  else if (command === 'observe-pending') console.log(JSON.stringify(await observePending({ store, observerPath: opt('--observer'), semanticResultFile: opt('--semantic-result') })));
  else if (command === 'schedule-help') help();
  else { help(); process.exitCode = 2; }
} catch (error) { console.error(JSON.stringify({ error: String(error.message).slice(0, 500) })); process.exitCode = 1; }
