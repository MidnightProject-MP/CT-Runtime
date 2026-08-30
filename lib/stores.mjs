import { Store } from './runtime.mjs';
import { loadConfig } from './config.mjs';
import { PostgresStore } from './postgres-store.mjs';
import { S3EvidenceStore } from './s3-evidence.mjs';
import { PostgresObserverStore } from './observer-store.mjs';
import { Pool } from 'pg';
import { request as requestCapability } from './capabilities/registry.mjs';
import { resolveBinding } from './capabilities/bindings.mjs';

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

/**
 * Legacy entry — preserved for tests and direct Store usage.
 * New code should use createCapabilityStores() which resolves bindings,
 * not vendors.
 */
export function createStore({ root, env = process.env, project } = {}) {
  const config = loadConfig(env);
  if (config.mode === 'production') {
    // Capability-first: durable_state + evidence_store are requested, not hard-coded.
    // Bindings select adapter; current production bindings default to postgres/s3.
    const durableBinding = resolveBinding('durable_state', { project, env, mode: 'production' });
    const evidenceBinding = resolveBinding('evidence_store', { project, env, mode: 'production' });
    if (durableBinding !== 'postgres') throw new Error(`production durable_state binding ${durableBinding} not yet wired for direct createStore — use request('durable_state')`);
    if (evidenceBinding !== 's3') throw new Error(`production evidence_store binding ${evidenceBinding} not yet wired`);

    const evidence = new S3EvidenceStore({ ...config.s3, accessKeyId: env.CT_RUNTIME_S3_ACCESS_KEY_ID, secretAccessKey: env.CT_RUNTIME_S3_SECRET_ACCESS_KEY });
    const providerEnvironment = Object.fromEntries(config.providerSecretNames.map((name) => {
      if (!env[name]) throw new Error(`allowlisted provider secret is unavailable: ${name}`);
      return [name, env[name]];
    }));
    const pool = new Pool({ connectionString: config.databaseUrl, max: 10, application_name: 'ct-runtime-v2', allowExitOnIdle: true });
    const store = new ProductionStore({ pool, config, evidenceStore: evidence }, providerEnvironment);
    return { store, config, evidenceStore: evidence, observerStore: new PostgresObserverStore(store.pool, evidence), bindings: { durable_state: durableBinding, evidence_store: evidenceBinding } };
  }
  if (!root) throw new Error('--store is required in filesystem mode');
  // filesystem bindings also go through registry for discoverability, but Store is the adapter
  return { store: new Store(root), config, bindings: { durable_state: 'filesystem', evidence_store: 'filesystem' } };
}

/**
 * Capability-first entry — Celestan requests purposes.
 *
 *   const { durableState, evidenceStore, observerStore } = await createCapabilityStores({ project: 'BorderCrossing' });
 *   await durableState.createManifest(...); // same contract regardless of postgres vs filesystem
 *   await evidenceStore.put(...);
 *   publishChronicle via knowledge_publishing capability, not via Git directly.
 *
 * Bindings may vary by project:
 *   BorderCrossing: project_system → jira
 *   CT-Foundry:     project_system → github_issues
 * while Celestan code stays `request('project_system')`.
 */
export async function createCapabilityStores({ project, env = process.env, root, pool, evidenceStore: injectedEvidence } = {}) {
  const config = loadConfig(env);
  const bindings = {};
  let durableState;
  let evidenceStore;

  const durableBinding = resolveBinding('durable_state', { project, env, mode: config.mode });
  bindings.durable_state = durableBinding;
  if (durableBinding === 'postgres') {
    const p = pool || new Pool({ connectionString: config.databaseUrl, max: 10, application_name: 'ct-runtime-v2', allowExitOnIdle: true });
    const ev = injectedEvidence || new S3EvidenceStore({ ...config.s3, accessKeyId: env.CT_RUNTIME_S3_ACCESS_KEY_ID, secretAccessKey: env.CT_RUNTIME_S3_SECRET_ACCESS_KEY });
    const providerEnvironment = Object.fromEntries((config.providerSecretNames || []).map((name) => {
      if (!env[name]) throw new Error(`allowlisted provider secret is unavailable: ${name}`);
      return [name, env[name]];
    }));
    durableState = new ProductionStore({ pool: p, config, evidenceStore: ev }, providerEnvironment);
    evidenceStore = ev;
  } else {
    if (!root) throw new Error('filesystem durable_state requires --store');
    durableState = new Store(root);
    evidenceStore = injectedEvidence || { kind: 'filesystem-evidence', root };
  }

  // Evidence store binding is orthogonal but in production they share the same S3 instance
  const evidenceBinding = resolveBinding('evidence_store', { project, env, mode: config.mode });
  bindings.evidence_store = evidenceBinding;
  if (evidenceBinding === 's3' && !evidenceStore?.put) {
    evidenceStore = new S3EvidenceStore({ ...config.s3, accessKeyId: env.CT_RUNTIME_S3_ACCESS_KEY_ID, secretAccessKey: env.CT_RUNTIME_S3_SECRET_ACCESS_KEY });
  }

  let observerStore = null;
  if (durableBinding === 'postgres') {
    observerStore = new PostgresObserverStore(durableState.pool || pool, evidenceStore);
  }

  return { config, bindings, durableState, store: durableState, evidenceStore, observerStore };
}
