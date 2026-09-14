/* Production A2 seam: Feedback sheet adapter -> authenticated Neon Data API -> immutable event RPC. */
var CT_GAS_FEEDBACK_VNEXT_TRANSPORT = (function () {
  var HEADERS = ['Project (optional)','Message / objective','Status','Celestan update / question','Your reply','Last activity','Thread ID','Reply revision'];

  function text(value, max) { return String(value == null ? '' : value).trim().slice(0, max || 4000); }
  function norm(value) { return text(value).toLowerCase().replace(/\s+/g, ' '); }
  function isHeader(cells) {
    if (!cells || cells.length < HEADERS.length) return false;
    for (var i = 0; i < HEADERS.length; i++) if (norm(cells[i]) !== norm(HEADERS[i])) return false;
    return true;
  }
  function rows(spreadsheetId, sheetName) {
    var sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName(sheetName);
    if (!sheet) throw new Error('Configured feedback sheet not found: ' + sheetName);
    var last = sheet.getLastRow(), found = [];
    if (last < 4) return { header: 0, rows: [] };
    var header = 0;
    for (var r = 1; r <= Math.min(last, 10); r++) if (isHeader(sheet.getRange(r, 1, 1, 8).getValues()[0])) { header = r; break; }
    if (header !== 4 || last < 5) return { header: header, rows: [] };
    var values = sheet.getRange(5, 1, last - 4, 8).getValues();
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (isHeader(v)) continue;
      found.push({ row: 5 + i, project: text(v[0], 100), message: text(v[1], CT_GAS.MAX_MESSAGE), reply: text(v[4], CT_GAS.MAX_MESSAGE), thread: text(v[6], 160) });
    }
    return { header: header, rows: found };
  }

  function ingest(clock, bundle) {
    if (typeof CT_GAS_FEEDBACK_VNEXT === 'undefined') throw new Error('vNext feedback adapter is required');
    if (typeof CT_GAS_VNEXT_EVENTS === 'undefined') throw new Error('vNext event transport is required');
    return CT_GAS_FEEDBACK_VNEXT.ingest(clock, bundle, function (event) {
      return CT_GAS_VNEXT_EVENTS.append(event);
    });
  }

  function reconcile(clock) {
    var c = clock || CT_GAS.clock(Date.now(), CT_GAS.BUDGET_MS);
    var props = PropertiesService.getScriptProperties();
    var spreadsheetId = props.getProperty('CT_GAS_FEEDBACK_SPREADSHEET_ID') || props.getProperty('CT_GAS_SPREADSHEET_ID');
    var sheetName = props.getProperty('CT_GAS_FEEDBACK_SHEET_NAME') || 'Feedback';
    if (!spreadsheetId) throw new Error('Feedback spreadsheet ID is required');
    var bundle = rows(spreadsheetId, sheetName);
    if (bundle.header !== 4) return { status: 'blocked', reason: 'feedback-header-not-ready' };
    return { status: 'complete', received: ingest(c, { spreadsheet_id: spreadsheetId, sheet_name: sheetName, rows: bundle.rows }) };
  }

  return { ingest: ingest, reconcile: reconcile };
}());

function reconcileFeedbackReceipts(clock) {
  return CT_GAS_FEEDBACK_VNEXT_TRANSPORT.reconcile(clock);
}
