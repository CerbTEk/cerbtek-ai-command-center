import fs from 'node:fs/promises';
import {fixture as baseFixture,rpc,org,owner,admin,member,connection,key,config,intake,saveContext} from './workflow-installation-fixture.mjs';
export * from './workflow-installation-fixture.mjs';
export async function employeeFixture(){
 const d=await baseFixture({activation:true});
 await d.exec('reset role');await d.exec(await fs.readFile(new URL('../../candidate/sql/employee-drafting-contract.sql',import.meta.url),'utf8'));await d.exec('set role service_role');return d;
}
export async function installed(d,{actor=member,assignee=member,reviewer=admin}={}){
 const c=await saveContext(d);const cfg=await rpc(d,'ai_draft_save',[org,owner,0,config]);
 const spec={recipe_key:'customer_followup',recipe_version:1,name:'Customer follow-up',outcome:'Respond using explicit saved company guidance.',bindings:{context_version_id:c.id,configuration_id:cfg.id,microsoft_connection_id:connection,assigned_to:assignee,reviewer_id:reviewer},limits:{max_open_requests:10}};
 const installation=await rpc(d,'workflow_installations_save',[org,owner,null,0,key(100),spec]);
 const started=await rpc(d,'workflow_installations_start',[org,actor,installation.id,installation.revision,key(200),intake]);
 return {c,cfg,installation,spec,w:started.workflow};
}
export const prepare=(d,p,actor=member,k=key(2))=>rpc(d,'customer_workflow_prepare_draft',[org,actor,p.w.id,p.w.revision,p.cfg.id,k]);
