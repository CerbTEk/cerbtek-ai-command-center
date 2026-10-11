// Bounded Google/Gmail boundary. Only a server-derived, freshly approved payload
// may reach send(). Inbox sender headers never confer authority. No live calls in tests.
// Docs checked 2026-10-11: developers.google.com/identity/openid-connect/openid-connect
// and developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
import {readBoundedJson} from '../mailbox-intake/provider.mjs';
export const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalidUnicode = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const unsafeHeader = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
export class GmailSendError extends Error {
  constructor(code, status = 409) { super(code); this.name = 'GmailSendError'; this.code = code; this.status = status; this.outcome = 'not_attempted'; }
}
const fail = (code, status) => { throw new GmailSendError(code, status); };
export function validateGmailAddress(value) {
  if (typeof value !== 'string' || value.length > 320 || value !== value.trim()
      || !/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value)) fail('invalid_google_mailbox_address', 422);
  const [local, domain] = value.split('@');
  if (local.length > 64 || domain.length > 253 || domain.split('.').some(label => label.length > 63)) fail('invalid_google_mailbox_address', 422);
  return value;
}
export function validateGoogleSubjectId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(value)) fail('invalid_google_mailbox_identity', 403);
  return value;
}
export function validateGmailId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail('invalid_gmail_reference', 400);
  return value;
}
export function stableGoogleValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableGoogleValue).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableGoogleValue(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function googleConnectionBinding(connection, requiredScope) {
  if (!object(connection) || connection.provider !== 'google' || connection.status !== 'Connected' || connection.oauth_verified_version !== 1
      || !Array.isArray(connection.scopes) || !connection.scopes.every(scope => typeof scope === 'string') || !connection.scopes.includes(requiredScope)) fail('google_mailbox_not_authorized', 403);
  validateGoogleSubjectId(connection.external_account_id);
  validateGmailAddress(connection.external_account_email);
  // Refresh-only metadata may advance. Grant, identity, organization, credential
  // slots and resource scopes are immutable during one operation.
  const keys = ['id','organization_id','integration_id','provider','status','tenant_id','client_id','external_account_id','external_account_email','oauth_verified_version','oauth_revision','access_secret_id','refresh_secret_id','client_secret_id'];
  if (['id','organization_id','integration_id'].some(key => typeof connection[key] !== 'string' || !connection[key])) fail('google_mailbox_not_authorized', 403);
  return {connection: Object.fromEntries(keys.map(key => [key, connection[key] ?? null])), scopes: [...new Set(connection.scopes)].sort(),
    granted_scopes: Array.isArray(connection.oauth_granted_scopes) ? [...new Set(connection.oauth_granted_scopes)].sort() : null};
}
export function verifyGoogleIdentity(profile, connection) {
  if (!object(profile) || profile.sub !== connection.external_account_id || profile.email_verified !== true
      || validateGmailAddress(profile.email).toLowerCase() !== connection.external_account_email.toLowerCase()) fail('google_mailbox_identity_mismatch', 403);
  return profile.email;
}
export function validateGoogleToken(token) {
  if (typeof token !== 'string' || !token || token.length > 32768 || /[^\x21-\x7e]/.test(token)) fail('google_mailbox_credentials_unavailable', 503);
  return token;
}
function validatePayload(value) {
  if (!object(value) || Object.keys(value).length !== 3 || !['recipient','subject','body'].every(key => Object.hasOwn(value, key))) fail('invalid_gmail_send_payload', 400);
  validateGmailAddress(value.recipient);
  if (typeof value.subject !== 'string' || !value.subject.trim() || value.subject.length > 998 || unsafeHeader.test(value.subject) || invalidUnicode.test(value.subject)
      || typeof value.body !== 'string' || !value.body.trim() || value.body.length > 100000 || invalidUnicode.test(value.body) || /[\u0000]/u.test(value.body)
      || new TextEncoder().encode(value.body).length > 200000) fail('invalid_gmail_send_payload', 400);
  return value;
}
function base64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
export function encodeGmailRaw(value) {
  return base64(new TextEncoder().encode(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function encodedSubject(value) {
  // RFC 2047 UTF-8 encoded-words: split on codepoints, never within a UTF-8
  // sequence. Encoding all text also makes header-looking text inert.
  const words = []; let chunk = '', bytes = 0;
  for (const character of value) {
    const size = new TextEncoder().encode(character).length;
    if (bytes + size > 42) { words.push(`=?UTF-8?B?${base64(new TextEncoder().encode(chunk))}?=`); chunk = ''; bytes = 0; }
    chunk += character; bytes += size;
  }
  if (chunk) words.push(`=?UTF-8?B?${base64(new TextEncoder().encode(chunk))}?=`);
  return words.join('\r\n ');
}
export function constructMime(value) {
  if (!object(value) || Object.keys(value).length !== 4 || !['from','recipient','subject','body'].every(key => Object.hasOwn(value, key))) fail('invalid_gmail_send_payload', 400);
  const {from, recipient, subject, body} = value;
  validateGmailAddress(from); validatePayload({recipient, subject, body});
  // Base64 MIME content preserves exact UTF-8 body bytes, including line endings.
  // It cannot create headers, CC/BCC, attachments, or additional MIME parts.
  const encodedBody = base64(new TextEncoder().encode(body)).match(/.{1,76}/g)?.join('\r\n') || '';
  return `From: ${from}\r\nTo: ${recipient}\r\nSubject: ${encodedSubject(subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encodedBody}\r\n`;
}
function sendBinding(value, payload) {
  const binding = googleConnectionBinding(value?.connection, GMAIL_SEND_SCOPE);
  if (!object(value) || value.mailbox_id !== value.connection.external_account_id || validateGmailAddress(value.account_email).toLowerCase() !== value.connection.external_account_email.toLowerCase()
      || !((object(value.approved_binding) && Object.keys(value.approved_binding).length > 0) || (typeof value.approved_binding === 'string' && value.approved_binding.length > 0))
      || stableGoogleValue(validatePayload(value.payload)) !== stableGoogleValue(payload)) fail('gmail_send_not_authorized', 403);
  return stableGoogleValue({...binding, mailbox_id: value.mailbox_id, account_email: value.account_email, approved_binding: value.approved_binding, payload: value.payload});
}
/** authorize() is read-only and must reload the exact approved payload and account.
 * beforeDispatch() atomically records the durable dispatch receipt. No send can
 * happen without it. The caller owns the claim/approval/idempotency state machine.
 * An unknown result MUST remain pending review and MUST NOT be automatically retried.
 */
export function createGmailSendProvider({fetchImpl = fetch, authorize, getAccessToken, beforeDispatch} = {}) {
  if (![fetchImpl, authorize, getAccessToken, beforeDispatch].every(value => typeof value === 'function')) fail('invalid_gmail_send_configuration', 500);
  return Object.freeze({async send(input) {
    const payload = structuredClone(validatePayload(input));
    const readAuthority = async () => { try { return await authorize(); } catch { fail('gmail_send_authorization_unavailable', 409); } };
    const initial = await readAuthority();
    const binding = sendBinding(initial, payload);
    const check = async () => { const fresh = await readAuthority(); if (sendBinding(fresh, payload) !== binding) fail('gmail_send_authorization_changed', 409); };
    let token;
    try { token = validateGoogleToken(await getAccessToken(initial.connection)); } catch { fail('google_mailbox_credentials_unavailable', 503); }
    const headers = {Authorization: `Bearer ${token}`, Accept: 'application/json'};
    await check();
    let profile;
    try { profile = await readBoundedJson(await fetchImpl(GOOGLE_USERINFO_URL, {method:'GET',redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(20000),headers})); }
    catch { fail('google_mailbox_identity_unavailable', 503); }
    const ownAddress = verifyGoogleIdentity(profile, initial.connection);
    const raw = encodeGmailRaw(constructMime({from: ownAddress, ...payload}));
    const options = {method:'POST',redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(20000),headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({raw})};
    await check();
    try { await beforeDispatch({mailbox_id:initial.mailbox_id,account_email:ownAddress,approved_binding:structuredClone(initial.approved_binding),payload:structuredClone(payload)}); }
    catch { fail('gmail_dispatch_not_recorded', 409); }
    // No retry, token refresh, or re-authorization once the POST starts. A
    // timeout, rejection, malformed success, stream error or redirect is unknown.
    try {
      const response = await fetchImpl(SEND_URL, options);
      const data = await readBoundedJson(response);
      validateGmailId(data.id); validateGmailId(data.threadId);
      return {outcome:'accepted',provider_message_id:data.id,provider_thread_id:data.threadId};
    } catch { return {outcome:'unknown',error:'gmail_send_outcome_unknown'}; }
  }});
}
