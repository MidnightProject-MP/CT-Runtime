/**
 * Capability definitions — purpose, not vendor.
 * Celestan reasons over these. Adapters implement them. Bindings select them.
 */

export const CAPABILITIES = Object.freeze({
  durable_state: Object.freeze({
    name: 'durable_state',
    purpose: 'canonical transactional runtime continuity',
    description: 'Authoritative, recoverable persistence for executions, topology, leases, schedules, and lifecycle. Supports fencing, idempotency, and at-least-once wake semantics without host-local dependence.',
    operations: Object.freeze([
      'createManifest', 'manifest', 'manifestsAll', 'updateManifest',
      'lease', 'heartbeat', 'release',
      'schedule', 'claimSchedules', 'completeSchedule', 'touchSchedule',
      'finalizeExecution', 'recoverExecution', 'rebuildTopology',
      'event', 'telemetry', 'hostTelemetry',
      'modelTelemetryFor', 'hostTelemetryFor',
      'evidenceFor', 'evidence',
       'registerDeployment', 'listEvidenceObjects', 'reconcileEvidenceObjects'
    ]),
    guarantees: Object.freeze(['transactional', 'fenced-leases', 'idempotent-manifests', 'deterministic-schedule-keys', 'monotonic-wakes']),
    authority: 'canonical',
    constraints: Object.freeze(['requires transactional store', 'no host-local canonical state', 'bounded recovery'])
  }),

  execution_federation: Object.freeze({
    name: 'execution_federation', purpose: 'provider-neutral coordination of logical work and physical executions',
    description: 'Durable work orders, fenced claims, leases, handoffs, checkpoints, conflict detection, and normalized lineage.',
    operations: Object.freeze(['createWorkOrder', 'claim', 'renew', 'release', 'defer', 'checkpoint', 'handoff', 'continue', 'finalize', 'reconstruct', 'repositoryDrift']),
    guarantees: Object.freeze(['durable-logical-work', 'fenced-claims', 'foreground-conflict-fail-closed', 'normalized-lineage']), authority: 'canonical', constraints: Object.freeze(['coordination must be available for mutation', 'GAS Sheets/Drive remain local provider state'])
  }),

  evidence_store: Object.freeze({
    name: 'evidence_store',
    purpose: 'raw/bulky logs, traces, artifacts, diagnostics, provenance objects',
    description: 'Content-addressed, retention-classified storage for bounded raw stdout/stderr, evidence bundles, traces, and diagnostics. Postgres holds only URI/hash/size/type metadata.',
    operations: Object.freeze(['put', 'verifyExisting', 'list', 'reconcileOrphans', 'reachable', 'putArtifact']),
    guarantees: Object.freeze(['content-addressed', 'verified-write', 'retention-classified']),
    authority: 'referenced',
    constraints: Object.freeze(['bounded 64 KiB per stream before hash', 'no secrets in keys/metadata', 'S3-compatible subset only'])
  }),

  project_system: Object.freeze({
    name: 'project_system',
    purpose: 'goals, work items, priorities, blockers, human feedback',
    description: 'Human work tracking. Celestan reads goals and writes progress/blockers without assuming vendor.',
    operations: Object.freeze(['listWork', 'getWork', 'createWork', 'updateWork', 'addComment', 'transition']),
    guarantees: Object.freeze(['project-scoped', 'human-visible']),
    authority: 'human-authoritative',
    constraints: Object.freeze(['rate-limited', 'requires project binding'])
  }),

  knowledge_publishing: Object.freeze({
    name: 'knowledge_publishing',
    purpose: 'publish human-readable Chronicle, decisions, lessons, developmental history',
    description: 'Publishes curated, human-readable knowledge. Source MD or structured artifact rendered through adapter.',
    operations: Object.freeze(['publishChronicle', 'publishDecision', 'publishLesson', 'listPublications']),
    guarantees: Object.freeze(['human-readable', 'provenance-linked']),
    authority: 'curated',
    constraints: Object.freeze(['no runtime coordination state in Git', 'long-lived'])
  }),

  code_repository: Object.freeze({
    name: 'code_repository',
    purpose: 'source, commits, releases, CI/deployment integration',
    description: 'Source truth for CT-Runtime, CT-Foundry, Identity, and docs. CI reads commit, image records provenance.',
    operations: Object.freeze(['clone', 'checkout', 'commit', 'push', 'createRelease', 'getCommit']),
    guarantees: Object.freeze(['versioned', 'auditable']),
    authority: 'source',
    constraints: Object.freeze(['no leases/queues/logs as primary DB'])
  }),

  disposable_compute: Object.freeze({
    name: 'disposable_compute',
    purpose: 'bounded ephemeral execution of caller-owned work',
    description: 'Creates and runs fresh disposable jobs without making the provider authoritative for runtime state, judgment, or result handoff.',
    operations: Object.freeze(['createJob', 'putJob', 'getJob', 'deleteJob', 'runJob', 'pollRun', 'getLogs', 'configureScheduledJob']),
    guarantees: Object.freeze(['ephemeral', 'bounded', 'caller-owned-command']),
    authority: 'mechanical',
    constraints: Object.freeze(['no canonical host-local state', 'runtime secrets by reference only', 'bounded logs and polling'])
  }),

  scheduler: Object.freeze({
    name: 'scheduler',
    purpose: 'mechanical wake triggering',
    description: 'Dumb, idempotent trigger. Owns timing, not judgment. Celestan decides what to do on wake.',
    operations: Object.freeze(['schedule', 'trigger', 'cancel']),
    guarantees: Object.freeze(['mechanical', 'at-least-once', 'idempotent']),
    authority: 'mechanical',
    constraints: Object.freeze(['no semantic orchestration', 'caller-owned judgment'])
  }),
  agent_executor: Object.freeze({ name: 'agent_executor', purpose: 'bounded model turn execution', description: 'Explicit-model, provider-mediated bounded turns with durable deferral.', operations: Object.freeze(['execute']), guarantees: Object.freeze(['free-only', 'bounded', 'secret-isolated']), authority: 'mechanical', constraints: Object.freeze(['no shell', 'no paid fallback']) }),
  workspace: Object.freeze({ name: 'workspace', purpose: 'bounded repository API access', description: 'Provider-neutral source workspace operations without a shell.', operations: Object.freeze(['readFile','tree','ref','createBranch','upsertFile','pullRequest','commits','checks','statuses']), guarantees: Object.freeze(['bounded','auditable']), authority: 'source', constraints: Object.freeze(['token from secret store', 'no arbitrary URL']) }),
  test_executor: Object.freeze({ name: 'test_executor', purpose: 'bounded CI dispatch and observation', description: 'Dispatches approved workflows and observes GitHub Actions; never schedules wakes.', operations: Object.freeze(['dispatch','inspectRuns']), guarantees: Object.freeze(['bounded','non-scheduler']), authority: 'mechanical', constraints: Object.freeze(['approved workflow only']) }),
  model_provider: Object.freeze({ name: 'model_provider', purpose: 'model transport', description: 'OpenRouter free-only transport selected by the caller.', operations: Object.freeze(['chat']), guarantees: Object.freeze(['strict-free','secret-isolated']), authority: 'mechanical', constraints: Object.freeze(['no paid fallback']) })
});

export function getCapabilityDefinition(name) {
  const def = CAPABILITIES[name];
  if (!def) throw new Error(`unknown capability: ${name}`);
  return def;
}

export function listCapabilities() {
  return Object.values(CAPABILITIES);
}
