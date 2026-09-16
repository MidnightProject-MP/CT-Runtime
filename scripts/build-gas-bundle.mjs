import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { bundleHash, normalizeFiles } from '../lib/gas-deploy-contract.mjs';

const DEPLOYABLE_FILES = new Set([
  'appsscript.json',
  'gas_actions.js',
  'gas_agent_executor.js',
  'gas_bootstrap.js',
  'gas_chronicle.js',
  'gas_core.js',
  'gas_cutover.js',
  'gas_deploy.js',
  'gas_deploy_qualify.js',
  'gas_evidence.js',
  'gas_federation.js',
  'gas_feedback.js',
  'gas_github.js',
  'gas_migrate.js',
  'gas_observer.js',
  'gas_state.js',
  'gas_trigger.js',
  'gas_v8.js',
  'gas_vnext_arm.js',
  'gas_zz_a_dispatch.js',
  'gas_zz_auth_trace.js'
]);

const root = process.argv[2] ?? 'gas';
const output = process.argv[3] ?? 'gas-bundle.json';
const entries = await readdir(root, { withFileTypes: true });
const files = [];
for (const entry of entries) {
  if (!entry.isFile()) continue;
  const name = entry.name;
  if (!DEPLOYABLE_FILES.has(name)) continue;
  const source = await readFile(join(root, name), 'utf8');
  const type = name === 'appsscript.json' ? 'JSON' : extname(name) === '.html' ? 'HTML' : 'SERVER_JS';
  files.push({ name, type, source });
}
const normalized = normalizeFiles(files);
const bundle = { schema: 'ct-runtime-gas-bundle-v1', files: normalized };
await writeFile(output, JSON.stringify(bundle), 'utf8');
console.log(JSON.stringify({ fileCount: normalized.length, bundleHash: bundleHash(normalized), output }));
