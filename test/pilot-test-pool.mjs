import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
export async function testPool({ dataDir } = {}) {
  if (process.env.TEST_DATABASE_URL) return new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 });
  const db = new PGlite(dataDir);
  let tail = Promise.resolve();
  const acquire = async () => { let release; const previous = tail; tail = new Promise(r => { release = r; }); await previous; return release; };
  const query = async (sql, args) => {
    const r = args ? await db.query(sql, args) : (await db.exec(sql)).at(-1);
    return { ...r, rowCount: r.rows.length || r.affectedRows || 0 };
  };
  return { async query(...args) { const release = await acquire(); try { return await query(...args); } finally { release(); } },
    async connect() { const release = await acquire(); return { query, release }; }, async end() { await db.close(); } };
}
