import { randomBytes } from 'node:crypto';
import { bundleHash, signature } from '../lib/gas-deploy-contract.mjs';

const endpoint = process.env.CT_GAS_ADMIN_WEB_APP_URL;
const secret = process.env.CT_GAS_DEPLOY_HMAC_SECRET;
const scriptId = process.env.CT_GAS_SCRIPT_ID;
const deploymentId = process.env.CT_GAS_DEPLOYMENT_ID;
const commit = process.env.GITHUB_SHA ?? 'readback000000000000000000000000000000000000';
const requestId = `ct-runtime-readback-${commit}`;
const placeholderBundleHash = bundleHash([{ name: 'appsscript.json', type: 'JSON', source: '{}' }]);

for (const [name, value] of Object.entries({ endpoint, secret, scriptId, deploymentId })) {
  if (!value) throw new Error(`${name} is required`);
}

async function post(body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(24).toString('hex');
  const payload = JSON.stringify(body);
  const sig = signature(body, timestamp, nonce, payload, secret);
  const url = new URL(endpoint);
  url.searchParams.set('timestamp', timestamp);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('signature', sig);
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'content-type': 'application/json' },
    body: payload
  });
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error(`non-json response status=${response.status} body=${JSON.stringify(text.slice(0, 500))}`); }
  if (!response.ok || value.status === 'rejected') throw new Error(JSON.stringify(value));
  return value;
}

const base = {
  script_id: scriptId,
  deployment_id: deploymentId,
  deployment_request_id: requestId,
  commit_sha: /^[0-9a-f]{40}$/.test(commit) ? commit : '0'.repeat(40),
  bundle_hash: placeholderBundleHash
};

const qualification = await post({ ...base, operation: 'self-deploy-qualify' });
const plan = await post({ ...base, operation: 'self-deploy-plan' });
console.log(JSON.stringify({ qualification, plan }, null, 2));
