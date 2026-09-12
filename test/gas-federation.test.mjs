import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalAdvisory, createGasNotifier, GAS_FEDERATION_RPC_PATHS, persistThenNotify, PostgresGasAdvisoryAdapter } from '../lib/gas-federation.mjs';
import { sha256 } from '../lib/config.mjs';

const advisory = { schema: 'celestan-gas-federation-advisory-v1', version: 1, nonce: 'nonce-1', issuedAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-09-01T00:05:00.000Z', instanceId: 'gas-instance', workOrderId: 'work-1', handoffId: 'handoff-1', handoffRevision: 1, targetExecutionId: 'exec-2', targetFence: 2, checkpointDigest: sha256({ step: 1 }), reason: 'bounded-continuation' };

test('GAS advisory has strict canonical fields, bounds, and fixed RPC paths', () => {
  assert.deepEqual(canonicalAdvisory(advisory), advisory);
  assert.throws(() => canonicalAdvisory({ ...advisory, task: 'must-not-cross-boundary' }), /canonical/);
  assert.throws(() => canonicalAdvisory({ ...advisory, expiresAt: '2026-09-01T00:31:00.000Z' }), /TTL/);
  assert.deepEqual(Object.keys(GAS_FEDERATION_RPC_PATHS), ['pending', 'take', 'checkpoint']);
});

test('canonical advisory rejects noncanonical timestamp spellings', () => {
  assert.throws(() => canonicalAdvisory({ ...advisory, issuedAt: '2026-09-01T00:00:00Z' }), /canonical/);
  assert.throws(() => canonicalAdvisory({ ...advisory, expiresAt: '2026-09-01 00:05:00.000Z' }), /canonical/);
  assert.throws(() => canonicalAdvisory({ ...advisory, issuedAt: 'not-a-date' }), /canonical|invalid/);
});

test('notifier signs the canonical advisory with HMAC in query and headers', async () => {
  let request;
  const notify = createGasNotifier({ url: 'https://gas.example/webapp', secret: 'unit-secret', fetch: async (url, options) => { request = { url: String(url), options }; return { status: 200, ok: true, text: async () => '{"status":"checkpointed"}' }; } });
  const result = await notify(advisory);
  assert.equal(result.ok, true); const parsed = new URL(request.url); const timestamp = parsed.searchParams.get('timestamp'); const signature = parsed.searchParams.get('signature');
  assert.match(timestamp, /^\d+$/); assert.match(signature, /^[a-f0-9]{64}$/); assert.equal(request.options.headers.authorization, undefined); assert.equal(request.options.body.includes('unit-secret'), false);
});

test('notifier requires an HMAC secret', () => {
  assert.throws(() => createGasNotifier({ url: 'https://gas.example/webapp', fetch: async () => ({ status: 200, ok: true }) }), /secret/);
});

test('notifier is successful only for explicit consumed classifications', async () => {
  for (const classification of ['already-consumed', 'invalid-response', 'competing-authority', 'stale-target', 'rejected']) {
    const notify = createGasNotifier({ url: 'https://gas.example/webapp', secret: 'unit-secret', fetch: async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ status: classification }) }) });
    const result = await notify(advisory);
    assert.equal(result.ok, classification === 'already-consumed');
  }
});

test('persistence completes before notification and notification failure remains recoverable', async () => {
  const order = [];
  await assert.rejects(() => persistThenNotify({ advisory, persist: async () => { order.push('persist'); return { state: 'pending' }; }, notify: async () => { order.push('notify'); throw new Error('web app unavailable'); } }), /unavailable/);
  assert.deepEqual(order, ['persist', 'notify']);
});

test('already-consumed duplicate reports its state and is not notified', async () => {
  let notified = false;
  const result = await persistThenNotify({ advisory, persist: async () => ({ state: 'consumed', duplicate: true }), notify: async () => { notified = true; } });
  assert.equal(result.persisted.state, 'consumed');
  assert.equal(result.notification, null);
  assert.equal(notified, false);
});

test('transport contract separates HMAC notification from identity-token RPC polling', async () => {
  const gas = await readFile(new URL('../gas/gas_federation.js', import.meta.url), 'utf8');
  const sql = await readFile(new URL('../migrations/006_gas_federation_transport.sql', import.meta.url), 'utf8');
  const trigger = await readFile(new URL('../gas/gas_trigger.js', import.meta.url), 'utf8');
  assert.match(gas, /ScriptApp\.getIdentityToken/);
  assert.match(gas, /function inspectFederationIdentity\(\)/);
  assert.match(gas, /FEDERATION_IDENTITY/);
  assert.match(gas, /aud:payload\.aud,sub:payload\.sub/);
  assert.match(gas, /computeHmacSha256Signature/);
  assert.match(gas, /CT_GAS_FEDERATION_HMAC_SECRET/);
  assert.match(sql, /request\.jwt\.claims/);
   assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.federation_gas_instances/);
   assert.match(sql, /i\.jwt_sub=public\.federation_jwt_sub\(\) AND i\.active/);
  assert.match(sql, /REVOKE ALL ON FUNCTION/);
  assert.match(sql, /federation_take_for_gas/);
  assert.match(trigger, /dispatchPendingFederationAdvisories/);
  assert.doesNotMatch(gas, /e&&e\.headers/);
});

test('admin web route is separate, replay-resistant, and allowlisted', async () => {
  const gas = await readFile(new URL('../gas/gas_federation.js', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../.github/workflows/gas-clasp-deploy.yml', import.meta.url), 'utf8');
  const caller = await readFile(new URL('../.github/scripts/gas-admin-call.mjs', import.meta.url), 'utf8');
  assert.match(gas, /CT_GAS_ADMIN_SECRET/);
  assert.match(gas, /CT_GAS_ADMIN_LAST_NONCE/);
  assert.match(gas, /unsupported admin operation/);
  assert.match(gas, /admin\.readinessCheck/);
  assert.match(workflow, /CT_GAS_ADMIN_WEB_APP_URL/);
  assert.doesNotMatch(workflow, /clasp run/);
  assert.match(caller, /createHmac/);
  assert.match(caller, /randomUUID/);
});

test('pre-persisted matching duplicate remains pending and notification can retry', async () => {
  const calls = [];
  const client = { query: async (sql, params) => {
    calls.push([sql, params]);
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.startsWith('SELECT h.*')) return { rows: [{ to_execution_id: 'exec-2', source_checkpoint: { step: 1 }, next_claim_fence: 2 }] };
    if (sql.startsWith('SELECT * FROM federation_executions')) return { rows: [{ claim_fence: 2, claim_owner: 'gas-instance', state: 'claimed' }] };
    if (sql.startsWith('INSERT')) return { rowCount: 0, rows: [] };
     if (sql.startsWith('SELECT body_digest')) return { rows: [{ body_digest: calls.find(([text]) => text.startsWith('INSERT'))[1][3], state: 'pending' }] };
    throw new Error(`unexpected query: ${sql}`);
  }, release() {} };
  const adapter = new PostgresGasAdvisoryAdapter({ connect: async () => client });
  const result = await adapter.persist(advisory);
  assert.equal(result.duplicate, true);
  assert.equal(calls[0][0], 'BEGIN'); assert.equal(calls.at(-1)[0], 'COMMIT');
  assert.ok(calls.some(([sql]) => sql.startsWith('SELECT body_digest')));
});

test('advisory persistence rejects a target superseded by a newer work-order fence', async () => {
  const client = { query: async (sql) => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.startsWith('INSERT')) return { rowCount: 1, rows: [{ advisory_id: advisory.nonce }] };
    if (sql.startsWith('SELECT h.*')) return { rows: [{ to_execution_id: 'exec-2', source_checkpoint: { step: 1 }, next_claim_fence: 3 }] };
    if (sql.startsWith('SELECT * FROM federation_executions')) return { rows: [{ claim_fence: 2, claim_owner: 'gas-instance', state: 'handoff' }] };
    throw new Error(`unexpected query: ${sql}`);
  }, release() {} };
  await assert.rejects(() => new PostgresGasAdvisoryAdapter({ connect: async () => client }).persist(advisory), /stale/);
});

test('consumed advisory retry remains idempotent after its target is superseded', async () => {
  const calls = [];
  let digest;
  const client = { query: async (sql, params) => {
    calls.push(sql);
    if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
    if (sql.startsWith('INSERT')) { digest = params[3]; return { rowCount: 0, rows: [] }; }
    if (sql.startsWith('SELECT body_digest')) return { rows: [{ body_digest: digest, state: 'consumed' }] };
    throw new Error(`unexpected query: ${sql}`);
  }, release() {} };
  const result = await new PostgresGasAdvisoryAdapter({ connect: async () => client }).persist(advisory);
  assert.deepEqual(result, { advisoryId: advisory.nonce, state: 'consumed', duplicate: true });
  assert.equal(calls.some((sql) => sql.startsWith('SELECT h.*')), false);
});

test('SQL contract authenticates notifications separately and checkpoints the returned fence', async () => {
  const sql = await readFile(new URL('../migrations/006_gas_federation_transport.sql', import.meta.url), 'utf8');
  const revisionSql = await readFile(new URL('../migrations/007_federation_handoff_revision.sql', import.meta.url), 'utf8');
   assert.match(sql, /p_advisory_text text,p_body_digest text,p_checkpoint_text text,p_checkpoint_digest text,p_fence bigint/);
  assert.match(sql, /e\.claim_fence<>p_fence/);
  assert.match(sql, /sourceCheckpointDigest/);
   assert.match(sql, /v_checkpoint->>'physicalExecutionId'/);
  assert.doesNotMatch(sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION federation_checkpoint_for_gas')), /a\.expires_at<=clock_timestamp\(\)/);
  assert.match(sql, /e\.claim_fence<>p_fence/);
   assert.match(sql, /a\.target_fence/);
   assert.match(sql, /advisory_body text/);
   assert.match(sql, /digest\(pg_catalog\.convert_to\(p_checkpoint_text/);
    assert.match(sql, /p_advisory_text<>a\.advisory_body/);
    assert.match(sql, /a\.body_digest IS DISTINCT FROM p_body_digest/);
    assert.match(sql, /advisory<>a\.advisory_body::jsonb/);
    assert.doesNotMatch(sql, /jsonb_object_length/);
  assert.doesNotMatch(sql, /p_checkpoint::text/);
  assert.match(revisionSql, /ADD COLUMN revision bigint NOT NULL DEFAULT 1/);
});

test('canonical text and stable identity contracts are enforced in transport', async () => {
  const gas = await readFile(new URL('../gas/gas_federation.js', import.meta.url), 'utf8');
  const sql = await readFile(new URL('../migrations/006_gas_federation_transport.sql', import.meta.url), 'utf8');
   assert.match(gas, /p_advisory_text:advisoryText/);
   assert.match(gas, /p_body_digest:bodyDigest/);
   assert.match(gas, /p_checkpoint_text:checkpointText/);
  assert.match(sql, /a\.expires_at>pg_catalog\.clock_timestamp\(\)/);
   assert.match(sql, /state='rejected'/);
   assert.match(sql, /state='rejected',consumed_at=pg_catalog\.clock_timestamp\(\)/);
   assert.match(sql, /claim_owner=instance/);
   assert.match(sql, /other\.lease_until>pg_catalog\.clock_timestamp\(\)/);
   assert.match(sql, /p_advisory_text IS NULL OR p_advisory_text<>a\.advisory_body/);
   assert.match(sql, /p_body_digest IS NULL/);
   assert.match(sql, /federation_checkpoint_for_gas\(text,text,text,text,bigint\)/);
  assert.match(sql, /REVOKE ALL ON public\.federation_work_orders,public\.federation_executions/);
  assert.match(sql, /TO authenticated/);
});

test('signature verification contract covers missing auth, bad auth, tamper, and replay handling', async () => {
  const gas = await readFile(new URL('../gas/gas_federation.js', import.meta.url), 'utf8');
  assert.match(gas, /missing federation authentication/);
  assert.match(gas, /invalid federation signature/);
  assert.match(gas, /timestamp\+'\.'\+raw/);
  assert.match(await readFile(new URL('../migrations/006_gas_federation_transport.sql', import.meta.url), 'utf8'), /already-consumed/);
  assert.match(gas, /lifecycle:'deferred'/);
  assert.match(gas, /federationRejectionReason/);
  assert.match(gas, /return 'internal-error'/);
});

test('interactive takeover safety migration treats null GAS leases as expired and omits JWT subjects', async () => {
  const sql = await readFile(new URL('../migrations/009_interactive_takeover_safety.sql', import.meta.url), 'utf8');
  assert.match(sql, /coalesce\(e\.lease_until,'-infinity'::timestamptz\)<=pg_catalog\.clock_timestamp\(\)/);
  assert.match(sql, /other\.lease_until>pg_catalog\.clock_timestamp\(\)/);
  assert.match(sql, /RETURN pg_catalog\.jsonb_build_object\('status','competing-authority'\)/);
  assert.match(sql, /'canonicalCheckpointDigest',canonical_digest/);
  assert.doesNotMatch(sql, /'subject',sub/);
});

test('successful GAS checkpoint atomically releases canonical mutation authority', async () => {
  const sql = await readFile(new URL('../migrations/010_gas_checkpoint_release.sql', import.meta.url), 'utf8');
  assert.match(sql, /state='deferred',lease_until=NULL/);
  assert.match(sql, /'state','deferred'/);
  assert.match(sql, /canonicalCheckpointDigest/);
});

test('superseded GAS advisories cannot revive an older fence after foreground expiry', async () => {
  const sql = await readFile(new URL('../migrations/011_superseded_gas_advisory.sql', import.meta.url), 'utf8');
  assert.match(sql, /w\.next_claim_fence<>a\.target_fence/);
  assert.match(sql, /e\.state NOT IN \('claimed','running'\)/);
  assert.match(sql, /RETURN pg_catalog\.jsonb_build_object\('status','stale-target'\)/);
});
