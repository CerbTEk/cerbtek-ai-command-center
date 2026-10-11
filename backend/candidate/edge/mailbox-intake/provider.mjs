// Read-only Microsoft mailbox boundary. All email fields remain untrusted data;
// sender addresses are routing metadata, never proof of identity or authority.
// Graph v1.0 documentation checked 2026-10-11:
// https://learn.microsoft.com/en-us/graph/api/user-list-mailfolders?view=graph-rest-1.0
// https://learn.microsoft.com/en-us/graph/api/mailfolder-get?view=graph-rest-1.0
// https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0
// https://learn.microsoft.com/en-us/graph/outlook-immutable-id
// https://learn.microsoft.com/en-us/graph/api/user-get?view=graph-rest-1.0
export class MailboxProviderError extends Error {
  constructor(code, status = 502) { super(code); this.name = 'MailboxProviderError'; this.code = code; this.status = status; }
}

const GRAPH = 'https://graph.microsoft.com/v1.0/me';
const MAX_RESPONSE_BYTES = 256 * 1024;
const FOLDER_LIMIT = 50;
const MESSAGE_LIMIT = 10;
const FOLDER_FIELDS = 'id,displayName,isHidden';
const MESSAGE_FIELDS = 'id,conversationId,internetMessageId,parentFolderId,receivedDateTime,hasAttachments,isDraft,from,sender,replyTo,subject,body';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const length = value => Array.from(value).length;
const fail = (code, status) => { throw new MailboxProviderError(code, status); };
const unsafeControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const invalidUnicode = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

// Graph IDs are opaque and case-sensitive. Permit base64/base64url characters,
// including slash and plus, but encode the entire ID as one URL path segment.
export function validateId(value) {
  if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_+/-]+={0,2}$/.test(value)) fail('invalid_mailbox_reference', 400);
  return value;
}

function decodeEntities(value) {
  const named = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
  return value.replace(/&(#(?:x[0-9a-f]{1,8}|[0-9]{1,10})|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()];
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}

// This is a lossy plain-text extraction fallback, NOT an HTML sanitizer for
// rendering. No DOM, HTML rendering, URL resolution, images or script execution.
// Callers must still display the result using textContent/React text nodes.
export function cleanText(value, {html = false, maxLength = 6000} = {}) {
  if (typeof value !== 'string' || invalidUnicode.test(value) || !Number.isSafeInteger(maxLength) || maxLength < 1) fail('invalid_mailbox_message', 422);
  // A local caller has the same resource bound as a provider response.
  if (new TextEncoder().encode(value).length > MAX_RESPONSE_BYTES) fail('mailbox_message_too_large', 422);
  let text = value.replace(/\r\n?/g, '\n').replace(unsafeControls, '');
  if (html) {
    text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
      .replace(/<(script|style|template|iframe|object|svg|math|head)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
      .replace(/<(?:br|hr)\b[^>]*>|<\/(?:p|div|li|tr|h[1-6]|section|article)\s*>/gi, '\n')
      .replace(/<[^>]*(?:>|$)/g, '');
    text = decodeEntities(text);
  } else {
    // Some providers label HTML as text. Remove active blocks conservatively.
    text = text.replace(/<(script|style|template|iframe|object|svg|math|head)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
  }
  // Also remove markup exposed by entity decoding; preserve no angle brackets.
  text = text.replace(/<[^>]*(?:>|$)/g, '').replace(/[<>]/g, '').replace(unsafeControls, '')
    .replace(/[\t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (length(text) > maxLength) fail('mailbox_message_too_large', 422);
  return text;
}

function shortText(value, maximum, fallback) {
  if (value === null || value === undefined || value === '') value = fallback;
  if (typeof value !== 'string' || length(value) > maximum) fail('invalid_mailbox_message', 422);
  const text = cleanText(value, {maxLength: maximum}).replace(/\s+/g, ' ').trim();
  if (!text) fail('invalid_mailbox_message', 422);
  return text;
}

function email(value) {
  // Deliberately narrow routing grammar. Never strip controls/markup from an
  // address and silently turn it into a different recipient.
  if (typeof value !== 'string' || value.length > 320 || value !== value.trim()
      || !/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value)) fail('invalid_mailbox_sender', 422);
  const [local, domain] = value.split('@');
  if (local.length > 64 || domain.length > 253 || domain.split('.').some(label => label.length > 63)) fail('invalid_mailbox_sender', 422);
  return value;
}

function internetMessageId(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 998 || /[\s\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value) || invalidUnicode.test(value)) fail('invalid_mailbox_message', 422);
  return value;
}

export function normalizeMessage(value, folderId) {
  validateId(folderId);
  if (!object(value) || value.isDraft !== false || value.parentFolderId !== folderId || typeof value.hasAttachments !== 'boolean') fail('invalid_mailbox_message', 422);
  const customerEmail = email(value.from?.emailAddress?.address);
  if (value.replyTo !== undefined && value.replyTo !== null) {
    if (!Array.isArray(value.replyTo) || value.replyTo.length > 1) fail('ambiguous_mailbox_reply_address', 422);
    if (value.replyTo.length === 1 && email(value.replyTo[0]?.emailAddress?.address).toLowerCase() !== customerEmail.toLowerCase()) fail('ambiguous_mailbox_reply_address', 422);
  }
  if (typeof value.receivedDateTime !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value.receivedDateTime)
      || !Number.isFinite(Date.parse(value.receivedDateTime))) fail('invalid_mailbox_message', 422);
  const received = new Date(value.receivedDateTime).toISOString();
  if (received.slice(0, 19) !== value.receivedDateTime.slice(0, 19)) fail('invalid_mailbox_message', 422);
  if (!object(value.body) || typeof value.body.contentType !== 'string' || !['text', 'html'].includes(value.body.contentType.toLowerCase())) fail('invalid_mailbox_message', 422);
  const message = cleanText(value.body.content, {html: value.body.contentType.toLowerCase() === 'html', maxLength: 6000});
  if (!message) fail('invalid_mailbox_message', 422);
  return {
    message_id: validateId(value.id),
    thread_id: validateId(value.conversationId),
    internet_message_id: internetMessageId(value.internetMessageId),
    folder_id: folderId,
    received_at: received,
    // This is Graph's non-inline attachment flag. Attachments are never read.
    has_attachments: value.hasAttachments,
    intake: {
      customer_email: customerEmail,
      customer_name: shortText(value.from.emailAddress.name, 200, customerEmail),
      subject: shortText(value.subject, 200, '(No subject)'),
      message,
    },
  };
}

export async function readBoundedJson(response) {
  if (!response || response.status !== 200 || response.redirected === true) {
    const status = response?.status;
    fail(status === 429 ? 'mailbox_provider_rate_limited' : status === 401 || status === 403 ? 'mailbox_provider_access_denied' : 'mailbox_provider_unavailable', status === 429 ? 429 : 502);
  }
  const advertised = response.headers?.get('content-length');
  if (advertised !== null && advertised !== undefined && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_RESPONSE_BYTES)) {
    try { await response.body?.cancel(); } catch { /* No provider text in errors. */ }
    fail('mailbox_provider_response_too_large');
  }
  const type = response.headers?.get('content-type') || '';
  if (!/^application\/json(?:\s*;|$)/i.test(type) || !response.body?.getReader) fail('invalid_mailbox_provider_response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let bytes = 0, text = '';
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail('invalid_mailbox_provider_response');
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* Best effort cancellation. */ }
        fail('mailbox_provider_response_too_large');
      }
      text += decoder.decode(value, {stream: true});
    }
    text += decoder.decode();
    const result = JSON.parse(text);
    if (!object(result)) fail('invalid_mailbox_provider_response');
    return result;
  } catch (error) {
    try { await reader.cancel(); } catch { /* Never retain an unread error stream. */ }
    if (error instanceof MailboxProviderError) throw error;
    fail('invalid_mailbox_provider_response');
  } finally { reader.releaseLock(); }
}

function listResult(value, limit) {
  if (!Array.isArray(value.value) || value.value.length > limit
      || (value['@odata.nextLink'] !== undefined && (typeof value['@odata.nextLink'] !== 'string' || !value['@odata.nextLink'].trim()))) fail('invalid_mailbox_provider_response');
  return {values: value.value, hasMore: typeof value['@odata.nextLink'] === 'string'};
}

function ordinaryFolder(value) {
  return object(value) && value.isHidden === false
    && (value['@odata.type'] === undefined || value['@odata.type'] === '#microsoft.graph.mailFolder')
    && !['filterQuery', 'sourceFolderIds', 'includeNestedFolders', 'isSupported'].some(key => Object.hasOwn(value, key));
}

function normalizeFolder(value) {
  if (!ordinaryFolder(value)) fail('unsupported_mailbox_folder', 422);
  return {id: validateId(value.id), name: shortText(value.displayName, 200)};
}

function authorizationBinding(value, folderId, requiredFolder = false) {
  const c = value?.connection;
  if (!object(value) || !object(c) || c.provider !== 'microsoft' || c.status !== 'Connected' || c.oauth_verified_version !== 1
      || !Array.isArray(c.scopes) || !c.scopes.every(scope => typeof scope === 'string') || !c.scopes.includes('Mail.Read')) fail('mailbox_read_not_authorized', 403);
  validateId(c.id);
  validateId(c.external_account_id);
  if (value.mailbox_id !== c.external_account_id) fail('mailbox_identity_mismatch', 403);
  if ((requiredFolder && value.folder_id !== folderId) || (value.folder_id != null && folderId !== undefined && value.folder_id !== folderId)) fail('mailbox_folder_not_authorized', 403);
  // Token refresh timestamps/revision may advance; account, tenant, OAuth grant,
  // credential slots and source selection may not change during a read.
  const keys = ['id', 'organization_id', 'integration_id', 'provider', 'status', 'tenant_id', 'client_id', 'external_account_id', 'oauth_verified_version', 'oauth_revision', 'access_secret_id', 'refresh_secret_id', 'client_secret_id'];
  return JSON.stringify({connection: Object.fromEntries(keys.map(key => [key, c[key] ?? null])), scopes: [...new Set(c.scopes)].sort(), mailbox_id: value.mailbox_id, folder_id: value.folder_id ?? null});
}

/**
 * Source-only provider contract, equally usable by a later authorized manual or
 * scheduled caller. This module creates no schedules and makes no writes.
 * authorize(): fresh server-side authority -> {connection, mailbox_id, folder_id?}
 * getAccessToken(connection): existing server-only Microsoft credential helper.
 * folders(): {folders:[{id,name}], has_more}; at most 50 top-level choices.
 * folder(id): {id,name}; actual ordinary folder from the bounded top-level list.
 * preview(id): {messages, has_more, skipped}; at most 10 recent non-draft items.
 * Preview requires the exact folder_id in every authorization result. A single
 * page is deliberate: has_more does not claim a complete mailbox/backfill.
 */
export function createMicrosoftIntakeProvider({fetchImpl = fetch, authorize, getAccessToken} = {}) {
  if (typeof fetchImpl !== 'function' || typeof authorize !== 'function' || typeof getAccessToken !== 'function') fail('invalid_mailbox_provider_configuration', 500);

  async function operation(folderId, requiredFolder = false) {
    if (folderId !== undefined) validateId(folderId);
    const initial = await authorize();
    const binding = authorizationBinding(initial, folderId, requiredFolder);
    const check = async () => {
      const fresh = await authorize();
      if (authorizationBinding(fresh, folderId, requiredFolder) !== binding) fail('mailbox_authorization_changed', 409);
    };
    let token;
    try { token = await getAccessToken(initial.connection); } catch { fail('mailbox_credentials_unavailable', 503); }
    if (typeof token !== 'string' || !token || token.length > 32768 || /[^\x21-\x7e]/.test(token)) fail('mailbox_credentials_unavailable', 503);

    async function request(path = '', query = {}) {
      const url = `${GRAPH}${path}?${new URLSearchParams(query)}`;
      const options = {method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20000),
        headers: {Authorization: `Bearer ${token}`, Accept: 'application/json', Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"'}};
      await check(); // No other asynchronous work before the fixed Graph request.
      let response;
      try { response = await fetchImpl(url, options); } catch { fail('mailbox_provider_unavailable', 503); }
      return readBoundedJson(response);
    }

    const account = await request('', {$select: 'id,mail,userPrincipalName'});
    if (account.id !== initial.mailbox_id) fail('mailbox_identity_mismatch', 403);
    const ownAddresses = new Set();
    for (const value of [account.mail, account.userPrincipalName]) {
      if (value !== undefined && value !== null && value !== '') ownAddresses.add(email(value).toLowerCase());
    }
    if (!ownAddresses.size) fail('mailbox_identity_mismatch', 403);
    return {request, check, ownAddresses};
  }

  async function readFolders(context) {
    const result = listResult(await context.request('/mailFolders', {$top: String(FOLDER_LIMIT), $select: FOLDER_FIELDS, includeHiddenFolders: 'false'}), FOLDER_LIMIT);
    const folders = [], seen = new Set();
    for (const value of result.values) {
      if (!ordinaryFolder(value)) continue;
      const folder = normalizeFolder(value);
      if (seen.has(folder.id)) fail('invalid_mailbox_provider_response');
      seen.add(folder.id); folders.push(folder);
    }
    return {folders, has_more: result.hasMore};
  }

  async function readFolder(context, id) {
    // Direct GET accepts nested IDs too. Require fresh membership in the same
    // first-page top-level choices offered by discovery before reading the ID.
    const choices = await readFolders(context);
    if (!choices.folders.some(folder => folder.id === id)) fail('unsupported_mailbox_folder', 422);
    const result = normalizeFolder(await context.request(`/mailFolders/${encodeURIComponent(id)}`, {$select: FOLDER_FIELDS}));
    if (result.id !== id) fail('mailbox_folder_mismatch', 409);
    return result;
  }

  return Object.freeze({
    async folders() {
      const context = await operation();
      const result = await readFolders(context);
      await context.check();
      return result;
    },
    async folder(id) {
      const context = await operation(id);
      const result = await readFolder(context, id);
      await context.check();
      return result;
    },
    async preview(folderId) {
      const context = await operation(folderId, true);
      await readFolder(context, folderId);
      // Graph requires ordered properties first in the filter when also sorting.
      const result = listResult(await context.request(`/mailFolders/${encodeURIComponent(folderId)}/messages`, {
        $top: String(MESSAGE_LIMIT), $select: MESSAGE_FIELDS,
        $filter: 'receivedDateTime ge 1970-01-01T00:00:00Z and isDraft eq false', $orderby: 'receivedDateTime desc',
      }), MESSAGE_LIMIT);
      const messages = [], seen = new Set();
      let skipped = 0;
      for (const value of result.values) {
        try {
          const message = normalizeMessage(value, folderId);
          const sender = value.sender?.emailAddress?.address;
          // Conservative outgoing exclusion; aliases and From are not authenticated.
          if (context.ownAddresses.has(message.intake.customer_email.toLowerCase())
              || (sender !== undefined && sender !== null && context.ownAddresses.has(email(sender).toLowerCase())) || seen.has(message.message_id)) {
            skipped++; continue;
          }
          seen.add(message.message_id); messages.push(message);
        } catch (error) {
          if (!(error instanceof MailboxProviderError)) throw error;
          skipped++;
        }
      }
      messages.sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at));
      await context.check();
      return {messages, has_more: result.hasMore, skipped};
    },
  });
}
