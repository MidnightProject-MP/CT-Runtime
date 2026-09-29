import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const connectionString = process.env.TEST_DATABASE_URL;

test('native PostgreSQL test database is isolated from another database', { skip: !connectionString, timeout: 60000 }, async () => {
  const admin = new Pool({ connectionString, max: 2 });
  const firstName = `isolation_a_${randomUUID().replaceAll('-', '')}`;
  const secondName = `isolation_b_${randomUUID().replaceAll('-', '')}`;
  let first;
  let second;
  try {
    await admin.query(`CREATE DATABASE "${firstName}"`);
    await admin.query(`CREATE DATABASE "${secondName}"`);
    const firstUrl = new URL(connectionString); firstUrl.pathname = `/${firstName}`;
    const secondUrl = new URL(connectionString); secondUrl.pathname = `/${secondName}`;
    first = new Pool({ connectionString: firstUrl.href });
    second = new Pool({ connectionString: secondUrl.href });

    const migration = await readFile(path.join(import.meta.dirname, '..', 'vnext-migrations', '001_outer_loop.sql'), 'utf8');
    await first.query(migration);
    await first.query(`INSERT INTO vnext_work_units(work_unit_id,objective_ref,state,fence,claim_execution_id,claim_owner,claim_fence,claim_expires_at) VALUES ('isolated-wu','objective','actionable',1,'isolated-exec','owner',1,'2099-01-01')`);
    assert.equal((await first.query('SELECT count(*)::int AS count FROM vnext_work_units')).rows[0].count, 1);
    assert.equal((await second.query("SELECT to_regclass('public.vnext_work_units') AS relation")).rows[0].relation, null);
  } finally {
    await Promise.allSettled([first?.end(), second?.end()]);
    await admin.query(`DROP DATABASE "${firstName}"`).catch(() => {});
    await admin.query(`DROP DATABASE "${secondName}"`).catch(() => {});
    await admin.end();
  }
});
