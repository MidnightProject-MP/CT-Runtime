/* Existing Google-authenticated Neon Data API transport for immutable vNext receipts. */
var CT_GAS_VNEXT_EVENTS = (function () {
  var PATH = '/rpc/vnext_append_immutable_event';

  function props() { return PropertiesService.getScriptProperties(); }
  function identityToken() {
    var token = ScriptApp.getIdentityToken();
    if (!token) throw new Error('GAS identity token unavailable');
    return token;
  }
  function dataApiUrl() {
    var url = props().getProperty('CT_GAS_FEDERATION_DATA_API_URL');
    if (!url) throw new Error('existing Neon Data API URL is required');
    return url.replace(/\/$/, '');
  }
  function rpc(envelope) {
    if (!envelope || typeof envelope.event_id !== 'string' || !envelope.event_id) throw new Error('event_id is required');
    if (typeof envelope.event_type !== 'string' || !envelope.event_type) throw new Error('event_type is required');
    if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) throw new Error('payload must be an object');
    var response = UrlFetchApp.fetch(dataApiUrl() + PATH, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + identityToken() },
      payload: JSON.stringify(envelope),
      muteHttpExceptions: true
    });
    var code = response.getResponseCode(), body = String(response.getContentText() || '');
    if (code < 200 || code >= 300) {
      if (code === 401) throw new Error('immutable event RPC unauthorized');
      if (code === 403) throw new Error('immutable event RPC forbidden');
      if (code === 404) throw new Error('immutable event RPC missing-function');
      if (code === 400) throw new Error('immutable event RPC invalid-request');
      throw new Error('immutable event RPC unavailable');
    }
    var parsed;
    try { parsed = JSON.parse(body); } catch (_) { throw new Error('immutable event RPC invalid-response'); }
    var status = typeof parsed === 'string' ? parsed : parsed && parsed.status;
    if (['inserted','duplicate','integrity_conflict'].indexOf(status) < 0) throw new Error('immutable event RPC invalid-status');
    return status;
  }

  function append(event) {
    if (!event || typeof event !== 'object') throw new Error('event is required');
    var payload = {};
    Object.keys(event).forEach(function (key) {
      if (key !== 'event_id' && key !== 'type') payload[key] = event[key];
    });
    return rpc({ event_id: event.event_id, event_type: event.type, payload: payload });
  }

  return { rpc: rpc, append: append, path: PATH };
}());
