import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

export async function migrateVNext({ connectionString, directory = path.join(process.cwd(), 'vnext-migrations'), pool } = {}) {
  if (!connectionString && !pool) throw new Error('vNext migration requires an explicit PostgreSQL connection string or injected pool');
  const db = pool || new Pool({ connectionString, application_name: 'ct-runtime-vnext-migrate' });
  const close = !pool;
  try {
    await db.query('CREATE TABLE IF NOT EXISTS vnext_schema_migrations (version bigint PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp(), checksum text NOT NULL)');
    const files = (await readdir(directory)).filter((file) => /^\d+_.*\.sql$/.test(file)).sort();
    for (const file of files) {
      const version = Number(file.match(/^\d+/)[0]);
      const sql = await readFile(path.join(directory, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const current = (await db.query('SELECT checksum FROM vnext_schema_migrations WHERE version=$1', [version])).rows[0];
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
