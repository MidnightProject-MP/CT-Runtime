#!/usr/bin/env node
import { invoke, observePending, recover, runScheduler, validateNextWake, validateWakeReason } from '../lib/runtime.mjs';
import { createStore, createCapabilityStores } from '../lib/stores.mjs';
import { loadConfig } from '../lib/config.mjs';
import { migrate } from '../lib/migration.mjs';
import { doctor, reconstruct } from '../lib/startup.mjs';
import { exportObserver, observePostgres } from '../lib/production-observer.mjs';
import { describeCapabilities } from '../lib/capabilities/registry.mjs';
import { describeAdapters } from '../lib/capabilities/adapters.mjs';
import { resolveAllBindings } from '../lib/capabilities/bindings.mjs';

const args = process.argv.slice(2);
const command = args[0];
const values = (name) => args.flatMap((v, i) => v === name ? [args[i + 1]] : []).filter((v) => v !== undefined);
const opt = (name, fallback) => values(name)[0] ?? fallback;
const defined = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
const help = () => console.log(`CT-Runtime: capability-first execution mechanics (durable_state, evidence_store, ...)

Commands:
  run --store PATH --project NAME --model MODEL --agent AGENT --task TEXT [--cwd PATH] [--opencode BIN] [--opencode-arg ARG]
  schedule --store PATH --time ISO --reason REASON --priority NAME --project NAME [--model MODEL --agent AGENT --task TEXT --cwd PATH --observer PATH]
  scheduler --store PATH --model MODEL --agent AGENT --task TEXT [--cwd PATH] [--observer PATH] [--opencode BIN]
  recover --store PATH [--stale-ms N]
  observe-pending --store PATH --observer PATH [--semantic-result FILE]
  wake --store PATH --reason REASON
  status | inspect --id ID
  capabilities [--project NAME]        # list purpose-level capabilities and current bindings
  adapters [--capability NAME]         # list adapters with purpose/authority/limitations
  bindings [--project NAME]            # show resolved bindings (global + per-project)

Celestan requests capabilities, not vendors:
  durable_state:      persist canonical execution state via durable_state (not "write to Neon")
  evidence_store:     put raw logs via evidence_store (not "write to R2")
  knowledge_publishing: publishChronicle({...}) via knowledge_publishing (not "write to Confluence")
Bindings (bindings.example.json / CELESTAN_BINDINGS_JSON) select the adapter; changing Neon↔Supabase or R2↔S3 changes only config, not Celestan code.
The scheduler launches due wakes once, using only its caller-supplied launch values.
Each run must write the exact CT_RUNTIME_RESULT_FILE JSON handoff. Runtime schedules
only its validated requested_next_wake. State is retained in the selected store.`);
if (!command || command === '--help') { help(); process.exit(command ? 0 : 2); }

try {
  if (command === 'migrate') {
    const connectionString = opt('--database-url', process.env.CT_RUNTIME_DATABASE_MIGRATION_URL || process.env.CT_RUNTIME_DATABASE_URL_UNPOOLED || process.env.CT_RUNTIME_DATABASE_URL);
    if (!connectionString) throw new Error('migrate requires --database-url or CT_RUNTIME_DATABASE_MIGRATION_URL (direct, owner/migrator) — never the pooled runtime URL alone in production');
    console.log(JSON.stringify(await migrate({ connectionString }))); process.exit(0);
  }
  if (command === 'capabilities') { console.log(JSON.stringify(describeCapabilities({ project: opt('--project'), env: process.env }), null, 2)); process.exit(0); }
  if (command === 'adapters') { console.log(JSON.stringify(describeAdapters(opt('--capability')), null, 2)); process.exit(0); }
  if (command === 'bindings') { console.log(JSON.stringify(resolveAllBindings({ project: opt('--project'), env: process.env }), null, 2)); process.exit(0); }
  const configured = createStore({ root: opt('--store'), project: opt('--project') });
  const store = configured.store;
  if (command === 'doctor') { console.log(JSON.stringify(await doctor({ store, config: configured.config }))); process.exit(0); }
  if (command === 'reconstruct') { console.log(JSON.stringify(await reconstruct({ store, config: configured.config }))); process.exit(0); }
  if (command === 'export-observer') { process.stdout.write(configured.observerStore ? await exportObserver(configured.observerStore) : '[]\n'); process.exit(0); }
  if (command === 'observe-pending' && configured.observerStore) {
    const reflectionArgs = process.env.CT_RUNTIME_OBSERVER_ARGS ? JSON.parse(process.env.CT_RUNTIME_OBSERVER_ARGS) : [];
    const reflection = process.env.CT_RUNTIME_OBSERVER_REFLECTION === 'opencode' ? { command: process.env.CT_RUNTIME_OBSERVER_COMMAND || 'opencode', args: reflectionArgs, model: process.env.CT_RUNTIME_OBSERVER_MODEL, agent: process.env.CT_RUNTIME_OBSERVER_AGENT, timeoutMs: Number(process.env.CT_RUNTIME_OBSERVER_TIMEOUT_MS || 300000) } : undefined;
    console.log(JSON.stringify(await observePostgres({ store, observerStore: configured.observerStore, semanticResultFile: opt('--semantic-result'), reflection })));
    process.exit(0);
  }
  if (command === 'run') {
    const requestedId = opt('--id');
    const existing = requestedId ? await store.manifest(requestedId).catch(() => null) : null;
    const result = existing ? { manifest: existing, created: false } : await store.createManifest({ executionId: requestedId, project: opt('--project'), task: opt('--task'), model: opt('--model'), agent: opt('--agent'), cwd: opt('--cwd'), wake_reason: opt('--reason', 'user'), topology: opt('--parent') || opt('--root') ? { rootId: opt('--root', requestedId), parentId: opt('--parent'), childIds: [] } : undefined });
    console.log(JSON.stringify(result));
    if (result.created || ['requeued', 'manifested', 'retrying'].includes(result.manifest.execution.status)) { const run = await invoke({ store, executionId: result.manifest.execution.id, command: opt('--opencode', process.env.OPENCODE_BIN || 'opencode'), commandArgs: values('--opencode-arg'), model: opt('--model', result.manifest.execution.model), agent: opt('--agent', result.manifest.execution.agent), task: opt('--task', result.manifest.execution.task), cwd: opt('--cwd', result.manifest.execution.cwd), env: Object.fromEntries(values('--env').map((v) => v.split('='))), secretNames: values('--secret-name'), timeoutMs: Number(opt('--timeout', '3600000')), dryRun: args.includes('--dry-run'), resultFile: opt('--result-file'), maxRetries: Number(opt('--max-retries', '2')) }); console.log(JSON.stringify(run)); if (run.status !== 'success') process.exitCode = 1; }
  } else if (command === 'wake') { const reason = validateWakeReason(opt('--reason')); const wake = { time: new Date().toISOString(), reason, priority: opt('--priority', 'normal'), project: opt('--project') }; const scheduled = await store.schedule(wake, { command: opt('--opencode', process.env.OPENCODE_BIN || 'opencode'), model: opt('--model'), agent: opt('--agent'), task: opt('--task'), cwd: opt('--cwd'), observerPath: opt('--observer') }); console.log(JSON.stringify({ status: 'enqueued', ...scheduled }));
  } else if (command === 'schedule') { console.log(JSON.stringify(await store.schedule({ time: opt('--time'), reason: opt('--reason'), priority: opt('--priority', 'normal'), project: opt('--project') }, { command: opt('--opencode'), model: opt('--model'), agent: opt('--agent'), task: opt('--task'), cwd: opt('--cwd'), observerPath: opt('--observer') })));
  } else if (command === 'scheduler') { const scheduler = await runScheduler({ store, invokeOptions: defined({ command: opt('--opencode', process.env.OPENCODE_BIN), model: opt('--model'), agent: opt('--agent'), task: opt('--task'), cwd: opt('--cwd'), observerPath: opt('--observer'), resultFile: opt('--result-file'), dryRun: args.includes('--dry-run') ? true : undefined, maxRetries: values('--max-retries').length ? Number(opt('--max-retries')) : undefined }) }); console.log(JSON.stringify(scheduler)); if (!scheduler.success) process.exitCode = 1;
  } else if (command === 'recover') console.log(JSON.stringify(await recover({ store, staleMs: Number(opt('--stale-ms', '300000')) })));
  else if (command === 'status') console.log(JSON.stringify({ manifests: await store.manifestsAll() }));
  else if (command === 'inspect') console.log(JSON.stringify(await store.manifest(opt('--id')), null, 2));
  else if (command === 'observe-pending') console.log(JSON.stringify(await observePending({ store, observerPath: opt('--observer'), semanticResultFile: opt('--semantic-result') })));
  else if (command === 'schedule-help') help();
  else { help(); process.exitCode = 2; }
} catch (error) { console.error(JSON.stringify({ error: String(error.message).slice(0, 500) })); process.exitCode = 1; }
