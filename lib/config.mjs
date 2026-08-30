import crypto from 'node:crypto';

const required = (name, value) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value;
};

const INFRASTRUCTURE_SECRET = /(?:CT_RUNTIME_(?:DATABASE|S3)|DATABASE|POSTGRES|AWS|SECRET_ACCESS_KEY)/i;

function providerSecretNames(value) {
  const names = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (new Set(names).size !== names.length) throw new Error('CT_RUNTIME_PROVIDER_SECRET_NAMES contains duplicates');
  for (const name of names) {
    if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(name)) throw new Error(`invalid provider secret name: ${name}`);
    if (INFRASTRUCTURE_SECRET.test(name)) throw new Error(`infrastructure secret cannot be passed to a child: ${name}`);
  }
  return names;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function sha256(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex'); }

export function loadConfig(env = process.env) {
  const mode = env.CT_RUNTIME_MODE || 'filesystem';
  if (!['filesystem', 'production'].includes(mode)) throw new Error('CT_RUNTIME_MODE must be filesystem or production');
  const config = {
    mode,
    databaseUrl: env.CT_RUNTIME_DATABASE_URL,
    databaseMigrationUrl: env.CT_RUNTIME_DATABASE_MIGRATION_URL || env.CT_RUNTIME_DATABASE_URL_UNPOOLED || env.DATABASE_URL_UNPOOLED,
    s3: { endpoint: env.CT_RUNTIME_S3_ENDPOINT, region: env.CT_RUNTIME_S3_REGION || 'us-east-1', bucket: env.CT_RUNTIME_S3_BUCKET, namespace: env.CT_RUNTIME_NAMESPACE || 'ct-runtime', forcePathStyle: env.CT_RUNTIME_S3_PATH_STYLE === 'true' },
    deploymentId: env.CT_RUNTIME_DEPLOYMENT_ID,
    provider: env.CT_RUNTIME_PROVIDER,
    runtimeClass: env.CT_RUNTIME_CLASS,
    region: env.CT_RUNTIME_REGION,
    providerSecretNames: providerSecretNames(env.CT_RUNTIME_PROVIDER_SECRET_NAMES),
    imageDigest: env.CT_RUNTIME_IMAGE_DIGEST,
    configDigest: env.CT_RUNTIME_CONFIG_DIGEST,
    gitRepository: env.CT_RUNTIME_GIT_REPOSITORY,
    gitCommit: env.CT_RUNTIME_GIT_COMMIT,
    runtimeVersion: env.CT_RUNTIME_VERSION || 'v2'
  };
  if (mode === 'production') {
    required('CT_RUNTIME_DATABASE_URL', config.databaseUrl);
    // databaseMigrationUrl is NOT required for normal wake containers — only for explicit migrate/deploy.
    // If present, it must be a distinct secret bound to the deployer identity, not the runtime.
    required('CT_RUNTIME_S3_BUCKET', config.s3.bucket);
    required('CT_RUNTIME_IMAGE_DIGEST', config.imageDigest);
    required('CT_RUNTIME_CONFIG_DIGEST', config.configDigest);
    required('CT_RUNTIME_DEPLOYMENT_ID', config.deploymentId);
    required('CT_RUNTIME_PROVIDER', config.provider);
    required('CT_RUNTIME_CLASS', config.runtimeClass);
    required('CT_RUNTIME_REGION', config.region);
    required('CT_RUNTIME_GIT_REPOSITORY', config.gitRepository);
    required('CT_RUNTIME_GIT_COMMIT', config.gitCommit);
    if (!/^sha256:[a-f0-9]{64}$/.test(config.imageDigest)) throw new Error('CT_RUNTIME_IMAGE_DIGEST must be an immutable sha256 digest');
    if (!/^sha256:[a-f0-9]{64}$/.test(config.configDigest)) throw new Error('CT_RUNTIME_CONFIG_DIGEST must be a sha256 digest');
    if (!/^[a-f0-9]{40,64}$/.test(config.gitCommit)) throw new Error('CT_RUNTIME_GIT_COMMIT must be a full Git commit');
    if (config.runtimeVersion !== 'v2') throw new Error('CT_RUNTIME_VERSION must be v2 in production');
  }
  return config;
}

export function runtimeMetadata(config, host = {}) {
  return { runtimeVersion: config.runtimeVersion, imageDigest: config.imageDigest || 'unavailable', configDigest: config.configDigest || 'unavailable', gitRepository: config.gitRepository || 'unavailable', gitCommit: config.gitCommit || 'unavailable', hostInstanceId: host.instanceId || 'unavailable' };
}
