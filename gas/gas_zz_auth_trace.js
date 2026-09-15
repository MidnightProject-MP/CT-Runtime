/* Temporary safe correlated authentication tracing. Remove after diagnosis. */
(function () {
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

  var originalAuthenticate = CT_GAS_DEPLOY.authenticate;
  CT_GAS_DEPLOY.authenticate = function (raw, query) {
    trace(raw, query, 'before-verify', 'CT_GAS_DEPLOY', null);
    try {
      var result = originalAuthenticate(raw, query);
      trace(raw, query, 'authenticated', 'CT_GAS_DEPLOY', null);
      return result;
    } catch (error) {
      trace(raw, query, 'rejected', 'CT_GAS_DEPLOY', String(error && error.message || error));
      throw error;
    }
  };

  var originalDoPost = doPost;
  doPost = function (e) {
    var raw = String(e && e.postData && e.postData.contents || '');
    var request = parsed(raw);
    var diagnosticId = String(request.correlation_id || Utilities.getUuid());
    var output = originalDoPost(e);
    var text = output && output.getContent ? output.getContent() : '';
    try {
      var result = JSON.parse(text);
      result.diagnostic_id = diagnosticId;
      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    } catch (_) {
      return output;
    }
  };
})();
