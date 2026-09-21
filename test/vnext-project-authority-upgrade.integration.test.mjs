import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const connectionString = process.env.TEST_DATABASE_URL;

test('project authority upgrade rejects unresolved ownership and rolls back atomically', { skip: !connectionString, timeout: 60000 }, async () => {
  const admin = new Pool({ connectionString });
  const name = `authority_upgrade_${randomUUID().replaceAll('-', '')}`;
  let pool;
  let created = false;
  try {
    // A disposable database keeps the exact public-qualified migration intact.
    await admin.query(`CREATE DATABASE ${name}`);
    created = true;
    const url = new URL(connectionString);
    url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.href });
    for (const file of ['001_outer_loop.sql', '002_survivability.sql']) {
      await pool.query(await readFile(new URL(`../vnext-migrations/${file}`, import.meta.url), 'utf8'));
    }
    await pool.query('ALTER TABLE vnext_work_units ADD COLUMN project_id text; ALTER TABLE vnext_executions ADD COLUMN project_id text');
    const migration = await readFile(new URL('../vnext-migrations/006_project_mutation_authority.sql', import.meta.url), 'utf8');
    for (const fixture of [
      { claimed: true, state: 'running', expiry: '2099-01-01' },
      { claimed: true, state: 'running', expiry: '2000-01-01' },
      { claimed: false, state: 'created', expiry: '2099-01-01' },
      { claimed: false, state: 'running', expiry: '2099-01-01' },
      { claimed: true, state: 'failed', expiry: '2000-01-01' },
    ]) {
      await pool.query("INSERT INTO vnext_work_units(work_unit_id,objective_ref,project_id,state,fence,claim_execution_id,claim_owner,claim_fence,claim_expires_at) VALUES ('w','objective','p','actionable',1,$1,$2,$3,$4)", [fixture.claimed ? 'e' : null, fixture.claimed ? 'owner' : null, fixture.claimed ? 1 : null, fixture.claimed ? fixture.expiry : null]);
      await pool.query("INSERT INTO vnext_executions(execution_id,work_unit_id,project_id,owner,fence,state,started_at,claim_expires_at) VALUES ('e','w','p','owner',1,$1,clock_timestamp(),$2)", [fixture.state, fixture.expiry]);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await assert.rejects(() => client.query(migration), /existing execution claims and active executions.*reconciled/);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      assert.equal((await pool.query("SELECT to_regclass('public.vnext_project_mutation_authority') AS relation")).rows[0].relation, null);
      assert.equal((await pool.query("SELECT state FROM vnext_executions WHERE execution_id='e'")).rows[0].state, fixture.state);
      await pool.query('DELETE FROM vnext_executions; DELETE FROM vnext_work_units');
    }
    await pool.query("INSERT INTO vnext_work_units(work_unit_id,objective_ref,project_id,state) VALUES ('settled','objective','p','terminal'); INSERT INTO vnext_executions(execution_id,work_unit_id,project_id,owner,fence,state,started_at,finished_at) VALUES ('finished','settled','p','owner',1,'succeeded',clock_timestamp(),clock_timestamp())");
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    assert.equal((await pool.query('SELECT * FROM vnext_project_mutation_authority')).rowCount, 0);
    assert.equal((await pool.query('SELECT * FROM vnext_executions')).rowCount, 1);
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
});


test('A8 preserves a pre-migration NULL authorization reference during legacy recovery', { skip: !connectionString, timeout: 60000 }, async () => {
  const admin = new Pool({ connectionString });
  const name = `authority_legacy_${randomUUID().replaceAll('-', '')}`;
  let pool;
  let created = false;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    created = true;
    const url = new URL(connectionString);
    url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.href });
    for (const file of ['001_outer_loop.sql', '002_survivability.sql']) {
      await pool.query(await readFile(new URL(`../vnext-migrations/${file}`, import.meta.url), 'utf8'));
    }
    await pool.query('ALTER TABLE vnext_work_units ADD COLUMN project_id text; ALTER TABLE vnext_executions ADD COLUMN project_id text');
    await pool.query(await readFile(new URL('../vnext-migrations/006_project_mutation_authority.sql', import.meta.url), 'utf8'));
    await pool.query("INSERT INTO vnext_work_units(work_unit_id,objective_ref,project_id,state,fence,claim_execution_id,claim_owner,claim_fence,claim_expires_at) VALUES ('legacy-wu','objective','legacy-project','actionable',1,'legacy-exec','legacy-owner',1,'2000-01-01')");
    await pool.query("INSERT INTO vnext_executions(execution_id,work_unit_id,project_id,owner,fence,state,started_at,claim_expires_at,authorization_decision_ref) VALUES ('legacy-exec','legacy-wu','legacy-project','legacy-owner',1,'expired',clock_timestamp(),'2000-01-01',NULL)");
    await pool.query(await readFile(new URL('../vnext-migrations/007-authorization-provenance.sql', import.meta.url), 'utf8'));
    await pool.query("UPDATE vnext_executions SET finished_at=clock_timestamp() WHERE execution_id='legacy-exec'");
    assert.equal((await pool.query("SELECT authorization_decision_ref FROM vnext_executions WHERE execution_id='legacy-exec'")).rows[0].authorization_decision_ref, null);
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
});
