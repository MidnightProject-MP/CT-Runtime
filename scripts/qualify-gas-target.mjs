import { pathToFileURL } from 'node:url';
import { deploymentIdFromWebAppUrl } from '../lib/gas-deploy-contract.mjs';
import { isProductionTarget } from '../lib/gas-targets.mjs';

const ID = /^[A-Za-z0-9_-]{20,}$/;
const SANDBOX_REF = /^refs\/tags\/gas-sandbox-release\/[A-Za-z0-9._-]+$/;

export function qualifySandboxTarget(env) {
  if (env.CT_GAS_TARGET !== 'sandbox') throw new Error('sandbox target required');
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('manual sandbox qualification required');
  if (!SANDBOX_REF.test(env.GITHUB_REF || '')) throw new Error('sandbox release ref required');
  if (!/^[0-9a-f]{40}$/.test(env.GITHUB_SHA || '')) throw new Error('full sandbox release commit required');

  const scriptId = (env.CT_GAS_SCRIPT_ID || '').trim();
  const deploymentId = (env.CT_GAS_DEPLOYMENT_ID || '').trim();
  const endpoint = (env.CT_GAS_ADMIN_WEB_APP_URL || '').trim();
  if (!ID.test(scriptId)) throw new Error('sandbox script id required');
  if (!ID.test(deploymentId)) throw new Error('sandbox deployment id required');
  if (!endpoint) throw new Error('sandbox admin endpoint required');
  if (!env.CT_GAS_DEPLOY_HMAC_SECRET) throw new Error('sandbox deploy secret unavailable');

  const derived = deploymentIdFromWebAppUrl(endpoint);
  if (derived !== deploymentId) throw new Error('sandbox deployment id does not match endpoint');
  if (isProductionTarget(scriptId, deploymentId)) throw new Error('production target is forbidden');

  return {
    target: 'sandbox',
    scriptId,
    deploymentId,
    releaseCommit: env.GITHUB_SHA,
    releaseRef: env.GITHUB_REF
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(qualifySandboxTarget(process.env)));
  } catch (error) {
    console.error(`sandbox target qualification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
