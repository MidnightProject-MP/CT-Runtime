import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const SCRIPT_ID = '1Uzv-r4UW-y9XLuO-f3QEvrwzInGu1JarmqecVtwarJor6Z5qpmUD2dri';
export const DEPLOYMENT_ID = 'AKfycbwyFPC55MvhCfPUmBlfm7eRp-uHr5tpZ2H9suobETGXod_hLLVDQtC9DelC7ee_WSNawg';
const KEYS = ['CT_GAS_FEDERATION_DATA_API_URL', 'CT_GAS_DEPLOYMENT_ID', 'CT_AUTONOMY_MODE'];
const API = `https://script.googleapis.com/v1/projects/${SCRIPT_ID}`;

// Compare complete normalized URLs in memory. Only fixed, explicitly safe identity
// components may leave this function; unknown hosts/IDs are not reflected.
function normalizedUrl(raw) {
  if (typeof raw !== 'string' || /[\\\x00-\x20\x7f]/.test(raw)) return null;
  try { return new URL(raw); } catch { return null; }
}
export function urlIdentity(raw) {
  const url = normalizedUrl(raw);
  return {
    scheme: ['https:', 'http:'].includes(url?.protocol) ? url.protocol.slice(0, -1) : null,
    hostname: url?.hostname === 'script.google.com' ? 'script.google.com' : null,
    deploymentId: url?.pathname === `/macros/s/${DEPLOYMENT_ID}/exec` ? DEPLOYMENT_ID : null
  };
}
function probeUrl(raw) {
  // Strict raw form prevents URL-parser normalization from laundering unsafe input.
  if (typeof raw !== 'string' || !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/i.test(raw)) return null;
  const url = normalizedUrl(raw);
  return url?.pathname === `/macros/s/${DEPLOYMENT_ID}/exec` ? url.href : null;
}
export async function probeEndpoint(raw, fetchImpl = fetch) {
  const url = probeUrl(raw);
  if (!url) return { status: 'skipped-not-pinned-url' };
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      credentials: 'omit', signal: AbortSignal.timeout(15000) });
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const result = { status: response.status,
      contentType: ['text/html', 'text/plain', 'application/json'].includes(mime) ? mime : null };
    // Never consume/log body, Location, cookies or other headers; never follow.
    await response.body?.cancel();
    return result;
  } catch { return { status: 'probe-failed' }; }
}
export function sourceHash(content) {
  if (!Array.isArray(content?.files) || !content.files.length) throw new Error('invalid-content');
  const files = content.files.map(({ name, type, source }) => {
    if ([name, type, source].some(v => typeof v !== 'string')) throw new Error('invalid-content');
    return { name, type, source };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (new Set(files.map(f => f.name)).size !== files.length) throw new Error('invalid-content');
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

export async function inspectEntryPoints(deployment, configuredUrl, fetchImpl, probe) {
  const entries = Array.isArray(deployment.entryPoints) ? deployment.entryPoints : [];
  const webapps = entries.filter(e => e.entryPointType === 'WEB_APP');
  // Ambiguous/missing canonical endpoint fails closed for comparison/probing.
  const webapp = webapps.length === 1 ? webapps[0].webApp : null;
  const config = webapp?.entryPointConfig;
  const canonical = normalizedUrl(webapp?.url), configured = normalizedUrl(configuredUrl);
  const equal = canonical && configured ? canonical.href === configured.href : null;
  const canonicalProbe = probe ? await probeEndpoint(webapp?.url, fetchImpl) : { status: 'disabled' };
  const sameProbeTarget = probeUrl(webapp?.url) && probeUrl(webapp?.url) === probeUrl(configuredUrl);
  return {
    webAppCount: webapps.length,
    executionApiPresent: entries.some(e => e.entryPointType === 'EXECUTION_API'),
    access: ['MYSELF', 'DOMAIN', 'ANYONE', 'ANYONE_ANONYMOUS'].includes(config?.access) ? config.access : null,
    executeAs: ['USER_ACCESSING', 'USER_DEPLOYING'].includes(config?.executeAs) ? config.executeAs : null,
    canonical: urlIdentity(webapp?.url), configured: urlIdentity(configuredUrl),
    normalizedUrlsEqual: equal,
    canonicalProbe,
    configuredProbe: !probe ? { status: 'disabled' } : sameProbeTarget
      ? { ...canonicalProbe, reusedCanonicalProbe: true } : await probeEndpoint(configuredUrl, fetchImpl)
  };
}

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

export async function inspectGas({ credentials, configuredUrl, probe = false, fetchImpl = fetch }) {
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
  const headHash = sourceHash(head), liveHash = sourceHash(live);
  const entryPoints = await inspectEntryPoints(deployment, configuredUrl, fetchImpl, probe);
  return {
    status: 'read-only-inspection-complete', scriptId: SCRIPT_ID, deploymentId: DEPLOYMENT_ID,
    liveVersion: config.versionNumber, head: inspectSource(head), live: inspectSource(live),
    contentComparison: { algorithm: 'sha256-sorted-name-type-source', headHash, liveHash, equal: headHash === liveHash },
    entryPoints,
    liveProperties: 'unavailable-via-apps-script-rest-api',
    projectIdentifiers: 'not-read-no-established-property-key-allowlist'
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await inspectGas({ credentials: JSON.parse(process.env.CLASPRC_JSON || '{}'),
      configuredUrl: process.env.CT_GAS_ADMIN_WEB_APP_URL, probe: true });
    console.log(JSON.stringify(result, null, 2));
  } catch {
    // Do not print exception messages, OAuth responses, source or raw API bodies.
    console.error('Read-only GAS inspection failed; no remote mutation attempted.');
    process.exitCode = 1;
  }
}
