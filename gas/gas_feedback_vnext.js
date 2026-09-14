/* vNext Feedback receipt adapter. Sheet mechanics stop at external_input.received. */
var CT_GAS_FEEDBACK_VNEXT = (function () {
  var ID_KEY = 'CT_FEEDBACK_ID';
  var REV_KEY = 'CT_FEEDBACK_REVISION';
  var HASH_KEY = 'CT_FEEDBACK_STATE_HASH';
  var ADAPTER_ID = 'google-sheets-feedback';

  function metadata(row) {
    var found = row.getDeveloperMetadata ? row.getDeveloperMetadata() : [];
    var out = {};
    found.forEach(function (m) {
      var key = String(m.getKey ? m.getKey() : '');
      if (key === ID_KEY || key === REV_KEY || key === HASH_KEY) out[key] = String(m.getValue ? m.getValue() : '');
    });
    return out;
  }

  function putMetadata(row, key, value) {
    row.addDeveloperMetadata(key, String(value), SpreadsheetApp.DeveloperMetadataVisibility.PROJECT);
  }

  function replaceMetadata(row, key, value) {
    var found = row.getDeveloperMetadata ? row.getDeveloperMetadata() : [];
    found.forEach(function (m) {
      if (String(m.getKey ? m.getKey() : '') === key && m.remove) m.remove();
    });
    putMetadata(row, key, value);
  }

  function sourceState(item) {
    return {
      project: CT_GAS.bound(item.project, 100),
      message: CT_GAS.bound(item.message, CT_GAS.MAX_MESSAGE),
      reply: CT_GAS.bound(item.reply, CT_GAS.MAX_MESSAGE)
    };
  }

  function stateHash(item) { return CT_GAS.sha256(CT_GAS.json(sourceState(item))); }

  function sourceReference(spreadsheetId, sheetName, feedbackId) {
    return 'google-sheets://' + encodeURIComponent(spreadsheetId) + '/' + encodeURIComponent(sheetName) + '/feedback/' + encodeURIComponent(feedbackId);
  }

  function sourceRevision(row, item) {
    var meta = metadata(row);
    var hasId = Object.prototype.hasOwnProperty.call(meta, ID_KEY);
    var hasRev = Object.prototype.hasOwnProperty.call(meta, REV_KEY);
    var hasHash = Object.prototype.hasOwnProperty.call(meta, HASH_KEY);
    if (!hasId && !hasRev && !hasHash) return { fresh: true, feedback_id: Utilities.getUuid(), source_revision: 1, state_hash: stateHash(item) };
    if (!hasId || !hasRev || !hasHash) throw new Error('feedback adapter state is incomplete on row ' + item.row);
    if (!meta[ID_KEY] || !/^\d+$/.test(meta[REV_KEY]) || !meta[HASH_KEY]) throw new Error('feedback adapter state is malformed on row ' + item.row);
    var nextHash = stateHash(item), revision = Number(meta[REV_KEY]);
    if (revision < 1) throw new Error('feedback adapter revision is invalid on row ' + item.row);
    return { fresh: false, feedback_id: meta[ID_KEY], source_revision: meta[HASH_KEY] === nextHash ? revision : revision + 1, state_hash: nextHash, changed: meta[HASH_KEY] !== nextHash };
  }

  function duplicateIdentity(rows, feedbackId, currentRow) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].row === currentRow) continue;
      var id = metadata(rows[i]._range)[ID_KEY];
      if (id && id === feedbackId) throw new Error('feedback identity conflict: ' + feedbackId + ' appears on rows ' + currentRow + ' and ' + rows[i].row);
    }
  }

  function ingest(clock, bundle, appendEvent) {
    if (typeof appendEvent !== 'function') throw new Error('appendEvent sink is required');
    var rows = (bundle && bundle.rows) || [], out = [], lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) throw new Error('feedback adapter lock unavailable');
    try {
      var s = SpreadsheetApp.openById(bundle.spreadsheet_id), sh = s.getSheetByName(bundle.sheet_name);
      if (!sh) throw new Error('feedback sheet not found: ' + bundle.sheet_name);
      rows.filter(function (x) { return CT_GAS.bound(x.message, CT_GAS.MAX_MESSAGE) || CT_GAS.bound(x.reply, CT_GAS.MAX_MESSAGE); }).slice(0, 12).forEach(function (item) {
        if (clock && !clock.canStart(CT_GAS.OPERATION_BUDGETS.stateWrite)) return;
        var row = sh.getRange(Number(item.row), 1, 1, 8), identity = sourceRevision(row, item);
        var allRows = rows.map(function (x) { var copy = Object.assign({}, x); copy._range = sh.getRange(Number(x.row), 1, 1, 8); return copy; });
        duplicateIdentity(allRows, identity.feedback_id, Number(item.row));
        var event = {
          type: 'external_input.received',
          event_id: 'human-feedback:' + identity.feedback_id + ':' + identity.source_revision,
          feedback_id: identity.feedback_id,
          adapter_id: ADAPTER_ID,
          source_reference: sourceReference(bundle.spreadsheet_id, bundle.sheet_name, identity.feedback_id),
          source_revision: identity.source_revision,
          message: CT_GAS.bound(item.message || item.reply, CT_GAS.MAX_MESSAGE),
          actor: 'human',
          source_timestamp: null,
          thread_reference: CT_GAS.bound(item.thread, 160) || null,
          metadata: { project: CT_GAS.bound(item.project, 100) }
        };
        appendEvent(event);
        if (identity.fresh) {
          putMetadata(row, ID_KEY, identity.feedback_id);
          putMetadata(row, REV_KEY, identity.source_revision);
          putMetadata(row, HASH_KEY, identity.state_hash);
        } else if (identity.changed) {
          replaceMetadata(row, REV_KEY, identity.source_revision);
          replaceMetadata(row, HASH_KEY, identity.state_hash);
        }
        out.push({ row: Number(item.row), feedback_id: identity.feedback_id, source_revision: identity.source_revision, event_id: event.event_id });
      });
      return out;
    } finally { lock.releaseLock(); }
  }

  return { ingest: ingest, metadata: metadata, stateHash: stateHash };
}());
