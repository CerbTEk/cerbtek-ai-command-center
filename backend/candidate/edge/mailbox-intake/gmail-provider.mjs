// Read-only Gmail selected-label intake. A Google identity authenticates the
// connected mailbox only; From/Sender/Reply-To remain untrusted routing data.
// Docs checked 2026-10-11: developers.google.com/workspace/gmail/api/reference/rest/v1/
// users.labels/{list,get}, users.messages/{list,get}, users/getProfile.
import {MailboxProviderError, readBoundedJson, cleanText} from './provider.mjs';
import {GMAIL_READ_SCOPE, GOOGLE_USERINFO_URL, googleConnectionBinding, stableGoogleValue,
  validateGmailAddress, validateGmailId, validateGoogleToken, verifyGoogleIdentity} from '../_shared/gmail-send.mjs';
const ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me';
const LABEL_LIMIT = 50, MESSAGE_LIMIT = 10, MAX_PARTS = 64, MAX_DEPTH = 8, MAX_BODY_BYTES = 65536;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, status = 422) => { throw new MailboxProviderError(code, status); };
const unsafeHeader = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const unsupportedLabels = new Set(['SENT','DRAFT','SPAM','TRASH','CHAT']);
const systemLabels = new Set(['INBOX','STARRED','IMPORTANT','UNREAD','CATEGORY_PERSONAL','CATEGORY_SOCIAL','CATEGORY_PROMOTIONS','CATEGORY_UPDATES','CATEGORY_FORUMS']);
function id(value) { try { return validateGmailId(value); } catch { fail('invalid_mailbox_reference',400); } }
function email(value) { try { return validateGmailAddress(value); } catch { fail('invalid_mailbox_sender'); } }
function headerText(value, max = 8192) {
  if (typeof value !== 'string' || value.length > max || unsafeHeader.test(value)) fail('invalid_mailbox_header');
  return value;
}
function headers(value) {
  if (!Array.isArray(value) || value.length > 100) fail('invalid_mailbox_header');
  const result = new Map();
  for (const item of value) {
    if (!object(item) || typeof item.name !== 'string' || !/^[A-Za-z0-9-]{1,78}$/.test(item.name) || typeof item.value !== 'string' || item.value.length > 8192) fail('invalid_mailbox_header');
    const name = item.name.toLowerCase();
    // Non-routing headers are ignored, never trusted or copied into outgoing mail.
    if (!['from','sender','reply-to','subject','message-id','content-type','content-disposition'].includes(name)) continue;
    if (result.has(name)) fail('ambiguous_mailbox_header');
    result.set(name, headerText(item.value));
  }
  return result;
}
function decodeBase64(value, url = true) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_BODY_BYTES * 4 / 3) + 4
      || !(url ? /^[A-Za-z0-9_-]*={0,2}$/ : /^[A-Za-z0-9+/]*={0,2}$/).test(value)
      || value.replace(/=+$/, '').length % 4 === 1 || (value.includes('=') && value.length % 4 !== 0)) fail('invalid_mailbox_encoding');
  const unpadded = value.replace(/=+$/, '');
  let binary;
  try { binary = atob((url ? unpadded.replace(/-/g,'+').replace(/_/g,'/') : unpadded).padEnd(Math.ceil(unpadded.length / 4) * 4,'=')); }
  catch { fail('invalid_mailbox_encoding'); }
  if (binary.length > MAX_BODY_BYTES) fail('mailbox_message_too_large');
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  // Reject noncanonical encodings with ignored low bits rather than silently
  // accepting more than one representation of the same input.
  const canonical = btoa(binary).replace(/=+$/, '');
  if ((url ? canonical.replace(/\+/g,'-').replace(/\//g,'_') : canonical) !== unpadded) fail('invalid_mailbox_encoding');
  return bytes;
}
function decodeBytes(bytes, charset = 'utf-8') {
  charset = charset.toLowerCase();
  if (!['utf-8','utf8','us-ascii','ascii','iso-8859-1','windows-1252'].includes(charset)) fail('unsupported_mailbox_charset');
  if (['us-ascii','ascii'].includes(charset) && bytes.some(byte => byte > 127)) fail('invalid_mailbox_encoding');
  try { return new TextDecoder(charset === 'utf8' ? 'utf-8' : charset, {fatal:true}).decode(bytes); }
  catch { fail('invalid_mailbox_encoding'); }
}
function decodeWords(value) {
  headerText(value);
  // Whitespace between adjacent encoded-words is folding, not content.
  value = value.replace(/(\?=)[ \t]+(?==\?)/g,'$1');
  const result = value.replace(/=\?([^?\s]{1,40})\?([bq])\?([^?]*)\?=/gi, (_, charset, encoding, encoded) => {
    let bytes;
    if (encoding.toLowerCase() === 'b') bytes = decodeBase64(encoded, false);
    else {
      if (/[^\x21-\x7e]|=(?![0-9a-f]{2})/i.test(encoded)) fail('invalid_mailbox_encoding');
      const text = encoded.replace(/_/g,' ').replace(/=([0-9a-f]{2})/gi,(_all,hex)=>String.fromCharCode(parseInt(hex,16)));
      bytes = Uint8Array.from(text, char=>char.charCodeAt(0));
    }
    return decodeBytes(bytes, charset);
  });
  if (/=\?/.test(result)) fail('invalid_mailbox_encoding');
  return headerText(result);
}
function singleAddress(value) {
  headerText(value, 2000);
  if (typeof value !== 'string' || !value.trim()) fail('invalid_mailbox_sender');
  value = value.trim();
  let address = value, name = '';
  if (value.includes('<') || value.includes('>')) {
    const match = value.match(/^([^<>]*)<([^<>]+)>$/);
    if (!match) fail('ambiguous_mailbox_reply_address');
    address = match[2]; name = match[1].trim();
    if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1,-1);
    // No groups, address lists, comments, escapes or additional addresses.
    if (/[,:;@\\()[\]"]/.test(name)) fail('ambiguous_mailbox_reply_address');
    name = decodeWords(name);
  }
  address = email(address);
  const display = cleanText(name || address, {maxLength:200}).replace(/\s+/g,' ').trim();
  if (!display) fail('invalid_mailbox_sender');
  return {address, name:display};
}
function subject(value) {
  const decoded = decodeWords(value ?? '(No subject)');
  const text = cleanText(decoded || '(No subject)', {maxLength:200}).replace(/\s+/g,' ').trim();
  return text || '(No subject)';
}
function messageId(value) {
  if (value === undefined || value === '') return null;
  headerText(value,998);
  if (!/^<[^<>\s@]+@[^<>\s@]+>$/.test(value) || /[^\x21-\x7e]/.test(value)) fail('invalid_mailbox_message');
  return value;
}
function extractBody(payload) {
  const plain = [], html = []; let count = 0, bytesRead = 0, hasAttachments = false;
  const visit = (part, depth) => {
    if (++count > MAX_PARTS || depth > MAX_DEPTH || !object(part) || typeof part.mimeType !== 'string' || part.mimeType.length > 100) fail('invalid_mailbox_mime');
    if (part.filename !== undefined && typeof part.filename !== 'string') fail('invalid_mailbox_mime');
    const metadata = headers(part.headers ?? []);
    const type = part.mimeType.toLowerCase();
    if ((part.filename || '') !== '' || part.body?.attachmentId !== undefined || /^attachment(?:\s*;|$)/i.test(metadata.get('content-disposition') || '') || type === 'message/rfc822') {
      hasAttachments = true; return; // No attachment retrieval or nested messages.
    }
    const children = part.parts ?? [];
    if (!Array.isArray(children) || children.length > MAX_PARTS) fail('invalid_mailbox_mime');
    if (type.startsWith('multipart/')) {
      if (!['multipart/mixed','multipart/alternative','multipart/related'].includes(type)) fail('unsupported_mailbox_mime');
      for (const child of children) visit(child, depth + 1);
      return;
    }
    if (children.length) fail('invalid_mailbox_mime');
    if (!['text/plain','text/html'].includes(type)) { hasAttachments = true; return; }
    if (!object(part.body)) fail('invalid_mailbox_mime');
    const bytes = decodeBase64(part.body.data ?? '');
    bytesRead += bytes.length;
    if (bytesRead > MAX_BODY_BYTES || (part.body.size !== undefined && (!Number.isSafeInteger(part.body.size) || part.body.size < 0 || part.body.size !== bytes.length))) fail('mailbox_message_too_large');
    const contentType = metadata.get('content-type') || '';
    const charsets = [...contentType.matchAll(/(?:^|;)\s*charset\s*=\s*(?:"([^";]+)"|([^;\s]+))/gi)];
    if (charsets.length > 1) fail('invalid_mailbox_mime');
    const text = decodeBytes(bytes, charsets[0]?.[1] || charsets[0]?.[2] || 'utf-8');
    (type === 'text/plain' ? plain : html).push(text);
  };
  visit(payload, 0);
  const usablePlain = plain.filter(value=>value.trim());
  const message = cleanText((usablePlain.length ? usablePlain : html).join('\n'), {html:usablePlain.length === 0,maxLength:6000});
  if (!message) fail('invalid_mailbox_message');
  return {message,hasAttachments};
}
export function normalizeGmailMessage(value, labelId) {
  id(labelId);
  if (!object(value) || !Array.isArray(value.labelIds) || value.labelIds.length > 100 || !value.labelIds.every(label=>typeof label==='string')
      || !value.labelIds.includes(labelId) || value.labelIds.some(label=>unsupportedLabels.has(label))) fail('invalid_mailbox_message');
  const metadata = headers(value.payload?.headers);
  const from = singleAddress(metadata.get('from'));
  for (const key of ['sender','reply-to']) if (metadata.has(key) && singleAddress(metadata.get(key)).address.toLowerCase() !== from.address.toLowerCase()) fail('ambiguous_mailbox_reply_address');
  if (typeof value.internalDate !== 'string' || !/^\d{1,15}$/.test(value.internalDate) || !Number.isSafeInteger(Number(value.internalDate))) fail('invalid_mailbox_message');
  const date = new Date(Number(value.internalDate));
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999) fail('invalid_mailbox_message');
  const {message,hasAttachments} = extractBody(value.payload);
  return {message_id:id(value.id),thread_id:id(value.threadId),internet_message_id:messageId(metadata.get('message-id')),folder_id:labelId,
    received_at:date.toISOString(),has_attachments:hasAttachments,
    intake:{customer_email:from.address,customer_name:from.name,subject:subject(metadata.get('subject')),message}};
}
function label(value) {
  if (!object(value) || !['user','system'].includes(value.type) || unsupportedLabels.has(value.id)
      || (value.type === 'system' && !systemLabels.has(value.id))) fail('unsupported_mailbox_folder');
  const name = cleanText(headerText(value.name,200), {maxLength:200}).replace(/\s+/g,' ').trim();
  if (!name) fail('unsupported_mailbox_folder');
  return {id:id(value.id),name};
}
function binding(value, labelId, required) {
  let connection;
  try { connection = googleConnectionBinding(value?.connection, GMAIL_READ_SCOPE); } catch { fail('mailbox_read_not_authorized',403); }
  if (value.mailbox_id !== value.connection.external_account_id || typeof value.account_email !== 'string'
      || value.account_email.toLowerCase() !== value.connection.external_account_email.toLowerCase()) fail('mailbox_identity_mismatch',403);
  if ((required && value.folder_id !== labelId) || (value.folder_id != null && labelId !== undefined && value.folder_id !== labelId)) fail('mailbox_folder_not_authorized',403);
  return stableGoogleValue({...connection,mailbox_id:value.mailbox_id,account_email:value.account_email,folder_id:value.folder_id ?? null});
}
export function createGmailIntakeProvider({fetchImpl=fetch,authorize,getAccessToken}={}) {
  if (![fetchImpl,authorize,getAccessToken].every(value=>typeof value==='function')) fail('invalid_mailbox_provider_configuration',500);
  async function operation(labelId, required=false) {
    if (labelId !== undefined) id(labelId);
    const initial = await authorize(), frozen = binding(initial,labelId,required);
    const check = async()=>{if(binding(await authorize(),labelId,required)!==frozen)fail('mailbox_authorization_changed',409)};
    let token;try {token=validateGoogleToken(await getAccessToken(initial.connection));} catch {fail('mailbox_credentials_unavailable',503)}
    async function request(path, query={}, identity=false) {
      const url = identity ? GOOGLE_USERINFO_URL : `${ROOT}${path}?${new URLSearchParams(query)}`;
      const options={method:'GET',redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}};
      await check();
      let response;try {response=await fetchImpl(url,options)}catch{fail('mailbox_provider_unavailable',503)}
      return readBoundedJson(response);
    }
    const identity = await request('',{},true);
    let ownAddress;try {ownAddress=verifyGoogleIdentity(identity,initial.connection)}catch{fail('mailbox_identity_mismatch',403)}
    const profile = await request('/profile',{fields:'emailAddress'});
    if (email(profile.emailAddress).toLowerCase() !== ownAddress.toLowerCase()) fail('mailbox_identity_mismatch',403);
    return {request,check,ownAddress:ownAddress.toLowerCase()};
  }
  async function readLabels(context) {
    // Gmail labels.list has no page-size/pagination parameter. Transport is byte-
    // bounded; at most 50 allowed choices are exposed in stable provider-ID order.
    const data=await context.request('/labels',{fields:'labels(id,name,type)'});
    if (!Array.isArray(data.labels)) fail('invalid_mailbox_provider_response',502);
    const choices=[],seen=new Set();
    for(const value of data.labels){
      if(!object(value))fail('invalid_mailbox_provider_response',502);
      if(unsupportedLabels.has(value.id)||(value.type==='system'&&!systemLabels.has(value.id)))continue;
      const normalized=label(value);if(seen.has(normalized.id))fail('invalid_mailbox_provider_response',502);
      seen.add(normalized.id);choices.push(normalized);
    }
    choices.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
    return {folders:choices.slice(0,LABEL_LIMIT),has_more:choices.length>LABEL_LIMIT};
  }
  async function readLabel(context,labelId){
    const choices=await readLabels(context);
    if(!choices.folders.some(value=>value.id===labelId))fail('unsupported_mailbox_folder');
    const actual=label(await context.request(`/labels/${encodeURIComponent(labelId)}`,{fields:'id,name,type'}));
    if(actual.id!==labelId)fail('mailbox_folder_mismatch',409);
    return actual;
  }
  return Object.freeze({
    async folders(){const context=await operation();const result=await readLabels(context);await context.check();return result},
    async folder(labelId){const context=await operation(labelId);const result=await readLabel(context,labelId);await context.check();return result},
    async preview(labelId){
      const context=await operation(labelId,true);await readLabel(context,labelId);
      const list=await context.request('/messages',{labelIds:labelId,maxResults:String(MESSAGE_LIMIT),includeSpamTrash:'false',q:'-in:sent -in:drafts',fields:'messages(id,threadId),nextPageToken'});
      if((list.messages!==undefined&&!Array.isArray(list.messages))||(list.messages?.length??0)>MESSAGE_LIMIT
          ||(list.nextPageToken!==undefined&&(typeof list.nextPageToken!=='string'||!list.nextPageToken||list.nextPageToken.length>2048)))fail('invalid_mailbox_provider_response',502);
      const messages=[],seen=new Set();let skipped=0;
      for(const item of list.messages??[]){
        if(!object(item))fail('invalid_mailbox_provider_response',502);
        const messageId=id(item.id),threadId=id(item.threadId);
        if(seen.has(messageId)){skipped++;continue}seen.add(messageId);
        const value=await context.request(`/messages/${encodeURIComponent(messageId)}`,{format:'full',fields:'id,threadId,labelIds,internalDate,payload'});
        if(value.id!==messageId||value.threadId!==threadId)fail('mailbox_message_mismatch',409);
        try {const normalized=normalizeGmailMessage(value,labelId);if(normalized.intake.customer_email.toLowerCase()===context.ownAddress){skipped++;continue}messages.push(normalized)}
        catch(error){if(!(error instanceof MailboxProviderError))throw error;skipped++}
      }
      messages.sort((a,b)=>Date.parse(b.received_at)-Date.parse(a.received_at));
      await context.check();return {messages,has_more:typeof list.nextPageToken==='string',skipped};
    },
  });
}
