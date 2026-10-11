import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../candidate/edge/mailbox-intake/handler.mjs';
const org='00000000-0000-4000-8000-000000000001',installation='00000000-0000-4000-8000-000000000002',actor='10000000-0000-4000-8000-000000000001',connection='50000000-0000-4000-8000-000000000002',preview='20000000-0000-4000-8000-000000000001',workflow='30000000-0000-4000-8000-000000000001';
const source={id:preview,revision:1,organization_id:org,installation_id:installation,installation_revision:1,connection_id:connection,mailbox_id:'own-mailbox',folder_id:'folder-1',folder_name:'Inquiries',saved_by:actor,saved_at:'2026-10-11T00:00:00Z'};
const authority={provider:'microsoft',connection_id:connection,mailbox_id:'own-mailbox',connection_fingerprint:'a'.repeat(64),mail_read:true,source};
const msg={message_id:'immutable-1',thread_id:'conversation',internet_message_id:'<inquiry@example.test>',folder_id:'folder-1',received_at:'2026-10-11T00:00:00Z',has_attachments:false,intake:{customer_email:'fixture@example.test',customer_name:'Fixture',subject:'Inquiry',message:'Untrusted content'}};
function setup({rpcError=null,roleDenied=false,authUser={id:actor},onRPC=null}={}){
 const calls=[],providers=[];
 const supabase={auth:{getUser:async()=>({data:{user:authUser}})},rpc:async(name,args)=>{
  calls.push({name,args});if(onRPC){const x=onRPC(name,args,calls);if(x)return x}
  if(roleDenied)return {error:{code:'P0001',message:'Manager authorization required'}};
  if(rpcError)return {error:rpcError};
  if(name==='mailbox_intake_authorize')return {data:structuredClone(authority)};
  if(name==='mailbox_intake_load')return {data:{source,capabilities:{provider:'microsoft',connection_id:connection,mail_read:true,mailbox_id:'own-mailbox',account_name:'Connected Microsoft account'},imports:[]}};
  if(name==='mailbox_intake_save')return {data:{...source,revision:2}};
  if(name==='mailbox_intake_capture')return {data:[{...msg,id:preview,expires_at:'2026-10-11T00:15:00Z'}]};
  if(name==='mailbox_intake_import')return {data:{workflow_id:workflow,replayed:false}};
  throw Error('Unexpected RPC');
 },from:()=>({select:()=>({eq:()=>({eq:()=>({single:async()=>({data:{id:connection,organization_id:org,provider:'microsoft',external_account_id:'own-mailbox',scopes:['Mail.Read']}})})})})})};
 const handler=createHandler({supabase,getAccessToken:async()=>{throw Error('mock should not read secrets')},allowedOrigins:['https://www.cerbtek.com'],providerFactory:({authorize})=>({
  folders:async()=>{await authorize();providers.push('folders');return {folders:[{id:'folder-1',name:'Inquiries'}],has_more:false}},
  folder:async id=>{await authorize();providers.push('folder');return {id,name:'Inquiries'}},
  preview:async()=>{await authorize();providers.push('preview');return {messages:[msg],has_more:true,skipped:1}},
 })});
 const call=async(body={},options={})=>{const r=await handler(new Request('https://example.test/mailbox-intake',{method:options.method||'POST',headers:{authorization:'Bearer fixture',origin:'https://www.cerbtek.com',...options.headers},...(options.method==='OPTIONS'?{}:{body:JSON.stringify({operation:'load',organization_id:org,installation_id:installation,installation_revision:1,...body})})}));return {status:r.status,headers:r.headers,body:r.status===204?null:await r.json()}};
 return {calls,providers,call};
}
test('load is current-organization manager RPC only; minimal browser projection and no provider access',async()=>{const f=setup(),r=await f.call();assert.equal(r.status,200);assert.deepEqual(Object.keys(r.body.source).sort(),['id','revision','folder_id','folder_name','mailbox_id'].sort());assert.equal(f.providers.length,0);assert.equal(f.calls[0].args.p_actor,actor);assert.equal(r.headers.get('cache-control'),'no-store')});
test('anonymous/invalid auth, forbidden origin and caller actor/body fields fail before provider access',async()=>{
 for(const authUser of [null,{id:actor,is_anonymous:true}]){const f=setup({authUser});assert.equal((await f.call()).status,401);assert.equal(f.calls.length,0)}
 const f=setup();assert.equal((await f.call({p_actor:'forged'})).status,400);assert.equal((await f.call({}, {headers:{origin:'https://evil.example'}})).status,403);assert.equal(f.calls.length,0);assert.equal(f.providers.length,0);
 assert.equal((await f.call({}, {method:'OPTIONS'})).status,204);
});
test('manager denial and missing scope fail closed before any mailbox response',async()=>{
 const f=setup({roleDenied:true});const r=await f.call({operation:'folders'});assert.equal(r.status,403);assert.equal(f.providers.length,0);
 const g=setup({rpcError:{code:'P0001',message:'mail_read_required'}});assert.equal((await g.call({operation:'folders'})).body.error,'mail_read_required');
});
test('preview authorizes before provider then atomically captures exact provider snapshot, no client text',async()=>{
 const f=setup();const r=await f.call({operation:'preview',source_revision:1});assert.equal(r.status,200);assert.equal(r.body.previews[0].intake.message,'Untrusted content');assert.equal(r.body.previews[0].internet_message_id,undefined);
 const cap=f.calls.find(c=>c.name==='mailbox_intake_capture');assert.deepEqual(cap.args.p_messages,[msg]);assert.deepEqual(cap.args.p_expected_binding,authority);assert.equal(r.body.has_more,true);assert.equal(r.body.skipped,1);
 assert.equal((await f.call({operation:'preview',source_revision:1,message:'forged'})).status,400);
});
test('import uses only preview ID, derives actor, never contacts provider and preserves unknown write status',async()=>{
 const f=setup();const r=await f.call({operation:'import',source_revision:1,preview_id:preview});assert.equal(r.body.workflow_id,workflow);assert.equal(f.providers.length,0);assert.equal(f.calls.length,1);assert.equal(f.calls[0].args.p_preview,preview);
 const g=setup({rpcError:{code:'NETWORK',message:'secret provider detail'}});const unknown=await g.call({operation:'import',source_revision:1,preview_id:preview});assert.equal(unknown.body.write_outcome,'unknown');assert.ok(!JSON.stringify(unknown.body).includes('secret'));
});
test('authority mutation between provider and capture prevents returning stale mail',async()=>{
 let n=0;const f=setup({onRPC:name=>name==='mailbox_intake_authorize'&&++n>=3?{data:{...authority,connection_fingerprint:'b'.repeat(64)}}:null});
 const r=await f.call({operation:'preview',source_revision:1});assert.equal(r.status,409);assert.equal(r.body.previews,undefined);assert.ok(!f.calls.some(c=>c.name==='mailbox_intake_capture'));
});
