#!/usr/bin/env node
import { observePending } from '../lib/runtime.mjs';
import { createStore, createCapabilityStores } from '../lib/stores.mjs';
import { loadConfig } from '../lib/config.mjs';
import { migrate } from '../lib/migration.mjs';
import { doctor, reconstruct } from '../lib/startup.mjs';
import { exportObserver, observePostgres } from '../lib/production-observer.mjs';
import { describeCapabilities } from '../lib/capabilities/registry.mjs';
import { describeAdapters } from '../lib/capabilities/adapters.mjs';
import { resolveAllBindings } from '../lib/capabilities/bindings.mjs';
import { exportExecution, backfillEvidence, exportOpenCodeSession, backfillOpenCodeEvidence } from '../lib/evidence-pipeline.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const command = args[0];
const values = (name) => args.flatMap((v, i) => v === name ? [args[i + 1]] : []).filter((v) => v !== undefined);
const opt = (name, fallback) => values(name)[0] ?? fallback;
const RETAINED_COMMANDS = new Set([
  'migrate', 'capabilities', 'adapters', 'bindings', 'doctor', 'reconstruct',
  'export-observer', 'evidence', 'observe-pending', 'status', 'inspect'
]);
const help = () => console.log(`CT-Runtime: vNext execution utilities

Autonomous execution:
  node bin/vnext-pilot.mjs submit|tick|run|status|inspect|accept|cancel|reconcile
  See docs/VNEXT-PILOT.md for configuration and command details.

Retained utilities:
  migrate --database-url URL
  doctor
  reconstruct
  export-observer
  observe-pending --store PATH --observer PATH [--semantic-result FILE]
  evidence export EXECUTION|ses_... --store PATH [--project NAME] [--rich|--source rich]
  evidence backfill --store PATH [--project NAME]  # all local OpenCode sessions; current-version metadata-only sanitized revisions
  status | inspect --id ID
  capabilities [--project NAME]        # list purpose-level capabilities and current bindings
  adapters [--capability NAME]         # list adapters with purpose/authority/limitations
  bindings [--project NAME]            # show resolved bindings (global + per-project)`);
if (!command || command === '--help') { help(); process.exit(command ? 0 : 2); }
if (!RETAINED_COMMANDS.has(command)) {
  console.error(`Unknown command: ${command}. Autonomous execution uses node bin/vnext-pilot.mjs (see docs/VNEXT-PILOT.md).`);
  process.exit(2);
}

try {
  if (command === 'migrate') {
    const connectionString = opt('--database-url', process.env.CT_RUNTIME_DATABASE_MIGRATION_URL || process.env.CT_RUNTIME_DATABASE_URL_UNPOOLED || process.env.CT_RUNTIME_DATABASE_URL);
    if (!connectionString) throw new Error('migrate requires --database-url or CT_RUNTIME_DATABASE_MIGRATION_URL (direct, owner/migrator) — never the pooled runtime URL alone in production');
    console.log(JSON.stringify(await migrate({ connectionString }))); process.exit(0);
  }
  if (command === 'capabilities') { console.log(JSON.stringify(describeCapabilities({ project: opt('--project'), env: process.env }), null, 2)); process.exit(0); }
  if (command === 'adapters') { console.log(JSON.stringify(describeAdapters(opt('--capability')), null, 2)); process.exit(0); }
  if (command === 'bindings') { console.log(JSON.stringify(resolveAllBindings({ project: opt('--project'), env: process.env }), null, 2)); process.exit(0); }
  const canonicalLocalStore = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime-store');
  const storeRoot = opt('--store', command === 'evidence' ? canonicalLocalStore : undefined);
  const configured = createStore({ root: storeRoot, project: opt('--project') });
  const store = configured.store;
  if (command === 'doctor') { console.log(JSON.stringify(await doctor({ store, config: configured.config }))); process.exit(0); }
  if (command === 'reconstruct') { console.log(JSON.stringify(await reconstruct({ store, config: configured.config }))); process.exit(0); }
  if (command === 'export-observer') { process.stdout.write(configured.observerStore ? await exportObserver(configured.observerStore) : '[]\n'); process.exit(0); }
  if (command === 'evidence') {
    const subcommand = args[1];
    if (subcommand === 'export') {
      const executionId = args[2];
      if (!executionId || executionId.startsWith('--')) throw new Error('evidence export requires an execution ID');
      console.log(JSON.stringify(executionId.startsWith('ses_')
        ? await exportOpenCodeSession({ sessionId: executionId, store, evidenceStore: configured.evidenceStore, project: opt('--project'), command: opt('--opencode', process.env.OPENCODE_BIN), extractionMode: args.includes('--rich') || opt('--source') === 'rich' ? 'rich' : 'sanitized' })
        : await exportExecution({ store, evidenceStore: configured.evidenceStore, executionId })));
    } else if (subcommand === 'backfill') {
      const local = await backfillEvidence({ store, evidenceStore: configured.evidenceStore });
       const opencode = await backfillOpenCodeEvidence({ store, evidenceStore: configured.evidenceStore, project: opt('--project'), command: opt('--opencode', process.env.OPENCODE_BIN) });
      console.log(JSON.stringify({ ...opencode, local }));
    }
    else { help(); process.exitCode = 2; }
    process.exit(0);
  }
  if (command === 'observe-pending' && configured.observerStore) {
    const reflectionArgs = process.env.CT_RUNTIME_OBSERVER_ARGS ? JSON.parse(process.env.CT_RUNTIME_OBSERVER_ARGS) : [];
    const reflection = process.env.CT_RUNTIME_OBSERVER_REFLECTION === 'opencode' ? { command: process.env.CT_RUNTIME_OBSERVER_COMMAND || 'opencode', args: reflectionArgs, model: process.env.CT_RUNTIME_OBSERVER_MODEL, agent: process.env.CT_RUNTIME_OBSERVER_AGENT, timeoutMs: Number(process.env.CT_RUNTIME_OBSERVER_TIMEOUT_MS || 300000) } : undefined;
    console.log(JSON.stringify(await observePostgres({ store, observerStore: configured.observerStore, semanticResultFile: opt('--semantic-result'), reflection })));
    process.exit(0);
  }
  if (command === 'status') console.log(JSON.stringify({ manifests: await store.manifestsAll() }));
  else if (command === 'inspect') console.log(JSON.stringify(await store.manifest(opt('--id')), null, 2));
  else if (command === 'observe-pending') console.log(JSON.stringify(await observePending({ store, observerPath: opt('--observer'), semanticResultFile: opt('--semantic-result') })));
  else { help(); process.exitCode = 2; }
} catch (error) { console.error(JSON.stringify({ error: String(error.message).slice(0, 500) })); process.exitCode = 1; }
