import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { bundleHash, normalizeFiles } from '../lib/gas-deploy-contract.mjs';

const root = process.argv[2] ?? 'gas';
const output = process.argv[3] ?? 'gas-bundle.json';
const entries = await readdir(root, { withFileTypes: true });
const files = [];
for (const entry of entries) {
  if (!entry.isFile()) continue;
  const name = entry.name;
  if (name === '.clasp.json' || name === '.claspignore' || name === '.clasp.json.example') continue;
  if (!['.js', '.mjs', '.html', '.json'].includes(extname(name)) || name === 'gas-bundle.json') continue;
  const source = await readFile(join(root, name), 'utf8');
  const type = name === 'appsscript.json' ? 'JSON' : extname(name) === '.html' ? 'HTML' : 'SERVER_JS';
  files.push({ name, type, source });
}
const normalized = normalizeFiles(files);
const bundle = { schema: 'ct-runtime-gas-bundle-v1', files: normalized };
await writeFile(output, JSON.stringify(bundle), 'utf8');
console.log(JSON.stringify({ fileCount: normalized.length, bundleHash: bundleHash(normalized), output }));
