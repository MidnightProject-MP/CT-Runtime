import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Observer transport does not replace the general B2/S3 evidence store', async () => {
  const adapters = await readFile(new URL('../lib/capabilities/adapters.mjs', import.meta.url), 'utf8');
  const s3 = await readFile(new URL('../lib/s3-evidence.mjs', import.meta.url), 'utf8');
  assert.match(adapters, /evidence_store/);
  assert.match(adapters, /S3-compatible/);
  assert.match(s3, /class S3EvidenceStore/);
});

test('local evidence exporter has no access path to environment or raw session logs', async () => {
  const source = await readFile(new URL('../lib/evidence-export.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.env|readFile|transcript|environment|credential/i);
  assert.match(source, /ALLOWED/);
});
