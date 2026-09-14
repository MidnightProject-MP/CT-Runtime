/* Production A2 seam: Feedback sheet adapter -> authenticated Neon Data API -> immutable event RPC. */
var CT_GAS_FEEDBACK_VNEXT_TRANSPORT = (function () {
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
    var book = SpreadsheetApp.openById(spreadsheetId), sheet = book.getSheetByName(sheetName);
    if (!sheet) throw new Error('Configured feedback sheet not found: ' + sheetName);
    var rows = CT_GAS_FEEDBACK.values ? CT_GAS_FEEDBACK.values() : null;
    if (!rows || rows.header !== 4) return { status: 'blocked', reason: 'feedback-header-not-ready' };
    return { status: 'complete', received: ingest(c, { spreadsheet_id: spreadsheetId, sheet_name: sheetName, rows: rows.rows }) };
  }

  return { ingest: ingest, reconcile: reconcile };
}());

function reconcileFeedbackReceipts(clock) {
  return CT_GAS_FEEDBACK_VNEXT_TRANSPORT.reconcile(clock);
}
