/**
 * Adapter registry — concrete implementations behind capabilities.
 * Each adapter exposes: capability, name, provider, operations, authority, configRequirements, limitations, health.
 */
import { Store as FilesystemStore } from '../runtime.mjs';
import { PostgresStore } from '../postgres-store.mjs';
import { S3EvidenceStore } from '../s3-evidence.mjs';
import { CAPABILITIES } from './definitions.mjs';
import { createNorthflankClient } from './northflank.mjs';
import { PostgresFederationAdapter } from '../federation.mjs';

function adapterMeta({ capability, name, provider, operations, authority, remote = false, configRequirements = [], limitations = [], reliability = {}, security = {} }) {
  const def = CAPABILITIES[capability];
  if (!def) throw new Error(`adapter references unknown capability: ${capability}`);
  return Object.freeze({
    capability, name, provider, remote,
    purpose: def.purpose,
    operations: Object.freeze(operations || def.operations),
    authority: authority || def.authority,
    configRequirements: Object.freeze(configRequirements),
    limitations: Object.freeze(limitations),
    reliability: Object.freeze(reliability),
    security: Object.freeze(security)
  });
}

export const ADAPTERS = Object.freeze({
  execution_federation: Object.freeze({
    postgres: Object.freeze({
      meta: adapterMeta({ capability: 'execution_federation', name: 'postgres', provider: 'Postgres (Neon/Supabase/any pg)', authority: 'canonical', configRequirements: ['CT_RUNTIME_DATABASE_URL'], limitations: ['requires migration 005 and network'], reliability: { fencing: 'monotonic claim fence', conflict: 'transactional' }, security: { secrets: 'never persisted' } }),
      create: (opts = {}) => new PostgresFederationAdapter(opts)
    })
  }),
  durable_state: Object.freeze({
    filesystem: Object.freeze({
      meta: adapterMeta({
        capability: 'durable_state', name: 'filesystem', provider: 'local-filesystem',
        authority: 'local',
        configRequirements: ['--store'],
        limitations: ['single-host', 'no cross-host fencing beyond file locks', 'not for production continuity'],
        reliability: { persistence: 'host-local', fencing: 'file-locks' },
        security: { isolation: 'filesystem permissions' }
      }),
      create: ({ root, config, evidenceStore } = {}) => new FilesystemStore(root)
    }),
    postgres: Object.freeze({
      meta: adapterMeta({
        capability: 'durable_state', name: 'postgres', provider: 'postgres (Neon/Supabase/any pg)',
        authority: 'canonical',
        configRequirements: ['CT_RUNTIME_DATABASE_URL'],
        limitations: ['requires network', 'bounded 0.5 GB free-tier storage (Neon) example', 'needs migrations'],
        reliability: { persistence: 'external-transactional', fencing: 'bigint monotonic + FOR UPDATE', claim: 'SKIP LOCKED' },
        security: { isolation: 'TLS + least-privilege roles' }
      }),
      create: ({ connectionString, pool, config, evidenceStore } = {}) => new PostgresStore({ connectionString, pool, config, evidenceStore })
    }),
    gas: Object.freeze({ meta: adapterMeta({ capability: 'durable_state', name: 'gas', provider: 'Google Sheets + LockService', limitations: ['serialized prototype','Sheets quotas','remote Apps Script provider; no Node callable methods','semantic continuations; cooperative preemption; no general_compute'], reliability: { persistence: 'Google Drive/Sheets' } }), create: () => ({ kind: 'gas-sheets-state', remote: true }) })
  }),

  evidence_store: Object.freeze({
    filesystem: Object.freeze({
      meta: adapterMeta({
        capability: 'evidence_store', name: 'filesystem', provider: 'local-filesystem',
        authority: 'referenced',
        configRequirements: ['--store'],
        limitations: ['host-local only'],
        reliability: { persistence: 'host-local' },
        security: { isolation: 'filesystem permissions' }
      }),
      create: ({ root } = {}) => {
        // Filesystem evidence is embedded in Store.raw; return a minimal adapter that delegates to Store.evidence
        // For capability tests we expose a filesystem-backed evidence handle via Store.
        return { kind: 'filesystem-evidence', root };
      }
    }),
    s3: Object.freeze({
      meta: adapterMeta({
        capability: 'evidence_store', name: 's3', provider: 'S3-compatible (AWS S3/Backblaze B2/R2/MinIO)',
        authority: 'referenced',
        configRequirements: ['CT_RUNTIME_S3_BUCKET'],
        limitations: ['requires S3 get/put/head/list operations', 'providers rejecting conditional writes use a non-atomic preflight GET/unconditional PUT/readback fallback', 'not full S3 (no ACL/lock/versioning)'],
        reliability: { persistence: 'external-object', write: 'atomic-if-none-match where supported', verification: 'bounded-get+sha256' },
        security: { isolation: 'provider IAM or bucket-scoped credentials, no secrets in keys' }
      }),
      create: (opts = {}) => new S3EvidenceStore(opts)
    }),
    gas: Object.freeze({ meta: adapterMeta({ capability: 'evidence_store', name: 'gas', provider: 'Google Drive', limitations: ['bounded artifacts','Drive quotas','remote Apps Script provider; no Node callable methods'], reliability: { persistence: 'Drive file IDs' } }), create: () => ({ kind: 'gas-drive-evidence', remote: true }) })
  }),

  project_system: Object.freeze({
    jira: Object.freeze({
      meta: adapterMeta({
        capability: 'project_system', name: 'jira', provider: 'Jira',
        authority: 'human-authoritative',
        configRequirements: ['JIRA_URL', 'JIRA_TOKEN', 'JIRA_PROJECT'],
        limitations: ['rate-limited', 'requires project mapping'],
        reliability: { api: 'REST' },
        security: { isolation: 'project-scoped token' }
      }),
      create: () => ({ kind: 'jira', todo: 'adapter not yet implemented — placeholder for capability contract' })
    }),
    linear: Object.freeze({
      meta: adapterMeta({
        capability: 'project_system', name: 'linear', provider: 'Linear',
        authority: 'human-authoritative',
        configRequirements: ['LINEAR_API_KEY'],
        limitations: ['rate-limited'],
        reliability: {}, security: {}
      }),
      create: () => ({ kind: 'linear', todo: 'placeholder' })
    }),
    github_issues: Object.freeze({
      meta: adapterMeta({
        capability: 'project_system', name: 'github_issues', provider: 'GitHub Issues',
        authority: 'human-authoritative',
        configRequirements: ['GITHUB_TOKEN', 'GITHUB_REPO'],
        limitations: ['API rate limits'],
        reliability: {}, security: {}
      }),
      create: () => ({ kind: 'github_issues', todo: 'placeholder' })
    })
  }),

  knowledge_publishing: Object.freeze({
    git: Object.freeze({
      meta: adapterMeta({
        capability: 'knowledge_publishing', name: 'git', provider: 'Git (Markdown)',
        authority: 'curated',
        configRequirements: ['GIT_REPO'],
        limitations: ['human promotion required'],
        reliability: {}, security: {}
      }),
      create: () => ({ kind: 'git-markdown', todo: 'publish via Git commit' })
    }),
    confluence: Object.freeze({
      meta: adapterMeta({
        capability: 'knowledge_publishing', name: 'confluence', provider: 'Confluence',
        authority: 'curated',
        configRequirements: ['CONFLUENCE_URL', 'CONFLUENCE_TOKEN', 'SPACE'],
        limitations: ['requires space permissions'],
        reliability: {}, security: {}
      }),
      create: () => ({ kind: 'confluence', todo: 'placeholder' })
    }),
    obsidian: Object.freeze({
      meta: adapterMeta({
        capability: 'knowledge_publishing', name: 'obsidian', provider: 'Obsidian/Markdown',
        authority: 'curated',
        configRequirements: ['OBSIDIAN_VAULT_PATH'],
        limitations: [],
        reliability: {}, security: {}
      }),
      create: () => ({ kind: 'obsidian', todo: 'placeholder' })
    })
  }),

  code_repository: Object.freeze({
    github: Object.freeze({
      meta: adapterMeta({
        capability: 'code_repository', name: 'github', provider: 'GitHub',
        authority: 'source',
        configRequirements: ['GITHUB_TOKEN?'],
        limitations: ['rate-limited'],
        reliability: {}, security: {}
      }),
      create: () => ({ kind: 'github', todo: 'git clone via HTTPS' })
    }),
    gitlab: Object.freeze({
      meta: adapterMeta({
        capability: 'code_repository', name: 'gitlab', provider: 'GitLab',
        authority: 'source',
        configRequirements: ['GITLAB_TOKEN'],
        limitations: [],
        reliability: {}, security: {}
      }),
      create: () => ({ kind: 'gitlab', todo: 'placeholder' })
    })
  }),

  scheduler: Object.freeze({
    northflank: Object.freeze({
      meta: adapterMeta({ capability: 'scheduler', name: 'northflank', provider: 'Northflank Jobs API', authority: 'mechanical', configRequirements: ['CT_RUNTIME_NORTHFLANK_API_TOKEN', 'CT_RUNTIME_NORTHFLANK_PROJECT_ID', 'CT_RUNTIME_NORTHFLANK_SECRET_GROUP_IDS'], limitations: ['prototype; live authorization required', 'external API availability', 'project secret group must already exist and be restricted to the job'], reliability: { guarantee: 'provider-scheduled, forbid overlap' }, security: { secrets: 'existing secret-group IDs only; values are never uploaded' } }),
      create: (opts = {}) => createNorthflankClient(opts)
    }),
    cloud_scheduler: Object.freeze({
      meta: adapterMeta({
        capability: 'scheduler', name: 'cloud_scheduler', provider: 'Google Cloud Scheduler',
        authority: 'mechanical',
        configRequirements: ['GCP_PROJECT', 'GCP_LOCATION', 'SCHEDULER_SERVICE_ACCOUNT'],
        limitations: ['requires billing', 'IAM run.invoker'],
        reliability: { guarantee: 'at-least-once trigger, not orchestration' },
        security: {}
      }),
      create: () => ({ kind: 'cloud_scheduler', todo: 'triggers Cloud Run Job via POST' })
    }),
    systemd_timer: Object.freeze({
      meta: adapterMeta({
        capability: 'scheduler', name: 'systemd_timer', provider: 'systemd timer',
        authority: 'mechanical',
        configRequirements: ['SYSTEMD_SERVICE'],
        limitations: ['host-local timer'],
        reliability: {}, security: {}
      }),
      create: () => ({ kind: 'systemd_timer', todo: 'placeholder' })
    }),
    cron: Object.freeze({
      meta: adapterMeta({
        capability: 'scheduler', name: 'cron', provider: 'cron',
        authority: 'mechanical',
        configRequirements: [],
        limitations: [],
        reliability: {}, security: {}
      }),
      create: () => ({ kind: 'cron', todo: 'placeholder' })
    }),
    gas: Object.freeze({ meta: adapterMeta({ capability: 'scheduler', name: 'gas', provider: 'Apps Script triggers', limitations: ['trigger quotas','remote Apps Script provider; no Node callable methods','idempotent continuation wakes; duration never requests general_compute'], reliability: { guarantee: 'at-least-once, idempotent' } }), create: () => ({ kind: 'gas-trigger-scheduler', remote: true }) })
  }),

  disposable_compute: Object.freeze({
    northflank_sandbox: Object.freeze({
      meta: adapterMeta({ capability: 'disposable_compute', name: 'northflank_sandbox', provider: 'Northflank Jobs API', authority: 'mechanical', configRequirements: ['CT_RUNTIME_NORTHFLANK_API_TOKEN', 'CT_RUNTIME_NORTHFLANK_PROJECT_ID', 'CT_RUNTIME_IMAGE_DIGEST', 'CT_RUNTIME_NORTHFLANK_SECRET_GROUP_IDS'], limitations: ['prototype; no live provider proof', 'ephemeral compute only', 'project secret group must already exist and be restricted to the job'], reliability: { execution: 'bounded job run' }, security: { secrets: 'existing secret-group IDs only; values are never uploaded' } }),
      create: (opts = {}) => createNorthflankClient(opts)
    }),
    filesystem: Object.freeze({
      meta: adapterMeta({ capability: 'disposable_compute', name: 'filesystem', provider: 'local-filesystem', authority: 'mechanical', limitations: ['test/local handle only'] }),
      create: () => ({ kind: 'filesystem-disposable-compute', operations: ['runJob'] })
    })
    }),
  agent_executor: Object.freeze({
    gas: Object.freeze({ meta: adapterMeta({ capability: 'agent_executor', name: 'gas', provider: 'OpenRouter via Apps Script', configRequirements: ['OPENROUTER_API_KEY'], limitations: ['Apps Script execution/time quotas', 'free models only','remote Apps Script provider; no Node callable methods'], reliability: { deferral: 'durable wake' }, security: { secrets: 'Script Properties only' } }), create: () => ({ kind: 'gas-agent-executor', remote: true }) }),
    missing: Object.freeze({ meta: adapterMeta({ capability: 'agent_executor', name: 'missing', provider: 'none', limitations: ['not configured'] }), create: () => ({ kind: 'missing' }) })
  }),
  workspace: Object.freeze({
    gas: Object.freeze({ meta: adapterMeta({ capability: 'workspace', name: 'gas', provider: 'GitHub API via Apps Script', configRequirements: ['GITHUB_TOKEN', 'GITHUB_REPO'], limitations: ['GitHub API rate limits','remote Apps Script provider; no Node callable methods'] }), create: () => ({ kind: 'gas-github-workspace', remote: true }) }),
    missing: Object.freeze({ meta: adapterMeta({ capability: 'workspace', name: 'missing', provider: 'none', limitations: ['not configured'] }), create: () => ({ kind: 'missing' }) })
  }),
  test_executor: Object.freeze({
    gas: Object.freeze({ meta: adapterMeta({ capability: 'test_executor', name: 'gas', provider: 'GitHub Actions API via Apps Script', configRequirements: ['GITHUB_TOKEN', 'GITHUB_REPO'], limitations: ['approved workflows only','remote Apps Script provider; no Node callable methods'] }), create: () => ({ kind: 'gas-actions-executor', remote: true }) }),
    missing: Object.freeze({ meta: adapterMeta({ capability: 'test_executor', name: 'missing', provider: 'none', limitations: ['not configured'] }), create: () => ({ kind: 'missing' }) })
  }),
  model_provider: Object.freeze({
    gas: Object.freeze({ meta: adapterMeta({ capability: 'model_provider', name: 'gas', provider: 'OpenRouter', configRequirements: ['OPENROUTER_API_KEY'], limitations: ['strict :free models','remote Apps Script provider; no Node callable methods'] }), create: () => ({ kind: 'gas-openrouter', remote: true }) }),
    missing: Object.freeze({ meta: adapterMeta({ capability: 'model_provider', name: 'missing', provider: 'none', limitations: ['not configured'] }), create: () => ({ kind: 'missing' }) })
  })
});

export function listAdapters(capability) {
  if (capability) {
    const group = ADAPTERS[capability];
    if (!group) throw new Error(`unknown capability: ${capability}`);
    return Object.values(group);
  }
  return Object.entries(ADAPTERS).flatMap(([cap, group]) => Object.values(group).map(a => ({ capability: cap, ...a })));
}

export function getAdapter(capability, name) {
  const group = ADAPTERS[capability];
  if (!group) throw new Error(`unknown capability: ${capability}`);
  const adapter = group[name];
  if (!adapter) throw new Error(`unknown adapter ${name} for ${capability}`);
  return adapter;
}

export function describeAdapters() {
  return Object.entries(ADAPTERS).flatMap(([capability, group]) =>
    Object.entries(group).map(([name, adapter]) => ({
      capability,
      adapter: name,
      provider: adapter.meta.provider,
      purpose: adapter.meta.purpose,
      operations: adapter.meta.operations,
      authority: adapter.meta.authority,
      configRequirements: adapter.meta.configRequirements,
      limitations: adapter.meta.limitations,
      reliability: adapter.meta.reliability,
      security: adapter.meta.security
    }))
  );
}
