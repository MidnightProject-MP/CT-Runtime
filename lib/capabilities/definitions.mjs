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

  scheduler: Object.freeze({
    name: 'scheduler',
    purpose: 'mechanical wake triggering',
    description: 'Dumb, idempotent trigger. Owns timing, not judgment. Celestan decides what to do on wake.',
    operations: Object.freeze(['schedule', 'trigger', 'cancel']),
    guarantees: Object.freeze(['mechanical', 'at-least-once', 'idempotent']),
    authority: 'mechanical',
    constraints: Object.freeze(['no semantic orchestration', 'caller-owned judgment'])
  })
});

export function getCapabilityDefinition(name) {
  const def = CAPABILITIES[name];
  if (!def) throw new Error(`unknown capability: ${name}`);
  return def;
}

export function listCapabilities() {
  return Object.values(CAPABILITIES);
}
