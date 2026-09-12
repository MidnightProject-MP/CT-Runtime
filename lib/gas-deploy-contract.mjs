import { createHash, createHmac } from 'node:crypto';

export const MAX_FILES = 64;
export const MAX_FILE_BYTES = 262144;
export const MAX_BUNDLE_BYTES = 2097152;

export function normalizeFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw new Error('invalid-file-count');
  const seen = new Set();
  const out = files.map((file) => {
    if (!file || typeof file.name !== 'string' || typeof file.source !== 'string' || typeof file.type !== 'string') throw new Error('invalid-file');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(file.name) || file.name.includes('..') || file.name.includes('/') || file.name.includes('\\')) throw new Error('invalid-file-name');
    if (seen.has(file.name)) throw new Error('duplicate-file');
    seen.add(file.name);
    if (!['SERVER_JS', 'HTML', 'JSON'].includes(file.type)) throw new Error('invalid-file-type');
    if (file.name === 'appsscript.json' ? file.type !== 'JSON' : file.type === 'JSON') throw new Error('invalid-manifest-type');
    if (Buffer.byteLength(file.source, 'utf8') > MAX_FILE_BYTES) throw new Error('file-too-large');
    return { name: file.name, type: file.type, source: file.source };
  }).sort((a, b) => a.name.localeCompare(b.name));
  if (!out.some((file) => file.name === 'appsscript.json')) throw new Error('manifest-required');
  const body = JSON.stringify(out);
  if (Buffer.byteLength(body, 'utf8') > MAX_BUNDLE_BYTES) throw new Error('bundle-too-large');
  return out;
}

export function bundleHash(files) {
  return createHash('sha256').update(JSON.stringify(normalizeFiles(files)), 'utf8').digest('hex');
}

export function signingString(request, timestamp, nonce, body) {
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  return [request.operation, timestamp, nonce, request.deployment_request_id ?? '', request.script_id ?? '', request.deployment_id ?? '', request.commit_sha ?? '', request.bundle_hash ?? '', bodyHash].join('\n');
}

export function signature(request, timestamp, nonce, body, secret) {
  return createHmac('sha256', secret).update(signingString(request, timestamp, nonce, body), 'utf8').digest('hex');
}
