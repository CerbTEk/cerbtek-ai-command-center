import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../candidate/edge/mailbox-intake/handler.mjs';
import {GMAIL_READ_SCOPE} from '../candidate/edge/_shared/gmail-send.mjs';
const org='00000000-0000-4000-8000-000000000001',installation='00000000-0000-4000-8000-000000000002',actor='10000000-0000-4000-8000-000000000001',connectionId='50000000-0000-4000-8000-000000000002',previewId='20000000-0000-4000-8000-000000000001',workflowId='30000000-0000-4000-8000-000000000001';
const mailbox='109876543210987654321',own='business@example.test',folderId='Label_42';
const source={id:previewId,revision:1,organization_id:org,installation_id:installation,installation_revision:1,connection_id:connectionId,mailbox_id:mailbox,folder_id:folderId,folder_name:'Customer inquiries',saved_by:actor,saved_at:'2026-10-11T00:00:00Z'};
const authority={provider:'google',connection_id:connectionId,mailbox_id:mailbox,account_email:own,account_name:'Business mailbox',connection_fingerprint:'a'.repeat(64),mail_read:true,source};
const connection={id:connectionId,organization_id:org,integration_id:'integration-fixture',provider:'google',status:'Connected',external_account_id:mailbox,external_account_email:own,oauth_verified_version:1,oauth_revision:'grant-fixture',scopes:['openid','email',GMAIL_READ_SCOPE]};
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
function fixture({onAuthority,onConnection,rpcError,providerTransform}={}){
 const calls=[],requests=[],tokens=[];let check=0;
 const supabase={auth:{getUser:async()=>({data:{user:{id:actor}}})},rpc:async(name,args)=>{
   calls.push({name,args});if(rpcError)return {error:rpcError};
   if(name==='mailbox_intake_authorize'){check++;return {data:onAuthority?onAuthority(structuredClone(authority),check):structuredClone(authority)}}
   if(name==='mailbox_intake_load')return {data:{source,capabilities:{provider:'google',connection_id:connectionId,mail_read:true,mailbox_id:mailbox,account_name:'Business mailbox'},imports:[]}};
   if(name==='mailbox_intake_save')return {data:{...source,revision:args.p_expected_source_revision+1}};
   if(name==='mailbox_intake_capture')return {data:args.p_messages.map(message=>({...message,id:previewId,expires_at:'2026-10-11T00:15:00Z'}))};
   if(name==='mailbox_intake_import')return {data:{workflow_id:workflowId,replayed:false}};
   throw Error('Unexpected RPC');
 },from:table=>{assert.equal(table,'oauth_connections');const filters={};const q={select:()=>q,eq:(key,value)=>{filters[key]=value;return q},single:async()=>{assert.deepEqual(filters,{id:connectionId,organization_id:org});return {data:onConnection?onConnection(structuredClone(connection)):structuredClone(connection)}}};return q}};
 const handler=createHandler({supabase,allowedOrigins:['https://www.cerbtek.com'],getAccessToken:async()=>{tokens.push('microsoft');throw Error('Google must not use Microsoft helper')},getGoogleAccessToken:async()=>{tokens.push('google');return 'fixture-token'},fetchImpl:async(url,options)=>{
   requests.push({url,options});const path=new URL(url).pathname;let data;
   if(path==='/v1/userinfo')data={sub:mailbox,email:own,email_verified:true};
   else if(path.endsWith('/profile'))data={emailAddress:own};
   else if(path.endsWith('/labels'))data={labels:[{id:folderId,name:'Customer inquiries',type:'user'}]};
   else if(path.endsWith(`/labels/${folderId}`))data={id:folderId,name:'Customer inquiries',type:'user'};
   else if(path.endsWith('/messages'))data={messages:[{id:'18af101',threadId:'18af100'}]};
   else if(path.endsWith('/messages/18af101'))data={id:'18af101',threadId:'18af100',labelIds:[folderId],internalDate:'1791633600000',payload:{mimeType:'text/plain',headers:[{name:'From',value:'Customer <customer@example.test>'},{name:'Subject',value:'Inquiry'}],body:{data:Buffer.from('What are your hours?').toString('base64url'),size:20}}};
   else throw Error('Unexpected transport');
   return json(providerTransform?providerTransform(data,path):data);
 }});
 const call=async(body={})=>{const response=await handler(new Request('https://fixture.test/mailbox-intake',{method:'POST',headers:{authorization:'Bearer fixture',origin:'https://www.cerbtek.com'},body:JSON.stringify({operation:'load',organization_id:org,installation_id:installation,installation_revision:1,...body})}));return {status:response.status,body:await response.json()}};
 return {call,calls,requests,tokens};
}
test('v2 Google load exposes provider capability and selected-label source without provider reads',async()=>{const f=fixture(),r=await f.call();assert.equal(r.status,200);assert.equal(r.body.contract_version,2);assert.equal(r.body.capabilities.provider,'google');assert.equal(r.body.capabilities.connection_id,connectionId);assert.deepEqual(Object.keys(r.body.source).sort(),['id','revision','folder_id','folder_name','mailbox_id'].sort());assert.equal(f.tokens.length,0);assert.equal(f.requests.length,0)});
test('Google label discovery dispatches from DB authority to Google helper and fixed Gmail provider',async()=>{const f=fixture(),r=await f.call({operation:'folders'});assert.equal(r.status,200);assert.deepEqual(r.body.folders,[{id:folderId,name:'Customer inquiries'}]);assert.deepEqual(f.tokens,['google']);assert.equal(f.requests.length,3);assert(f.requests.every(r=>r.options.method==='GET'))});
test('Google save freshly verifies label and persists only its exact selected provider identity',async()=>{const f=fixture(),r=await f.call({operation:'save',expected_source_revision:1,folder_id:folderId});assert.equal(r.status,200);assert.equal(r.body.source.revision,2);const write=f.calls.find(c=>c.name==='mailbox_intake_save');assert.equal(write.args.p_folder_id,folderId);assert.equal(write.args.p_folder_name,'Customer inquiries');assert.deepEqual(write.args.p_expected_binding,authority)});
test('Google preview captures bounded untrusted data from server-selected label and hides provider internals',async()=>{const f=fixture(),r=await f.call({operation:'preview',source_revision:1});assert.equal(r.status,200);assert.equal(r.body.previews.length,1);assert.equal(r.body.previews[0].intake.message,'What are your hours?');assert.equal(r.body.previews[0].internet_message_id,undefined);assert.equal(f.requests.length,6);const capture=f.calls.find(c=>c.name==='mailbox_intake_capture');assert.equal(capture.args.p_actor,actor);assert.equal(capture.args.p_messages[0].folder_id,folderId);assert.deepEqual(capture.args.p_expected_binding,authority)});
test('caller cannot choose provider, token, arbitrary URL, own mailbox or preview text',async()=>{for(const extra of [{provider:'google'},{access_token:'fake'},{url:'https://attacker.invalid'},{mailbox_id:'other'},{message:'forged'}]){const f=fixture(),r=await f.call({operation:'preview',source_revision:1,...extra});assert.equal(r.status,400);assert.equal(f.calls.length,0);assert.equal(f.requests.length,0)}});
test('unrecognized DB provider or authority mismatch is rejected before token lookup',async()=>{
 for(const mutate of [a=>({...a,provider:'caller-picked'}),a=>({...a,provider:undefined}),a=>({...a,account_email:null})]){const f=fixture({onAuthority:mutate});assert.equal((await f.call({operation:'folders'})).status,503);assert.equal(f.tokens.length,0)}
 for(const changes of [{provider:'microsoft'},{organization_id:installation},{external_account_id:'other'},{external_account_email:'other@example.test'},{scopes:['Mail.Read']}]){const f=fixture({onConnection:c=>({...c,...changes})});assert.equal((await f.call({operation:'folders'})).status,409);assert.equal(f.tokens.length,0);assert.equal(f.requests.length,0)}
});
test('frozen provider/scope/email changes during reads prevent stale preview capture',async()=>{for(const changes of [{provider:'microsoft'},{account_email:'other@example.test'},{connection_fingerprint:'b'.repeat(64)}]){const f=fixture({onAuthority:(a,n)=>n>=6?{...a,...changes}:a});const r=await f.call({operation:'preview',source_revision:1});assert.equal(r.status,409);assert.equal(r.body.previews,undefined);assert(!f.calls.some(c=>c.name==='mailbox_intake_capture'))}});
test('Google import is only a manager-authorized snapshot RPC, with no OAuth or Gmail operation',async()=>{const f=fixture(),r=await f.call({operation:'import',source_revision:1,preview_id:previewId});assert.equal(r.body.workflow_id,workflowId);assert.equal(f.calls.length,1);assert.equal(f.requests.length,0);assert.equal(f.tokens.length,0)});
test('controlled Gmail identity error is sanitized and no source write occurs',async()=>{const f=fixture({providerTransform:(data,path)=>path==='/v1/userinfo'?{...data,sub:'other'}:data}),r=await f.call({operation:'folders'});assert.equal(r.status,403);assert.equal(r.body.error,'mailbox_identity_mismatch');assert.equal(r.body.write_outcome,'not_applied');assert.equal(f.requests.length,1);assert(!f.calls.some(c=>c.name==='mailbox_intake_save'))});
