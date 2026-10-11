import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
const org='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const owner='10000000-0000-4000-8000-000000000001',admin='10000000-0000-4000-8000-000000000002',member='10000000-0000-4000-8000-000000000003',viewer='10000000-0000-4000-8000-000000000004',outsider='10000000-0000-4000-8000-000000000005';
const integration='50000000-0000-4000-8000-000000000001',connection='50000000-0000-4000-8000-000000000002';
const key=n=>`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const context={company_name:'Fictional Example LLC',reply_guidance:'Reply using these saved facts only. Support hours are 09:00–17:00 UTC.'};
const intake={customer_email:'customer@example.test',customer_name:'Synthetic Customer',subject:'Support hours',message:'When is support available?'};
const config={schema_version:1,provider:'openai',model:'fixture-model',task:'customer_reply',instructions:'Use only supplied business facts.',source:'manual_context',max_input_bytes:12000,max_output_tokens:1000,max_daily_runs:100,daily_budget_microusd:100000000,human_review:true};
const draft={title:'Support hours',body:'Our support hours are 09:00–17:00 UTC.',source_ids:['manual-1'],warnings:[]};
const rpc=async(d,name,args)=>(await d.query(`select to_jsonb(public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})) as result`,args)).rows[0].result;
const root=async(d,sql,args=[])=>{await d.exec('reset role');try{return await d.query(sql,args)}finally{await d.exec('set role service_role')}};
async function baseFixture({knowledge=false,activation=false}={}){
 const d=new PGlite();
 await d.exec(`create schema auth;create schema private;create role anon;create role authenticated;create role service_role bypassrls;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key);create table organizations(id uuid primary key,name text);
 create table organization_members(organization_id uuid,user_id uuid,role text,primary key(organization_id,user_id));
 create table staff_accounts(user_id uuid,active boolean,role text);
 create table integrations(id uuid primary key,organization_id uuid,provider text,integration_type text,status text,oauth_revision uuid);
 create table oauth_connections(id uuid primary key,organization_id uuid,integration_id uuid,provider text,status text,oauth_verified_version integer,external_account_id text,scopes text[],oauth_revision uuid);
 create table action_requests(id uuid primary key default gen_random_uuid(),organization_id uuid not null,integration_id uuid,connection_id uuid,provider text,action_type text,status text,title text,summary text,payload jsonb,requested_by uuid,approved_by uuid,approved_at timestamptz,rejected_by uuid,rejected_at timestamptz,executed_at timestamptz,error_message text,workflow_run_id uuid,created_at timestamptz default now(),updated_at timestamptz default now());
 alter table action_requests enable row level security;
 create table agent_run_requests(like action_requests including defaults);
 create table workflow_runs(id uuid primary key,organization_id uuid,status text,context jsonb);
 create table audit_events(id uuid primary key default gen_random_uuid(),organization_id uuid,actor_user_id uuid,event_type text,entity_type text,entity_id uuid,summary text,metadata jsonb);
 create function private.assert_workflow_action_approval(uuid,uuid,uuid,text) returns void language sql as $$select$$;
 create function public.assert_agent_workflow_lineage(uuid,uuid) returns jsonb language sql as $$select null::jsonb$$;
 create function private.microsoft_connection_binding(c public.oauth_connections,i public.integrations) returns jsonb language sql as $$select jsonb_build_object('connection_id',c.id,'integration_id',i.id,'account',c.external_account_id,'scopes',c.scopes,'revision',c.oauth_revision)$$;
 insert into auth.users values('${owner}'),('${admin}'),('${member}'),('${viewer}'),('${outsider}');
 insert into organizations values('${org}','Fixture Company'),('${other}','Other Fixture Company');
 insert into organization_members values('${org}','${owner}','owner'),('${org}','${admin}','admin'),('${org}','${member}','member'),('${org}','${viewer}','viewer'),('${other}','${outsider}','owner');
 insert into integrations values('${integration}','${org}','Microsoft','OAuth','Connected',gen_random_uuid());
 insert into oauth_connections values('${connection}','${org}','${integration}','microsoft','Connected',1,'fictional-account',array['Mail.Send'],gen_random_uuid());
 grant usage on schema public,private,auth to service_role,authenticated,anon;
 grant select,insert,update on all tables in schema public to service_role;`);
 for(const file of ['oauth-binding-fixture.sql','ai-draft-contract.sql','guard-contract.sql','reconciliation-contract.sql','customer-workflow-contract.sql',...(knowledge||activation?['company-knowledge-contract.sql','knowledge-draft-contract.sql']:[]),...(activation?['ai-inference-activation-contract.sql']:[])])await d.exec(await fs.readFile(new URL('./installer-dependencies/'+file,import.meta.url),'utf8'));
 await d.exec('set role service_role');return d;
}
const saveContext=(d,version=0,value=context)=>rpc(d,'customer_workflow_save_context',[org,owner,version,value]);
const makeIntake=(d,n=1,actor=member,data=intake)=>rpc(d,'customer_workflow_intake',[org,actor,key(n),data]);
async function prepared(d,{source=context,inquiry=intake,requester=member,assignee=null}={}){
 const c=await saveContext(d,0,source);const cfg=await rpc(d,'ai_draft_save',[org,owner,0,config]);let w=await makeIntake(d,1,requester,inquiry);
 if(assignee)w=await rpc(d,'customer_workflow_assign',[org,owner,w.id,w.revision,assignee]);
 const p=await rpc(d,'customer_workflow_prepare_draft',[org,owner,w.id,w.revision,cfg.id,key(2)]);
 return {c,cfg,w:p};
}
async function run(d,p,status='accepted',text=draft){
 const input=await rpc(d,'customer_workflow_draft_input',[org,owner,p.w.id,p.w.revision,p.cfg.id,key(2)]);
 const hash=createHash('sha256').update(JSON.stringify({configuration_id:p.cfg.id,input})).digest('hex');
 const a=(await rpc(d,'ai_draft_reserve',[org,owner,p.cfg.id,key(2),hash,10000])).run;
 await rpc(d,'ai_draft_finish',[org,owner,a.id,{status:status==='unknown'?'unknown':status==='failed'?'failed':'awaiting_review',draft:text,usage:{input_tokens:10,output_tokens:10}}]);
 if(['accepted','rejected'].includes(status))await rpc(d,'ai_draft_review',[org,owner,a.id,status]);
 return a;
}
async function queued(d){const p=await prepared(d);const a=await run(d,p);const w=await rpc(d,'customer_workflow_queue',[org,member,p.w.id,p.w.revision]);return {...p,w,a,action:w.action_request}}
const approve=(d,a,actor=admin)=>d.query("update action_requests set status='Approved',approved_by=$2,approved_at=now() where id=$1 returning *",[a.id,actor]);
const load=(d,actor=owner,tenant=org)=>rpc(d,'customer_workflow_load',[tenant,actor]);


export async function fixture(options){const d=await baseFixture(options);await d.exec('reset role');await d.exec(await fs.readFile(new URL('../../candidate/sql/workflow-installations-contract.sql',import.meta.url),'utf8'));await d.exec('set role service_role');return d;}
export {org,other,owner,admin,member,viewer,outsider,integration,connection,key,context,intake,config,draft,rpc,root,saveContext,makeIntake,prepared,run,queued,approve,load};

const refs=source=>Object.fromEntries(['document_id','version_id','chunk_id','content_sha256','version_sha256'].map(k=>[k,source[k]]));
const canonical=input=>({...input,...(input.sources?{sources:input.sources.map(s=>Object.fromEntries(Object.keys(s).sort().map(k=>[k,s[k]])))}:{})});
const hashInput=(config,input)=>createHash('sha256').update(JSON.stringify({configuration_id:config,input:canonical(input)})).digest('hex');
async function knowledge(d,{audience='organization',text='Support policy: replies within one business day.',title='Published support policy',reviewMs=86400000}={}){
 await d.exec('reset role');await d.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);await d.exec('set role authenticated');
 const call=async(op,p)=>(await d.query('select public.kairo_company_knowledge($1,$2,$3) value',[org,op,p])).rows[0].value;
 const saved=await call('save',{request_key:crypto.randomUUID(),expected_revision:0,title,content_text:text,source_kind:'manual',source_name:'Pasted text',audience,review_due_at:new Date(Date.now()+reviewMs).toISOString()});
 const published=await call('publish',{document_id:saved.document_id,version_id:saved.version_id,expected_revision:saved.revision,request_key:crypto.randomUUID()});
 const found=(await call('search',{query:title})).results.find(item=>item.document_id===saved.document_id);
 await d.exec('reset role;set role service_role');return {...published,ref:refs(found)};
}

async function archiveKnowledge(d,k){
 await d.exec('reset role');await d.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);await d.exec('set role authenticated');
 await d.query("select public.kairo_company_knowledge($1,'archive',$2)",[org,{document_id:k.document_id,version_id:k.version_id,expected_revision:k.revision,request_key:crypto.randomUUID()}]);await d.exec('reset role;set role service_role');
}

export {knowledge,hashInput,archiveKnowledge};

const fingerprint='a'.repeat(64),account='synthetic-provider-account';
async function approveActivation(d,cfg,patch={}){
 const value={organization_id:org,version:1,enabled:true,configuration_id:cfg,provider:config.provider,model:config.model,account_reference:account,credential_sha256:fingerprint,approved_by:owner,approval_reference:'Synthetic bounded approval fixture only',approved_at:new Date(Date.now()-10000).toISOString(),expires_at:new Date(Date.now()+3600000).toISOString(),request_microusd:100000,daily_microusd:200000,total_microusd:300000,daily_runs:10,total_runs:20,...patch};
 const keys=Object.keys(value);return (await root(d,`insert into private.ai_inference_activations(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')}) returning *`,Object.values(value))).rows[0];
}

export {approveActivation,fingerprint,account};
