import os from 'node:os';

export function unavailableHostTelemetry(reason = 'not-measured') { return { schema: 'celestan-runtime-host-telemetry-v1', availability: 'unavailable', reason, host: hostIdentity() }; }

export function hostTelemetry({ instanceId, sampleType = 'execution', sampledAt = new Date().toISOString(), coldStart = false, startedAt, finishedAt, durationMs, termination = 'not-terminated', resourceLimits, resources, failures = [], cost } = {}) {
  const safeFailures = failures.map((item) => ({ category: ['network', 'provider', 'runtime', 'termination', 'unknown'].includes(item.category) ? item.category : 'runtime', count: Number.isSafeInteger(item.count) && item.count >= 0 ? item.count : 1, ...(typeof item.retryable === 'boolean' ? { retryable: item.retryable } : {}) }));
  const networkFailures = safeFailures.filter((item) => item.category === 'network').reduce((sum, item) => sum + item.count, 0);
  const providerFailures = safeFailures.filter((item) => item.category === 'provider').reduce((sum, item) => sum + item.count, 0);
  return {
    schema: 'celestan-runtime-host-telemetry-v1', availability: 'available', sampleType, sampledAt,
    host: { ...hostIdentity(), instanceId: instanceId || `${os.hostname()}-${process.pid}` },
    ...(sampleType === 'startup' ? { startup: { coldStart, startedAt: startedAt || sampledAt, ...(durationMs === undefined ? {} : { durationMs }) } } : {}),
    ...(sampleType !== 'startup' ? { execution: { ...(startedAt ? { startedAt } : {}), ...(finishedAt ? { finishedAt } : {}), ...(durationMs === undefined ? {} : { durationMs }), networkFailures, providerFailures, failures: safeFailures, termination } } : {}),
    ...(resourceLimits ? { resourceLimits } : {}), ...(resources ? { resources } : {}),
    cost: cost?.measured === true ? cost : { availability: 'unavailable', reason: 'not-genuinely-measured' }
  };
}

function hostIdentity() { return { deployment: process.env.CT_RUNTIME_DEPLOYMENT_ID || 'unknown', provider: process.env.CT_RUNTIME_PROVIDER || 'unknown', runtimeClass: process.env.CT_RUNTIME_CLASS || 'job', region: process.env.CT_RUNTIME_REGION || 'unknown', architecture: process.arch, os: process.platform, imageDigest: process.env.CT_RUNTIME_IMAGE_DIGEST || 'unavailable', runtimeVersion: process.env.CT_RUNTIME_VERSION || 'unavailable' }; }
