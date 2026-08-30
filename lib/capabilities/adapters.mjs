/**
 * Adapter registry — concrete implementations behind capabilities.
 * Each adapter exposes: capability, name, provider, operations, authority, configRequirements, limitations, health.
 */
import { Store as FilesystemStore } from '../runtime.mjs';
import { PostgresStore } from '../postgres-store.mjs';
import { S3EvidenceStore } from '../s3-evidence.mjs';
import { CAPABILITIES } from './definitions.mjs';

function adapterMeta({ capability, name, provider, operations, authority, configRequirements = [], limitations = [], reliability = {}, security = {} }) {
  const def = CAPABILITIES[capability];
  if (!def) throw new Error(`adapter references unknown capability: ${capability}`);
  return Object.freeze({
    capability, name, provider,
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
    })
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
        capability: 'evidence_store', name: 's3', provider: 'S3-compatible (R2/S3/MinIO)',
        authority: 'referenced',
        configRequirements: ['CT_RUNTIME_S3_BUCKET', 'CT_RUNTIME_S3_ENDPOINT (+ creds)'],
        limitations: ['requires S3 subset: put/head/list, IfNoneMatch', 'R2: 1 write/s per key may 429', 'not full S3 (no ACL/lock/versioning)'],
        reliability: { persistence: 'external-object', verification: 'head+checksum' },
        security: { isolation: 'bucket-scoped token, no secrets in keys' }
      }),
      create: (opts = {}) => new S3EvidenceStore(opts)
    })
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
    })
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
