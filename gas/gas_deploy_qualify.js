/* Read-only compatibility layer: expose the GAS-native desired hash without changing deployment behavior. */
(function () {
  var originalQualify = CT_GAS_DEPLOY.qualify;
  CT_GAS_DEPLOY.qualify = function (request) {
    var result = originalQualify(request);
    return {
      status: result.status,
      scriptId: result.scriptId,
      headBundleHash: result.headBundleHash,
      desiredBundleHash: bundleHash(request.files),
      fileCount: result.fileCount
    };
  };
}());
