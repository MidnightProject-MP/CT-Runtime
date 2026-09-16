/* Temporary MVP cutover capability. Remove after vNext migration is complete. */
var CT_GAS_VNEXT_ARM = (function () {
  var OPERATION = 'arm-vnext-cutover';
  var NONCE_PREFIX = 'CT_GAS_DEPLOY_NONCE_';
  var TTL_MS = 10 * 60 * 1000;

  function props() { return PropertiesService.getScriptProperties(); }
  function fail(message) { throw new Error('deploy-' + message); }
  function hex(bytes) { return bytes.map(function (b) { return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2); }).join(''); }
  function digest(value) { return hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)); }
  function hmac(value, secret) { return hex(Utilities.computeHmacSha256Signature(value, secret, Utilities.Charset.UTF_8)); }
  function equal(a, b) { a = String(a || ''); b = String(b || ''); var n = Math.max(a.length, b.length), diff = a.length ^ b.length; for (var i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return diff === 0; }

  function reserveNonce(nonce) {
    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      var now = Date.now(), hash = digest(String(nonce)), all = props().getProperties(), key = NONCE_PREFIX + hash;
      Object.keys(all).forEach(function (candidate) {
        if (candidate.indexOf(NONCE_PREFIX) !== 0) return;
        if (!Number.isFinite(Number(all[candidate])) || Number(all[candidate]) <= now) props().deleteProperty(candidate);
      });
      var current = props().getProperty(key);
      if (current !== null && Number(current) > now) fail('nonce-replay');
      props().setProperty(key, String(now + TTL_MS));
    } finally { lock.releaseLock(); }
  }

  function authenticate(raw, query) {
    var timestamp = String(query.timestamp || ''), nonce = String(query.nonce || ''), signature = String(query.signature || ''), secret = props().getProperty('CT_GAS_DEPLOY_HMAC_SECRET');
    if (!secret || !timestamp || !nonce || !signature) fail('authentication-missing');
    var seconds = Number(timestamp), now = Math.floor(Date.now() / 1000);
    if (!/^\d+$/.test(timestamp) || !Number.isSafeInteger(seconds) || Math.abs(now - seconds) > 300) fail('authentication-skew');
    var request; try { request = JSON.parse(raw); } catch (_) { fail('invalid-json'); }
    if (request.operation !== OPERATION) fail('operation-not-allowed');
    if (!/^[0-9a-f]{40}$/.test(String(request.commit_sha || ''))) fail('invalid-commit');
    if (!/^[0-9a-f]{64}$/.test(String(request.github_bundle_hash || ''))) fail('invalid-github-bundle-hash');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(String(request.deployment_request_id || ''))) fail('invalid-request-id');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(String(request.deployment_id || ''))) fail('invalid-deployment-id');
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(String(request.script_id || ''))) fail('invalid-script-id');
    var bodyHash = digest(raw), signed = [request.operation, timestamp, nonce, request.deployment_request_id || '', request.script_id || '', request.deployment_id || '', request.commit_sha || '', request.github_bundle_hash || '', bodyHash].join('\n');
    if (!equal(signature, hmac(signed, secret))) fail('authentication-signature');
    reserveNonce(nonce);
    return request;
  }

  function arm(request) {
    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      props().setProperty('CT_AUTONOMY_MODE', 'vnext');
      var autonomyMode = props().getProperty('CT_AUTONOMY_MODE');
      if (autonomyMode !== 'vnext') fail('vnext-arm-readback');
      return { status: 'VNEXT_ARMED', autonomy_mode: autonomyMode };
    } finally { lock.releaseLock(); }
  }

  return { authenticate: authenticate, arm: arm };
}());
