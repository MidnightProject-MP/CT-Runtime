/* Add the GAS-computed desired bundle hash to the read-only qualification response. */
(function () {
  var MAX_FILES = 64;
  var MAX_FILE_BYTES = 262144;
  var MAX_BUNDLE_BYTES = 2097152;

  function bytes(value) {
    return Utilities.newBlob(String(value), 'text/plain').getBytes().length;
  }

  function digest(value) {
    var bytesValue = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
    return bytesValue.map(function (b) {
      return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2);
    }).join('');
  }

  function canonicalName(name) {
    if (name === 'appsscript.json' || name === 'appsscript') return 'appsscript';
    return name.replace(/\.(?:js|mjs|html)$/i, '');
  }

  function normalizeFiles(files) {
    if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw new Error('deploy-invalid-file-count');
    var seen = {}, canonical = {}, manifest = 0, out = [];
    files.forEach(function (file) {
      if (!file || typeof file !== 'object' || typeof file.name !== 'string' || typeof file.source !== 'string' || typeof file.type !== 'string') throw new Error('deploy-invalid-file');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(file.name) || file.name.indexOf('..') >= 0 || file.name.indexOf('/') >= 0 || file.name.indexOf('\\') >= 0) throw new Error('deploy-invalid-file-name');
      if (seen[file.name]) throw new Error('deploy-duplicate-file');
      seen[file.name] = true;
      if (['SERVER_JS', 'HTML', 'JSON'].indexOf(file.type) < 0) throw new Error('deploy-invalid-file-type');
      var name = canonicalName(file.name);
      if (name === 'appsscript') {
        if (file.type !== 'JSON') throw new Error('deploy-invalid-manifest-type');
        manifest++;
      } else if (file.type === 'JSON') {
        throw new Error('deploy-unexpected-json-file');
      }
      if (canonical[name]) throw new Error('deploy-duplicate-canonical-file');
      canonical[name] = true;
      if (bytes(file.source) > MAX_FILE_BYTES) throw new Error('deploy-file-too-large');
      out.push({ name: name, type: file.type, source: file.source });
    });
    if (manifest !== 1) throw new Error('deploy-manifest-required');
    out.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    if (bytes(JSON.stringify(out)) > MAX_BUNDLE_BYTES) throw new Error('deploy-bundle-too-large');
    return out;
  }

  function bundleHash(files) {
    return digest(JSON.stringify(normalizeFiles(files)));
  }

  var qualify = CT_GAS_DEPLOY.qualify;
  CT_GAS_DEPLOY.qualify = function (request) {
    var result = qualify(request);
    if (request && Array.isArray(request.files) && request.files.length) {
      result.desiredBundleHash = bundleHash(request.files);
    }
    return result;
  };
}());
