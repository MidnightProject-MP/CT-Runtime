/**
 * Binding resolver — selects active adapter for a capability.
 * Global bindings + per-project overrides. Pure purpose → adapter.
 * Celestan requests capability, not vendor.
 *
 * Sources (precedence):
 *  1. explicit argument
 *  2. env CELESTAN_BINDINGS_JSON (JSON: { global: { durable_state: "postgres", ... }, projects: { BorderCrossing: { project_system: "jira" } } })
 *  3. env per-capability: CELESTAN_DURABLE_STATE=postgres etc.
 *  4. defaults (production → postgres/s3, filesystem → local)
 */

import { CAPABILITIES } from './definitions.mjs';
import { ADAPTERS } from './adapters.mjs';

const CAP_ENV_MAP = {
  durable_state: 'CELESTAN_DURABLE_STATE',
  evidence_store: 'CELESTAN_EVIDENCE_STORE',
  project_system: 'CELESTAN_PROJECT_SYSTEM',
  knowledge_publishing: 'CELESTAN_KNOWLEDGE_PUBLISHING',
  code_repository: 'CELESTAN_CODE_REPOSITORY',
  scheduler: 'CELESTAN_SCHEDULER'
};

const DEFAULTS = Object.freeze({
  production: Object.freeze({
    durable_state: 'postgres',
    evidence_store: 's3',
    code_repository: 'github',
    knowledge_publishing: 'git',
    scheduler: 'cloud_scheduler',
    project_system: 'github_issues'
  }),
  filesystem: Object.freeze({
    durable_state: 'filesystem',
    evidence_store: 'filesystem',
    code_repository: 'github',
    knowledge_publishing: 'git',
    scheduler: 'cron',
    project_system: 'github_issues'
  })
});

function parseBindingsJson(env) {
  const raw = env.CELESTAN_BINDINGS_JSON || env.CELESTAN_BINDINGS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed;
  } catch {
    throw new Error('CELESTAN_BINDINGS_JSON is not valid JSON');
  }
}

export function resolveBinding(capability, { project, env = process.env, mode } = {}) {
  if (!CAPABILITIES[capability]) throw new Error(`unknown capability: ${capability}`);
  const bindingsJson = parseBindingsJson(env);
  // per-project from JSON
  if (project && bindingsJson?.projects?.[project]?.[capability]) {
    const name = bindingsJson.projects[project][capability];
    validateAdapter(capability, name);
    return name;
  }
  // global from JSON
  if (bindingsJson?.global?.[capability]) {
    const name = bindingsJson.global[capability];
    validateAdapter(capability, name);
    return name;
  }
  // per-capability env
  const envKey = CAP_ENV_MAP[capability];
  if (envKey && env[envKey]) {
    const name = env[envKey];
    validateAdapter(capability, name);
    return name;
  }
  // explicit project bindings via separate env: CELESTAN_PROJECT_SYSTEM__BorderCrossing etc. (optional future)
  // fallback to mode defaults
  const effectiveMode = mode || env.CT_RUNTIME_MODE || 'filesystem';
  const defaults = DEFAULTS[effectiveMode] || DEFAULTS.filesystem;
  const fallback = defaults[capability];
  if (fallback) {
    validateAdapter(capability, fallback);
    return fallback;
  }
  throw new Error(`no binding for ${capability} and no default`);
}

function validateAdapter(capability, name) {
  if (!ADAPTERS[capability]?.[name]) throw new Error(`binding ${capability} → ${name} has no adapter`);
}

export function resolveAllBindings({ project, env = process.env, mode } = {}) {
  const out = {};
  for (const cap of Object.keys(CAPABILITIES)) out[cap] = resolveBinding(cap, { project, env, mode });
  return out;
}

export function describeBinding(capability, opts = {}) {
  const adapterName = resolveBinding(capability, opts);
  const adapter = ADAPTERS[capability][adapterName];
  return {
    capability,
    binding: adapterName,
    provider: adapter.meta.provider,
    purpose: adapter.meta.purpose,
    authority: adapter.meta.authority,
    operations: adapter.meta.operations,
    configRequirements: adapter.meta.configRequirements,
    limitations: adapter.meta.limitations
  };
}
