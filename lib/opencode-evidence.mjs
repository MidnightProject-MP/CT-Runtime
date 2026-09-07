import crypto from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exportExecutionEvidence } from './evidence-export.mjs';
import { validateExecutionEvidence } from './execution-evidence.mjs';
import { canonicalJson } from './config.mjs';
import { runProcess } from './runtime.mjs';
import { validateSemanticEvidence } from './semantic-evidence.mjs';

const MAX_OUTPUT = 32 * 1024 * 1024;
const MAX_RICH_OUTPUT = 64 * 1024 * 1024;
const MAX_TEXT = 4000;
const MAX_CONTEXT = 2000;
const ID = /^ses_[A-Za-z0-9_-]+$/;
export const OPENCODE_SANITIZED_EXTRACTOR_VERSION = 2;

export async function readOpenCodeExport(sessionId, { command = process.env.OPENCODE_BIN || 'opencode', run = runProcess, extractionMode = 'sanitized' } = {}) {
  if (!ID.test(sessionId || '')) throw new Error('invalid OpenCode session ID');
  if (!['sanitized', 'rich'].includes(extractionMode)) throw new Error('invalid OpenCode extraction mode');
  const rich = extractionMode === 'rich';
  const result = await invoke(run, command, rich ? ['export', sessionId] : ['export', sessionId, '--sanitize'], rich ? MAX_RICH_OUTPUT : MAX_OUTPUT);
  if (result.truncated?.stdout) return { status: 'unavailable', sourceSessionId: sessionId, reason: `OpenCode ${rich ? 'rich' : 'sanitized'} export was truncated` };
  if (result.error || result.code !== 0) return { status: 'unavailable', sourceSessionId: sessionId, reason: 'historical session export unavailable' };
  const json = stripStatusPrefix(result.stdout);
  try { return { status: 'available', sourceSessionId: sessionId, evidence: parseExport(JSON.parse(json), sessionId, extractionMode) }; }
  catch (error) { if (/^OpenCode export (?:structure is invalid|session mismatch)$/.test(error?.message || '')) throw error; return { status: 'unavailable', sourceSessionId: sessionId, reason: `OpenCode returned invalid ${rich ? 'rich' : 'sanitized'} export` }; }
}

export async function listOpenCodeSessions({ command = process.env.OPENCODE_BIN || 'opencode', run = runProcess } = {}) {
  const result = await invoke(run, command, ['db', 'SELECT id FROM session ORDER BY time_created, id', '--format', 'json'], MAX_OUTPUT);
  if (result.error || result.truncated?.stdout || result.code !== 0) throw new Error('OpenCode database session discovery unavailable');
  let value;
  try { value = JSON.parse(stripStatusPrefix(result.stdout)); }
  catch { throw new Error('OpenCode database returned invalid JSON'); }
  const rows = Array.isArray(value) ? value : value?.rows;
  if (!Array.isArray(rows)) throw new Error('OpenCode database session query was not an array');
  const ids = rows.map((item) => typeof item === 'string' ? item : item?.id);
  if (ids.some((id) => !ID.test(id || ''))) throw new Error('OpenCode database returned an invalid session ID');
  return [...new Set(ids)].sort();
}

async function invoke(run, command, args, maxOutput) {
  // The production runner supplies executable resolution, restricted environment,
  // timeout handling, and a distinct truncation signal. Tests may inject a process runner.
  if (run === runProcess || run.length <= 1) return run({ command: command || 'opencode', args, timeoutMs: 300000, maxOutput });
  return run(command || 'opencode', args, { timeoutMs: 300000, maxOutput });
}

function stripStatusPrefix(stdout) {
  return String(stdout).replace(/^Exporting session: ses_[A-Za-z0-9_-]+\s*/, '');
}

/*
  return exportExecutionEvidence({ evidenceId, substrate: 'opencode-local-historical', provider: 'opencode', modelCalls: modelCalls || undefined, turns, tokens: { input: inputTokens, output: outputTokens }, startedAt, finishedAt, durationMs: duration(startedAt, finishedAt), initiator: safeText(info.agent) || undefined, role: safeText(info.agent) || undefined, promptContext: safeText(clip(allText[0] || '', MAX_CONTEXT)), toolCalls: tools.slice(0, 100), failures: failures.slice(0, 100), tests: rich ? tests.slice(0, 100) : undefined, mutations: rich ? git.slice(0, 100) : undefined, review: rich && reviews.length ? reviews.slice(0, 100) : undefined, retries: rich ? allText.filter((t) => /\bretr(?:y|ied|ies)\b/i.test(t)).length || undefined : undefined, repository, summary: rich ? summaryText(info.summary, allText.at(-1)) : undefined, completionClaim: rich && typeof info.summary === 'string' && /\b(complet|done|finish|success)\b/i.test(info.summary) ? safeText(clip(info.summary, 500)) : undefined, provenance: { source: 'opencode-cli-export', sourceSessionId, historical: true }, modelAttribution: { sessionOrchestrator: orchestrator ? { identity: orchestrator, basis: 'session info.model' } : unavailable, aggregates: aggregateModels(modelMessages).slice(0, 32), segments: segments.slice(0, 100), coverage: { assistantMessages: modelCalls, aggregateLimit: 32, segmentLimit: 100, aggregatesTruncated: aggregateModels(modelMessages).length > 32, segmentsTruncated: segments.length > 100 } }, evidenceFidelity: { mode: extractionMode, sourceView: rich ? 'rich-structural-extraction' : 'sanitized-structural', rawSourcePersisted: false, semanticEligibility: rich ? 'bounded-factual' : 'structural-only' }, semanticAvailability: rich ? { task: unavailable, completion: typeof info.summary === 'string' ? available('explicit session summary') : unavailable, review: reviews.length ? available('structured review tool event') : unavailable, retries: allText.some((t) => /\bretr(?:y|ied|ies)\b/i.test(t)) ? available('explicit retry text event') : unavailable, tests: tests.length ? available('structured test tool event') : unavailable } : { task: unavailable, completion: unavailable, review: unavailable, retries: unavailable, tests: unavailable }, outcome: rich && typeof info.summary === 'string' && /\b(failed|cancelled|crashed)\b/i.test(info.summary) ? 'failed' : undefined });
}
*/
export function parseExport(document, sourceSessionId, extractionMode = 'sanitized') {
  if (!ID.test(sourceSessionId || '')) throw new Error('invalid OpenCode session ID');
  if (!['sanitized', 'rich'].includes(extractionMode)) throw new Error('invalid OpenCode extraction mode');
  if (!document || typeof document !== 'object' || Array.isArray(document) || !document.info || typeof document.info !== 'object' || Array.isArray(document.info) || !Array.isArray(document.messages)) throw new Error('OpenCode export structure is invalid');
  const info = document.info;
  if (info.id !== sourceSessionId) throw new Error('OpenCode export session mismatch');
  const messages = document.messages;
  const rich = extractionMode === 'rich';
  const tools = [], failures = [], tests = [], mutations = [], reviews = [], userText = [], assistantText = [];
  const aggregates = new Map(), segments = [];
  let modelCalls = 0, assistantOrdinal = 0, structuredRetries = 0;

  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || !message.info || typeof message.info !== 'object' || Array.isArray(message.info) || !Array.isArray(message.parts)) throw new Error('OpenCode export structure is invalid');
    const messageInfo = message?.info || {};
    if (messageInfo.sessionID !== undefined && messageInfo.sessionID !== sourceSessionId) throw new Error('OpenCode export session mismatch');
    for (const part of message.parts) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) throw new Error('OpenCode export structure is invalid');
      if (part.sessionID !== undefined && part.sessionID !== sourceSessionId) throw new Error('OpenCode export session mismatch');
    }
    const role = messageInfo.role || message?.role;
    const parts = (Array.isArray(message?.parts) ? message.parts : []).slice(0, 200);
    if (role === 'assistant') {
      modelCalls++;
      assistantOrdinal++;
      const identity = attributedIdentity(messageInfo);
      const messageTools = parts.filter((part) => part.type === 'tool');
      const startedAt = epoch(messageInfo.time?.created || messageInfo.time?.start);
      const finishedAt = epoch(messageInfo.time?.completed || messageInfo.time?.updated || messageInfo.time?.end || messageInfo.time?.created || messageInfo.time?.start);
      addModelAggregate(aggregates, identity, messageInfo, messageTools, startedAt, finishedAt);
      const previous = segments.at(-1);
      if (!previous || previous.identityKey !== identity.key) segments.push({ identityKey: identity.key, identity: identity.value, startOrdinal: assistantOrdinal, endOrdinal: assistantOrdinal, messageCount: 1, startedAt, finishedAt });
      else { previous.endOrdinal = assistantOrdinal; previous.messageCount++; previous.finishedAt = finishedAt || previous.finishedAt; }
    }

    for (const part of parts) {
      if (rich && part.type === 'text') {
        const value = safeText(part.text);
        if (value && role === 'user') userText.push(value);
        if (value && role === 'assistant') assistantText.push(value);
      }
      if (part.type === 'retry' || part.type === 'retrying' || (part.type === 'event' && /retry/i.test(part.event || part.name || ''))) structuredRetries++;
      if (part.type !== 'tool') continue;
      const state = part.state || {};
      const startedAt = epoch(state.time?.start), finishedAt = epoch(state.time?.end);
      const tool = compact({ name: rich ? clip(part.tool, 200) : metadataIdentifier(part.tool, 200), status: rich ? clip(state.status, 80) : metadataStatus(state.status), ...(rich ? { input: allowlistedInput(state.input) } : {}), startedAt, finishedAt, durationMs: state.time?.duration === undefined ? duration(startedAt, finishedAt) : number(state.time.duration) });
      if (tools.length < 30) tools.push(tool);
      if (rich && isFailedTool(part) && failures.length < 20) failures.push({ tool: tool.name, status: tool.status, error: safeText(state.error || state.output)?.slice(0, 500) });
      if (!rich) continue;
      const output = safeText(state.output);
      const factual = safeText(`${tool.name || ''} ${JSON.stringify(tool.input || {})} ${output || ''}`);
      if (/\bgit\s+(?:add|commit|push|pull|checkout|merge|rebase|reset)\b/i.test(factual || '') && mutations.length < 30) mutations.push({ operation: clip(factual, 500) });
      if (/\b(?:test|pytest|vitest|jest|npm test|cargo test|node --test)\b/i.test(factual || '') && tests.length < 30) tests.push({ type: 'reported-tool-result', summary: clip(factual, 500), result: isFailedTool(part) || /\b(?:fail(?:ed)?|error)\b/i.test(output || '') ? 'failed' : 'observed' });
      if (/\b(?:review|finding|reviewer)\b/i.test(factual || '') && reviews.length < 20) reviews.push({ type: 'reported-review-finding', finding: clip(factual, 500) });
    }
  }

  const aggregateValues = [...aggregates.values()].sort((left, right) => identityKey(left.identity).localeCompare(identityKey(right.identity)));
  const taskContext = userText.find(Boolean);
  const completionSummary = [...assistantText].reverse().find(Boolean);
  const completionClaim = rich && completionSummary && /\b(?:completed|complete|done|finished|successfully|verified)\b/i.test(completionSummary) ? clip(completionSummary, 500) : undefined;
  const unavailable = (reason) => ({ availability: 'unavailable', reason });
  const available = (basis) => ({ availability: 'available', basis });
  const sessionOrchestrator = attributedIdentity({ model: info.model });
  const totalTokens = info.tokens || {};
  const startedAt = epoch(info.time?.created || info.time?.start), finishedAt = epoch(info.time?.updated || info.time?.end);
  const evidenceId = `opencode-session-${crypto.createHash('sha256').update(sourceSessionId).digest('hex').slice(0, 32)}`;
  return exportExecutionEvidence({
    evidenceId,
    substrate: 'opencode-local-historical',
    provider: 'opencode',
    modelCalls: modelCalls || undefined,
    turns: messages.length,
    tokens: { input: number(totalTokens.input), output: number(totalTokens.output) },
    startedAt,
    finishedAt,
    durationMs: duration(startedAt, finishedAt),
    initiator: rich ? safeText(info.agent) : metadataIdentifier(info.agent, 200),
    role: rich ? safeText(info.agent) : metadataIdentifier(info.agent, 200),
    promptContext: rich ? clip(taskContext, MAX_CONTEXT) : undefined,
    toolCalls: tools,
    failures: rich ? failures : undefined,
    tests: rich && tests.length ? tests : undefined,
    mutations: rich && mutations.length ? mutations : undefined,
    review: rich && reviews.length ? reviews : undefined,
    retries: rich && structuredRetries ? structuredRetries : undefined,
    repository: rich && info.directory ? { path: clip(info.directory, 500), ...(info.ref || info.branch ? { ref: clip(info.ref || info.branch, 200) } : {}) } : undefined,
    summary: rich ? clip(completionSummary, MAX_CONTEXT) : undefined,
    completionClaim,
    provenance: { source: 'opencode-cli-export', sourceSessionId, historical: true, extractionMode },
    modelAttribution: {
      sessionDefaultRoute: sessionOrchestrator.available ? { availability: sessionOrchestrator.value.availability, basis: 'session-metadata', identity: sessionOrchestrator.value } : unavailable('session-model-unavailable'),
      assistantMessageRouteMetadata: {
        availability: modelCalls ? 'available' : 'unavailable',
        basis: 'opencode-assistant-message-route-metadata',
        aggregates: aggregateValues.slice(0, 32),
        segments: segments.slice(0, 60).map(({ identityKey: _, ...segment }) => segment),
        coverage: { assistantMessages: modelCalls, attributedMessages: aggregateValues.filter((item) => item.identity.availability === 'available').reduce((sum, item) => sum + item.messageCount, 0), aggregateLimit: 32, segmentLimit: 60, aggregatesComplete: aggregateValues.length <= 32, segmentsComplete: segments.length <= 60 }
      }
    },
    evidenceFidelity: { mode: extractionMode, ...(rich ? {} : { extractorVersion: OPENCODE_SANITIZED_EXTRACTOR_VERSION }), sourceView: rich ? 'ephemeral-unsanitized-rich-extraction' : 'sanitized-structural', rawSourceDocumentPersisted: false, derivedTextPersisted: rich, privacyBoundary: rich ? 'allowlisted-redacted-derived-facts' : 'metadata-only-structural-fields', rawSourceLifetime: 'memory-only', semanticEligibility: rich ? 'bounded-factual' : 'structural-only' },
    semanticAvailability: {
      task: rich && taskContext ? available('bounded-first-user-message') : unavailable(rich ? 'task-context-unavailable' : 'sanitized-source-does-not-preserve-task-intent'),
      completion: rich && completionSummary ? available(completionClaim ? 'bounded-assistant-completion-claim' : 'bounded-final-assistant-summary') : unavailable(rich ? 'completion-summary-unavailable' : 'sanitized-source-does-not-preserve-completion'),
      review: rich && reviews.length ? available('bounded-tool-evidence') : unavailable(rich ? 'review-evidence-unavailable' : 'sanitized-source-does-not-preserve-review-findings'),
      retries: rich && structuredRetries ? available('structured-retry-events') : unavailable(rich ? 'structured-retry-events-unavailable' : 'sanitized-source-does-not-preserve-retry-meaning'),
      tests: rich && tests.length ? available('bounded-tool-evidence') : unavailable(rich ? 'test-evidence-unavailable' : 'sanitized-source-does-not-preserve-test-results')
    }
  });
}

export async function writeLocalHistoricalEvidence({ evidence, store, resolveSemanticSource }) {
  validateExecutionEvidence(evidence);
  if (evidence?.semanticEvidenceEnvelope !== undefined && evidence?.evidenceFidelity?.mode !== 'sanitized') throw new Error('semantic evidence is only attachable to sanitized historical evidence');
  if (evidence?.evidenceFidelity?.mode === 'sanitized') auditSanitizedHistoricalEvidence(evidence);
  if (evidence?.semanticEvidenceEnvelope) await verifySemanticEnvelopeSources(evidence.semanticEvidenceEnvelope, resolveSemanticSource);
  const content = Buffer.from(canonicalJson(evidence) + '\n');
  const root = store?.root; if (!root) throw new Error('historical evidence requires an evidence store or filesystem store');
  const dir = path.join(root, 'observer', 'inbox'); await mkdir(dir, { recursive: true }); const target = path.join(dir, `${encodeURIComponent(evidence.evidenceId)}-${evidence.contentHash}.json`);
  try { const existing = await readFile(target); if (Buffer.compare(existing, content) !== 0) throw new Error('Observer inbox evidence conflict'); } catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(target, content, { flag: 'wx', mode: 0o600 }); }
  const local = { objectUri: `file://${target.replaceAll('\\', '/')}`, objectKey: path.relative(root, target).replaceAll(path.sep, '/'), bytes: content.length };
  return { local, content, target };
}

export async function deliverHistoricalEvidence({ evidence, store, evidenceStore, project = 'unknown', resolveSemanticSource }) {
  const { local, content } = await writeLocalHistoricalEvidence({ evidence, store, resolveSemanticSource });
  const remote = evidenceStore?.put ? await evidenceStore.put({ project, executionId: evidence.provenance.sourceSessionId, attempt: 1, label: `opencode-${evidence.contentHash.slice(0, 12)}`, content, contentType: 'application/json', retentionClass: 'observer-ledger' }) : undefined;
  return remote ? { local, remote } : local;
}

export async function representedHistoricalSessions(root, extractionMode = 'sanitized') {
  const ids = new Set();
  for (const item of await readHistoricalEvidenceFiles(root)) if (extractionMode === 'sanitized' && item.evidenceFidelity?.extractorVersion === OPENCODE_SANITIZED_EXTRACTOR_VERSION) ids.add(item.provenance.sourceSessionId);
  return ids;
}

export async function readHistoricalEvidenceFiles(root) {
  const dir = path.join(root, 'observer', 'inbox'); let names;
  try { names = await readdir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const values = [];
  for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
    let value;
    try { value = JSON.parse(await readFile(path.join(dir, name), 'utf8')); }
    catch (error) { if (name.startsWith('opencode-session-')) throw new Error(`OpenCode historical evidence JSON is invalid: ${name}`); continue; }
    const candidate = name.startsWith('opencode-session-') || value?.substrate === 'opencode-local-historical' || value?.provenance?.source === 'opencode-cli-export';
    if (!candidate) continue;
    validateExecutionEvidence(value);
    const expectedName = `${encodeURIComponent(value.evidenceId)}-${value.contentHash}.json`;
    if (name !== expectedName) throw new Error(`OpenCode historical evidence canonical name is invalid: ${name}`);
    if (value.evidenceFidelity?.extractorVersion === OPENCODE_SANITIZED_EXTRACTOR_VERSION) auditSanitizedHistoricalEvidence(value);
    values.push(value);
  }
  return values;
}

const TOP_LEVEL = new Set(['schema', 'version', 'evidenceId', 'substrate', 'provider', 'modelCalls', 'turns', 'tokens', 'startedAt', 'finishedAt', 'durationMs', 'initiator', 'role', 'toolCalls', 'provenance', 'modelAttribution', 'evidenceFidelity', 'semanticAvailability', 'semanticEvidenceEnvelope', 'revision', 'contentHash']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.+~-]*$/;
const SENSITIVE_IDENTIFIER = /(?:^|[_.+~-])(?:password|secret|token|credential|authorization|cookie|private-key|api-key)(?:$|[_.+~-])/i;
const TOOL_STATUSES = new Set(['pending', 'running', 'completed', 'error', 'failed', 'cancelled', 'aborted', 'timeout', 'unknown']);
const keys = (value, allowed, name) => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`sanitized historical evidence ${name} is invalid`); for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`sanitized historical evidence ${name} has unknown field: ${key}`); };
const finite = (value, name) => { if (!Number.isFinite(value) || value < 0) throw new Error(`sanitized historical evidence ${name} is invalid`); };
const count = (value, name) => { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`sanitized historical evidence ${name} is invalid`); };
const optionalText = (value, name, max) => { if (value !== undefined && (typeof value !== 'string' || !value || value.length > max || /[\r\n\0]/.test(value))) throw new Error(`sanitized historical evidence ${name} is invalid`); };
const optionalIdentifier = (value, name, max) => { optionalText(value, name, max); if (value !== undefined && (!IDENTIFIER.test(value) || SENSITIVE_IDENTIFIER.test(value))) throw new Error(`sanitized historical evidence ${name} is invalid`); };
const optionalTime = (value, name) => { optionalText(value, name, 40); if (value !== undefined && (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) throw new Error(`sanitized historical evidence ${name} is invalid`); };

export function auditSanitizedHistoricalEvidence(value) {
  validateExecutionEvidence(value);
  const fidelity = value.evidenceFidelity || {}, provenance = value.provenance || {};
  if (value.substrate !== 'opencode-local-historical' || fidelity.mode !== 'sanitized' || fidelity.extractorVersion !== OPENCODE_SANITIZED_EXTRACTOR_VERSION || fidelity.sourceView !== 'sanitized-structural' || fidelity.rawSourceDocumentPersisted !== false || fidelity.derivedTextPersisted !== false || fidelity.semanticEligibility !== 'structural-only') throw new Error('sanitized historical evidence fidelity is invalid');
  if (!ID.test(provenance.sourceSessionId || '') || provenance.historical !== true || provenance.extractionMode !== 'sanitized') throw new Error('sanitized historical evidence provenance is invalid');
  keys(value, TOP_LEVEL, 'document');
  const expectedEvidenceId = `opencode-session-${crypto.createHash('sha256').update(provenance.sourceSessionId).digest('hex').slice(0, 32)}`;
  if (value.evidenceId !== expectedEvidenceId) throw new Error('sanitized historical evidence identity is invalid');
  optionalIdentifier(value.provider, 'provider', 100); optionalIdentifier(value.initiator, 'initiator', 200); optionalIdentifier(value.role, 'role', 200);
  for (const field of ['modelCalls', 'turns']) if (value[field] !== undefined) count(value[field], field); if (value.durationMs !== undefined) finite(value.durationMs, 'durationMs');
  optionalTime(value.startedAt, 'startedAt'); optionalTime(value.finishedAt, 'finishedAt');
  keys(value.tokens, new Set(['input', 'output']), 'tokens'); count(value.tokens.input, 'tokens.input'); count(value.tokens.output, 'tokens.output');
  if (!Array.isArray(value.toolCalls) || value.toolCalls.length > 30) throw new Error('sanitized historical evidence toolCalls is invalid');
  for (const [index, tool] of value.toolCalls.entries()) { keys(tool, new Set(['name', 'status', 'startedAt', 'finishedAt', 'durationMs']), `toolCalls[${index}]`); optionalIdentifier(tool.name, `toolCalls[${index}].name`, 200); optionalIdentifier(tool.status, `toolCalls[${index}].status`, 80); if (tool.status !== undefined && !TOOL_STATUSES.has(tool.status)) throw new Error(`sanitized historical evidence toolCalls[${index}].status is invalid`); optionalTime(tool.startedAt, `toolCalls[${index}].startedAt`); optionalTime(tool.finishedAt, `toolCalls[${index}].finishedAt`); if (tool.durationMs !== undefined) finite(tool.durationMs, `toolCalls[${index}].durationMs`); }
  keys(provenance, new Set(['source', 'sourceSessionId', 'historical', 'extractionMode']), 'provenance'); if (provenance.source !== 'opencode-cli-export') throw new Error('sanitized historical evidence provenance is invalid');
  keys(fidelity, new Set(['mode', 'extractorVersion', 'sourceView', 'rawSourceDocumentPersisted', 'derivedTextPersisted', 'privacyBoundary', 'rawSourceLifetime', 'semanticEligibility']), 'evidenceFidelity'); if (fidelity.privacyBoundary !== 'metadata-only-structural-fields' || fidelity.rawSourceLifetime !== 'memory-only') throw new Error('sanitized historical evidence fidelity is invalid');
  validateModelAttribution(value.modelAttribution);
  validateSemanticAvailability(value.semanticAvailability);
  if (value.revision !== undefined) { keys(value.revision, new Set(['number', 'predecessorContentHash', 'reason']), 'revision'); if (!Number.isSafeInteger(value.revision.number) || value.revision.number < 1 || !['extractor-upgrade'].includes(value.revision.reason) || value.revision.predecessorContentHash !== undefined && !/^[a-f0-9]{64}$/.test(value.revision.predecessorContentHash)) throw new Error('sanitized historical evidence revision is invalid'); }
  if (value.semanticEvidenceEnvelope !== undefined) validateSemanticEnvelope(value.semanticEvidenceEnvelope, value.provenance.sourceSessionId);
  return value;
}

function validateModelAttribution(value) {
  keys(value, new Set(['sessionDefaultRoute', 'assistantMessageRouteMetadata']), 'modelAttribution');
  const route = value.sessionDefaultRoute; keys(route, new Set(route?.identity ? ['availability', 'basis', 'identity'] : ['availability', 'reason']), 'modelAttribution.sessionDefaultRoute');
  if (route.identity) { if (route.basis !== 'session-metadata' || !['available', 'partial'].includes(route.availability) || route.availability !== route.identity.availability) throw new Error('sanitized historical evidence session route basis is invalid'); validateIdentity(route.identity, 'modelAttribution.sessionDefaultRoute.identity'); }
  else if (route.availability !== 'unavailable' || route.reason !== 'session-model-unavailable') throw new Error('sanitized historical evidence session route is invalid');
  const metadata = value.assistantMessageRouteMetadata; keys(metadata, new Set(['availability', 'basis', 'aggregates', 'segments', 'coverage']), 'modelAttribution.assistantMessageRouteMetadata');
  if (!['available', 'unavailable'].includes(metadata.availability) || metadata.basis !== 'opencode-assistant-message-route-metadata' || !Array.isArray(metadata.aggregates) || metadata.aggregates.length > 32 || !Array.isArray(metadata.segments) || metadata.segments.length > 60) throw new Error('sanitized historical evidence assistant route metadata is invalid');
  for (const [index, aggregate] of metadata.aggregates.entries()) { keys(aggregate, new Set(['identity', 'messageCount', 'modelCallCount', 'inputTokens', 'outputTokens', 'startedAt', 'finishedAt', 'workers', 'agents', 'toolCallCount', 'failedToolCount']), `modelAttribution.aggregates[${index}]`); validateIdentity(aggregate.identity, `modelAttribution.aggregates[${index}].identity`); for (const field of ['messageCount', 'modelCallCount', 'inputTokens', 'outputTokens', 'toolCallCount', 'failedToolCount']) count(aggregate[field], `modelAttribution.aggregates[${index}].${field}`); validateTextList(aggregate.workers, 20, 200, `modelAttribution.aggregates[${index}].workers`); validateTextList(aggregate.agents, 20, 200, `modelAttribution.aggregates[${index}].agents`); optionalTime(aggregate.startedAt, 'aggregate.startedAt'); optionalTime(aggregate.finishedAt, 'aggregate.finishedAt'); }
  for (const [index, segment] of metadata.segments.entries()) { keys(segment, new Set(['identity', 'startOrdinal', 'endOrdinal', 'messageCount', 'startedAt', 'finishedAt']), `modelAttribution.segments[${index}]`); validateIdentity(segment.identity, `modelAttribution.segments[${index}].identity`); for (const field of ['startOrdinal', 'endOrdinal', 'messageCount']) count(segment[field], `modelAttribution.segments[${index}].${field}`); optionalTime(segment.startedAt, 'segment.startedAt'); optionalTime(segment.finishedAt, 'segment.finishedAt'); }
  const coverage = metadata.coverage; keys(coverage, new Set(['assistantMessages', 'attributedMessages', 'aggregateLimit', 'segmentLimit', 'aggregatesComplete', 'segmentsComplete']), 'modelAttribution.coverage'); for (const field of ['assistantMessages', 'attributedMessages', 'aggregateLimit', 'segmentLimit']) count(coverage[field], `modelAttribution.coverage.${field}`); if (typeof coverage.aggregatesComplete !== 'boolean' || typeof coverage.segmentsComplete !== 'boolean') throw new Error('sanitized historical evidence route coverage is invalid');
}

function validateIdentity(value, name) { keys(value, new Set(value?.availability === 'unavailable' ? ['availability', 'reason'] : ['availability', 'provider', 'model', 'variant']), name); if (!['available', 'partial', 'unavailable'].includes(value.availability)) throw new Error(`sanitized historical evidence ${name} is invalid`); optionalIdentifier(value.provider, `${name}.provider`, 200); optionalIdentifier(value.model, `${name}.model`, 300); optionalIdentifier(value.variant, `${name}.variant`, 120); if (value.reason !== undefined && value.reason !== 'session-route-unavailable') throw new Error(`sanitized historical evidence ${name}.reason is invalid`); }
function validateTextList(value, limit, max, name) { if (!Array.isArray(value) || value.length > limit) throw new Error(`sanitized historical evidence ${name} is invalid`); for (const item of value) optionalIdentifier(item, name, max); }
function validateSemanticAvailability(value) { const reasons = { task: 'sanitized-source-does-not-preserve-task-intent', completion: 'sanitized-source-does-not-preserve-completion', review: 'sanitized-source-does-not-preserve-review-findings', retries: 'sanitized-source-does-not-preserve-retry-meaning', tests: 'sanitized-source-does-not-preserve-test-results' }; keys(value, new Set(Object.keys(reasons)), 'semanticAvailability'); for (const [name, item] of Object.entries(value)) { keys(item, new Set(['availability', 'reason']), `semanticAvailability.${name}`); if (item.availability !== 'unavailable' || item.reason !== reasons[name]) throw new Error(`sanitized historical evidence semanticAvailability.${name} is invalid`); } }

export function validateSemanticEnvelope(envelope, sessionId) {
  const value = validateSemanticEvidence(envelope);
  if (value.lineage.sourceSessionId !== sessionId) throw new Error('semantic envelope source session mismatch');
  if (value.sources.some((source) => !/^[a-f0-9]{64}$/.test(source.sha256 || ''))) throw new Error('semantic envelope sources require sha256');
  return value;
}
export async function verifySemanticEnvelopeSources(envelope, resolveSemanticSource) {
  if (typeof resolveSemanticSource !== 'function') throw new Error('semantic envelope sources require a durable source resolver');
  for (const source of envelope.sources) {
    const bytes = await resolveSemanticSource(source);
    if (!(typeof bytes === 'string' || Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) throw new Error(`semantic envelope source is unavailable: ${source.sourceId}`);
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual !== source.sha256) throw new Error(`semantic envelope source hash mismatch: ${source.sourceId}`);
  }
  return envelope;
}
export const validateSanitizedHistoricalEvidence = auditSanitizedHistoricalEvidence;
export const auditSanitizedEvidence = auditSanitizedHistoricalEvidence;

function clip(value, max = MAX_TEXT) { return value === undefined || value === null ? '' : String(value).replace(/[\r\n\0]/g, ' ').slice(0, max); }
function metadataIdentifier(value, max) { const raw = clip(value, max); if (!raw) return undefined; return IDENTIFIER.test(raw) && !SENSITIVE_IDENTIFIER.test(raw) ? raw : `opaque-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)}`; }
function metadataStatus(value) { const raw = clip(value, 80).toLowerCase(); return TOOL_STATUSES.has(raw) ? raw : raw ? 'unknown' : undefined; }
function safeText(value) { const clipped = clip(value); if (!clipped) return undefined; return clipped.replace(/((?:password|secret|api[_-]?key|authorization|token|credential)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]').replace(/((?:--password|--secret|--api-key|--token|bearer)\s+)\S+/gi, '$1[REDACTED]').replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, '$1[REDACTED]@'); }
function allowlistedInput(input) { if (!input || typeof input !== 'object') return undefined; return Object.fromEntries(Object.entries(input).filter(([key]) => /^(command|cmd|path|file|pattern|query|args|url)$/i.test(key)).slice(0, 20).map(([key, value]) => [key, safeText(typeof value === 'object' ? JSON.stringify(value) : value)?.slice(0, 1000)])); }
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== '')); }
function summaryText(summary, fallback) { if (typeof summary === 'string') return safeText(clip(summary, MAX_CONTEXT)); if (summary && typeof summary === 'object') { const fields = ['additions', 'deletions', 'files'].filter((key) => Number.isFinite(Number(summary[key]))).map((key) => `${key}=${Number(summary[key])}`); if (fields.length) return `Repository changes: ${fields.join(', ')}`; } return safeText(clip(fallback || '', MAX_CONTEXT)); }
function attributedIdentity(info = {}) { const value = info.model; const provider = metadataIdentifier(info.providerID || info.provider || (value && typeof value === 'object' ? value.providerID || value.provider : ''), 200); const model = metadataIdentifier(info.modelID || (value && typeof value === 'object' ? value.modelID || value.id || value.model : typeof value === 'string' ? value : ''), 300); const availability = provider && model ? 'available' : provider || model ? 'partial' : 'unavailable'; const variant = metadataIdentifier(info.variant || (value && typeof value === 'object' ? value.variant : ''), 120); const identity = availability !== 'unavailable' ? compact({ availability, provider, model, variant }) : { availability, reason: 'session-route-unavailable' }; return { available: availability !== 'unavailable', key: identityKey(identity), value: identity }; }
function identityKey(identity) { return canonicalJson(identity); }
function isFailedTool(part) { return ['error', 'failed'].includes(String(part?.state?.status).toLowerCase()) || Boolean(part?.state?.error); }
function addModelAggregate(map, identity, info, tools, startedAt, finishedAt) { const current = map.get(identity.key) || { identity: identity.value, messageCount: 0, modelCallCount: 0, inputTokens: 0, outputTokens: 0, startedAt, finishedAt, workers: [], agents: [], toolCallCount: 0, failedToolCount: 0 }; current.messageCount++; current.modelCallCount++; current.inputTokens += number(info.tokens?.input); current.outputTokens += number(info.tokens?.output); current.startedAt = !current.startedAt || startedAt && startedAt < current.startedAt ? startedAt : current.startedAt; current.finishedAt = !current.finishedAt || finishedAt && finishedAt > current.finishedAt ? finishedAt : current.finishedAt; const worker = metadataIdentifier(info.worker || info.workerID, 200), agent = metadataIdentifier(info.agent, 200); if (worker && !current.workers.includes(worker) && current.workers.length < 20) current.workers.push(worker); if (agent && !current.agents.includes(agent) && current.agents.length < 20) current.agents.push(agent); current.toolCallCount += tools.length; current.failedToolCount += tools.filter(isFailedTool).length; map.set(identity.key, current); }
function epoch(value) { if (value === undefined || value === null) return undefined; const n = Number(value); if (!Number.isFinite(n)) return undefined; const date = new Date(n); return date.toISOString(); }
function number(value) { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; }
function duration(start, finish) { if (!start || !finish) return undefined; const n = Date.parse(finish) - Date.parse(start); return Number.isFinite(n) && n >= 0 ? n : undefined; }
