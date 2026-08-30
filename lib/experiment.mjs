import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function recordExperiment({ file = path.join(process.cwd(), 'ab-c-experiment.ndjson'), workload = 'fixed-fixture', hosts = ['cloud-run', 'oracle-a1', 'cloud-run-fresh'], imageDigest, configDigest, results = [] } = {}) {
  if (!imageDigest || !configDigest) throw new Error('experiment requires imageDigest and configDigest');
  await mkdir(path.dirname(file), { recursive: true });
  const record = { schema: 'celestan-runtime-ab-c-v1', experimentId: `exp-${crypto.randomUUID()}`, workload, imageDigest, configDigest, hosts, results, recordedAt: new Date().toISOString(), claims: { continuity: results.length === hosts.length && results.every((item) => item.executionId), verified: false } };
  await appendFile(file, JSON.stringify(record) + '\n');
  return record;
}
