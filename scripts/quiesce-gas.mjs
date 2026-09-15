import { randomUUID } from 'node:crypto';
import { signingString, signature } from '../lib/gas-deploy-contract.mjs';

const operation = process.argv[2];
if (!['quiesce-legacy-autonomy', 'assert-legacy-quiesced'].includes(operation)) {
  throw new Error(`invalid operation: ${operation}`);
}

const endpoint = String(process.env.CT_GAS_ADMIN_WEB_APP_URL || '').trim();
const secret = String(process.env.CT_GAS_DEPLOY_HMAC_SECRET || '');
if (!endpoint || !secret) throw new Error('CT_GAS_ADMIN_WEB_APP_URL and CT_GAS_DEPLOY_HMAC_SECRET are required');

const request = {
  operation,
  deployment_request_id: `ct-runtime-${operation}-${process.env.GITHUB_RUN_ID || Date.now()}`,
  script_id: '',
  deployment_id: '',
  commit_sha: '',
  github_bundle_hash: ''
};
const body = JSON.stringify({});
const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = randomUUID();
const url = new URL(endpoint);
url.searchParams.set('timestamp', timestamp);
url.searchParams.set('nonce', nonce);
url.searchParams.set('signature', signature(request, timestamp, nonce, body, secret));

const response = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body,
  redirect: 'follow'
});
const text = await response.text();
let result;
try { result = JSON.parse(text); } catch (_) { throw new Error(`invalid GAS response: HTTP ${response.status}`); }
if (!response.ok) throw new Error(`GAS control-plane HTTP ${response.status}: ${JSON.stringify(result)}`);

const output = { operation, ...result };
console.log(JSON.stringify(output));
if (process.env.OUTPUT_PATH) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(process.env.OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
}
