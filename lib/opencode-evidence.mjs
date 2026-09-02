import crypto from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exportExecutionEvidence } from './evidence-export.mjs';
import { canonicalJson } from './config.mjs';
import { runProcess } from './runtime.mjs';

const MAX_OUTPUT = 32 * 1024 * 1024;
const MAX_RICH_OUTPUT = 64 * 1024 * 1024;
const MAX_TEXT = 4000;
const MAX_CONTEXT = 2000;
const ID = /^ses_[A-Za-z0-9_-]+$/;

export async function readOpenCodeExport(sessionId, { command = process.env.OPENCODE_BIN || 'opencode', run = runProcess, extractionMode = 'sanitized' } = {}) {
  if (!ID.test(sessionId || '')) throw new Error('invalid OpenCode session ID');
  const rich = extractionMode === 'rich';
  const result = await invoke(run, command, rich ? ['export', sessionId] : ['export', sessionId, '--sanitize'], rich ? MAX_RICH_OUTPUT : MAX_OUTPUT);
  if (result.truncated?.stdout) return { status: 'unavailable', sourceSessionId: sessionId, reason: `OpenCode ${rich ? 'rich' : 'sanitized'} export was truncated` };
  if (result.error || result.code !== 0) return { status: 'unavailable', sourceSessionId: sessionId, reason: 'historical session export unavailable' };
  const json = stripStatusPrefix(result.stdout);
  try { return { status: 'available', sourceSessionId: sessionId, evidence: parseExport(JSON.parse(json), sessionId, extractionMode) }; }
  catch (error) { const known = /execution evidence exceeds|Unexpected token|JSON|unsupported execution evidence/i.test(error?.message || '') ? clip(error.message, 200) : `OpenCode returned invalid ${rich ? 'rich' : 'sanitized'} export`; return { status: 'unavailable', sourceSessionId: sessionId, reason: known }; }
}

export async function listOpenCodeSessions({ command = process.env.OPENCODE_BIN || 'opencode', run = runProcess } = {}) {
  const result = await invoke(run, command, ['session', 'list', '--format', 'json'], MAX_OUTPUT);
  if (result.error || result.truncated?.stdout || result.code !== 0) throw new Error('OpenCode session list unavailable');
  const value = JSON.parse(stripStatusPrefix(result.stdout));
  const sessions = Array.isArray(value) ? value : value?.sessions;
  if (!Array.isArray(sessions)) throw new Error('OpenCode session list was not an array');
  return sessions.map((item) => typeof item === 'string' ? item : item?.id || item?.sessionID || item?.sessionId).filter((id) => ID.test(id));
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
  const info = document?.info || {};
  const messages = Array.isArray(document?.messages) ? document.messages : [];
  const rich = extractionMode === 'rich';
  const tools = [], failures = [], tests = [], mutations = [], reviews = [], userText = [], assistantText = [];
  const aggregates = new Map(), segments = [];
  let modelCalls = 0, assistantOrdinal = 0, structuredRetries = 0;

  for (const message of messages) {
    const messageInfo = message?.info || {};
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
      if (part.type === 'text') {
        const value = safeText(part.text);
        if (value && role === 'user') userText.push(value);
        if (value && role === 'assistant') assistantText.push(value);
      }
      if (part.type === 'retry' || part.type === 'retrying' || (part.type === 'event' && /retry/i.test(part.event || part.name || ''))) structuredRetries++;
      if (part.type !== 'tool') continue;
      const state = part.state || {};
      const startedAt = epoch(state.time?.start), finishedAt = epoch(state.time?.end);
      const tool = compact({ name: clip(part.tool, 200), status: clip(state.status, 80), input: allowlistedInput(state.input), startedAt, finishedAt, durationMs: state.time?.duration === undefined ? duration(startedAt, finishedAt) : number(state.time.duration) });
      if (tools.length < 30) tools.push(tool);
      if (isFailedTool(part) && failures.length < 20) failures.push({ tool: tool.name, status: tool.status, error: safeText(state.error || state.output)?.slice(0, 500) });
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
    initiator: safeText(info.agent),
    role: safeText(info.agent),
    promptContext: rich ? clip(taskContext, MAX_CONTEXT) : undefined,
    toolCalls: tools,
    failures,
    tests: rich && tests.length ? tests : undefined,
    mutations: rich && mutations.length ? mutations : undefined,
    review: rich && reviews.length ? reviews : undefined,
    retries: rich && structuredRetries ? structuredRetries : undefined,
    repository: info.directory ? { path: clip(info.directory, 500), ...(info.ref || info.branch ? { ref: clip(info.ref || info.branch, 200) } : {}) } : undefined,
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
    evidenceFidelity: { mode: extractionMode, sourceView: rich ? 'ephemeral-unsanitized-rich-extraction' : 'sanitized-structural', rawSourceDocumentPersisted: false, derivedTextPersisted: rich, privacyBoundary: 'allowlisted-redacted-derived-facts', rawSourceLifetime: 'memory-only', semanticEligibility: rich ? 'bounded-factual' : 'structural-only' },
    semanticAvailability: {
      task: rich && taskContext ? available('bounded-first-user-message') : unavailable(rich ? 'task-context-unavailable' : 'sanitized-source-does-not-preserve-task-intent'),
      completion: rich && completionSummary ? available(completionClaim ? 'bounded-assistant-completion-claim' : 'bounded-final-assistant-summary') : unavailable(rich ? 'completion-summary-unavailable' : 'sanitized-source-does-not-preserve-completion'),
      review: rich && reviews.length ? available('bounded-tool-evidence') : unavailable(rich ? 'review-evidence-unavailable' : 'sanitized-source-does-not-preserve-review-findings'),
      retries: rich && structuredRetries ? available('structured-retry-events') : unavailable(rich ? 'structured-retry-events-unavailable' : 'sanitized-source-does-not-preserve-retry-meaning'),
      tests: rich && tests.length ? available('bounded-tool-evidence') : unavailable(rich ? 'test-evidence-unavailable' : 'sanitized-source-does-not-preserve-test-results')
    }
  });
}

export async function deliverHistoricalEvidence({ evidence, store, evidenceStore, project = 'unknown' }) {
  const content = Buffer.from(canonicalJson(evidence) + '\n');
  if (evidenceStore?.put) return evidenceStore.put({ project, executionId: evidence.provenance.sourceSessionId, attempt: 1, label: `opencode-${evidence.contentHash.slice(0, 12)}`, content, contentType: 'application/json', retentionClass: 'observer-ledger' });
  const root = store?.root; if (!root) throw new Error('historical evidence requires an evidence store or filesystem store');
  const dir = path.join(root, 'observer', 'inbox'); await mkdir(dir, { recursive: true }); const target = path.join(dir, `${encodeURIComponent(evidence.evidenceId)}-${evidence.contentHash}.json`);
  try { const existing = await readFile(target); if (Buffer.compare(existing, content) !== 0) throw new Error('Observer inbox evidence conflict'); } catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(target, content, { flag: 'wx', mode: 0o600 }); }
  return { objectUri: `file://${target.replaceAll('\\', '/')}`, objectKey: path.relative(root, target).replaceAll(path.sep, '/'), bytes: content.length };
}

export async function representedHistoricalSessions(root, extractionMode = 'sanitized') {
  const dir = path.join(root, 'observer', 'inbox'), ids = new Set(); let names;
  try { names = await readdir(dir); } catch (error) { if (error.code === 'ENOENT') return ids; throw error; }
  for (const name of names.filter((n) => n.endsWith('.json'))) try { const item = JSON.parse(await readFile(path.join(dir, name), 'utf8')); if (item.provenance?.sourceSessionId && (extractionMode === 'rich' || item.evidenceFidelity?.mode === 'sanitized' || !item.evidenceFidelity)) ids.add(item.provenance.sourceSessionId); } catch {}
  return ids;
}

function clip(value, max = MAX_TEXT) { return value === undefined || value === null ? '' : String(value).replace(/[\r\n\0]/g, ' ').slice(0, max); }
function safeText(value) { const clipped = clip(value); if (!clipped) return undefined; return clipped.replace(/((?:password|secret|api[_-]?key|authorization|token|credential)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]').replace(/((?:--password|--secret|--api-key|--token|bearer)\s+)\S+/gi, '$1[REDACTED]').replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, '$1[REDACTED]@'); }
function allowlistedInput(input) { if (!input || typeof input !== 'object') return undefined; return Object.fromEntries(Object.entries(input).filter(([key]) => /^(command|cmd|path|file|pattern|query|args|url)$/i.test(key)).slice(0, 20).map(([key, value]) => [key, safeText(typeof value === 'object' ? JSON.stringify(value) : value)?.slice(0, 1000)])); }
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== '')); }
function summaryText(summary, fallback) { if (typeof summary === 'string') return safeText(clip(summary, MAX_CONTEXT)); if (summary && typeof summary === 'object') { const fields = ['additions', 'deletions', 'files'].filter((key) => Number.isFinite(Number(summary[key]))).map((key) => `${key}=${Number(summary[key])}`); if (fields.length) return `Repository changes: ${fields.join(', ')}`; } return safeText(clip(fallback || '', MAX_CONTEXT)); }
function attributedIdentity(info = {}) { const value = info.model; const provider = clip(info.providerID || info.provider || (value && typeof value === 'object' ? value.providerID || value.provider : ''), 200) || undefined; const model = clip(info.modelID || (value && typeof value === 'object' ? value.modelID || value.id || value.model : typeof value === 'string' ? value : ''), 300) || undefined; const availability = provider && model ? 'available' : provider || model ? 'partial' : 'unavailable'; const variant = clip(info.variant || (value && typeof value === 'object' ? value.variant : ''), 120) || undefined; const identity = availability !== 'unavailable' ? compact({ availability, provider, model, variant }) : { availability, reason: 'session-route-unavailable' }; return { available: availability !== 'unavailable', key: identityKey(identity), value: identity }; }
function identityKey(identity) { return canonicalJson(identity); }
function isFailedTool(part) { return ['error', 'failed'].includes(String(part?.state?.status).toLowerCase()) || Boolean(part?.state?.error); }
function addModelAggregate(map, identity, info, tools, startedAt, finishedAt) { const current = map.get(identity.key) || { identity: identity.value, messageCount: 0, modelCallCount: 0, inputTokens: 0, outputTokens: 0, startedAt, finishedAt, workers: [], agents: [], toolCallCount: 0, failedToolCount: 0 }; current.messageCount++; current.modelCallCount++; current.inputTokens += number(info.tokens?.input); current.outputTokens += number(info.tokens?.output); current.startedAt = !current.startedAt || startedAt && startedAt < current.startedAt ? startedAt : current.startedAt; current.finishedAt = !current.finishedAt || finishedAt && finishedAt > current.finishedAt ? finishedAt : current.finishedAt; const worker = clip(info.worker || info.workerID, 200), agent = clip(info.agent, 200); if (worker && !current.workers.includes(worker) && current.workers.length < 20) current.workers.push(worker); if (agent && !current.agents.includes(agent) && current.agents.length < 20) current.agents.push(agent); current.toolCallCount += tools.length; current.failedToolCount += tools.filter(isFailedTool).length; map.set(identity.key, current); }
function epoch(value) { if (value === undefined || value === null) return undefined; const n = Number(value); if (!Number.isFinite(n)) return undefined; const date = new Date(n); return date.toISOString(); }
function number(value) { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; }
function duration(start, finish) { if (!start || !finish) return undefined; const n = Date.parse(finish) - Date.parse(start); return Number.isFinite(n) && n >= 0 ? n : undefined; }
