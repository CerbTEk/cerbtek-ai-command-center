import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {PGlite} from '@electric-sql/pglite';import {createHandler} from '../candidate/edge/ai-draft/handler.mjs';import {openAIResponse} from '../candidate/edge/ai-draft/core.mjs';
const org='00000000-0000-4000-8000-000000000001',actor='10000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const config={schema_version:1,provider:'openai',model:'fixture',task:'customer_reply',instructions:'Use only supplied business facts.',source:'manual_context',max_input_bytes:6000,max_output_tokens:1000,max_daily_runs:3,daily_budget_microusd:1000000,human_review:true};
const catalog=[{provider:'openai',model:'fixture',structured_outputs:true,input_microusd_per_token:1,output_microusd_per_token:2}];
async function setup(){const db=new PGlite();await db.exec(`create schema auth;create role anon;create role authenticated;create role service_role bypassrls;create table auth.users(id uuid primary key);create table organizations(id uuid primary key);create table organization_members(organization_id uuid,user_id uuid,role text);insert into auth.users values('${actor}');insert into organizations values('${org}'),('${other}');insert into organization_members values('${org}','${actor}','owner');grant usage on schema auth,public to service_role;grant select,update on organizations to service_role;grant select on organization_members to service_role;`);await db.exec(await fs.readFile(new URL('../candidate/sql/ai-draft-contract.sql',import.meta.url),'utf8'));await db.exec('set role service_role');
 const supabase={auth:{getUser:async token=>token==='fixture-token'?{data:{user:{id:actor}}}:{error:{message:'bad'}}},rpc:async(name,args)=>{try{return {data:(await db.query(`select public.${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}`).join(',')}) as result`,Object.values(args))).rows[0].result}}catch(e){return {error:{message:e.message}}}},from:table=>{let selected='*',filters=[],params=[],order='',limit='',singular=false,count=false;const q={select(cols,opts){selected=cols;count=opts?.count==='exact';return q},eq(k,v){params.push(v);filters.push(`${k}=$${params.length}`);return q},in(k,vs){params.push(vs);filters.push(`${k}=any($${params.length})`);return q},order(k,opts){order=` order by ${k} ${opts.ascending?'asc':'desc'}`;return q},limit(n){limit=` limit ${n}`;return q},maybeSingle(){singular=true;return q},single(){singular=true;return q},then(resolve,reject){return db.query(`select ${count?'count(*)':selected} from public.${table}${filters.length?' where '+filters.join(' and '):''}${order}${limit}`,params).then(r=>resolve(count?{data:null,count:Number(r.rows[0].count)}:{data:singular?r.rows[0]:r.rows}),e=>resolve({error:{message:e.message}}))}};return q}};
 let calls=0;const handler=createHandler({supabase,catalog,liveEnabled:true,resolveCredential:async({organizationId,provider})=>({organizationId,provider,apiKey:'synthetic-fixture-key'}),discover:async provider=>catalog.filter(m=>m.provider===provider).map(m=>({provider,model:m.model,label:m.model,available:true,structured_outputs:true})),allowedOrigins:['http://localhost:5173'],invoke:body=>openAIResponse(body,{apiKey:'synthetic-fixture-key',fetchImpl:async()=>{calls++;return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({title:'Reviewed draft',body:'Synthetic customer reply.',source_ids:['manual-1'],warnings:[]})}]}],usage:{input_tokens:90,output_tokens:25}}))}})});
 const request=async(body,token='fixture-token',origin='http://localhost:5173')=>{const r=await handler(new Request('http://localhost/ai-draft',{method:'POST',headers:{Authorization:`Bearer ${token}`,Origin:origin},body:JSON.stringify({organization_id:org,...body})}));return {status:r.status,...await r.json()}};
 return {db,request,calls:()=>calls,supabase};}
test('real handler + SQL + mocked HTTP adapter: setup, version, draft, idempotent replay, human review, telemetry',async()=>{const {db,request,calls}=await setup();try{assert.equal((await request({operation:'load'})).configuration,null);const saved=await request({operation:'save',expected_version:0,configuration:config});assert.equal(saved.status,200);assert.equal(saved.configuration.version,1);const input={operation:'run',configuration_id:saved.configuration.id,request_key:'20000000-0000-4000-8000-000000000001',input:{context:'Synthetic company reply context.'}};const run=await request(input);assert.equal(run.status,200);assert.equal(run.run.status,'awaiting_review');assert.equal(run.run.usage.input_tokens,90);assert.equal((await request(input)).run.id,run.run.id);assert.equal(calls(),1);assert.equal((await request({operation:'review',run_id:run.run.id,decision:'accepted'})).run.status,'accepted');const loaded=await request({operation:'load'});assert.equal(loaded.runs[0].status,'accepted');assert.equal(loaded.unresolved_count,0);assert.equal(loaded.runs[0].configuration_id,saved.configuration.id)}finally{await db.close()}});
test('real route blocks forged tenancy, bad auth, unapproved origin and client key injection before inference',async()=>{const {db,request,calls}=await setup();try{assert.equal((await request({operation:'load',organization_id:other})).status,403);assert.equal((await request({operation:'load'},'bad-token')).status,401);assert.equal((await request({operation:'load'},'fixture-token','https://attacker.invalid')).status,403);assert.equal((await request({operation:'save',expected_version:0,configuration:{...config,api_key:'injected'}})).status,400);assert.equal(calls(),0)}finally{await db.close()}});

const fixtureKey=n=>`30000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function seedRun(db,configuration,n,{organization=org,status='failed',created='2040-01-02 12:00:00+00',body=null}={}){
 return (await db.query(`insert into ai_draft_runs(organization_id,configuration_id,request_key,request_hash,requested_by,reserved_microusd,reservation_day,status,created_at,draft) values($1,$2,$3,$4,$5,1000,'2040-01-02',$6,$7,$8) returning *`,[organization,configuration,fixtureKey(n),'a'.repeat(64),actor,status,created,body?{title:'Fixture',body,source_ids:[],warnings:[]}:null])).rows[0];
}
test('older unresolved request is listed beyond recent20 and inspectable by ID/key without writes or provider calls',async()=>{
 const {db,request,calls,supabase}=await setup();try{
  const saved=(await request({operation:'save',expected_version:0,configuration:config})).configuration;
  const old=await seedRun(db,saved.id,1,{status:'unknown',created:'2040-01-01 12:00:00+00'});
  for(let n=2;n<=25;n++)await seedRun(db,saved.id,n);
  const foreign=await seedRun(db,saved.id,99,{organization:other,status:'unknown',body:'Other organization private draft'});
  const snapshot=JSON.stringify((await db.query('select * from ai_draft_runs order by id')).rows);
  let rpcCalls=0;const original=supabase.rpc;supabase.rpc=(...args)=>{rpcCalls++;return original(...args)};
  const loaded=await request({operation:'load'});assert.equal(loaded.runs.length,20);assert(!loaded.runs.some(x=>x.id===old.id));
  assert.equal(loaded.unresolved_count,1);assert.equal(loaded.unresolved_limit,20);assert.deepEqual(loaded.unresolved_runs.map(x=>x.id),[old.id]);
  assert.deepEqual(Object.keys(loaded.unresolved_runs[0]).sort(),['created_at','id','request_key','status']);
  for(const target of [{run_id:old.id},{request_key:old.request_key}]){const r=await request({operation:'lookup',...target});assert.equal(r.status,200);assert.equal(r.run.id,old.id);assert.equal(r.run.status,'unknown')}
  const missing=await request({operation:'lookup',run_id:fixtureKey(1000)});
  for(const target of [{run_id:foreign.id},{request_key:foreign.request_key}])assert.deepEqual(await request({operation:'lookup',...target}),missing);
  assert.deepEqual(missing,{status:200,run:null});assert.equal(rpcCalls,0);assert.equal(calls(),0);
  assert.equal(JSON.stringify((await db.query('select * from ai_draft_runs order by id')).rows),snapshot);
 }finally{await db.close()}
});
test('lookup keeps existing role/membership/auth boundaries and rejects malformed or ambiguous references',async()=>{
 const {db,request,calls}=await setup();try{
  const saved=(await request({operation:'save',expected_version:0,configuration:config})).configuration;
  const old=await seedRun(db,saved.id,1,{status:'reserved'});
  for(const role of ['owner','admin','consultant']){
   await db.exec(`reset role;update organization_members set role='${role}';set role service_role`);
   assert.equal((await request({operation:'lookup',run_id:old.id})).run.id,old.id);
  }
  for(const role of ['member','staff']){
   await db.exec(`reset role;update organization_members set role='${role}';set role service_role`);
   assert.equal((await request({operation:'lookup',run_id:old.id})).status,403);
   assert.equal((await request({operation:'load'})).status,403);
  }
  await db.exec("reset role;update organization_members set role='owner';set role service_role");
  assert.equal((await request({operation:'lookup',run_id:old.id},'invalid')).status,401);
  assert.equal((await request({operation:'lookup',run_id:old.id,organization_id:other})).status,403);
  for(const target of [{},{run_id:'not-a-uuid'},{request_key:null},{run_id:old.id,request_key:old.request_key},{run_id:old.id,request_key:null}]){
   const result=await request({operation:'lookup',...target});assert.equal(result.status,400);assert.equal(result.error,'invalid_request_reference');
  }
  await db.exec('reset role;delete from organization_members;set role service_role');
  assert.equal((await request({operation:'lookup',run_id:old.id})).status,403);assert.equal(calls(),0);
 }finally{await db.close()}
});
test('unresolved summaries are bounded20 oldest-first while count remains all-history and tenant-scoped',async()=>{
 const {db,request,calls}=await setup();try{
  const saved=(await request({operation:'save',expected_version:0,configuration:config})).configuration;
  const rows=[];for(let n=1;n<=25;n++)rows.push(await seedRun(db,saved.id,n,{status:n%2?'unknown':'reserved',created:`2040-01-${String(n).padStart(2,'0')} 12:00:00+00`}));
  await seedRun(db,saved.id,99,{organization:other,status:'unknown',created:'2030-01-01 00:00:00+00'});
  const loaded=await request({operation:'load'});assert.equal(loaded.unresolved_count,25);assert.equal(loaded.unresolved_runs.length,20);assert.deepEqual(loaded.unresolved_runs.map(r=>r.id),rows.slice(0,20).map(r=>r.id));
  assert.equal((await request({operation:'lookup',request_key:rows[24].request_key})).run.id,rows[24].id);assert.equal(calls(),0);
 }finally{await db.close()}
});
