function sourceFingerprintFixtures(){
  var fixtures=[
    ['A-ASCII','function hello() { return "hello"; }'],
    ['B-UNICODE','function hello() { return "héllo 👋"; }'],
    ['C-LF','a\nb\n'],
    ['D-CRLF','a\r\nb\r\n'],
    ['E-NO-FINAL-NL','abc'],
    ['E-FINAL-NL','abc\n'],
    ['F-BLANK-LINES','a\n\nb'],
    ['G-ESCAPING','const x = "\\path\\to\\file \\"quoted\\"";']
  ];
  return fixtures.map(function(f){
    var bytes=Utilities.newBlob(f[1],'text/plain').getBytes();
    var digest=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,f[1],Utilities.Charset.UTF_8);
    return {fixtureId:f[0],utf8ByteLength:bytes.length,sourceSha256:digest.map(function(b){var n=b<0?b+256:b;return ('0'+n.toString(16)).slice(-2);}).join('')};
  });
}
