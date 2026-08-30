import { Store } from './runtime.mjs';
import { loadConfig } from './config.mjs';
import { PostgresStore } from './postgres-store.mjs';
import { S3EvidenceStore } from './s3-evidence.mjs';
import { PostgresObserverStore } from './observer-store.mjs';
import { Pool } from 'pg';

class ProductionStore extends PostgresStore {
  constructor(options, providerEnvironment) {
    super(options);
    this.providerEnvironment = providerEnvironment;
  }

  async claimSchedules(...args) {
    const schedules = await super.claimSchedules(...args);
    const secretNames = Object.keys(this.providerEnvironment);
    return schedules.map((schedule) => ({
      ...schedule,
      launch: { ...schedule.launch, env: { ...this.providerEnvironment }, secretNames }
    }));
  }

  async finalizeExecution(executionId, value, lease) {
    const launch = { ...value.launch };
    delete launch.env;
    return super.finalizeExecution(executionId, { ...value, launch }, lease);
  }
}

export function createStore({ root, env = process.env } = {}) {
  const config = loadConfig(env);
  if (config.mode === 'production') {
    const evidence = new S3EvidenceStore({ ...config.s3, accessKeyId: env.CT_RUNTIME_S3_ACCESS_KEY_ID, secretAccessKey: env.CT_RUNTIME_S3_SECRET_ACCESS_KEY });
    const providerEnvironment = Object.fromEntries(config.providerSecretNames.map((name) => {
      if (!env[name]) throw new Error(`allowlisted provider secret is unavailable: ${name}`);
      return [name, env[name]];
    }));
    const pool = new Pool({ connectionString: config.databaseUrl, max: 10, application_name: 'ct-runtime-v2', allowExitOnIdle: true });
    const store = new ProductionStore({ pool, config, evidenceStore: evidence }, providerEnvironment);
    return { store, config, evidenceStore: evidence, observerStore: new PostgresObserverStore(store.pool, evidence) };
  }
  if (!root) throw new Error('--store is required in filesystem mode');
  return { store: new Store(root), config };
}
