import { createMicrosoftIntakeProvider, MailboxProviderError } from './provider.mjs';
import { createGmailIntakeProvider } from './gmail-provider.mjs';
import { GMAIL_READ_SCOPE } from '../_shared/gmail-send.mjs';
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const id=v=>typeof v==='string'&&v.length>0&&v.length<=1024&&!/[\x00-\x1f\x7f]/.test(v);
const ops={load:[],folders:[],save:['expected_source_revision','folder_id'],preview:['source_revision'],import:['source_revision','preview_id']};
class IntakeError extends Error {constructor(code,status=409,outcome='not_applied'){super(code);this.code=code;this.status=status;this.outcome=outcome}}
export function createHandler({supabase,getAccessToken,getGoogleAccessToken,fetchImpl=fetch,providerFactory,allowedOrigins=[]}){
 return async request=>{
  const origin=request.headers.get('origin'),headers={'Content-Type':'application/json','Cache-Control':'no-store',Vary:'Origin'};
  if(origin&&allowedOrigins.includes(origin))Object.assign(headers,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS'});
  const reply=(v,status=200)=>new Response(JSON.stringify(v),{status,headers});
  if(origin&&!allowedOrigins.includes(origin))return reply({ok:false,error:'origin_not_allowed',write_outcome:'not_applied'},403);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(request.method!=='POST')return reply({ok:false,error:'method_not_allowed',write_outcome:'not_applied'},405);
  let writeAttempted=false;
  try{
   const token=request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
   if(!token)throw new IntakeError('sign_in_required',401);
   const {data:session,error:authError}=await supabase.auth.getUser(token);
   if(authError||!uuid(session?.user?.id)||session.user.is_anonymous===true)throw new IntakeError('sign_in_required',401);
   const raw=await request.text();if(new TextEncoder().encode(raw).length>5000)throw new IntakeError('request_too_large',413);
   let body;try{body=JSON.parse(raw)}catch{throw new IntakeError('invalid_request',400)}
   if(!object(body)||!Object.hasOwn(ops,body.operation)||!exact(body,['operation','organization_id','installation_id','installation_revision',...ops[body.operation]]))throw new IntakeError('unsupported_request_fields',400);
   if(!uuid(body.organization_id)||!uuid(body.installation_id)||!Number.isSafeInteger(body.installation_revision)||body.installation_revision<1)throw new IntakeError('invalid_reference',400);
   if(['preview','import'].includes(body.operation)&&(!Number.isSafeInteger(body.source_revision)||body.source_revision<1))throw new IntakeError('invalid_revision',400);
   if(body.operation==='save'&&(!Number.isSafeInteger(body.expected_source_revision)||body.expected_source_revision<0||!id(body.folder_id)))throw new IntakeError('invalid_source',400);
   if(body.operation==='import'&&!uuid(body.preview_id))throw new IntakeError('invalid_preview',400);
   const args={p_org:body.organization_id,p_actor:session.user.id,p_installation:body.installation_id,p_revision:body.installation_revision};
   const rpc=async(name,extra={},writing=false)=>{
    if(writing)writeAttempted=true;
    const {data,error}=await supabase.rpc(name,{...args,...extra});
    if(error){
     if(['42P01','42883','3F000','PGRST202'].includes(error.code))throw new IntakeError('mailbox_intake_not_installed',503);
     if(error.code==='42501'||/access denied|authorization required/i.test(error.message||''))throw new IntakeError('organization_access_denied',403);
     if(['mail_read_required','mailbox_connection_unavailable'].includes(error.message))throw new IntakeError(error.message,409);
     if(['P0001','23514','23503','23505','22P02','22007','22008','40001','40P01','55P03','57014'].includes(error.code))throw new IntakeError('mailbox_source_changed_or_not_ready',409);
     throw new IntakeError('mailbox_storage_unavailable',503,writing?'unknown':'not_applied');
    }
    return data;
   };
   const envelope={ok:true,contract_version:2,organization_id:body.organization_id,installation_id:body.installation_id,installation_revision:body.installation_revision};
   const verifySource=s=>s===null||object(s)&&uuid(s.id)&&Number.isSafeInteger(s.revision)&&s.revision>0&&s.organization_id===body.organization_id&&s.installation_id===body.installation_id&&s.installation_revision===body.installation_revision&&id(s.folder_id)&&id(s.mailbox_id)&&typeof s.folder_name==='string';
   const publicSource=s=>s===null?null:Object.fromEntries(['id','revision','folder_id','folder_name','mailbox_id'].map(k=>[k,s[k]]));
   const invalid=()=>{throw new IntakeError('mailbox_response_unverified',503,writeAttempted?'unknown':'not_applied')};
   if(body.operation==='load'){
    const data=await rpc('mailbox_intake_load');
    if(!object(data)||!verifySource(data.source)||!object(data.capabilities)||typeof data.capabilities.mail_read!=='boolean'||!['microsoft','google'].includes(data.capabilities.provider)||!uuid(data.capabilities.connection_id)||!id(data.capabilities.mailbox_id)||typeof data.capabilities.account_name!=='string'||!Array.isArray(data.imports)||data.imports.length>20||!data.imports.every(r=>uuid(r.preview_id)&&uuid(r.workflow_id)&&id(r.message_id)))invalid();
    return reply({...envelope,...data,source:publicSource(data.source)});
   }
   if(body.operation==='import'){
    const data=await rpc('mailbox_intake_import',{p_source_revision:body.source_revision,p_preview:body.preview_id},true);
    if(!object(data)||!uuid(data.workflow_id)||typeof data.replayed!=='boolean')invalid();
    return reply({...envelope,...data});
   }
   let frozen;
   const authority=async()=>{
    const a=await rpc('mailbox_intake_authorize',{p_source_revision:body.operation==='preview'?body.source_revision:null,p_require_read:true});
    if(!object(a)||!['microsoft','google'].includes(a.provider)||!uuid(a.connection_id)||!id(a.mailbox_id)||(a.provider==='google'&&(typeof a.account_email!=='string'||!a.account_email))||a.mail_read!==true||typeof a.connection_fingerprint!=='string'||!verifySource(a.source))invalid();
    if(frozen&&JSON.stringify(a)!==JSON.stringify(frozen))throw new IntakeError('mailbox_source_changed_or_not_ready');
    frozen??=a;return a;
   };
   const authorize=async()=>{
    const a=await authority();
    const {data:c,error}=await supabase.from('oauth_connections').select('*').eq('id',a.connection_id).eq('organization_id',body.organization_id).single();
    if(error||!c||c.id!==a.connection_id||c.organization_id!==body.organization_id||c.provider!==a.provider||c.external_account_id!==a.mailbox_id||(a.provider==='google'&&c.external_account_email!==a.account_email)||!Array.isArray(c.scopes)||!c.scopes.includes(a.provider==='google'?GMAIL_READ_SCOPE:'Mail.Read'))throw new IntakeError('mailbox_connection_unavailable');
    return {connection:c,mailbox_id:a.mailbox_id,...(a.provider==='google'?{account_email:a.account_email}:{}),...(body.operation==='preview'?{folder_id:a.source.folder_id}:{})};
   };
   // Provider choice comes only from the frozen server authorization, never request fields.
   await authority();
   const providerName=frozen.provider;
   const factory=providerFactory??(providerName==='google'?createGmailIntakeProvider:createMicrosoftIntakeProvider);
   const access=providerName==='google'?getGoogleAccessToken:getAccessToken;
   const provider=factory({fetchImpl,authorize,getAccessToken:connection=>{if(typeof access!=='function')throw new IntakeError('mailbox_credentials_unavailable',503);return access(connection)}});
   if(body.operation==='folders'){
    const data=await provider.folders();await authority();
    if(!object(data)||!Array.isArray(data.folders)||data.folders.length>50||typeof data.has_more!=='boolean'||!data.folders.every(f=>id(f.id)&&typeof f.name==='string'&&f.name.length>0&&f.name.length<=200))invalid();
    return reply({...envelope,...data});
   }
   if(body.operation==='save'){
    const folder=await provider.folder(body.folder_id);await authority();
    if(!object(folder)||folder.id!==body.folder_id||typeof folder.name!=='string')invalid();
    const source=await rpc('mailbox_intake_save',{p_expected_source_revision:body.expected_source_revision,p_folder_id:folder.id,p_folder_name:folder.name,p_expected_binding:frozen},true);
    if(!verifySource(source)||source===null||source.revision!==body.expected_source_revision+1||source.folder_id!==body.folder_id)invalid();
    return reply({...envelope,source:publicSource(source)});
   }
   await authority();
   const data=await provider.preview(frozen.source.folder_id);await authority();
   if(!object(data)||!Array.isArray(data.messages)||data.messages.length>10||typeof data.has_more!=='boolean'||!Number.isSafeInteger(data.skipped)||data.skipped<0)invalid();
   const previews=await rpc('mailbox_intake_capture',{p_source_revision:body.source_revision,p_expected_binding:frozen,p_messages:data.messages},true);
   if(!Array.isArray(previews)||previews.length!==data.messages.length||!previews.every(p=>uuid(p.id)&&id(p.message_id)&&object(p.intake)&&typeof p.expires_at==='string'))invalid();
   return reply({...envelope,previews:previews.map(p=>Object.fromEntries(['id','expires_at','message_id','thread_id','received_at','has_attachments','intake'].map(k=>[k,p[k]]))),has_more:data.has_more,skipped:data.skipped});
  }catch(error){const known=error instanceof IntakeError||error instanceof MailboxProviderError;return reply({ok:false,error:known?error.code:'mailbox_intake_unavailable',write_outcome:error instanceof IntakeError?error.outcome:writeAttempted?'unknown':'not_applied'},known?error.status:503)}
 };
}
