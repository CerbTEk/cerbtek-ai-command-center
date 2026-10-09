import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../candidate/edge/ai-draft/handler.mjs';
const org='00000000-0000-4000-8000-000000000001';
const actor='10000000-0000-4000-8000-000000000001';
const id='20000000-0000-4000-8000-000000000001';
function fixture({storageError=false,role='owner'}={}){
 const queries=[];let mutations=0,inferences=0;
 const supabase={auth:{getUser:async()=>({data:{user:{id:actor}}})},rpc:async()=>{mutations++;throw Error('Unexpected mutation')},from:table=>{
  const query={table,filters:[]};queries.push(query);
  const q={select(value){query.selected=value;return q},eq(field,value){query.filters.push([field,value]);return q},limit(n){query.limit=n;return q},maybeSingle(){query.single=true;return q},then(resolve){return Promise.resolve(table==='organization_members'?{data:{role}}:storageError?{error:{message:'INTERNAL_DATABASE_SECRET'}}:{data:{id,status:'unknown'}}).then(resolve)}};return q;
 }};
 const handler=createHandler({supabase,liveEnabled:false,allowedOrigins:['http://localhost:5173'],invoke:async()=>{inferences++;throw Error('Unexpected provider call')}});
 const request=async body=>{const r=await handler(new Request('http://localhost/ai-draft',{method:'POST',headers:{authorization:'Bearer fixture',origin:'http://localhost:5173'},body:JSON.stringify({organization_id:org,operation:'lookup',...body})}));return {status:r.status,body:await r.json()}};
 return {request,queries,counts:()=>({mutations,inferences})};
}
test('lookup is available with live inference disabled, is tenant-filtered and bounded to one record',async()=>{
 const x=fixture();const r=await x.request({run_id:id,p_actor:'attacker',limit:999});
 assert.equal(r.status,200);assert.equal(r.body.run.id,id);
 assert.deepEqual(x.queries[0].filters,[['organization_id',org],['user_id',actor]]);
 assert.deepEqual(x.queries[1].filters,[['organization_id',org],['id',id]]);assert.equal(x.queries[1].limit,1);assert.equal(x.queries[1].single,true);
 assert.deepEqual(x.counts(),{mutations:0,inferences:0});
});
test('request-key lookup uses the scoped exact key, never an unscoped fallback',async()=>{
 const x=fixture();await x.request({request_key:id});
 assert.deepEqual(x.queries[1].filters,[['organization_id',org],['request_key',id]]);assert.equal(x.queries.length,2);
 assert.deepEqual(x.counts(),{mutations:0,inferences:0});
});
test('storage failure is sanitized and cannot masquerade as a missing record',async()=>{
 const x=fixture({storageError:true});const r=await x.request({run_id:id});
 assert.deepEqual(r,{status:503,body:{error:'storage_unavailable'}});assert(!JSON.stringify(r).includes('INTERNAL_DATABASE_SECRET'));
 assert.deepEqual(x.counts(),{mutations:0,inferences:0});
});
test('invalid references and unauthorized roles never query request records',async()=>{
 for(const target of [{},{run_id:'invalid'},{run_id:id,request_key:id}]){
  const x=fixture();assert.equal((await x.request(target)).status,400);assert.deepEqual(x.queries.map(q=>q.table),['organization_members']);
 }
 const x=fixture({role:'member'});assert.equal((await x.request({run_id:id})).status,403);assert.deepEqual(x.queries.map(q=>q.table),['organization_members']);
});
