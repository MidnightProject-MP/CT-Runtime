/* vNext FeedbackEvaluation -> human Feedback Sheet projection. This adapter only communicates durable judgment. */
var CT_GAS_FEEDBACK_VNEXT_PROJECTION = (function () {
  var ID_KEY = 'CT_FEEDBACK_ID';
  var REV_KEY = 'CT_FEEDBACK_REVISION';
  var PROJECTION_KEY = 'CT_FEEDBACK_PROJECTION_ID';
  var EVALUATION_KEY = 'CT_FEEDBACK_PROJECTION_EVALUATION';
  var HASH_KEY = 'CT_FEEDBACK_PROJECTION_HASH';
  var ADAPTER_ID = 'google-sheets-feedback';
  var HEADERS = ['Project (optional)','Message / objective','Status','Celestan update / question','Your reply','Last activity','Thread ID','Reply revision'];
  var STATUS = {
    acknowledged: 'Acknowledged',
    informational: 'Informational',
    needs_follow_up: 'Needs follow-up',
    suggests_new_work: 'New work suggested',
    relates_to_existing_work: 'Related to existing work',
    question_answered: 'Answered',
    no_action: 'No action'
  };

  function text(value, max) {
    var out = String(value == null ? '' : value);
    if (out.indexOf('\0') >= 0 || /[\r\n]/.test(out)) throw new Error('projection text contains forbidden characters');
    out = out.trim();
    return out.length > (max || 4000) ? out.slice(0, max || 4000) : out;
  }

  function metadata(row) {
    var found = row.getDeveloperMetadata ? row.getDeveloperMetadata() : [], out = {};
    found.forEach(function (m) {
      var key = String(m.getKey ? m.getKey() : '');
      if ([ID_KEY, REV_KEY, PROJECTION_KEY, EVALUATION_KEY, HASH_KEY].indexOf(key) >= 0) out[key] = String(m.getValue ? m.getValue() : '');
    });
    return out;
  }

  function replaceMetadata(row, key, value) {
    var found = row.getDeveloperMetadata ? row.getDeveloperMetadata() : [];
    found.forEach(function (m) {
      if (String(m.getKey ? m.getKey() : '') === key && m.remove) m.remove();
    });
    row.addDeveloperMetadata(key, String(value), SpreadsheetApp.DeveloperMetadataVisibility.PROJECT);
  }

  function projectionId(evaluationId) {
    if (typeof evaluationId !== 'string' || !evaluationId.trim()) throw new Error('evaluation_id is required');
    return 'feedback-projection:' + evaluationId;
  }

  function statusFor(disposition) {
    if (!Object.prototype.hasOwnProperty.call(STATUS, disposition)) throw new Error('invalid feedback evaluation disposition');
    return STATUS[disposition];
  }

  function sourceReference(spreadsheetId, sheetName, feedbackId) {
    return 'google-sheets://' + encodeURIComponent(spreadsheetId) + '/' + encodeURIComponent(sheetName) + '/feedback/' + encodeURIComponent(feedbackId);
  }

  function canonicalProjection(evaluation, status) {
    return {
      projection_id: projectionId(evaluation.evaluation_id),
      evaluation_id: evaluation.evaluation_id,
      feedback_id: evaluation.feedback_id,
      source_revision: evaluation.source_revision,
      receipt_event_id: evaluation.receipt_event_id,
      source_reference: evaluation.source_reference,
      status: status,
      response: evaluation.response == null ? '' : text(evaluation.response, 4000),
      adapter_id: ADAPTER_ID
    };
  }

  function validateEvaluation(evaluation) {
    if (!evaluation || typeof evaluation !== 'object') throw new Error('FeedbackEvaluation is required');
    if (typeof evaluation.evaluation_id !== 'string' || !evaluation.evaluation_id.trim()) throw new Error('evaluation_id is required');
    if (typeof evaluation.feedback_id !== 'string' || !evaluation.feedback_id.trim()) throw new Error('feedback_id is required');
    var revision = Number(evaluation.source_revision);
    if (!Number.isInteger(revision) || revision < 1) throw new Error('source_revision must be a positive integer');
    if (evaluation.evaluation_id !== 'feedback-evaluation:' + evaluation.feedback_id + ':' + revision) throw new Error('evaluation identity is invalid');
    if (evaluation.receipt_event_id !== 'human-feedback:' + evaluation.feedback_id + ':' + revision) throw new Error('receipt event identity is invalid');
    if (typeof evaluation.disposition !== 'string' || !Object.prototype.hasOwnProperty.call(STATUS, evaluation.disposition)) throw new Error('invalid feedback evaluation disposition');
    if (typeof evaluation.summary !== 'string' || !evaluation.summary.trim()) throw new Error('evaluation summary is required');
    return Object.assign({}, evaluation, { source_revision: revision });
  }

  function rowMatchesEvaluation(row, evaluation) {
    var meta = metadata(row);
    if (meta[ID_KEY] !== evaluation.feedback_id) return false;
    if (meta[REV_KEY] !== String(evaluation.source_revision)) throw new Error('feedback source revision changed; projection refused');
    return true;
  }

  function locate(sheet, evaluation) {
    var last = sheet.getLastRow();
    if (last < 5) throw new Error('feedback source row not found: ' + evaluation.feedback_id);
    var found = [], duplicate = false;
    for (var rowNumber = 5; rowNumber <= last; rowNumber++) {
      var row = sheet.getRange(rowNumber, 1, 1, 8), meta = metadata(row);
      if (meta[ID_KEY] !== evaluation.feedback_id) continue;
      if (found.length) duplicate = true;
      found.push({ rowNumber: rowNumber, range: row, metadata: meta });
    }
    if (!found.length) throw new Error('feedback source row not found: ' + evaluation.feedback_id);
    if (duplicate) throw new Error('feedback source identity conflict: ' + evaluation.feedback_id + ' appears on multiple rows');
    rowMatchesEvaluation(found[0].range, evaluation);
    return found[0];
  }

  function sheetFrom(spreadsheetId, sheetName) {
    if (typeof spreadsheetId !== 'string' || !spreadsheetId.trim()) throw new Error('feedback spreadsheet ID is required');
    var name = text(sheetName || 'Feedback', 200), book = SpreadsheetApp.openById(spreadsheetId), sheet = book.getSheetByName(name);
    if (!sheet) throw new Error('feedback sheet not found: ' + name);
    var header = sheet.getRange(4, 1, 1, 8).getValues()[0];
    for (var i = 0; i < HEADERS.length; i++) if (String(header[i] == null ? '' : header[i]).trim() !== HEADERS[i]) throw new Error('feedback header contract invalid');
    return sheet;
  }

  function project(spreadsheetId, sheetName, evaluation) {
    var value = validateEvaluation(evaluation), status = statusFor(value.disposition), projection = canonicalProjection(value, status);
    projection.source_reference = sourceReference(spreadsheetId, sheetName || 'Feedback', value.feedback_id);
    var digest = CT_GAS.sha256(CT_GAS.json(projection)), lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) throw new Error('feedback projection lock unavailable');
    try {
      var sheet = sheetFrom(spreadsheetId, sheetName), target = locate(sheet, value), meta = metadata(target.range), current = target.range.getValues()[0], currentStatus = String(current[2] == null ? '' : current[2]), currentResponse = String(current[3] == null ? '' : current[3]);
      if (meta[PROJECTION_KEY]) {
        if (meta[PROJECTION_KEY] !== projection.projection_id || meta[EVALUATION_KEY] !== value.evaluation_id || meta[HASH_KEY] !== digest) throw new Error('feedback projection identity conflict: ' + value.evaluation_id);
        if (currentStatus !== status || currentResponse !== projection.response) throw new Error('feedback projection state conflict: ' + value.evaluation_id);
        return { status: 'existing', projection_id: projection.projection_id, row: target.rowNumber, evaluation_id: value.evaluation_id };
      }
      if (currentStatus && currentStatus !== status) throw new Error('feedback projection target already has conflicting status: ' + value.feedback_id);
      if (currentResponse && currentResponse !== projection.response) throw new Error('feedback projection target already has conflicting response: ' + value.feedback_id);
      target.range.getSheet().getRange(target.rowNumber, 3, 1, 2).setValues([[status, projection.response]]);
      replaceMetadata(target.range, PROJECTION_KEY, projection.projection_id);
      replaceMetadata(target.range, EVALUATION_KEY, value.evaluation_id);
      replaceMetadata(target.range, HASH_KEY, digest);
      return { status: 'created', projection_id: projection.projection_id, row: target.rowNumber, evaluation_id: value.evaluation_id };
    } finally { lock.releaseLock(); }
  }

  return { project: project, projectionId: projectionId, statusFor: statusFor, canonicalProjection: canonicalProjection };
}());

function projectFeedbackEvaluationResponse(spreadsheetId, sheetName, evaluation) {
  return CT_GAS_FEEDBACK_VNEXT_PROJECTION.project(spreadsheetId, sheetName, evaluation);
}
