/* Canonical GAS web-app dispatcher. Keep deployment authentication ahead of federation. */
var CT_GAS_DISPATCH = (function () {
  function isDeploymentOperation(operation) {
    return operation === 'self-deploy' || operation === 'self-deploy-plan' || operation === 'self-deploy-qualify' || operation === 'quiesce-legacy-autonomy' || operation === 'assert-legacy-quiesced' || operation === 'arm-vnext-cutover';
  }
  function assertDeploymentIdentity(request) {
    var receivedScriptId = String(ScriptApp.getScriptId());
    var configuredDeploymentId = String(PropertiesService.getScriptProperties().getProperty('CT_GAS_DEPLOYMENT_ID') || '');
    if (!request || String(request.script_id || '') !== receivedScriptId) throw new Error('deploy-script-id-mismatch');
    if (!configuredDeploymentId || String(request.deployment_id || '') !== configuredDeploymentId) throw new Error('deploy-deployment-id-mismatch');
  }
  function handle(e) {
    var raw = String(e && e.postData && e.postData.contents || ''), parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return federationDoPost(e); }
    if (!isDeploymentOperation(parsed.operation)) return federationDoPost(e);
    try {
      var query = e && e.parameter || {}, request = CT_GAS_AUTH_TRACE.authenticate(raw, query, CT_GAS_DEPLOY.authenticate), result;
      assertDeploymentIdentity(request);
      if (parsed.operation === 'self-deploy') result = CT_GAS_DEPLOY.deploy(request, parsed.files);
      else if (parsed.operation === 'self-deploy-plan') result = CT_GAS_DEPLOY.plan(request);
      else if (parsed.operation === 'self-deploy-qualify') result = CT_GAS_DEPLOY.qualify(request);
      else if (parsed.operation === 'quiesce-legacy-autonomy') result = quiesceLegacyAutonomy();
      else if (parsed.operation === 'arm-vnext-cutover') result = CT_GAS_DEPLOY.armVnext(request);
      else result = assertLegacyQuiesced();
      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    } catch (error) {
      var message = String(error && error.message || error);
      return ContentService.createTextOutput(JSON.stringify({ status: 'rejected', reason: message.indexOf('deploy-') === 0 ? message : 'internal-error' })).setMimeType(ContentService.MimeType.JSON);
    }
  }
  return {handle:handle};
}());
// The sole web entry point. Dependencies are resolved only on invocation, after
// GAS has initialized every file; filenames/evaluation order have no authority.
function doPost(e) { return CT_GAS_AUTH_TRACE.dispatch(e, CT_GAS_DISPATCH.handle); }
