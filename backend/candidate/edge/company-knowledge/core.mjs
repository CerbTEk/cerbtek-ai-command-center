export const SCHEMA_VERSION = 1;
export const MAX_TEXT_BYTES = 32768;
export const MAX_REQUEST_BYTES = 220000;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED = {
  access: [], list: [], get: ['document_id', 'version_id'],
  search: ['query', 'limit'], source: ['document_id', 'version_id', 'chunk_id'],
  save: ['document_id', 'expected_revision', 'request_key', 'title', 'content_text', 'source_kind', 'source_name', 'audience', 'review_due_at'],
  publish: ['document_id', 'version_id', 'expected_revision', 'request_key'],
  archive: ['document_id', 'version_id', 'expected_revision', 'request_key'],
};
export class KnowledgeError extends Error {
  constructor(message, code = '22023', status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = message => { throw new KnowledgeError(message); };
export const utf8Bytes = text => new TextEncoder().encode(text).byteLength;
export function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.schema_version !== SCHEMA_VERSION || !UUID.test(body.organization_id || '') || !Object.hasOwn(ALLOWED, body.operation)) fail('Invalid Company Knowledge request');
  const allowed = new Set(['schema_version', 'organization_id', 'operation', ...ALLOWED[body.operation]]);
  if (Object.keys(body).some(key => !allowed.has(key))) fail('Unexpected request field');
  const payload = Object.fromEntries(ALLOWED[body.operation].filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
  for (const key of ['document_id', 'version_id', 'chunk_id', 'request_key']) {
    if (payload[key] !== undefined && payload[key] !== null && !UUID.test(payload[key])) fail('Invalid source identifier');
  }
  if (['get', 'publish', 'archive', 'source'].includes(body.operation) && !UUID.test(payload.document_id || '')) fail('Document is required');
  if (['publish', 'archive', 'source'].includes(body.operation) && !UUID.test(payload.version_id || '')) fail('Version is required');
  if (body.operation === 'source' && !UUID.test(payload.chunk_id || '')) fail('Chunk is required');
  if (['save', 'publish', 'archive'].includes(body.operation) && (!UUID.test(payload.request_key || '') || !Number.isSafeInteger(payload.expected_revision) || payload.expected_revision < 0)) fail('Request key and expected revision are required');
  if (body.operation === 'save') {
    if (typeof payload.title !== 'string' || !payload.title.trim() || payload.title.length > 160 || payload.title.includes('\0')) fail('Use a title of 1 to 160 characters');
    if (typeof payload.content_text !== 'string' || !payload.content_text.trim() || payload.content_text.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(payload.content_text) || utf8Bytes(payload.content_text) > MAX_TEXT_BYTES) fail('Use valid UTF-8 text up to 32 KiB');
    if (!['manual', 'text_upload'].includes(payload.source_kind) || typeof payload.source_name !== 'string' || !payload.source_name.trim() || payload.source_name.length > 160 || payload.source_name.includes('\0')) fail('Invalid source details');
    if (!['private', 'organization'].includes(payload.audience)) fail('Choose a supported audience');
    const due = typeof payload.review_due_at === 'string' ? Date.parse(payload.review_due_at) : NaN;
    // Time-relative review validation belongs after SQL's idempotency lookup:
    // a retry must still recover a confirmed save after its review date passes.
    if (!Number.isFinite(due)) fail('Choose a valid review date');
  }
  if (body.operation === 'search' && (typeof payload.query !== 'string' || payload.query.trim().length < 2 || payload.query.length > 200 || (payload.limit !== undefined && (!Number.isInteger(payload.limit) || payload.limit < 1 || payload.limit > 10)))) fail('Search needs 2 to 200 characters and a limit of 1 to 10');
  return { organization_id: body.organization_id, operation: body.operation, payload };
}

export async function readBoundedJson(request) {
  const length = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) throw new KnowledgeError('Request too large', 'too_large', 413);
  const reader = request.body?.getReader();
  if (!reader) fail('Invalid JSON');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) { await reader.cancel(); throw new KnowledgeError('Request too large', 'too_large', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('Use valid UTF-8 JSON'); }
}
