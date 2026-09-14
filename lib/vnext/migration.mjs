import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

const LEGACY_BASELINE_FILE = 'legacy-baseline.json';

async function readLegacyBaseline(directory) {
  const filename = path.join(directory, LEGACY_BASELINE_FILE);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw new Error(`vNext legacy migration baseline is invalid: ${error.message}`);
  }

  if (!Array.isArray(parsed?.legacy_applied_migrations)) {
    throw new Error('vNext legacy migration baseline is invalid: legacy_applied_migrations must be an array');
  }

  const baseline = new Map();
  for (const entry of parsed.legacy_applied_migrations) {
    if (!Number.isInteger(entry?.version) || entry.version < 1 || !/^[a-f0-9]{64}$/.test(entry?.checksum || '')) {
      throw new Error('vNext legacy migration baseline is invalid: each entry requires an integer version and SHA-256 checksum');
    }
    if (baseline.has(entry.version)) throw new Error(`vNext legacy migration baseline has duplicate version: ${entry.version}`);
    baseline.set(entry.version, entry.checksum);
  }
  return baseline;
}

export async function migrateVNext({ connectionString, directory = path.join(process.cwd(), 'vnext-migrations'), pool } = {}) {
  if (!connectionString && !pool) throw new Error('vNext migration requires an explicit PostgreSQL connection string or injected pool');
  const db = pool || new Pool({ connectionString, application_name: 'ct-runtime-vnext-migrate' });
  const close = !pool;
  try {
    await db.query('CREATE TABLE IF NOT EXISTS vnext_schema_migrations (version bigint PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp(), checksum text NOT NULL)');
    const files = (await readdir(directory)).filter((file) => /^\d+_.*\.sql$/.test(file)).sort();
    const repositoryVersions = new Set(files.map((file) => Number(file.match(/^\d+/)[0])));
    const baseline = await readLegacyBaseline(directory);
    const ledger = (await db.query('SELECT version, checksum FROM vnext_schema_migrations ORDER BY version')).rows;

    for (const row of ledger) {
      const version = Number(row.version);
      if (repositoryVersions.has(version)) continue;
      const expected = baseline.get(version);
      if (!expected || row.checksum !== expected) {
        throw new Error(`vNext migration checksum mismatch or unknown orphaned migration: version ${version}`);
      }
    }

    for (const [version] of baseline) {
      if (repositoryVersions.has(version)) {
        throw new Error(`vNext legacy migration baseline overlaps repository migration: version ${version}`);
      }
    }

    for (const file of files) {
      const version = Number(file.match(/^\d+/)[0]);
      const sql = await readFile(path.join(directory, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const current = ledger.find((row) => Number(row.version) === version);
      if (current) { if (current.checksum !== checksum) throw new Error(`vNext migration checksum mismatch: ${file}`); continue; }
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO vnext_schema_migrations(version,checksum) VALUES ($1,$2)', [version, checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    }
    return { status: 'migrated', applied: files.map((file) => Number(file.match(/^\d+/)[0])) };
  } finally { if (close) await db.end(); }
}
