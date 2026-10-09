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
async function fixture(){
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
 for(const file of ['ai-draft-contract.sql','guard-contract.sql','reconciliation-contract.sql','customer-workflow-contract.sql','company-knowledge-contract.sql','knowledge-draft-contract.sql','ai-inference-activation-contract.sql'])await d.exec(await fs.readFile(new URL('../../candidate/sql/'+file,import.meta.url),'utf8'));
 await d.exec('set role service_role');return d;
}
const fingerprint='a'.repeat(64),account='synthetic-provider-account';
const save=d=>rpc(d,'ai_draft_save',[org,owner,0,config]);
const status=(d,cfg,tenant=org,actor=owner,acct=account,fp=fingerprint)=>rpc(d,'ai_inference_readiness',[tenant,actor,cfg,acct,fp]);
const reserve=(d,cfg,n=1,cost=10000,acct=account,fp=fingerprint)=>rpc(d,'ai_inference_reserve',[org,owner,cfg,key(n),'b'.repeat(64),cost,acct,fp]);
const dispatch=(d,r,acct=account,fp=fingerprint)=>rpc(d,'ai_inference_dispatch',[org,owner,r.configuration_id,r.request_key,r.id,r.request_hash,acct,fp]);
const finish=(d,r,state='failed')=>rpc(d,'ai_draft_finish',[org,owner,r.id,{status:state,failure_code:'synthetic_no_provider',draft:null,usage:null}]);
async function approveActivation(d,cfg,patch={}){
 const value={organization_id:org,version:1,enabled:true,configuration_id:cfg,provider:config.provider,model:config.model,account_reference:account,credential_sha256:fingerprint,approved_by:owner,approval_reference:'Synthetic bounded approval fixture only',approved_at:new Date(Date.now()-10000).toISOString(),expires_at:new Date(Date.now()+3600000).toISOString(),request_microusd:100000,daily_microusd:200000,total_microusd:300000,daily_runs:10,total_runs:20,...patch};
 const keys=Object.keys(value);return (await root(d,`insert into private.ai_inference_activations(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')}) returning *`,Object.values(value))).rows[0];
}

export {fixture,org,other,owner,admin,member,viewer,outsider,config,key,rpc,root,save,status,reserve,dispatch,finish,approveActivation,fingerprint,account};
