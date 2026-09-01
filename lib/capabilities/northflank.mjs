const API_BASE = 'https://api.northflank.com/v1';
const INFRASTRUCTURE = new Set(['CT_RUNTIME_DATABASE_URL', 'CT_RUNTIME_S3_ACCESS_KEY_ID', 'CT_RUNTIME_S3_SECRET_ACCESS_KEY']);
const INFRASTRUCTURE_NAME = /(?:CT_RUNTIME_(?:DATABASE|S3)|DATABASE|POSTGRES|AWS|SECRET_ACCESS_KEY)/i;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,127}$/;
const SECRET_GROUP_ID = /^[A-Za-z0-9_-]{1,200}$/;

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

export function validateRuntimeSecretNames(names = []) {
  if (!Array.isArray(names)) throw new Error('runtime secret names must be an array');
  const out = [...names];
  if (new Set(out).size !== out.length) throw new Error('runtime secret names contain duplicates');
  for (const name of out) {
    if (!SECRET_NAME.test(name)) throw new Error(`invalid provider secret name: ${name}`);
    if (INFRASTRUCTURE_NAME.test(name) || name === 'CT_RUNTIME_NORTHFLANK_API_TOKEN' || name === 'NORTHFLANK_API_TOKEN') throw new Error(`infrastructure secret cannot be passed to a child: ${name}`);
  }
  return [...INFRASTRUCTURE, ...out.filter((name) => !INFRASTRUCTURE.has(name))];
}

function immutableImage(image) {
  required(image, 'image');
  if (!/^.+@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('image must be an immutable image@sha256 digest');
  return image;
}

function secretGroupIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('secretGroupIds are required');
  if (new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string' || !SECRET_GROUP_ID.test(id))) throw new Error('secretGroupIds must contain unique IDs only');
  return [...ids];
}

function runtimeEnvironment(values = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('runtimeEnvironment must be an object');
  for (const name of Object.keys(values)) {
    if (INFRASTRUCTURE_NAME.test(name) || /secret|token|credential|password|key/i.test(name)) throw new Error(`runtimeEnvironment cannot contain credentials: ${name}`);
  }
  return { ...values };
}

export function buildJobPayload(config = {}) {
  secretGroupIds(config.secretGroupIds);
  const requiredRuntimeSecretNames = validateRuntimeSecretNames(config.providerSecretNames || []);
  const image = immutableImage(config.image);
  const deadline = Number(config.activeDeadlineSeconds || 3600);
  if (!Number.isFinite(deadline)) throw new Error('activeDeadlineSeconds must be finite');
  const storageSize = Number(config.storageSize || 1);
  if (!Number.isInteger(storageSize) || storageSize < 1) throw new Error('storageSize must be a positive integer');
  const docker = { configType: 'default' };
  if (config.customEntrypoint !== undefined) {
    if (typeof config.customEntrypoint !== 'string' || !config.customEntrypoint.trim()) throw new Error('customEntrypoint must be a non-empty string');
    docker.configType = 'customEntrypoint';
    docker.customEntrypoint = config.customEntrypoint.trim();
  }
  const payload = {
    name: required(config.name, 'name'),
    billing: { deploymentPlan: config.deploymentPlan || 'nf-compute-20' },
    deployment: {
      docker,
      storage: { ephemeralStorage: { storageSize } },
      external: { imagePath: image }
    },
    runtimeEnvironment: runtimeEnvironment(config.runtimeEnvironment),
    settings: { backoffLimit: 0, runOnSourceChange: 'never', activeDeadlineSeconds: Math.max(1, Math.min(86400, deadline)) }
  };
  if (config.cron !== undefined) {
    if (!/^\S+(?:\s+\S+){4}$/.test(config.cron)) throw new Error('cron must be a 5-field expression');
    payload.settings.cron = { schedule: config.cron, suspended: false, concurrencyPolicy: 'forbid' };
  }
  return payload;
}

export function redactDiagnostic(error) {
  return { status: error?.status || 0, code: error?.code || 'NORTHFLANK_ERROR', message: String(error?.message || error).slice(0, 300) };
}

export function createNorthflankClient(options = {}) {
  const { token, projectId, transport = fetch, baseUrl = API_BASE, timeoutMs = 10000, pollIntervalMs = 250, maxPolls = 20, maxLogBytes = 65536 } = options;
  const project = required(projectId, 'projectId');
  const configuration = Object.freeze({ secretGroupIds: secretGroupIds(options.secretGroupIds), requiredRuntimeSecretNames: validateRuntimeSecretNames(options.providerSecretNames || []) });
  const normalize = (value) => value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'data') ? value.data : value;
  const normalizeRun = (value) => {
    const run = normalize(value);
    if (!run || typeof run !== 'object') return run;
    const normalized = { ...run };
    if (normalized.id === undefined && normalized.runId !== undefined) normalized.id = normalized.runId;
    delete normalized.runId;
    if (typeof normalized.status === 'string') normalized.status = normalized.status.toUpperCase();
    return normalized;
  };
  const request = async (method, path, body) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await transport(`${baseUrl}${path}`, { method, signal: controller.signal, headers: { authorization: `Bearer ${required(token, 'token')}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) { const error = new Error(`Northflank request failed (${response.status})`); error.status = response.status; error.code = 'NORTHFLANK_HTTP_ERROR'; throw error; }
      return response.status === 204 ? null : normalize(await response.json());
    } catch (error) { throw Object.assign(new Error(redactDiagnostic(error).message), redactDiagnostic(error)); }
    finally { clearTimeout(timer); }
  };
  const jobPath = (id = '') => `/projects/${encodeURIComponent(project)}/jobs${id ? `/${encodeURIComponent(id)}` : ''}`;
  return {
    createJob: (config) => request('POST', jobPath(), buildJobPayload({ ...config, secretGroupIds: config.secretGroupIds ?? configuration.secretGroupIds })),
    putJob: (id, payload) => request('PUT', jobPath(id), payload),
    getJob: (id) => request('GET', jobPath(id)),
    deleteJob: (id) => request('DELETE', jobPath(id)),
    runJob: async (id) => normalizeRun(await request('POST', `${jobPath(id)}/runs`)),
    pollRun: async (jobId, runId) => { for (let attempt = 0; attempt < maxPolls; attempt++) { const run = normalizeRun(await request('GET', `${jobPath(jobId)}/runs/${encodeURIComponent(runId)}`)); if (run?.status === 'SUCCESS' || run?.status === 'FAILED') return run; if (run?.status !== 'RUNNING') throw Object.assign(new Error(`Northflank returned unsupported run status: ${run?.status || 'missing'}`), { code: 'NORTHFLANK_RUN_STATUS', status: 0 }); if (attempt + 1 < maxPolls) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs)); } throw Object.assign(new Error('Northflank run polling bound exceeded'), { code: 'NORTHFLANK_POLL_TIMEOUT', status: 0 }); },
    getLogs: async (jobId, runId) => { const value = await request('GET', `${jobPath(jobId)}/logs?runId=${encodeURIComponent(runId)}&type=runtime&queryType=range`); if (typeof value === 'string') return value.slice(0, maxLogBytes); if (value && typeof value === 'object') { const out = { ...value }; for (const key of ['logs', 'stdout', 'stderr']) if (typeof out[key] === 'string') out[key] = out[key].slice(0, maxLogBytes); return out; } return value; },
    config: configuration,
    configuration,
    validateSecretGroupRestriction: ({ jobId, secretGroupIds: ids = configuration.secretGroupIds } = {}) => ({ jobId: required(jobId, 'jobId'), secretGroupIds: secretGroupIds(ids), requiredRuntimeSecretNames: configuration.requiredRuntimeSecretNames, action: 'verify existing project secret group is restricted to this job; no secrets are uploaded by this adapter' }),
    configureScheduledJob: (config) => { const payload = buildJobPayload(config); if (!payload.settings.cron) throw new Error('scheduled job requires a cron schedule'); return request('PUT', jobPath(config.jobId || payload.name), payload); }
  };
}

export const NORTHFLANK_API_BASE = API_BASE;
export const buildNorthflankJobPayload = buildJobPayload;
