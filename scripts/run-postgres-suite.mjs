import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';

const adminUrl = process.env.POSTGRES_URL;
const suite = process.argv[2];
const extraArgs = process.argv.slice(3);

if (!adminUrl || !suite) throw new Error('POSTGRES_URL and a test suite path are required');

const admin = new Pool({ connectionString: adminUrl, max: 1 });
const database = `ctruntime_test_${randomUUID().replaceAll('-', '')}`;
const url = new URL(adminUrl);
url.pathname = `/${database}`;
let created = false;
let exitCode = 1;

try {
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  const child = spawn(process.execPath, ['--test', suite, ...extraArgs], {
    stdio: 'inherit',
    env: { ...process.env, TEST_DATABASE_URL: url.href },
  });
  exitCode = await new Promise(resolve => {
    child.once('error', () => resolve(1));
    child.once('exit', code => resolve(code ?? 1));
  });
} finally {
  if (created) {
    await admin.query(`DROP DATABASE "${database}"`).catch(error => {
      console.error(`Failed to drop isolated PostgreSQL test database ${database}: ${error.message}`);
      exitCode = exitCode || 1;
    });
  }
  await admin.end();
}

process.exitCode = exitCode;
