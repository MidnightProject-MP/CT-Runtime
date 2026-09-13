import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { bundleHash, deploymentIdFromWebAppUrl, normalizeFiles, signature } from '../lib/gas-deploy-contract.mjs';

const bundle = JSON.parse(await readFile(process.env.GAS_BUNDLE_PATH ?? 'gas-bundle.json', 'utf8'));
if (bundle.schema !== 'ct-runtime-gas-bundle-v1') throw new Error('invalid bundle schema');
const files = normalizeFiles(bundle.files);
const computed = bundleHash(files);
if (computed !== process.env.GAS_BUNDLE_HASH) throw new Error('bundle hash mismatch');

const scriptId = process.env.CT_GAS_SCRIPT_ID;
const endpoint = process.env.CT_GAS_ADMIN_WEB_APP_URL;
const deploymentId = deploymentIdFromWebAppUrl(endpoint);
const secret = process.env.CT_GAS_DEPLOY_HMAC_SECRET;
const commit = process.env.GITHUB_SHA;
const expectedLiveBundleHash = process.env.CT_GAS_EXPECTED_LIVE_BUNDLE_HASH;
for (const [name, value] of Object.entries({ scriptId, endpoint, secret, commit, expectedLiveBundleHash })) if (!value) throw new Error(`${name} is required`);
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('GITHUB_SHA must be a full commit SHA');
const requestId = `ct-runtime-${commit}`;

async function post(body) {
  const url = new URL(endpoint);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(24).toString('hex');
  const payload = JSON.stringify(body);
  const sig = signature(body, timestamp, nonce, payload, secret);
  url.searchParams.set('timestamp', timestamp);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('signature', sig);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
    redirect: 'follow'
  });
  const text = await response.text();
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('response too large');
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 1000)}`);
  if (!text.trim()) throw new Error(`empty response body (HTTP ${response.status})`);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON response (HTTP ${response.status}): ${text.slice(0, 1000)}`);
  }
  if (value.status === 'rejected') throw new Error(JSON.stringify(value));
  return value;
}

const base = { deployment_request_id: requestId, script_id: scriptId, deployment_id: deploymentId, commit_sha: commit, bundle_hash: computed };
const qualification = await post({ ...base, operation: 'self-deploy-qualify' });
if (qualification.status !== 'qualified') throw new Error('self-deploy qualification failed');
const plan = await post({ ...base, operation: 'self-deploy-plan' });
if (plan.liveBundleHash !== expectedLiveBundleHash) throw new Error('live bundle does not match expected predecessor; refusing deployment');
const result = await post({ ...base, operation: 'self-deploy', expected_live_version: plan.liveVersion, expected_live_bundle_hash: plan.liveBundleHash, files });
console.log(JSON.stringify({ ...result, qualification, requestId, commit, bundleHash: computed, deploymentId }));