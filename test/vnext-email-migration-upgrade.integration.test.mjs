import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testPool } from './pilot-test-pool.mjs';
import { migrateVNext } from '../lib/vnext/migration.mjs';

test('Gmail migrations upgrade cleanly from canonical state through 009', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async () => {
  const pool = await testPool();
  const root = fileURLToPath(new URL('../vnext-migrations', import.meta.url));
  const temp = await mkdtemp(path.join(process.cwd(), '.email-migration-'));
  const pre = path.join(temp, 'pre');
  const full = path.join(temp, 'full');
  await Promise.all([writeFile(path.join(temp, '.keep'), ''), import('node:fs/promises').then(({ mkdir }) => Promise.all([mkdir(pre), mkdir(full)]))]);
  try {
    const files = (await readdir(root)).filter(file => /^\d+_.*\.sql$/.test(file)).sort();
    const versionsThrough011 = files.filter(file => Number(file.match(/^\d+/)[0]) <= 11).map(file => Number(file.match(/^\d+/)[0]));
    assert.ok(files.some(file => file.startsWith('009_')));
    for (const file of files) {
      const source = await readFile(path.join(root, file));
      if (Number(file.match(/^\d+/)[0]) <= 11) await writeFile(path.join(full, file), source);
      if (Number(file.match(/^\d+/)[0]) <= 9) await writeFile(path.join(pre, file), source);
    }
    await migrateVNext({ pool, directory: pre });
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM vnext_schema_migrations WHERE version=9")).rows[0].count, 1);
    assert.equal((await pool.query("SELECT to_regclass('public.vnext_email_mailboxes') AS relation")).rows[0].relation, null);
    assert.equal((await pool.query("SELECT to_regclass('public.vnext_project_reconciliation_blocks') AS relation")).rows[0].relation, 'vnext_project_reconciliation_blocks');
    await migrateVNext({ pool, directory: full });
    const versions = (await pool.query('SELECT version::int FROM vnext_schema_migrations ORDER BY version')).rows.map(row => row.version);
    assert.deepEqual(versions, versionsThrough011);
    const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='vnext_email_mailboxes' ORDER BY column_name")).rows.map(row => row.column_name);
    assert.deepEqual(columns.sort(), ['allowed_sender','enabled','label_name','mailbox_address','mailbox_id','project_id','updated_at'].sort());
    assert.equal((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='vnext_pilot_results' AND column_name='input_seq'")).rows.length, 1);
    assert.equal((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='vnext_email_outbox' AND column_name='in_reply_to'")).rows.length, 1);
  } finally {
    await pool.end();
    await rm(temp, { recursive: true, force: true });
  }
});
