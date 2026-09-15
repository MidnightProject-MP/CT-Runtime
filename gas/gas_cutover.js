/* One-time cutover operation: isolate the known legacy GAS trigger and prove no legacy execution remains live. */
var CT_VNEXT_CUTOVER = (function () {
  var QUIESCED = 'CT_VNEXT_LEGACY_QUIESCED';
  var LEGACY_HANDLERS = { gasSafetyWake: true };

  function properties() { return PropertiesService.getScriptProperties(); }

  function latestExecutions() {
    var rows = CT_GAS_STATE.list('executions'), ids = {}, out = [];
    rows.forEach(function (row) { if (row && row.id) ids[row.id] = true; });
    Object.keys(ids).forEach(function (id) {
      var row = CT_GAS_STATE.get('executions', id);
      if (row) out.push(row);
    });
    return out;
  }

  function quiesceLegacy() {
    if (properties().getProperty('CT_AUTONOMY_MODE') !== 'vnext') {
      return { status: 'REQUIRES_VNEXT', autonomy_mode: properties().getProperty('CT_AUTONOMY_MODE') || null };
    }
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var triggers = ScriptApp.getProjectTriggers(), retired = [];
      triggers.forEach(function (trigger) {
        var handler = String(trigger.getHandlerFunction ? trigger.getHandlerFunction() : '');
        if (!LEGACY_HANDLERS[handler]) return;
        ScriptApp.deleteTrigger(trigger);
        retired.push({ handler: handler, id: trigger.getUniqueId ? trigger.getUniqueId() : null });
      });

      var live = latestExecutions().filter(function (row) { return row.lifecycle === 'running'; });
      if (live.length) {
        return {
          status: 'LEGACY_NOT_QUIESCED',
          autonomy_mode: 'vnext',
          retired_trigger_count: retired.length,
          live_execution_ids: live.map(function (row) { return row.id; }).sort()
        };
      }

      var remainingLegacyTriggers = ScriptApp.getProjectTriggers().filter(function (trigger) {
        var handler = String(trigger.getHandlerFunction ? trigger.getHandlerFunction() : '');
        return !!LEGACY_HANDLERS[handler];
      });
      if (remainingLegacyTriggers.length) {
        return {
          status: 'LEGACY_NOT_QUIESCED',
          autonomy_mode: 'vnext',
          retired_trigger_count: retired.length,
          live_execution_ids: [],
          remaining_trigger_count: remainingLegacyTriggers.length
        };
      }

      var value = JSON.stringify({ status: 'quiesced', at: new Date().toISOString(), retired_trigger_count: retired.length });
      properties().setProperty(QUIESCED, value);
      return { status: 'LEGACY_QUIESCED', autonomy_mode: 'vnext', retired_trigger_count: retired.length };
    } finally {
      lock.releaseLock();
    }
  }

  function assertQuiesced() {
    if (properties().getProperty('CT_AUTONOMY_MODE') !== 'vnext') {
      return { status: 'REQUIRES_VNEXT', autonomy_mode: properties().getProperty('CT_AUTONOMY_MODE') || null };
    }
    var raw = properties().getProperty(QUIESCED);
    if (!raw) return { status: 'LEGACY_NOT_QUIESCED', autonomy_mode: 'vnext' };
    var parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return { status: 'LEGACY_NOT_QUIESCED', autonomy_mode: 'vnext' }; }
    return parsed && parsed.status === 'quiesced'
      ? { status: 'LEGACY_QUIESCED', autonomy_mode: 'vnext', retired_trigger_count: Number(parsed.retired_trigger_count || 0) }
      : { status: 'LEGACY_NOT_QUIESCED', autonomy_mode: 'vnext' };
  }

  return { quiesceLegacy: quiesceLegacy, assertQuiesced: assertQuiesced };
}());

function quiesceLegacyAutonomy() { return CT_VNEXT_CUTOVER.quiesceLegacy(); }
function assertLegacyQuiesced() { return CT_VNEXT_CUTOVER.assertQuiesced(); }
