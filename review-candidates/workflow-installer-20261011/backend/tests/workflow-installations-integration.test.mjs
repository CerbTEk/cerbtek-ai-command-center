import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../candidate/edge/workflow-installations/handler.mjs';
import {verifyInstallations,validInstallation} from '../../src/workflow-installation-model.js';
import {fixture,org,other,owner,admin,member,connection,key,config,intake,rpc,saveContext,approveActivation} from './fixtures/workflow-installation-fixture.mjs';
function app(d){
 const supabase={auth:{getUser:async token=>({data:{user:[owner,admin,member].includes(token)?{id:token}:null},error:null})},rpc:async(name,args)=>{
  try{const values=Object.values(args);const names=Object.keys(args);const data=(await d.query(`select public.${name}(${names.map((name,i)=>`${name} => $${i+1}`).join(',')}) value`,values)).rows[0].value;return {data,error:null}}catch(error){return {data:null,error:{code:error.code,message:error.message}}}
 }};
 const handler=createHandler({supabase,allowedOrigins:['https://www.cerbtek.com']});
 return async(body,actor=owner)=>{const response=await handler(new Request('https://synthetic.example.test/workflow-installations',{method:'POST',headers:{authorization:`Bearer ${actor}`,origin:'https://www.cerbtek.com'},body:JSON.stringify({organization_id:org,...body})}));return {status:response.status,data:await response.json()}};
}

test('HTTP→PostgreSQL→frontend verifier agrees on load/save/start and actor-scoped receipts',async()=>{
 const d=await fixture();try{
  const invoke=app(d);let response=await invoke({operation:'load'});assert.equal(response.status,200);assert.equal(verifyInstallations(response.data,org,owner).installations.length,0);
  const c=await saveContext(d);const cfg=await rpc(d,'ai_draft_save',[org,owner,0,config]);
  const saveBody={operation:'save',installation_id:null,expected_revision:0,request_key:key(100),recipe_key:'customer_followup',recipe_version:1,name:'Customer follow-up',outcome:'Respond using explicit saved company guidance.',bindings:{context_version_id:c.id,configuration_id:cfg.id,microsoft_connection_id:connection,assigned_to:member,reviewer_id:admin},limits:{max_open_requests:2}};
  response=await invoke(saveBody);assert.equal(response.status,200);const installation=response.data.installation;assert.equal(validInstallation(installation,org),true);assert.equal(installation.status,'configured');
  response=await invoke({operation:'load'});assert.equal(verifyInstallations(response.data,org,owner).installations[0].id,installation.id);assert.equal(response.data.recipes[0].recipe_version,1);assert.equal(response.data.operation_receipts[0].operation,'save');
  const startBody={operation:'start',installation_id:installation.id,expected_revision:1,request_key:key(200),intake};
  response=await invoke(startBody,member);assert.equal(response.status,200);const workflowId=response.data.workflow.id;assert.equal(response.data.provenance.workflow_id,workflowId);
  response=await invoke(startBody,member);assert.equal(response.data.replayed,true);assert.equal(response.data.workflow.id,workflowId);
  response=await invoke({operation:'load'},member);assert.equal(verifyInstallations(response.data,org,member).workspace.workflows[0].id,workflowId);assert.equal(response.data.operation_receipts[0].operation,'start');
  response=await invoke({...startBody,request_key:key(201)},admin);assert.equal(response.status,409);assert.equal(response.data.error,'reviewer_conflict');assert.equal(response.data.write_outcome,'not_applied');
  response=await invoke({operation:'load',organization_id:other});assert.equal(response.status,403);assert.equal(response.data.write_outcome,'not_applied');
 }finally{await d.close()}
});
test('full load with an independently active AI configuration remains verifiable without activating from installer',async()=>{
 const d=await fixture({activation:true});try{
  await saveContext(d);const cfg=await rpc(d,'ai_draft_save',[org,owner,0,config]);await approveActivation(d,cfg.id);
  const response=await app(d)({operation:'load'});assert.equal(response.status,200);assert.equal(verifyInstallations(response.data,org,owner).workspace.readiness.live_inference_enabled,true);
  assert.equal((await d.query('select count(*) from ai_draft_runs')).rows[0].count,0);
 }finally{await d.close()}
});
