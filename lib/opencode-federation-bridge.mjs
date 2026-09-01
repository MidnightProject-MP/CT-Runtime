import { assertCoordination, normalizeObserverLineage, redactFederation } from './federation.mjs';

// Local-only semantic boundary for OpenCode; no shell, credentials, or GAS state.
export function createOpenCodeFederationBridge(adapter, { secrets = [] } = {}) {
  assertCoordination(adapter);
  return Object.freeze({
    async begin(input) { return adapter.claim(input); },
    async checkpoint(executionId, checkpoint, claim) { return adapter.checkpoint(executionId, redactFederation(checkpoint, secrets), claim); },
    async defer(executionId, claim) { return adapter.release(executionId, claim); },
    async continue(executionId, options, claim) { return adapter.handoff(executionId, options, claim); },
    async finalize(executionId, result, claim) { return adapter.finalize(executionId, redactFederation(result, secrets), claim); },
    lineage(input) { return normalizeObserverLineage(input); }
  });
}
export const OPEN_CODE_SEMANTIC_BOUNDARIES = Object.freeze(['begin', 'checkpoint', 'defer', 'continue', 'finalize', 'lineage']);
