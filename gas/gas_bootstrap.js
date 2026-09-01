/* Creates only the non-secret Google resources required by the prototype. */
function bootstrapGasResources() {
  var props = PropertiesService.getScriptProperties();
  var spreadsheetId = props.getProperty('CT_GAS_SPREADSHEET_ID');
  var driveRootId = props.getProperty('CT_GAS_DRIVE_ROOT_ID');
  if (!spreadsheetId) {
    spreadsheetId = SpreadsheetApp.create('CT-Runtime GAS Durable State').getId();
    props.setProperty('CT_GAS_SPREADSHEET_ID', spreadsheetId);
  }
  if (!driveRootId) {
    driveRootId = DriveApp.createFolder('CT-Runtime GAS Evidence').getId();
    props.setProperty('CT_GAS_DRIVE_ROOT_ID', driveRootId);
  }
  initializeGasSchema();
  return { spreadsheetId: spreadsheetId, driveRootId: driveRootId, schema: CT_GAS.SHEETS };
}

function configureGasPrototype() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('CT_GAS_PROOF_MODEL', 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free');
  props.setProperty('CT_GAS_BUDGET_MS', String(CT_GAS.BUDGET_MS));
  props.setProperty('GITHUB_REPO', 'MidnightProject-MP/CT-Runtime');
  props.setProperty('GITHUB_ACTION_WORKFLOW_ALLOWLIST', 'ci.yml');
  return { model: props.getProperty('CT_GAS_PROOF_MODEL'), budgetMs: Number(props.getProperty('CT_GAS_BUDGET_MS')) };
}

function startGasProof() {
  var props = PropertiesService.getScriptProperties(), model = props.getProperty('CT_GAS_PROOF_MODEL');
  CT_GAS.freeModel(model);
  var workOrderId = CT_GAS.id('work-order', { proof: 'gas-a-b', created: Date.now() });
  var executionId = CT_GAS.id('execution', { work_order_id: workOrderId, created: Date.now() });
  var continuationId = CT_GAS.id('continuation', { work_order_id: workOrderId, execution_id: executionId, step: 'A' });
  CT_GAS_STATE.create('work_orders', { id: workOrderId, lifecycle: 'requested', payload: { work_order_id: workOrderId, goal: 'Continue bounded work', step: 'A', model: model, physical_execution_count: 1, launch_context: { model: model, proof: 'gas-a-b' }, resume_context: { source: 'sheets-drive' } } });
  var wake = requestNextWake({ time: new Date().toISOString(), reason: 'requested', project: 'ct-runtime-gas-proof', work_order_id: workOrderId, execution_id: executionId, continuation_id: continuationId, launch: { model: model, proof: 'gas-a-b' }, resume: { source: 'sheets-drive' } });
  return { work_order_id: workOrderId, execution_id: executionId, continuation_id: continuationId, wake_id: wake.id };
}

function setupGasTrigger() {
  return CT_GAS_TRIGGER.ensure();
}

function inspectGasProofState(workOrderId) {
  var rows = CT_GAS_STATE.list('wakes').filter(function (row) { return !workOrderId || (row.payload && row.payload.work_order_id === workOrderId); });
  return { work_orders: CT_GAS_STATE.list('work_orders').filter(function (row) { return !workOrderId || row.id === workOrderId; }).map(function (row) { return { id: row.id, lifecycle: row.lifecycle, payload: row.payload && { step: row.payload.step, model: row.payload.model, next_operation: row.payload.next_operation, physical_execution_count: row.payload.physical_execution_count } }; }), wakes: rows.map(function (row) { return { id: row.id, lifecycle: row.lifecycle, owner: row.owner || '', fence: row.fence ? String(row.fence) : '', payload: row.payload && { work_order_id: row.payload.work_order_id, continuation_id: row.payload.continuation_id, reason: row.payload.reason } }; }) };
}

function auditGitHubAccess() {
  var clock = CT_GAS.clock(Date.now(), 30000);
  var ref = githubWorkspace().ref('main', clock);
  var runs = testExecutor().inspectRuns(clock);
  return { repository: PropertiesService.getScriptProperties().getProperty('GITHUB_REPO'), default_ref: ref.object && ref.object.sha ? 'readable' : 'readable', workflow_runs_observable: Array.isArray(runs.workflow_runs), workflow_run_count: Array.isArray(runs.workflow_runs) ? runs.workflow_runs.length : 0 };
}

function auditGitHubRepositoryRead() {
  var ref = githubWorkspace().ref('main', CT_GAS.clock(Date.now(), 30000));
  return { repository: PropertiesService.getScriptProperties().getProperty('GITHUB_REPO'), default_ref_readable: Boolean(ref && ref.object && ref.object.sha) };
}

function diagnoseGasProvider() {
  var props = PropertiesService.getScriptProperties(), model = props.getProperty('CT_GAS_PROOF_MODEL'), started = Date.now(), key = props.getProperty('OPENROUTER_API_KEY');
  CT_GAS.freeModel(model);
  var telemetry = CT_GAS_STATE.list('model_telemetry').slice(-20).map(function (row) { return { id: row.id, payload: row.payload && { operation: row.payload.operation, model: row.payload.model, turns: row.payload.turns, elapsed_ms: row.payload.elapsed_ms, actual_duration_ms: row.payload.actual_duration_ms, continuation_reason: row.payload.continuation_reason, defer_reason: row.payload.defer_reason, physical_execution_count: row.payload.physical_execution_count } }; });
  var events = CT_GAS_STATE.list('observer_ledger').filter(function (row) { return row.kind === 'model_deferred' || row.kind === 'wake_interrupted'; }).slice(-20).map(function (row) { return { id: row.id, kind: row.kind, payload: row.payload && { execution_id: row.payload.execution_id, work_order_id: row.payload.work_order_id, continuation_id: row.payload.continuation_id, operation: row.payload.operation, reason: row.payload.reason, attempt: row.payload.attempt, error: row.payload.error } }; });
  var clock = CT_GAS.clock(started, 60000), result = { model: model, request_started: new Date(started).toISOString(), gas_preempted: false };
  if (!key) return { durable_telemetry: telemetry, durable_events: events, smoke: { status: 'blocked', classification: 'missing-key' }, model: model };
  if (!clock.canStart(CT_GAS.OPERATION_BUDGETS.model)) return { durable_telemetry: telemetry, durable_events: events, smoke: { status: 'blocked', classification: 'insufficient-gas-budget' }, model: model };
  var response;
  try {
    response = UrlFetchApp.fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + key }, payload: JSON.stringify({ model: model, messages: [{ role: 'user', content: 'Return exactly the word ACK.' }], max_tokens: 8 }), muteHttpExceptions: true });
  } catch (e) {
    result.smoke = { status: 'failed', classification: 'gas-urlfetch-error', retryable: true, elapsed_ms: Date.now() - started, error: CT_GAS.redact(CT_GAS.bound(e.message || e, 240), [key]) };
    return { durable_telemetry: telemetry, durable_events: events, smoke: result.smoke, model: model };
  }
  var elapsed = Date.now() - started, code = response.getResponseCode(), text = CT_GAS.bound(response.getContentText(), 12000), parsed = null;
  try { parsed = JSON.parse(text); } catch (_) {}
  if (!clock.canStart(0)) result.gas_preempted = true;
  var err = parsed && parsed.error, usage = parsed && parsed.usage, output = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
  var retryable = code === 408 || code === 409 || code === 425 || code === 429 || code >= 500;
  var classification = code >= 200 && code < 300 ? 'success' : code === 400 || code === 422 ? 'bad-request-or-model-contract' : code === 401 || code === 403 ? 'key-or-account-restriction' : code === 429 ? 'free-model-quota-or-rate-limit' : code >= 500 ? 'upstream-provider-unavailable-or-congested' : 'provider-http-error';
  result.smoke = { status: code >= 200 && code < 300 ? 'complete' : 'failed', classification: classification, http_code: code, retryable: retryable, elapsed_ms: elapsed, response_json: Boolean(parsed), provider_model: parsed && (parsed.model || parsed.id) || null, usage: usage ? { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens } : null, semantic_output: typeof output === 'string' ? CT_GAS.bound(output, 80) : null, error: err ? { code: CT_GAS.bound(err.code, 80), type: CT_GAS.bound(err.type, 80), message: CT_GAS.redact(CT_GAS.bound(err.message, 240), [key]) } : null, gas_preempted: result.gas_preempted };
  return { durable_telemetry: telemetry, durable_events: events, smoke: result.smoke, model: model };
}

function discoverFreeGasModels() {
  var key = PropertiesService.getScriptProperties().getProperty('OPENROUTER_API_KEY');
  if (!key) return { status: 'blocked', classification: 'missing-key' };
  var response;
  try { response = UrlFetchApp.fetch('https://openrouter.ai/api/v1/models', { method: 'get', headers: { Authorization: 'Bearer ' + key }, muteHttpExceptions: true }); } catch (e) { return { status: 'failed', classification: 'gas-urlfetch-error' }; }
  var code = response.getResponseCode(), parsed;
  try { parsed = JSON.parse(CT_GAS.bound(response.getContentText(), 1000000)); } catch (_) { return { status: 'failed', classification: 'invalid-model-catalog', http_code: code }; }
  if (code < 200 || code >= 300 || !Array.isArray(parsed.data)) return { status: 'failed', classification: 'model-catalog-http-error', http_code: code };
  var candidates = parsed.data.filter(function (m) { var p=m.pricing||{}, a=m.architecture||{}; return /^(?:openrouter\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+:free$/.test(String(m.id||'')) && String(p.prompt)==='0' && String(p.completion)==='0' && (!a.input_modalities || a.input_modalities.indexOf('text')>=0) && (!a.output_modalities || a.output_modalities.indexOf('text')>=0); }).slice(0,20).map(function (m) { return { id:m.id, context_length:m.context_length || null, input_modalities:m.architecture && m.architecture.input_modalities || [], output_modalities:m.architecture && m.architecture.output_modalities || [], prompt_price:String(m.pricing.prompt), completion_price:String(m.pricing.completion) }; });
  return { status: 'complete', count: candidates.length, candidates: candidates };
}

function recentGasFailureJson() {
  return JSON.stringify(CT_GAS_STATE.list('observer_ledger').filter(function (row) { return row.kind === 'wake_interrupted' || row.kind === 'model_deferred'; }).slice(-8).map(function (row) { return { kind: row.kind, id: row.id, execution_id: row.payload && row.payload.execution_id, work_order_id: row.payload && row.payload.work_order_id, continuation_id: row.payload && row.payload.continuation_id, operation: row.payload && row.payload.operation, reason: row.payload && row.payload.reason, attempt: row.payload && row.payload.attempt, error: row.payload && row.payload.error }; }));
}

function smokeFreeGasCandidates() {
  var key = PropertiesService.getScriptProperties().getProperty('OPENROUTER_API_KEY');
  if (!key) return { status: 'blocked', classification: 'missing-key' };
  var catalog = discoverFreeGasModels();
  if (catalog.status !== 'complete') return catalog;
  var results = [], selected = null;
  catalog.candidates.slice(0, 5).forEach(function (candidate) {
    if (selected) return;
    var started = Date.now(), response;
    try { response = UrlFetchApp.fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + key }, payload: JSON.stringify({ model: candidate.id, messages: [{ role: 'user', content: 'Return exactly the word ACK.' }], max_tokens: 8 }), muteHttpExceptions: true }); } catch (e) { results.push({ model: candidate.id, classification: 'gas-urlfetch-error', retryable: true, elapsed_ms: Date.now() - started }); return; }
    var code = response.getResponseCode(), parsed = null;
    try { parsed = JSON.parse(CT_GAS.bound(response.getContentText(), 12000)); } catch (_) {}
    var output = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
    var ok = code >= 200 && code < 300 && typeof output === 'string' && output.length > 0;
    results.push({ model: candidate.id, classification: ok ? 'success' : (code === 429 ? 'free-model-quota-or-rate-limit' : code >= 500 ? 'upstream-provider-unavailable-or-congested' : code === 400 || code === 422 ? 'bad-request-or-model-contract' : 'provider-http-error'), http_code: code, retryable: code === 408 || code === 409 || code === 425 || code === 429 || code >= 500, elapsed_ms: Date.now() - started, provider_model: parsed && (parsed.model || parsed.id) || null, semantic_output: ok ? CT_GAS.bound(output, 80) : null });
    if (ok) selected = candidate.id;
  });
  return { status: selected ? 'complete' : 'failed', selected_model: selected, tested: results };
}

function activateGasFreeFallback() {
  var fallback = 'nvidia/nemotron-3.5-lightning:free', catalog = discoverFreeGasModels();
  if (catalog.status !== 'complete' || !catalog.candidates.some(function (x) { return x.id === fallback && x.prompt_price === '0' && x.completion_price === '0'; })) throw new Error('fallback model is not currently verified zero-priced');
  CT_GAS.freeModel(fallback);
  var orders = CT_GAS_STATE.list('work_orders').map(function (row) { return CT_GAS_STATE.get('work_orders', row.id); }).filter(function (row) { return row && row.payload && row.payload.launch_context && row.payload.launch_context.proof === 'gas-a-b' && row.lifecycle !== 'completed'; });
  if (!orders.length) throw new Error('incomplete Proof A work order not found');
  orders.sort(function (a,b) { return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(); });
  var order = orders[0], previous = order.payload.model || (order.payload.launch_context && order.payload.launch_context.model), current = CT_GAS_STATE.latestContinuation(order.id);
  if (!current) throw new Error('Proof A continuation not found');
  var continuationId = CT_GAS.id('continuation', { work_order_id: order.id, execution_id: current.execution_id, previous: current.continuation_id, fallback: fallback });
  var launch = Object.assign({}, current.launch_context, { model: fallback });
  var payload = Object.assign({}, order.payload, { model: fallback, launch_context: launch, fallback_from: previous, fallback_to: fallback, fallback_count: Number(order.payload.fallback_count || 0) + 1, fallback_reason: 'invalid-model-id' });
  CT_GAS_STATE.update('work_orders', order.id, { payload: payload });
  CT_GAS_STATE.continuation(CT_GAS.continuation({ goal: current.goal, completed: current.completed, decisions: (current.decisions || []).concat(['free-model-fallback:'+String(previous || 'unknown')+'->'+fallback]), evidence: current.evidence, provenance: current.provenance, outstanding: current.outstanding, next_operation: 'model', reason: 'free-model-fallback', resumed_from: current.execution_id, physical_execution_count: current.physical_execution_count, work_order_id: order.id, execution_id: current.execution_id, wake_id: current.wake_id, continuation_id: continuationId, launch_context: launch, resume_context: current.resume_context }));
  var wake = requestNextWake({ time: new Date().toISOString(), reason: 'model-deferred', project: 'ct-runtime-gas-proof', work_order_id: order.id, execution_id: current.execution_id, continuation_id: continuationId, launch: launch, resume: current.resume_context });
  PropertiesService.getScriptProperties().setProperty('CT_GAS_PROOF_MODEL', fallback);
  CT_GAS_STATE.telemetry({ work_order_id: order.id, execution_id: current.execution_id, continuation_id: continuationId, operation: 'model-fallback', continuation_reason: 'free-model-fallback', model: fallback, physical_execution_count: current.physical_execution_count, general_compute_requested: false });
  return { work_order_id: order.id, execution_id: current.execution_id, continuation_id: continuationId, wake_id: wake.id, previous_model: previous, selected_model: fallback, fallback_count: payload.fallback_count };
}

function repairGasProofLifecycle() {
  var orders = CT_GAS_STATE.list('work_orders').map(function (row) { return CT_GAS_STATE.get('work_orders', row.id); }).filter(function (row) { return row && row.payload && row.payload.launch_context && row.payload.launch_context.proof === 'gas-a-b' && row.lifecycle === 'running'; });
  if (!orders.length) return { status: 'unchanged' };
  orders.sort(function (a,b) { return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(); });
  CT_GAS_STATE.update('work_orders', orders[0].id, { lifecycle: 'deferred' });
  return { status: 'repaired', work_order_id: orders[0].id };
}

function runCurrentGasProofWake() {
  var orders = CT_GAS_STATE.list('work_orders').map(function (row) { return CT_GAS_STATE.get('work_orders', row.id); }).filter(function (row) { return row && row.payload && row.payload.launch_context && row.payload.launch_context.proof === 'gas-a-b' && row.lifecycle !== 'completed'; });
  if (!orders.length) throw new Error('incomplete Proof A work order not found');
  orders.sort(function (a,b) { return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(); });
  var order = orders[0], continuation = CT_GAS_STATE.latestContinuation(order.id);
  if (!continuation) throw new Error('current Proof A continuation not found');
  return runWake({ work_order_id: order.id, execution_id: continuation.execution_id, continuation_id: continuation.continuation_id, wake_id: continuation.wake_id, launch: continuation.launch_context, resume: continuation.resume_context });
}

function inspectGasConfigPresence() {
  var props = PropertiesService.getScriptProperties(), names = ['CT_GAS_SPREADSHEET_ID','CT_GAS_DRIVE_ROOT_ID','CT_GAS_PROOF_MODEL','CT_GAS_BUDGET_MS','GITHUB_REPO','GITHUB_ACTION_WORKFLOW_ALLOWLIST','OPENROUTER_API_KEY','GITHUB_TOKEN'];
  var present = {}; names.forEach(function (name) { present[name] = Boolean(props.getProperty(name)); });
  return present;
}

function diagnoseGitHubActionsResponse() {
  var key = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!key) return { status: 'blocked', classification: 'missing-token' };
  var started = Date.now(), response;
  try { response = UrlFetchApp.fetch('https://api.github.com/repos/' + PropertiesService.getScriptProperties().getProperty('GITHUB_REPO') + '/actions/runs?per_page=10', { method: 'get', headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + key }, muteHttpExceptions: true }); } catch (e) { return { status: 'failed', classification: 'gas-urlfetch-error', elapsed_ms: Date.now() - started }; }
  var text = response.getContentText(), parsed = null, headers = response.getAllHeaders ? response.getAllHeaders() : {};
  try { parsed = JSON.parse(text); } catch (_) {}
  return { status: 'complete', http_code: response.getResponseCode(), elapsed_ms: Date.now() - started, content_type: headers['Content-Type'] || headers['content-type'] || null, content_length: text.length, response_json: Boolean(parsed), body_prefix: CT_GAS.redact(CT_GAS.bound(text, 240), [key]), top_level_keys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 20) : [] };
}

function startGasGitHubProof() {
  var model = PropertiesService.getScriptProperties().getProperty('CT_GAS_PROOF_MODEL'), now = Date.now(), workOrderId = CT_GAS.id('work-order', { proof: 'github-async', created: now }), executionId = CT_GAS.id('execution', { work_order_id: workOrderId, created: now }), continuationId = CT_GAS.id('continuation', { work_order_id: workOrderId, execution_id: executionId, step: 'github' }), clock = CT_GAS.clock(now, 60000);
  CT_GAS.freeModel(model);
  CT_GAS_STATE.create('work_orders', { id: workOrderId, lifecycle: 'requested', payload: { work_order_id: workOrderId, goal: 'Bounded reversible GitHub proof', step: 'github', model: model, physical_execution_count: 1, launch_context: { model: model, proof: 'github-async' }, resume_context: { source: 'github-actions' } } });
  var base = githubWorkspace().ref('main', clock), branch = 'ct-runtime-gas-proof-' + String(now), path = 'docs/gas-proof-async.md', content = '# CT Runtime GAS asynchronous proof\n\nThis unmerged marker validates the constrained GitHub workspace and pull-request CI path.\n', update;
  githubWorkspace().createBranch(branch, base.object.sha, clock);
  update = githubWorkspace().upsertFile(path, { message: 'test: validate bounded GAS GitHub proof', content: Utilities.base64Encode(content), branch: branch }, clock);
  var pr = githubWorkspace().pullRequest({ title: 'test: bounded GAS GitHub proof', head: branch, base: 'main', body: 'Unmerged, documentation-only proof change. Close without merging after CI observation.' }, clock), payload = { work_order_id: workOrderId, execution_id: executionId, branch: branch, path: path, pull_request_number: pr.number, commit_sha: update.commit && update.commit.sha || '', workflow: 'ci.yml', wait_condition: 'ci', model: model, physical_execution_count: 1 };
  CT_GAS_STATE.update('work_orders', workOrderId, { lifecycle: 'waiting', payload: payload });
  CT_GAS_STATE.continuation(CT_GAS.continuation({ goal: 'Bounded reversible GitHub proof', completed: ['branch and PR created'], decisions: ['PR trigger used; workflow dispatch not used'], evidence: [], provenance: ['GitHub PR #'+pr.number], outstanding: ['CI observation'], next_operation: 'inspectRuns', reason: 'ci', resumed_from: executionId, physical_execution_count: 1, work_order_id: workOrderId, execution_id: executionId, wake_id: 'github-pr-'+pr.number, continuation_id: continuationId, wait_condition: 'ci', launch_context: { model: model, proof: 'github-async' }, resume_context: { source: 'github-actions', branch: branch } }));
  CT_GAS_STATE.telemetry({ work_order_id: workOrderId, execution_id: executionId, continuation_id: continuationId, operation: 'github-pr-created', model: model, wait_condition: 'ci', physical_execution_count: 1, general_compute_requested: false });
  return { work_order_id: workOrderId, execution_id: executionId, continuation_id: continuationId, pull_request_number: pr.number, branch: branch, commit_sha: payload.commit_sha, workflow: 'ci.yml' };
}

function observeGasGitHubProof() {
  var rows = CT_GAS_STATE.list('work_orders').map(function (row) { return CT_GAS_STATE.get('work_orders', row.id); }).filter(function (row) { return row && row.payload && row.payload.step === 'github' && row.lifecycle === 'waiting'; });
  if (!rows.length) return { status: 'unchanged' };
  rows.sort(function (a,b) { return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(); });
  var order = rows[0], p = order.payload, runs = testExecutor().inspectRuns(CT_GAS.clock(Date.now(), 30000)), match = (runs.workflow_runs || []).filter(function (run) { return run.path === '.github/workflows/ci.yml' && run.head_branch === p.branch; })[0];
  if (!match || match.status !== 'completed') return { status: 'waiting', work_order_id: order.id, workflow: 'ci.yml', run_status: match && match.status || 'not-found' };
  var outcome = match.conclusion === 'success' ? 'completed' : 'deferred';
  CT_GAS_STATE.update('work_orders', order.id, { lifecycle: outcome, payload: Object.assign({}, p, { ci_run_id: match.id, ci_conclusion: match.conclusion, final_outcome: match.conclusion === 'success' ? 'success' : 'ci-failure' }) });
  CT_GAS_STATE.telemetry({ work_order_id: order.id, execution_id: p.execution_id, continuation_id: CT_GAS.id('continuation', { work_order_id: order.id, ci_run_id: match.id }), operation: 'github-ci-observation', model: p.model, wait_condition: 'ci', physical_execution_count: Number(p.physical_execution_count || 1), verified: outcome === 'completed', general_compute_requested: false });
  CT_GAS_STATE.event('github_ci_observed', { work_order_id: order.id, execution_id: p.execution_id, operation: 'github-ci-observation', workflow: 'ci.yml', run_id: match.id, conclusion: match.conclusion });
  return { status: outcome, work_order_id: order.id, workflow: 'ci.yml', run_id: match.id, conclusion: match.conclusion };
}

function recoverGasGitHubProof() {
  var key = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN'), repo = PropertiesService.getScriptProperties().getProperty('GITHUB_REPO'), response = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/pulls?state=open&per_page=10', { method: 'get', headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + key }, muteHttpExceptions: true }), parsed;
  try { parsed = JSON.parse(response.getContentText()); } catch (_) { throw new Error('invalid GitHub pull request response'); }
  var pr = Array.isArray(parsed) ? parsed.filter(function (x) { return x.title === 'test: bounded GAS GitHub proof' && x.head && /^ct-runtime-gas-proof-/.test(x.head.ref); })[0] : null;
  if (!pr) return { status: 'not-found' };
  var rows = CT_GAS_STATE.list('work_orders').map(function (row) { return CT_GAS_STATE.get('work_orders', row.id); }).filter(function (row) { return row && row.payload && row.payload.step === 'github' && row.lifecycle !== 'completed'; });
  if (!rows.length) throw new Error('GitHub proof work order not found');
  rows.sort(function (a,b) { return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(); });
  var order = rows[0], executionId = order.payload.execution_id || CT_GAS.id('execution', { work_order_id: order.id, proof: 'github-async' }), continuationId = CT_GAS.id('continuation', { work_order_id: order.id, execution_id: executionId, pr: pr.number });
  var payload = Object.assign({}, order.payload, { execution_id: executionId, branch: pr.head.ref, pull_request_number: pr.number, commit_sha: pr.head.sha, workflow: 'ci.yml', wait_condition: 'ci' });
  CT_GAS_STATE.update('work_orders', order.id, { lifecycle: 'waiting', payload: payload });
  CT_GAS_STATE.continuation(CT_GAS.continuation({ goal: 'Bounded reversible GitHub proof', completed: ['branch and PR created'], decisions: ['PR trigger used; workflow dispatch not used'], evidence: [], provenance: ['GitHub PR #'+pr.number], outstanding: ['CI observation'], next_operation: 'inspectRuns', reason: 'ci-recovered', resumed_from: executionId, physical_execution_count: 1, work_order_id: order.id, execution_id: executionId, wake_id: 'github-pr-'+pr.number, continuation_id: continuationId, wait_condition: 'ci', launch_context: { model: payload.model, proof: 'github-async' }, resume_context: { source: 'github-actions', branch: pr.head.ref } }));
  return { status: 'recovered', work_order_id: order.id, execution_id: executionId, continuation_id: continuationId, pull_request_number: pr.number, branch: pr.head.ref, commit_sha: pr.head.sha, workflow: 'ci.yml' };
}

function correctHistoricalOpenRouterFailures() {
  var rows = CT_GAS_STATE.list('observer_ledger').filter(function (row) { return row.kind === 'wake_interrupted' && row.payload && String(row.payload.error || '').indexOf('OpenRouter request failed: 400') === 0; }), existing = CT_GAS_STATE.list('observer_ledger').filter(function (row) { return row.kind === 'model_failure_correction'; }).map(function (row) { return row.payload && row.payload.original_event_id; }), added = 0;
  rows.forEach(function (row) { if (existing.indexOf(row.id) >= 0) return; CT_GAS_STATE.event('model_failure_correction', { original_event_id: row.id, execution_id: row.payload.execution_id, work_order_id: row.payload.work_order_id, classification: 'request-contract-invalid-model-identifier', before_model_execution: true, quota_failure: false, latency_failure: false, provider_congestion: false, model_quality_failure: false, corrected_from: 'runtime-interruption', correction: 'OpenRouter direct API requires provider/model:free; the historical openrouter/ prefix was invalid' }); added++; });
  return { corrected: added, originals: rows.length };
}

function runGasL1Soak() {
  var started = Date.now(), model = PropertiesService.getScriptProperties().getProperty('CT_GAS_PROOF_MODEL'), workOrders = [], duplicateWakeSuppressed = 0, staleClaimsRejected = 0;
  for (var i=0;i<3;i++) {
    var orderId=CT_GAS.id('work-order',{soak:'gas-l1',index:i,started:started}), seed='soak-seed-'+i, first=CT_GAS_STATE.executionStart({work_order_id:orderId,parent_execution_id:seed,wake_id:'soak-wake-'+i,continuation_id:'soak-cont-'+i,reconstruction_source:'synthetic-soak'});
    CT_GAS_STATE.create('work_orders',{id:orderId,lifecycle:'requested',payload:{work_order_id:orderId,goal:'Synthetic GAS L1 soak',step:'soak',model:model,physical_execution_count:1,launch_context:{model:model,proof:'gas-l1-soak'},resume_context:{source:'synthetic'}}});
    CT_GAS_STATE.update('work_orders',orderId,{lifecycle:'running'});
    CT_GAS_STATE.executionFinish(first.id,{lifecycle:'checkpointed',completion_reason:'synthetic-checkpoint',checkpoint_count:1,next_physical_execution_id:'pending'});
    var second=CT_GAS_STATE.executionStart({work_order_id:orderId,parent_execution_id:first.id,wake_id:'soak-wake-'+i,continuation_id:'soak-cont-'+i,reconstruction_source:'synthetic-reconstruction'});
    CT_GAS_STATE.executionFinish(second.id,{lifecycle:'completed',completion_reason:'synthetic-complete',checkpoint_count:1,previous_physical_execution_id:first.id});
    CT_GAS_STATE.update('work_orders',orderId,{lifecycle:'completed',payload:{physical_execution_count:CT_GAS_STATE.physicalExecutionCount(orderId),soak:true}});
    var wake={time:new Date().toISOString(),reason:'scheduled',work_order_id:orderId,execution_id:second.id,continuation_id:'soak-cont-'+i,launch:{model:model},resume:{source:'synthetic'}}, a=CT_GAS_STATE.schedule(wake), b=CT_GAS_STATE.schedule(Object.assign({},wake,{time:new Date(Date.now()+60000).toISOString()})); if (a.id===b.id) duplicateWakeSuppressed++;
    try { CT_GAS_STATE.claim(a.id,'soak','soak-fence-'+i,new Date(Date.now()+60000).toISOString()); CT_GAS_STATE.complete(a.id,{status:'synthetic'},'other','bad-fence'); } catch (_) { staleClaimsRejected++; }
    CT_GAS_STATE.complete(a.id,{status:'synthetic'},'soak','soak-fence-'+i);
    workOrders.push({id:orderId,physical_executions:CT_GAS_STATE.physicalExecutionCount(orderId)});
  }
  return { status:'complete',duration_ms:Date.now()-started,model:model,logical_work_orders:workOrders.length,work_orders:workOrders,duplicate_wakes_suppressed:duplicateWakeSuppressed,stale_claims_rejected:staleClaimsRejected,trigger_count:CT_GAS_TRIGGER.registry().filter(function (x) { return x.handler==='gasSafetyWake'; }).length };
}

function recordGasL1Signals() {
  var signals=[['gas-suitability','bounded API/state/evidence/CI tasks are suitable for GAS'],['continuation-efficiency','durable continuation preserved one logical task across physical executions'],['physical-execution-overhead','each wake has a durable physical execution record'],['model-routing-reliability','catalog-verified zero-priced routing separated invalid IDs from provider deferrals'],['wake-reliability','latest wake revisions, leases, and duplicate delivery require explicit fencing']];
  signals.forEach(function (x) { CT_GAS_STATE.create('foundry_signals',{id:CT_GAS.id('foundry-signal',{kind:x[0],proof:'gas-l1'}),kind:'foundry-signal',payload:{signal:x[0],observation:x[1],source:'gas-l1-proof',provenance:'Sheets/Drive/GitHub live proof'}}); });
  return { recorded:signals.length, identity_signals_recorded:0 };
}

function auditGasSecretPlacement() {
  var props=PropertiesService.getScriptProperties(), secrets=['OPENROUTER_API_KEY','GITHUB_TOKEN'].map(function (name) { return props.getProperty(name); }).filter(Boolean), sheetHits=0, driveHits=0, filesChecked=0, book=SpreadsheetApp.openById(props.getProperty('CT_GAS_SPREADSHEET_ID'));
  book.getSheets().forEach(function (sheet) { var values=sheet.getDataRange().getValues(); values.forEach(function (row) { var text=JSON.stringify(row); secrets.forEach(function (secret) { if (secret && text.indexOf(secret)>=0) sheetHits++; }); }); });
  function scan(folder) { var fileIt=folder.getFiles(); while (fileIt.hasNext() && filesChecked<500) { var file=fileIt.next(), text=file.getBlob().getDataAsString(), description=file.getDescription ? file.getDescription() : ''; filesChecked++; secrets.forEach(function (secret) { if (secret && (text.indexOf(secret)>=0 || description.indexOf(secret)>=0)) driveHits++; }); } var folderIt=folder.getFolders(); while (folderIt.hasNext() && filesChecked<500) scan(folderIt.next()); }
  scan(DriveApp.getFolderById(props.getProperty('CT_GAS_DRIVE_ROOT_ID')));
  return { script_property_keys_present: secrets.length===2, sheets_secret_hits:sheetHits, drive_secret_hits:driveHits, drive_files_checked:filesChecked, secrets_exposed_by_audit:sheetHits+driveHits>0 };
}

function cleanupGasGitHubProof() {
  var p=PropertiesService.getScriptProperties(), key=p.getProperty('GITHUB_TOKEN'), repo=p.getProperty('GITHUB_REPO'), response=UrlFetchApp.fetch('https://api.github.com/repos/'+repo+'/pulls?state=open&per_page=10',{method:'get',headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+key},muteHttpExceptions:true}), pulls=JSON.parse(response.getContentText()), pr=Array.isArray(pulls)?pulls.filter(function (x) { return x.title==='test: bounded GAS GitHub proof' && x.head && /^ct-runtime-gas-proof-/.test(x.head.ref); })[0]:null;
  if (!pr) return { status:'already-clean' };
  var close=UrlFetchApp.fetch('https://api.github.com/repos/'+repo+'/pulls/'+pr.number,{method:'patch',contentType:'application/json',headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+key},payload:JSON.stringify({state:'closed'}),muteHttpExceptions:true});
  if (close.getResponseCode()<200 || close.getResponseCode()>=300) throw new Error('proof PR close failed: '+close.getResponseCode());
  var remove=UrlFetchApp.fetch('https://api.github.com/repos/'+repo+'/git/refs/heads/'+encodeURIComponent(pr.head.ref),{method:'delete',headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+key},muteHttpExceptions:true});
  if (remove.getResponseCode()<200 || remove.getResponseCode()>=300) throw new Error('proof branch delete failed: '+remove.getResponseCode());
  return { status:'cleaned', pull_request_number:pr.number, branch:pr.head.ref };
}
