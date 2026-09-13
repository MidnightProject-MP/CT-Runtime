/**
 * Disposable GAS fixture runner.
 *
 * Diagnostic-only. The repository's gas/.claspignore excludes *.test.* files,
 * so this cannot enter the normal clasp deployment set. No Script ID,
 * deployment ID, authorization, or production mutation path is used.
 */
function runSourceFingerprintFixture() {
  var fixtures = [
    { fixtureId: 'A-ascii', source: 'function hello() { return "hello"; }' },
    { fixtureId: 'B-unicode', source: 'function hello() { return "héllo 👋"; }' },
    { fixtureId: 'C-lf', source: 'a\nb\n' },
    { fixtureId: 'D-crlf', source: 'a\r\nb\r\n' },
    { fixtureId: 'E-no-final-newline', source: 'abc' },
    { fixtureId: 'E-final-newline', source: 'abc\n' },
    { fixtureId: 'F-blank-lines', source: 'a\n\nb' },
    { fixtureId: 'G-escaping', source: 'const x = "\\\\path\\\\to\\\\file \\\"quoted\\\"";' }
  ];

  var evidence = fixtures.map(function (fixture) {
    var bytes = Utilities.newBlob(fixture.source).getBytes();
    var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
    var hash = digest.map(function (value) {
      var unsigned = value < 0 ? value + 256 : value;
      return ('0' + unsigned.toString(16)).slice(-2);
    }).join('');

    return {
      fixtureId: fixture.fixtureId,
      utf8ByteLength: bytes.length,
      sourceSha256: hash
    };
  });

  Logger.log(JSON.stringify({
    evidenceType: 'source-fingerprint-v1',
    diagnosticOnly: true,
    fixtures: evidence
  }));

  return evidence;
}
