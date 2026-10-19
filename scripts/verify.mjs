import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';

const root = path.resolve(import.meta.dirname, '..');
const mode = process.argv[2];
const selected = process.argv.slice(3);
const results = [];

const coreSuites = [
  'test/postgres.integration.test.mjs',
  'test/observer.integration.test.mjs',
  'test/vnext-neon.integration.test.mjs',
  'test/vnext-a9-postgres.integration.test.mjs',
  'test/vnext-pilot.integration.test.mjs',
  'test/phase1-operating-boundary.test.mjs',
  'test/vnext-recoverable-dispatch.integration.test.mjs',
  'test/vnext-feedback-evaluation.integration.test.mjs',
  'test/vnext-project-authority-owner.integration.test.mjs',
  'test/vnext-project-authority.integration.test.mjs',
  'test/vnext-project-authority-upgrade.integration.test.mjs',
  'test/vnext-concurrency.integration.test.mjs',
  'test/vnext-postgres-isolation.integration.test.mjs',
];

function fail(message) {
  console.error(`verify: FAILED: ${message}`);
  process.exit(1);
}

function note(message) {
  console.log(`verify: ${message}`);
}

function childEnv() {
  const env = { ...process.env };
  delete env.TEST_DATABASE_URL;
  return env;
}

function text(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function parseTap(output) {
  const counts = { tests: 0, pass: 0, fail: 0, skipped: 0 };
  for (const match of output.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gm)) counts[match[1]] = Number(match[2]);
  return counts;
}

function step(label, command, args) {
  const child = spawn(command, args, { cwd: root, env: childEnv(), stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  return new Promise((resolve) => {
    child.once('close', (code) => resolve({ label, code: code ?? 1, output }));
  });
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22 || major >= 25) fail(`Node ${process.versions.node} is outside the supported range (>=22 <25)`);
}

async function checkPostgres() {
  const url = process.env.POSTGRES_URL;
  if (!url) fail('POSTGRES_URL is required (admin URL for native PostgreSQL)');
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000, application_name: 'ct-runtime-verify' });
  try {
    const version = (await pool.query('SELECT version() AS version')).rows[0].version;
    const roles = (await pool.query("SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])", [['authenticated', 'anonymous']])).rows.map((row) => row.rolname);
    const missing = ['authenticated', 'anonymous'].filter((role) => !roles.includes(role));
    if (missing.length) fail(`PostgreSQL is missing required roles: ${missing.join(', ')} (CREATE ROLE <role> NOLOGIN)`);
    return version;
  } catch (error) {
    fail(`PostgreSQL is not reachable at POSTGRES_URL: ${error.message}`);
  } finally {
    await pool.end().catch(() => {});
  }
}

function checkObserver() {
  const directory = path.resolve(root, '..', 'CT-Foundry', 'capabilities', 'observer');
  for (const file of ['observer.mjs', 'schema.mjs']) {
    if (!existsSync(path.join(directory, file))) fail(`pinned Observer dependency missing: ${path.join(directory, file)}`);
  }
}

async function crossProcessProof() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ct-runtime-proof-'));
  try {
    const first = await step('cross-process proof', process.execPath, ['scripts/prove-vnext-pilot.mjs', directory]);
    if (first.code !== 0) return first;
    await sleep(2000);
    const second = await step('cross-process proof', process.execPath, ['scripts/prove-vnext-pilot.mjs', directory]);
    if (second.code !== 0) return second;
    const outcome = readFileSync(path.join(directory, 'outcome.txt'), 'utf8').trim();
    if (outcome !== '2') {
      console.error(`verify: proof outcome was ${JSON.stringify(outcome)}, expected "2"`);
      return { label: 'cross-process proof', code: 1, output: '' };
    }
    return { label: 'cross-process proof', code: 0, output: '' };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function summarize(identity, environment) {
  console.log('verify: ------------------------------');
  console.log(`verify: mode=${mode}`);
  console.log(`verify: commit=${identity.commit} branch=${identity.branch} worktree=${identity.worktree}`);
  console.log(`verify: environment=${environment}`);
  for (const result of results) {
    const counts = parseTap(result.output);
    const tally = counts.tests ? ` tests=${counts.tests} pass=${counts.pass} fail=${counts.fail} skipped=${counts.skipped}` : '';
    console.log(`verify: ${result.label}: ${result.code === 0 ? 'pass' : 'FAIL'}${tally}`);
  }
  const failed = results.filter((result) => result.code !== 0).length;
  const skipped = results.reduce((total, result) => total + parseTap(result.output).skipped, 0);
  console.log(`verify: skipped=${skipped}`);
  console.log(`verify: result=${failed === 0 ? 'PASS' : 'FAIL'}${failed ? ` (${failed} failed step${failed === 1 ? '' : 's'})` : ''}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

if (mode !== 'targeted' && mode !== 'core') fail('usage: node scripts/verify.mjs targeted <suite...> | core');
checkNode();
if (mode === 'targeted' && selected.length === 0) fail('targeted verification needs at least one suite path');
for (const suite of selected) {
  if (!existsSync(path.resolve(root, suite))) fail(`suite does not exist: ${suite}`);
}
const postgres = await checkPostgres();
const identity = { commit: text('git', ['rev-parse', '--short', 'HEAD']) || 'unknown', branch: text('git', ['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown', worktree: text('git', ['status', '--porcelain']) ? 'dirty' : 'clean' };
const environment = `node ${process.versions.node} ${process.platform}/${process.arch}; ${postgres.split(',')[0]}`;

if (mode === 'targeted') {
  for (const suite of selected) {
    note(`suite ${suite}`);
    results.push(await step(suite, process.execPath, ['scripts/run-postgres-suite.mjs', suite]));
  }
} else {
  if (process.platform !== 'linux') fail('core verification requires Linux for the cross-process proof');
  checkObserver();
  note('local tests');
  const files = readdirSync(path.join(root, 'test')).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => path.join('test', name));
  results.push(await step('local tests', process.execPath, ['--test', ...files]));
  note('migrations');
  results.push(await step('migrations', process.execPath, ['bin/ct-runtime.mjs', 'migrate', '--database-url', process.env.POSTGRES_URL]));
  for (const suite of coreSuites) {
    note(`suite ${suite}`);
    results.push(await step(suite, process.execPath, ['scripts/run-postgres-suite.mjs', suite]));
  }
  note('cross-process proof');
  results.push(await crossProcessProof());
}

summarize(identity, environment);
