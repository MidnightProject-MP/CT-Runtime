#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Pool } from 'pg';
import { createPilotStore } from '../lib/vnext/pilot-store.mjs';
import { runPilotOnce } from '../lib/vnext/pilot.mjs';
import { createCommandExecutor } from '../lib/vnext/command-executor.mjs';
import { migrateVNext } from '../lib/vnext/migration.mjs';

const [action, ...args] = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
let pool;
try {
  if (!['migrate','submit','tick','status'].includes(action)) throw new Error('usage: vnext-pilot migrate|submit|tick|status --config /absolute/config.json [--thread ID --receipt ID --message-file PATH]');
  const configPath = option('--config');
  if (!configPath || !path.isAbsolute(configPath)) throw new Error('--config must be an absolute path outside the repository');
  const config = JSON.parse(await readFile(configPath,'utf8'));
  const connectionString = process.env.CT_PILOT_DATABASE_URL;
  if (!connectionString) throw new Error('CT_PILOT_DATABASE_URL is required');
  pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 10000, statement_timeout: 15000, application_name: 'ct-runtime-vnext-pilot' });
  if (action === 'migrate') {
    console.log(JSON.stringify(await migrateVNext({ pool, directory: path.join(import.meta.dirname,'../vnext-migrations') })));
  } else {
    const authority = action === 'tick' ? await import(pathToFileURL(await realpath(config.authorityModule)).href) : {};
    const store = createPilotStore({ pool, authorizationVerifier: authority.verifyExecution, intervalMs: config.intervalMs ?? 60000 });
    if (action === 'submit') {
      const file = option('--message-file');
      if (!file) throw new Error('--message-file is required');
      console.log(JSON.stringify(await store.submit({ projectId: config.projectId, threadId: option('--thread'), receiptId: option('--receipt'), message: await readFile(file,'utf8') })));
    } else if (action === 'status') console.log(JSON.stringify(await store.status(config.projectId),null,2));
    else {
      if (config.enabled !== true || config.legacyExcluded !== true) throw new Error('pilot is disabled; qualify legacy exclusion before enabling');
      // This is an operator assertion, not proof of deployment/exclusion.
      const result = await runPilotOnce({ store, projectId: config.projectId, workspaceRoot: await realpath(config.workspaceRoot), identityFiles: config.identityFiles, authority,
        timeoutMs: config.timeoutMs ?? 120000, executor: createCommandExecutor(config.executor) });
      console.log(JSON.stringify(result));
    }
  }
} catch (error) {
  // Provider and database errors may contain credentials or source text.
  console.error(JSON.stringify({ status: 'failed', code: error.code || 'PILOT_FAILED', message: 'Pilot stopped. Check configuration and durable status; do not blindly repeat uncertain effects.' }));
  process.exitCode = 1;
} finally { await pool?.end(); }