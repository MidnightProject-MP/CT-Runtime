// Review-only GAS-compatible helper. Deliberately outside gas/: NOT deployed.
// No entrypoint, logging, broad property reads, or property writes.
function gasDiagnosticProperties(properties) {
  function value(key) { return properties.getProperty(key); }
  function identifier(raw) {
    return typeof raw === 'string' && /^[A-Za-z0-9_-]{20,128}$/.test(raw) ? raw : null;
  }
  function endpoint(raw) {
    // GAS has no WHATWG URL. Reject ambiguous encodings/backslashes/control chars.
    if (typeof raw !== 'string' || /[\\\s\x00-\x1f\x7f]/.test(raw)) return null;
    var match = raw.match(/^https:\/\/([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/i);
    if (!match) return null;
    var host = match[1].slice(match[1].lastIndexOf('@') + 1).toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/.test(host)) return null;
    var path = match[2] || '/';
    if (!/^\/[A-Za-z0-9_./~-]*$/.test(path)) return null;
    return { hostname: host.replace(/:[0-9]+$/, ''), path: path };
  }
  var mode = value('CT_AUTONOMY_MODE');
  return {
    CT_GAS_FEDERATION_DATA_API_URL: endpoint(value('CT_GAS_FEDERATION_DATA_API_URL')),
    CT_GAS_DEPLOYMENT_ID: identifier(value('CT_GAS_DEPLOYMENT_ID')),
    CT_AUTONOMY_MODE: ['vnext', 'legacy'].indexOf(mode) >= 0 ? mode : null
  };
}
if (typeof module !== 'undefined') module.exports = { gasDiagnosticProperties: gasDiagnosticProperties };
