import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {PGlite} from '@electric-sql/pglite';
const org='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',actor='10000000-0000-4000-8000-000000000001',outsider='10000000-0000-4000-8000-000000000002';
const config={schema_version:1,provider:'openai',model:'fixture-model',task:'customer_reply',instructions:'Use only supplied business facts.',source:'manual_context',max_input_bytes:6000,max_output_tokens:1000,max_daily_runs:2,daily_budget_microusd:50000,human_review:true};
const hash='a'.repeat(64),key=n=>`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function db(){const d=new PGlite();await d.exec(`create schema auth;create role anon;create role authenticated;create role service_role bypassrls;create table auth.users(id uuid primary key);create table public.organizations(id uuid primary key);create table public.organization_members(organization_id uuid,user_id uuid,role text);insert into auth.users values('${actor}'),('${outsider}');insert into organizations values('${org}'),('${other}');insert into organization_members values('${org}','${actor}','owner');grant usage on schema public,auth to service_role;grant select,update on organizations to service_role;grant select on organization_members to service_role;`);await d.exec(await fs.readFile(new URL('../candidate/sql/ai-draft-contract.sql',import.meta.url),'utf8'));await d.exec('set role service_role');return d}
const rpc=async(d,name,args)=> (await d.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;
const save=(d,expected=0,c=config)=>rpc(d,'ai_draft_save',[org,actor,expected,c]);
const reserve=(d,id,n=1,cost=10000,a=actor)=>rpc(d,'ai_draft_reserve',[org,a,id,key(n),hash,cost]);
test('SQL versions persisted; stale saves and out-of-org actors denied',async()=>{const d=await db();try{const c=await save(d);assert.equal(c.version,1);await assert.rejects(()=>save(d),/changed/);await assert.rejects(()=>rpc(d,'ai_draft_save',[other,actor,0,config]),/access denied/);await assert.rejects(()=>rpc(d,'ai_draft_save',[org,outsider,1,config]),/access denied/);assert.equal((await save(d,1)).version,2)}finally{await d.close()}});
test('SQL reservation is idempotent; changed payload or actor denied',async()=>{const d=await db();try{const c=await save(d);assert.equal((await reserve(d,c.id)).created,true);assert.equal((await reserve(d,c.id)).created,false);await assert.rejects(()=>rpc(d,'ai_draft_reserve',[org,actor,c.id,key(1),'b'.repeat(64),10000]),/Idempotency/);await assert.rejects(()=>reserve(d,c.id,2,10000,outsider),/access denied/)}finally{await d.close()}});
test('SQL limits apply across versions, reject stale config and retain failed spend',async()=>{const d=await db();try{const c=await save(d);const first=await reserve(d,c.id,1,30000);await rpc(d,'ai_draft_finish',[org,actor,first.run.id,{status:'failed',failure_code:'provider_refused',draft:null,usage:null}]);const next=await save(d,1);await assert.rejects(()=>reserve(d,c.id,2),/superseded/);await assert.rejects(()=>reserve(d,next.id,2,30000),/allowance/);const second=await reserve(d,next.id,2,10000);await rpc(d,'ai_draft_finish',[org,actor,second.run.id,{status:'failed',failure_code:'provider_failed',draft:null,usage:null}]);await assert.rejects(()=>reserve(d,next.id,3,1),/allowance/)}finally{await d.close()}});
test('SQL human review lifecycle has no action execution and no cross-org access',async()=>{const d=await db();try{const c=await save(d);const r=(await reserve(d,c.id)).run;await assert.rejects(()=>rpc(d,'ai_draft_review',[org,actor,r.id,'accepted']),/state conflict/);await rpc(d,'ai_draft_finish',[org,actor,r.id,{status:'awaiting_review',draft:{title:'fixture'},usage:{input_tokens:10,output_tokens:10}}]);await assert.rejects(()=>rpc(d,'ai_draft_review',[other,actor,r.id,'accepted']),/access denied/);const done=await rpc(d,'ai_draft_review',[org,actor,r.id,'accepted']);assert.equal(done.reviewed_by,actor);assert.equal(done.status,'accepted');await assert.rejects(()=>rpc(d,'ai_draft_review',[org,actor,r.id,'rejected']),/state conflict/)}finally{await d.close()}});
test('anonymous and authenticated callers cannot read private drafts or invoke service RPCs',async()=>{const d=await db();try{await d.exec('reset role;set role authenticated');await assert.rejects(()=>d.query('select * from public.ai_draft_runs'),/permission denied/);await assert.rejects(()=>save(d),/permission denied/);await d.exec('reset role;set role anon');await assert.rejects(()=>save(d),/permission denied/)}finally{await d.close()}});

test('SQL blocks a second request after unknown outcome; inherited grants cannot mutate configuration',async()=>{const d=await db();try{const c=await save(d);const r=(await reserve(d,c.id)).run;await assert.rejects(()=>reserve(d,c.id,2),/Unresolved/);await rpc(d,'ai_draft_finish',[org,actor,r.id,{status:'unknown',failure_code:'provider_timeout_unknown',draft:null,usage:null}]);await assert.rejects(()=>reserve(d,c.id,2),/Unresolved/);await assert.rejects(()=>d.query('update public.ai_draft_configurations set version=99'),/permission denied/);await d.exec('reset role');await assert.rejects(()=>d.query('update public.ai_draft_configurations set version=99'),/immutable/)}finally{await d.close()}});

test('SQL persists only the three approved provider enums and never accepts provider credentials/endpoints',async()=>{
 const d=await db();try{
  let version=0;
  for(const provider of ['openai','anthropic','gemini']){
   const result=await save(d,version,{...config,provider});version++;assert.equal(result.configuration.provider,provider);assert.equal(result.version,version);
  }
  for(const provider of ['google','custom','OPENAI','',null,{},1])await assert.rejects(()=>save(d,version,{...config,provider}),/Invalid configuration/);
  for(const field of ['api_key','base_url','endpoint'])await assert.rejects(()=>save(d,version,{...config,[field]:'synthetic'}),/Invalid configuration/);
  assert.equal((await d.query('select count(*)::integer as count from ai_draft_configurations')).rows[0].count,3);
 }finally{await d.close()}
});

test('deployment provider patch changes only the save predicate, preserves grants and all other functions, and is idempotent',async()=>{
 const d=await db();try{
  await d.exec('reset role');
  const signature='public.ai_draft_save(uuid,uuid,integer,jsonb)';
  const modern="coalesce(p_config->>'provider','') not in ('openai','anthropic','gemini')",legacy="p_config->>'provider' is distinct from 'openai'";
  const definition=(await d.query('select pg_get_functiondef($1::regprocedure) as definition',[signature])).rows[0].definition;
  // Start from the legacy production predicate while retaining this database's ACLs.
  await d.exec(definition.replace(modern,legacy));
  const snapshot=async()=> (await d.query("select p.oid,p.proname,p.proacl::text as acl,p.proowner,p.prosecdef,p.proconfig,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'ai_draft_%' order by p.proname")).rows;
  const before=await snapshot();
  const patch=await fs.readFile(new URL('../deployment/ai-provider-model-selection.sql',import.meta.url),'utf8');
  await d.exec(patch);const after=await snapshot();
  assert.equal(after.length,before.length);
  for(let i=0;i<before.length;i++)assert.deepEqual(after[i],before[i].proname==='ai_draft_save'?{...before[i],definition:before[i].definition.replace(legacy,modern)}:before[i]);
  await d.exec(patch);assert.deepEqual(await snapshot(),after);
  await d.exec('set role authenticated');await assert.rejects(()=>save(d),/permission denied/);
  await d.exec('reset role;set role service_role');assert.equal((await save(d,0,{...config,provider:'anthropic'})).configuration.provider,'anthropic');
 }finally{await d.close()}
});
