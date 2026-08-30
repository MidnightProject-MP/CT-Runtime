/**
 * Capability registry — Celestan requests purposes, not vendors.
 *
 *   import { request } from './capabilities/registry.mjs';
 *   const durable = await request('durable_state', { project: 'BorderCrossing' });
 *   await durable.createManifest(...);
 *
 * Registry hides adapter selection. Bindings are replaceable without
 * changing Celestan's cognitive model.
 */

import { CAPABILITIES, getCapabilityDefinition } from './definitions.mjs';
import { ADAPTERS, getAdapter } from './adapters.mjs';
import { resolveBinding } from './bindings.mjs';
import { Store } from '../runtime.mjs';
import { PostgresStore } from '../postgres-store.mjs';
import { S3EvidenceStore } from '../s3-evidence.mjs';
import { loadConfig } from '../config.mjs';

export { CAPABILITIES, getCapabilityDefinition };
export { ADAPTERS, getAdapter };

/**
 * Request a capability — returns an adapter instance satisfying the purpose.
 * `project` allows per-project binding (e.g., BorderCrossing → Jira).
 */
export async function request(capability, { project, env = process.env, ...createOpts } = {}) {
  const def = getCapabilityDefinition(capability);
  const binding = resolveBinding(capability, { project, env, mode: env.CT_RUNTIME_MODE });
  const adapter = getAdapter(capability, binding);

  // Capability-specific factories that need runtime args
  if (capability === 'durable_state') {
    if (binding === 'filesystem') {
      const root = createOpts.root || env.CT_RUNTIME_STORE;
      if (!root) throw new Error('durable_state filesystem requires --store / CT_RUNTIME_STORE');
      return adapter.create({ root, config: createOpts.config, evidenceStore: createOpts.evidenceStore });
    }
    if (binding === 'postgres') {
      const config = createOpts.config || loadConfig(env);
      // Postgres adapter is provider-neutral (Neon/Supabase/any pg)
      const pool = createOpts.pool;
      const connectionString = createOpts.connectionString || env.CT_RUNTIME_DATABASE_URL;
      return adapter.create({ connectionString, pool, config, evidenceStore: createOpts.evidenceStore });
    }
  }

  if (capability === 'evidence_store') {
    if (binding === 'filesystem') {
      // Evidence filesystem is via Store.raw — return a handle that delegates to durable_state
      return adapter.create({ root: createOpts.root });
    }
    if (binding === 's3') {
      const config = createOpts.config || loadConfig(env);
      return adapter.create({
        bucket: createOpts.bucket || env.CT_RUNTIME_S3_BUCKET || config.s3?.bucket,
        namespace: createOpts.namespace || config.s3?.namespace,
        endpoint: createOpts.endpoint || env.CT_RUNTIME_S3_ENDPOINT || config.s3?.endpoint,
        region: createOpts.region || env.CT_RUNTIME_S3_REGION || config.s3?.region,
        forcePathStyle: createOpts.forcePathStyle ?? (env.CT_RUNTIME_S3_PATH_STYLE === 'true'),
        accessKeyId: createOpts.accessKeyId || env.CT_RUNTIME_S3_ACCESS_KEY_ID,
        secretAccessKey: createOpts.secretAccessKey || env.CT_RUNTIME_S3_SECRET_ACCESS_KEY,
        client: createOpts.client
      });
    }
  }

  // Placeholder adapters for non-persistence capabilities — return meta + todo handle
  return {
    capability: def.name,
    binding,
    provider: adapter.meta.provider,
    meta: adapter.meta,
    // For not-yet-implemented adapters, expose a discoverable handle
    operations: adapter.meta.operations,
    authority: adapter.meta.authority,
    ...adapter.create(createOpts)
  };
}

/**
 * Describe all capabilities and their current bindings — for discovery/health.
 */
export function describeCapabilities({ project, env = process.env } = {}) {
  const out = [];
  for (const cap of Object.values(CAPABILITIES)) {
    const binding = resolveBinding(cap.name, { project, env });
    const adapter = getAdapter(cap.name, binding);
    out.push({
      capability: cap.name,
      purpose: cap.purpose,
      description: cap.description,
      authority: cap.authority,
      operations: cap.operations,
      binding,
      provider: adapter.meta.provider,
      configRequirements: adapter.meta.configRequirements,
      limitations: adapter.meta.limitations,
      reliability: adapter.meta.reliability,
      security: adapter.meta.security
    });
  }
  return out;
}

/**
 * Health probe — optional, where adapter exposes health().
 */
export async function health(capability, opts = {}) {
  const instance = await request(capability, opts);
  if (typeof instance.health === 'function') return instance.health();
  if (typeof instance.reachable === 'function') {
    try { await instance.reachable(); return { status: 'ok' }; }
    catch (e) { return { status: 'error', error: e.message }; }
  }
  return { status: 'unknown', note: 'adapter has no health probe' };
}
