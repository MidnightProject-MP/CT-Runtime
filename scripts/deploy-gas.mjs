import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { request } from 'node:https';
import { bundleHash, normalizeFiles, signature } from '../lib/gas-deploy-contract.mjs';

const bundle = JSON.parse(await readFile(process.env.GAS_BUNDLE_PATH ?? 'gas-bundle.json', 'utf8'));
if (bundle.schema !== 'ct-runtime-gas-bundle-v1') throw new Error('invalid bundle schema');
const files = normalizeFiles(bundle.files);
const computed = bundleHash(files);
if (computed !== process.env.GAS_BUNDLE_HASH) throw new Error('bundle hash mismatch');

const scriptId = process.env.CT_GAS_SCRIPT_ID;
const deploymentId = process.env.CT_GAS_DEPLOYMENT_ID;
const endpoint = process.env.CT_GAS_DEPLOY_URL;
const secret = process.env.CT_GAS_DEPLOY_HMAC_SECRET;
const commit = process.env.GITHUB_SHA;
const expectedLiveBundleHash = process.env.CT_GAS_EXPECTED_LIVE_BUNDLE_HASH;
for (const [name, value] of Object.entries({ scriptId, deploymentId, endpoint, secret, commit, expectedLiveBundleHash })) if (!value) throw new Error(`${name} is required`);
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('GITHUB_SHA must be a full commit SHA');
const requestId = `ct-runtime-${commit}`;

function post(body) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(24).toString('hex');
    const payload = JSON.stringify(body);
    const sig = signature(body, timestamp, nonce, payload, secret);
    url.searchParams.set('timestamp', timestamp);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('signature', sig);
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; if (Buffer.byteLength(text) > 4 * 1024 * 1024) req.destroy(new Error('response too large')); });
      res.on('end', () => {
        try {
          const value = JSON.parse(text);
          if (res.statusCode < 200 || res.statusCode >= 300 || value.status === 'rejected') reject(new Error(JSON.stringify(value)));
          else resolve(value);
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const base = { deployment_request_id: requestId, script_id: scriptId, deployment_id: deploymentId, commit_sha: commit, bundle_hash: computed };
const qualification = await post({ ...base, operation: 'self-deploy-qualify' });
if (qualification.status !== 'qualified') throw new Error('self-deploy qualification failed');
const plan = await post({ ...base, operation: 'self-deploy-plan' });
if (plan.liveBundleHash !== expectedLiveBundleHash) throw new Error('live bundle does not match expected predecessor; refusing deployment');
const result = await post({ ...base, operation: 'self-deploy', expected_live_version: plan.liveVersion, expected_live_bundle_hash: plan.liveBundleHash, files });
console.log(JSON.stringify({ ...result, qualification, requestId, commit, bundleHash: computed }));
