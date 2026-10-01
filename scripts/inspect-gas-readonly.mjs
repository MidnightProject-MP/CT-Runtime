import { pathToFileURL } from 'node:url';

export const SCRIPT_ID = '1Uzv-r4UW-y9XLuO-f3QEvrwzInGu1JarmqecVtwarJor6Z5qpmUD2dri';
export const DEPLOYMENT_ID = 'AKfycbwyFPC55MvhCfPUmBlfm7eRp-uHr5tpZ2H9suobETGXod_hLLVDQtC9DelC7ee_WSNawg';
const KEYS = ['CT_GAS_FEDERATION_DATA_API_URL', 'CT_GAS_DEPLOYMENT_ID', 'CT_AUTONOMY_MODE'];
const API = `https://script.googleapis.com/v1/projects/${SCRIPT_ID}`;

// Presence only: never evaluate source or infer current properties from literals.
export function inspectSource(content) {
  const files = Array.isArray(content?.files) ? content.files : [];
  const sources = files.filter(f => f.type === 'SERVER_JS').map(f => String(f.source || ''));
  const result = {
    fileCount: files.length,
    propertyReferences: Object.fromEntries(KEYS.map(key => [key, sources.some(s => s.includes(key))])),
    hasDoGet: sources.some(s => /\bfunction\s+doGet\s*\(/.test(s)),
    hasDoPost: sources.some(s => /\bfunction\s+doPost\s*\(/.test(s)),
    webapp: null
  };
  const manifest = files.find(f => f.type === 'JSON' && /^appsscript(?:\.json)?$/.test(f.name));
  try {
    const webapp = JSON.parse(manifest?.source).webapp;
    if (webapp) result.webapp = {
      access: ['MYSELF', 'DOMAIN', 'ANYONE', 'ANYONE_ANONYMOUS'].includes(webapp.access) ? webapp.access : null,
      executeAs: ['USER_ACCESSING', 'USER_DEPLOYING'].includes(webapp.executeAs) ? webapp.executeAs : null
    };
  } catch { /* Never expose parse errors containing source. */ }
  return result;
}

async function jsonResponse(response) {
  if (!response.ok) throw new Error('request-failed');
  return response.json();
}

export async function inspectGas({ credentials, fetchImpl = fetch }) {
  const stored = credentials.tokens?.default || (credentials.token && {
    ...credentials.token,
    client_id: credentials.oauth2ClientSettings?.clientId,
    client_secret: credentials.oauth2ClientSettings?.clientSecret
  });
  if (!stored?.refresh_token || !stored.client_id || !stored.client_secret) throw new Error('credentials-unavailable');
  const auth = await jsonResponse(await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: stored.refresh_token,
      client_id: stored.client_id, client_secret: stored.client_secret })
  }));
  if (typeof auth.access_token !== 'string' || !auth.access_token) throw new Error('credentials-unavailable');
  async function get(suffix) {
    return jsonResponse(await fetchImpl(API + suffix, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${auth.access_token}` }
    }));
  }
  const deployment = await get(`/deployments/${DEPLOYMENT_ID}`);
  const config = deployment.deploymentConfig;
  if (deployment.deploymentId !== DEPLOYMENT_ID || config?.scriptId !== SCRIPT_ID ||
      !Number.isSafeInteger(config.versionNumber) || config.versionNumber < 1) throw new Error('target-mismatch');
  const head = await get('/content');
  const live = await get(`/content?versionNumber=${config.versionNumber}`);
  return {
    status: 'read-only-inspection-complete', scriptId: SCRIPT_ID, deploymentId: DEPLOYMENT_ID,
    liveVersion: config.versionNumber, head: inspectSource(head), live: inspectSource(live),
    liveProperties: 'unavailable-via-apps-script-rest-api',
    projectIdentifiers: 'not-read-no-established-property-key-allowlist'
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await inspectGas({ credentials: JSON.parse(process.env.CLASPRC_JSON || '{}') });
    console.log(JSON.stringify(result, null, 2));
  } catch {
    // Do not print exception messages, OAuth responses, source or raw API bodies.
    console.error('Read-only GAS inspection failed; no remote mutation attempted.');
    process.exitCode = 1;
  }
}
