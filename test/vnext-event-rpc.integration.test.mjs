import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrate } from '../lib/migration.mjs';
import { migrateVNext } from '../lib/vnext/migration.mjs';

const connectionString = process.env.TEST_DATABASE_URL;

async function rpc(pool, claims, eventId, eventType, payload) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE authenticated');
    await client.query('SELECT set_config($1,$2,true)', ['request.jwt.claims', JSON.stringify(claims)]);
    const result = await client.query('SELECT public.vnext_append_immutable_event($1,$2,$3::jsonb) AS status', [eventId, eventType, JSON.stringify(payload)]);
    await client.query('COMMIT');
    return result.rows[0].status;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function counts(pool) {
  const [work, executions, continuations, wakes] = await Promise.all([
    pool.query('SELECT count(*)::int AS count FROM vnext_work_units'),
    pool.query('SELECT count(*)::int AS count FROM vnext_executions'),
    pool.query('SELECT count(*)::int AS count FROM vnext_continuations'),
    pool.query('SELECT count(*)::int AS count FROM runtime_schedules'),
  ]);
  return { work_units: work.rows[0].count, executions: executions.rows[0].count, continuations: continuations.rows[0].count, wakes: wakes.rows[0].count };
}

test('authenticated immutable event RPC is idempotent, conflict-safe, and side-effect free', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 5 });
  const sub = `a2-test-${randomUUID()}`;
  const prefix = `human-feedback:${randomUUID()}`;
  try {
    await migrate({ pool, directory: path.join(import.meta.dirname, '..', 'migrations') });
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
    await pool.query(`INSERT INTO public.federation_gas_instances(instance_id,jwt_sub,active) VALUES ('gas-primary',$1,true) ON CONFLICT (jwt_sub) DO UPDATE SET instance_id='gas-primary',active=true`, [sub]);

    const before = await counts(pool);
    const payloadR1 = { feedback_id: 'F1', source_revision: 1, message: 'A' };
    const payloadR2 = { feedback_id: 'F1', source_revision: 2, message: 'B' };

    assert.equal(await rpc(pool, { sub }, `${prefix}:1`, 'external_input.received', payloadR1), 'inserted');
    assert.equal(await rpc(pool, { sub }, `${prefix}:1`, 'external_input.received', { message: 'A', source_revision: 1, feedback_id: 'F1' }), 'duplicate');
    assert.equal(await rpc(pool, { sub }, `${prefix}:1`, 'external_input.received', { ...payloadR1, message: 'changed' }), 'integrity_conflict');
    assert.equal(await rpc(pool, { sub }, `${prefix}:2`, 'external_input.received', payloadR2), 'inserted');

    const rows = await pool.query('SELECT event_id,event_type,payload FROM public.vnext_events WHERE event_id LIKE $1 ORDER BY event_id', [`${prefix}:%`]);
    assert.equal(rows.rowCount, 2);
    assert.deepEqual(rows.rows.map((row) => row.event_id), [`${prefix}:1`, `${prefix}:2`]);

    const after = await counts(pool);
    assert.deepEqual(after, before);
  } finally {
    await pool.query('DELETE FROM public.vnext_events WHERE event_id LIKE $1', [`${prefix}:%`]).catch(() => {});
    await pool.query('DELETE FROM public.federation_gas_instances WHERE jwt_sub=$1', [sub]).catch(() => {});
    await pool.end();
  }
});

test('immutable event RPC rejects an event family outside the A2 authorization envelope', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 2 });
  const sub = `a2-family-${randomUUID()}`;
  try {
    await migrate({ pool, directory: path.join(import.meta.dirname, '..', 'migrations') });
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
    await pool.query(`INSERT INTO public.federation_gas_instances(instance_id,jwt_sub,active) VALUES ('gas-primary',$1,true) ON CONFLICT (jwt_sub) DO UPDATE SET instance_id='gas-primary',active=true`, [sub]);
    await assert.rejects(() => rpc(pool, { sub }, `a2-unauthorized-${randomUUID()}`, 'work.created', { work_unit_id: 'must-not-write' }), /event family not authorized/);
  } finally {
    await pool.query('DELETE FROM public.federation_gas_instances WHERE jwt_sub=$1', [sub]).catch(() => {});
    await pool.end();
  }
});
