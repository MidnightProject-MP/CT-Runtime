import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateVNext } from '../lib/vnext/migration.mjs';

class FakePool {
  constructor(ledger = []) {
    this.ledger = new Map(ledger.map((row) => [Number(row.version), { version: Number(row.version), checksum: row.checksum }]));
    this.executed = [];
  }
  async query(sql, params = []) {
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS')) return { rows: [] };
    if (sql.startsWith('SELECT version, checksum FROM vnext_schema_migrations')) return { rows: [...this.ledger.values()] };
    if (sql.startsWith('SELECT checksum FROM vnext_schema_migrations')) {
      const row = this.ledger.get(Number(params[0]));
      return { rows: row ? [{ checksum: row.checksum }] : [] };
    }
    throw new Error(`unexpected pool query: ${sql}`);
  }
  async connect() {
    const pool = this;
    return {
      async query(sql, params = []) {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.startsWith('INSERT INTO vnext_schema_migrations')) {
          pool.ledger.set(Number(params[0]), { version: Number(params[0]), checksum: params[1] });
          return { rows: [] };
        }
        pool.executed.push(sql);
        return { rows: [] };
      },
      release() {},
    };
  }
}

async function fixture({ files, ledger = [], baseline = true }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ct-runtime-vnext-migration-'));
  await mkdir(directory, { recursive: true });
  for (const [name, sql] of Object.entries(files)) await writeFile(path.join(directory, name), sql);
  if (baseline) {
    await writeFile(path.join(directory, 'legacy-baseline.json'), JSON.stringify({
      legacy_applied_migrations: [{ version: 3, checksum: '1dbd5813111b159b4fb93f69fd39ebf18b6a68eccc31d7ac01329c4125725b1a' }],
    }, null, 2) + '\n');
  }
  return directory;
}

const files = {
  '001_outer_loop.sql': 'migration one',
  '002_survivability.sql': 'migration two',
  '004_immutable_events.sql': 'migration four',
};

const sha256 = (value) => import('node:crypto').then(({ createHash }) => createHash('sha256').update(value).digest('hex'));

test('fresh repository runs 001, 002, then 004', async () => {
  const directory = await fixture({ files });
  const pool = new FakePool();
  await migrateVNext({ pool, directory });
  assert.deepEqual(pool.executed, ['migration one', 'migration two', 'migration four']);
});

test('production predecessor ledger 1, 2, 3@pinned baseline accepts orphan 3 and applies only 004', async () => {
  const directory = await fixture({ files, ledger: [
    { version: 1, checksum: await sha256(files['001_outer_loop.sql']) },
    { version: 2, checksum: await sha256(files['002_survivability.sql']) },
    { version: 3, checksum: '1dbd5813111b159b4fb93f69fd39ebf18b6a68eccc31d7ac01329c4125725b1a' },
  ] });
  const pool = new FakePool([
    { version: 1, checksum: await sha256(files['001_outer_loop.sql']) },
    { version: 2, checksum: await sha256(files['002_survivability.sql']) },
    { version: 3, checksum: '1dbd5813111b159b4fb93f69fd39ebf18b6a68eccc31d7ac01329c4125725b1a' },
  ]);
  await migrateVNext({ pool, directory });
  assert.deepEqual(pool.executed, ['migration four']);
  assert.equal(pool.ledger.get(3).checksum, '1dbd5813111b159b4fb93f69ebf18b6a68eccc31d7ac01329c4125725b1a');
  assert.equal(pool.ledger.get(4).checksum, await sha256(files['004_immutable_events.sql']));
});

test('orphaned version 3 with any other checksum remains a hard failure', async () => {
  const directory = await fixture({ files });
  const pool = new FakePool([{ version: 3, checksum: '0'.repeat(64) }]);
  await assert.rejects(() => migrateVNext({ pool, directory }), /checksum mismatch or unknown orphaned migration: version 3/);
  assert.deepEqual(pool.executed, []);
});

test('applied repository migration remains checksum-immutable', async () => {
  const directory = await fixture({ files });
  const pool = new FakePool([{ version: 1, checksum: '0'.repeat(64) }]);
  await assert.rejects(() => migrateVNext({ pool, directory }), /vNext migration checksum mismatch: 001_outer_loop\.sql/);
  assert.deepEqual(pool.executed, []);
});

test('legacy baseline itself cannot overlap an authoritative repository migration', async () => {
  const directory = await fixture({ files });
  await writeFile(path.join(directory, 'legacy-baseline.json'), JSON.stringify({
    legacy_applied_migrations: [{ version: 4, checksum: '1'.repeat(64) }],
  }));
  const pool = new FakePool();
  await assert.rejects(() => migrateVNext({ pool, directory }), /legacy migration baseline overlaps repository migration: version 4/);
});
