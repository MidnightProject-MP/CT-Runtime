import { GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import crypto from 'node:crypto';

const MAX = 64 * 1024;
const RETENTION = new Set(['ephemeral', 'operational', 'audit', 'observer-ledger', 'chronicle', 'quarantine']);
const PROTECTED = new Set(['schema', 'execution-id', 'attempt', 'evidence-id', 'sha256', 'truncated', 'retention-class', 'retention-policy-version']);
const shaHex = (body) => crypto.createHash('sha256').update(body).digest('hex');

export class S3EvidenceStore {
  constructor({ bucket, namespace = 'ct-runtime', endpoint, region = 'us-east-1', forcePathStyle = false, client, accessKeyId, secretAccessKey } = {}) {
    if (typeof bucket !== 'string' || !bucket.trim()) throw new Error('S3 bucket is required');
    if (typeof namespace !== 'string' || !namespace.trim() || namespace.length > 200 || /[\r\n\0]/.test(namespace)) throw new Error('S3 namespace is invalid');
    this.bucket = bucket;
    this.namespace = namespace.replace(/^\/+|\/+$/g, '');
    this.client = client || new S3Client({
      endpoint,
      region,
      forcePathStyle,
      credentials: accessKeyId ? { accessKeyId, secretAccessKey } : undefined,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED'
    });
  }

  async put({ project, executionId, attempt, label, content, contentType = 'text/plain', retentionClass = 'operational', metadata = {} }) {
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > 1000000) throw new Error('attempt must be a bounded positive integer');
    for (const [field, value] of [['project', project], ['executionId', executionId], ['label', label]]) validateId(value, field);
    if (typeof contentType !== 'string' || contentType.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(contentType)) throw new Error('contentType is invalid');
    if (!RETENTION.has(retentionClass)) throw new Error('retentionClass is invalid');
    const metadataKeys = Object.keys(metadata);
    if (metadataKeys.some((key) => PROTECTED.has(key.toLowerCase()))) throw new Error('caller cannot override protected evidence metadata');
    if (metadataKeys.length) throw new Error('caller metadata is not accepted on evidence objects');
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    const body = raw.subarray(0, MAX), truncated = body.length !== raw.length, hash = shaHex(body);
    const evidenceId = `${label}-${hash}`;
    const key = `${this.namespace}/evidence/${safe(project)}/${safe(executionId)}/${attempt}/${safe(label)}-${hash}.raw`;
    const objectMetadata = { schema: 'celestan-runtime-evidence-v2', 'execution-id': executionId, attempt: String(attempt), 'evidence-id': evidenceId, sha256: hash, truncated: String(truncated), 'retention-class': retentionClass, 'retention-policy-version': '1' };
    const verification = { key, body, hash, contentType, objectMetadata, evidenceId, truncated, retentionClass };
    const put = { Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, Metadata: objectMetadata };
    try {
      await this.client.send(new PutObjectCommand({ ...put, IfNoneMatch: '*' }));
    } catch (putError) {
      if (isAlreadyExists(putError)) return this.verifyExisting(verification);
      if (isConditionalUnsupported(putError)) return this.putWithoutCondition(put, verification);
      return this.resolveFailedPut(putError, verification);
    }
    return this.verifyExisting(verification);
  }

  async putWithoutCondition(put, verification) {
    // This provider-neutral fallback is the only non-atomic write path.
    try {
      return await this.verifyExisting(verification);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    try {
      await this.client.send(new PutObjectCommand(put));
    } catch (putError) {
      return this.resolveFailedPut(putError, verification);
    }
    return this.verifyExisting(verification);
  }

  async resolveFailedPut(putError, verification) {
    if (!isAmbiguousFailure(putError)) throw putError;
    try {
      return await this.verifyExisting(verification);
    } catch (readbackError) {
      if (isConflict(readbackError)) throw readbackError;
      throw putError;
    }
  }

  async verifyExisting({ key, body, hash, contentType, objectMetadata, evidenceId, truncated, retentionClass }) {
    let object;
    try {
      object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(body.length ? { Range: `bytes=0-${body.length}` } : {}) }));
    } catch (error) {
      if (isRangeNotSatisfiable(error)) throw conflict();
      throw error;
    }
    if (!numericEqual(object.ContentLength, body.length)) {
      releaseBody(object.Body);
      throw conflict();
    }
    let actualBody;
    try {
      actualBody = await readBounded(object.Body, body.length + 1);
    } catch (error) {
      releaseBody(object.Body);
      throw error;
    }
    const actualMetadata = Object.fromEntries(Object.entries(object.Metadata || {}).map(([name, value]) => [name.toLowerCase(), value]));
    const metadataMatches = Object.entries(objectMetadata).every(([name, value]) => actualMetadata[name] === value);
    if (actualBody.length !== body.length || shaHex(actualBody) !== hash || !metadataMatches || object.ContentType !== contentType) throw conflict();
    return { evidenceId, objectKey: key, objectUri: `s3://${this.bucket}/${key}`, sha256: hash, bytes: body.length, truncated, contentType, retentionClass, metadata: objectMetadata };
  }

  async putArtifact({ kind, key, content, markdown }) {
    validateId(kind, 'artifact kind'); validateId(key, 'artifact key');
    const value = { kind, key, content, ...(markdown === undefined ? {} : { markdown }) };
    return this.put({ project: 'observer', executionId: shaHex(Buffer.from(key)), attempt: 1, label: kind, content: JSON.stringify(value), contentType: 'application/json', retentionClass: kind === 'chronicle' ? 'chronicle' : 'observer-ledger' });
  }

  async reachable() { await this.client.send(new HeadBucketCommand({ Bucket: this.bucket })); return true; }

  async list({ prefix = `${this.namespace}/evidence/`, continuationToken, maxKeys = 1000, includeMetadata = true } = {}) {
    if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > 1000) throw new Error('maxKeys must be from 1 to 1000');
    const result = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: continuationToken, MaxKeys: maxKeys }));
    const candidates = [];
    for (const item of result.Contents || []) {
      const candidate = { objectKey: item.Key, bytes: String(item.Size), etag: item.ETag, lastModified: item.LastModified?.toISOString?.() || item.LastModified };
      if (includeMetadata) {
        const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: item.Key }));
        candidate.bytes = String(head.ContentLength);
        candidate.sha256 = head.Metadata?.sha256;
        candidate.retentionClass = head.Metadata?.['retention-class'];
        candidate.checksumSHA256 = head.ChecksumSHA256;
      }
      candidates.push(candidate);
    }
    return { candidates, nextToken: result.NextContinuationToken, truncated: Boolean(result.IsTruncated) };
  }

  async reconcileOrphans(references = [], { objects } = {}) {
    const listed = objects || await this.list();
    const candidates = Array.isArray(listed) ? listed : listed.candidates;
    const referencesByKey = new Map(references.map((reference) => [reference.objectKey, reference]));
    const referenced = [], orphaned = [], conflicts = [];
    for (const candidate of candidates) {
      const reference = referencesByKey.get(candidate.objectKey);
      if (!reference) { orphaned.push(candidate); continue; }
      if (!numericEqual(candidate.bytes, reference.bytes) || candidate.sha256 && candidate.sha256 !== reference.sha256) conflicts.push(candidate);
      else referenced.push(candidate);
    }
    return { scanned: candidates.length, referenced, orphaned, conflicts, nextToken: Array.isArray(listed) ? undefined : listed.nextToken, destructiveActions: [] };
  }
}

function validateId(value, field) { if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\r\n\0]/.test(value)) throw new Error(`${field} is invalid`); }
function safe(value) { return encodeURIComponent(String(value)); }
function numericEqual(left, right) { try { return BigInt(left) === BigInt(right); } catch { return false; } }
function conflict() { const error = new Error('S3 evidence conflict or verification failure'); error.code = 'S3EvidenceConflict'; return error; }
function isConflict(error) { return error?.code === 'S3EvidenceConflict'; }
function statusCode(error) { return error?.$metadata?.httpStatusCode ?? error?.$response?.statusCode ?? error?.statusCode ?? error?.status; }
function errorCodes(error) { return [error?.name, error?.Code, error?.code].filter(Boolean); }
function isMissing(error) {
  return Number(statusCode(error)) === 404 || errorCodes(error).some((code) => ['NoSuchKey', 'NotFound', '404'].includes(code));
}
function isAlreadyExists(error) {
  return Number(statusCode(error)) === 412 || errorCodes(error).some((code) => ['PreconditionFailed', 'ConditionalRequestConflict'].includes(code));
}
function isConditionalUnsupported(error) {
  const status = Number(statusCode(error));
  if (![400, 501].includes(status)) return false;
  const codes = errorCodes(error).join(' ');
  const details = `${codes} ${error?.message || ''} ${error?.Header || error?.header || error?.headerName || ''}`;
  return /if-?none-?match|conditional/i.test(details) && /not.?implemented|unsupported|invalid.?request/i.test(details)
    || status === 501 && /not.?implemented/i.test(codes);
}
function isRangeNotSatisfiable(error) { return Number(statusCode(error)) === 416 || errorCodes(error).some((code) => ['RangeNotSatisfiable', 'InvalidRange'].includes(code)); }
function isAmbiguousFailure(error) {
  const rawStatus = statusCode(error);
  const status = Number(rawStatus);
  return rawStatus === undefined || status === 408 || status === 429 || status >= 500;
}
async function readBounded(body, limit) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body) || body instanceof Uint8Array || typeof body === 'string') {
    const value = Buffer.from(body);
    if (value.length > limit) throw conflict();
    return value;
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of body) {
      const value = Buffer.from(chunk);
      bytes += value.length;
      if (bytes > limit) throw conflict();
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes);
  }
  throw conflict();
}
function releaseBody(body) {
  try { body?.destroy?.(); } catch {}
}
