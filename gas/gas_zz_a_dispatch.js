/* Canonical GAS web-app dispatcher. Keep deployment authentication ahead of federation. */
(function () {
  var federationDoPost = doPost;
  function isDeploymentOperation(operation) {
    return operation === 'self-deploy' || operation === 'self-deploy-plan' || operation === 'self-deploy-qualify' || operation === 'quiesce-legacy-autonomy' || operation === 'assert-legacy-quiesced';
  }
  doPost = function (e) {
    var raw = String(e && e.postData && e.postData.contents || ''), parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return federationDoPost(e); }
    if (!isDeploymentOperation(parsed.operation)) return federationDoPost(e);
    try {
      var query = e && e.parameter || {}, request = CT_GAS_DEPLOY.authenticate(raw, query), result;
      if (parsed.operation === 'self-deploy') result = CT_GAS_DEPLOY.deploy(request, parsed.files);
      else if (parsed.operation === 'self-deploy-plan') result = CT_GAS_DEPLOY.plan(request);
      else if (parsed.operation === 'self-deploy-qualify') result = CT_GAS_DEPLOY.qualify(request);
      else if (parsed.operation === 'quiesce-legacy-autonomy') result = quiesceLegacyAutonomy();
      else result = assertLegacyQuiesced();
      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    } catch (error) {
      var message = String(error && error.message || error);
      return ContentService.createTextOutput(JSON.stringify({ status: 'rejected', reason: message.indexOf('deploy-') === 0 ? message : 'internal-error' })).setMimeType(ContentService.MimeType.JSON);
    }
  };
}());
