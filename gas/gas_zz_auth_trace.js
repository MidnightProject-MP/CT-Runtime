/* Bounded, best-effort authentication tracing. Diagnostics never authorize requests. */
var CT_GAS_AUTH_TRACE = (function () {
  var MAX_DEPLOY_BODY_BYTES = 3 * 1024 * 1024;
  var MAX_FEDERATION_BODY_BYTES = 8192;

  function digest(value) {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8);
    return bytes.map(function (b) { return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2); }).join('');
  }
  function byteLength(value) { return Utilities.newBlob(String(value), 'text/plain').getBytes().length; }
  function parsed(raw) { try { return JSON.parse(raw); } catch (_) { return {}; } }
  function canonicalMaterial(raw, query, request) {
    var bodyHash = digest(raw);
    var canonical = [
      request.operation || '',
      String(query.timestamp || ''),
      String(query.nonce || ''),
      request.deployment_request_id || '',
      request.script_id || '',
      request.deployment_id || '',
      request.commit_sha || '',
      request.github_bundle_hash || '',
      bodyHash
    ].join('\n');
    return { body_hash: bodyHash, canonical_hash: digest(canonical) };
  }
  function trace(raw, query, stage, authPath, reason) {
    var request = parsed(raw), material = canonicalMaterial(raw, query || {}, request);
    var suppliedSignature = String((query || {}).signature || '');
    var record = {
      trace: 'ct-gas-auth',
      diagnostic_id: String(request.correlation_id || Utilities.getUuid()),
      stage: stage,
      auth_path: authPath || 'CT_GAS_DEPLOY',
      operation: request.operation || null,
      timestamp: String((query || {}).timestamp || ''),
      nonce: String((query || {}).nonce || ''),
      body_bytes: byteLength(raw),
      body_sha256: material.body_hash,
      canonical_sha256: material.canonical_hash,
      identity_fields_present: ['deployment_request_id', 'script_id', 'deployment_id', 'commit_sha', 'github_bundle_hash'].filter(function (key) { return Object.prototype.hasOwnProperty.call(request, key); }),
      secret_present: !!PropertiesService.getScriptProperties().getProperty('CT_GAS_DEPLOY_HMAC_SECRET'),
      signature_present: !!suppliedSignature,
      signature_length: suppliedSignature.length,
      reason: reason || null
    };
    console.log(JSON.stringify(record));
    return record.diagnostic_id;
  }
  // Tracing is never part of the authorization decision. If a diagnostic service
  // fails, the real authenticator still runs and retains its own fail-closed behavior.
  function safeTrace(raw, query, stage, authPath, reason) {
    try { return trace(raw, query, stage, authPath, reason); } catch (_) { return null; }
  }
  function rejected(reason) {
    return ContentService.createTextOutput(JSON.stringify({ status: 'rejected', reason: reason })).setMimeType(ContentService.MimeType.JSON);
  }
  function isDeploymentOperation(operation) {
    return operation === 'self-deploy' || operation === 'self-deploy-plan' ||
      operation === 'self-deploy-qualify' || operation === 'quiesce-legacy-autonomy' ||
      operation === 'assert-legacy-quiesced' || operation === 'arm-vnext-cutover';
  }
  function authenticate(raw, query, originalAuthenticate) {
    safeTrace(raw, query, 'before-verify', 'CT_GAS_DEPLOY', null);
    try {
      var result = originalAuthenticate(raw, query);
      safeTrace(raw, query, 'authenticated', 'CT_GAS_DEPLOY', null);
      return result;
    } catch (error) {
      safeTrace(raw, query, 'rejected', 'CT_GAS_DEPLOY', String(error && error.message || error));
      throw error;
    }
  }
  function dispatch(e, originalDoPost) {
    var raw = String(e && e.postData && e.postData.contents || '');
    var query = e && e.parameter || {};

    // Check a cheap character bound before allocating a Blob, hashing, parsing JSON,
    // reading Script Properties, or emitting a log record. The byte check is then
    // exact; deploy requests retain room for the bounded 2 MiB source bundle.
    if (raw.length > MAX_DEPLOY_BODY_BYTES) return rejected('request-body-too-large');
    var rawBytes;
    try { rawBytes = byteLength(raw); } catch (_) { return rejected('request-body-unavailable'); }
    if (rawBytes > MAX_DEPLOY_BODY_BYTES) return rejected('request-body-too-large');

    var request;
    try { request = JSON.parse(raw); } catch (_) { return originalDoPost(e); }
    if (!isDeploymentOperation(request && request.operation)) {
      // Federation has a much smaller protocol limit than deployment bundles.
      if (rawBytes > MAX_FEDERATION_BODY_BYTES) return rejected('federation-body-too-large');
      return originalDoPost(e);
    }

    // Only deployment traffic is traced. Federation requests do not trigger
    // deployment-secret reads or diagnostic hashing/logging.
    var diagnosticId = safeTrace(raw, query, 'received', 'dispatcher', null);
    var output = originalDoPost(e);
    if (!diagnosticId) return output;
    var text = '';
    try { text = output && output.getContent ? output.getContent() : ''; } catch (_) { return output; }
    try {
      var result = JSON.parse(text);
      result.diagnostic_id = diagnosticId;
      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    } catch (_) {
      return output;
    }
  }
  return {authenticate:authenticate,dispatch:dispatch};
})();
