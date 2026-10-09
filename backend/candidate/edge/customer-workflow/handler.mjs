// Thin authenticated boundary. Context, membership, revisions, source binding and
// all proposal writes are derived inside the service-only database contract.
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key))&&keys.every(key=>Object.hasOwn(value,key));
class WorkflowError extends Error { constructor(code,status=400){super(code);this.code=code;this.status=status;} }
const operations={
 load:[],save_context:['expected_version','context'],intake:['request_key','customer_email','customer_name','subject','message'],
 assign:['workflow_id','expected_revision','assigned_to'],prepare_draft:['workflow_id','expected_revision','configuration_id','request_key'],
 queue:['workflow_id','expected_revision'],cancel:['workflow_id','expected_revision'],
};
export function createHandler({supabase,allowedOrigins=[]}){
 return async request=>{
  const origin=request.headers.get('origin');
  const headers={'Content-Type':'application/json','Cache-Control':'no-store',Vary:'Origin'};
  if(origin&&allowedOrigins.includes(origin))Object.assign(headers,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS'});
  const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
  if(origin&&!allowedOrigins.includes(origin))return reply({ok:false,error:'origin_not_allowed'},403);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(request.method!=='POST')return reply({ok:false,error:'method_not_allowed'},405);
  try{
   const token=request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
   if(!token)throw new WorkflowError('sign_in_required',401);
   const {data:session,error:authError}=await supabase.auth.getUser(token);
   if(authError||!session?.user?.id||session.user.is_anonymous===true)throw new WorkflowError('sign_in_required',401);
   const raw=await request.text();if(new TextEncoder().encode(raw).length>45000)throw new WorkflowError('request_too_large',413);
   let body;try{body=JSON.parse(raw)}catch{throw new WorkflowError('invalid_request')}
   if(!object(body)||!Object.hasOwn(operations,body.operation)||!exact(body,['operation','organization_id',...operations[body.operation]]))throw new WorkflowError('unsupported_request_fields');
   if(!uuid(body.organization_id))throw new WorkflowError('invalid_organization');
   for(const field of ['workflow_id','request_key','configuration_id','assigned_to'])if(field in body&&!uuid(body[field]))throw new WorkflowError('invalid_reference');
   if('expected_revision' in body&&(!Number.isSafeInteger(body.expected_revision)||body.expected_revision<1))throw new WorkflowError('invalid_revision');
   if('expected_version' in body&&(!Number.isSafeInteger(body.expected_version)||body.expected_version<0))throw new WorkflowError('invalid_version');
   const args={p_org:body.organization_id,p_actor:session.user.id};
   if(body.operation==='save_context'){
    if(!exact(body.context,['company_name','reply_guidance']))throw new WorkflowError('invalid_company_context');
    Object.assign(args,{p_expected_version:body.expected_version,p_context:body.context});
   }else if(body.operation==='intake'){
    Object.assign(args,{p_request_key:body.request_key,p_intake:Object.fromEntries(['customer_email','customer_name','subject','message'].map(key=>[key,body[key]]))});
   }else if(body.operation!=='load'){
    Object.assign(args,{p_workflow:body.workflow_id,p_expected_revision:body.expected_revision});
    if(body.operation==='assign')args.p_assigned_to=body.assigned_to;
    if(body.operation==='prepare_draft')Object.assign(args,{p_config:body.configuration_id,p_request_key:body.request_key});
   }
   const result=await supabase.rpc(`customer_workflow_${body.operation}`,args);
   if(result.error){
    const code=result.error.code;
    if(['42P01','42883','3F000'].includes(code))throw new WorkflowError('customer_workflow_not_installed',503);
    if(code==='42501'||/access denied|authorization required/i.test(result.error.message||''))throw new WorkflowError('organization_access_denied',403);
    throw new WorkflowError(body.operation==='load'?'workflow_storage_unavailable':'workflow_changed_or_not_ready',body.operation==='load'?503:409);
   }
   if(!object(result.data))throw new WorkflowError('workflow_storage_unavailable',503);
   const envelope={ok:true,contract_version:1,organization_id:body.organization_id};
   if(body.operation==='load'){
    if(result.data.actor?.id!==session.user.id||!Array.isArray(result.data.workflows)||result.data.workflows.some(w=>w.organization_id!==body.organization_id))throw new WorkflowError('workflow_storage_unavailable',503);
    return reply({...result.data,...envelope});
   }
   if(result.data.organization_id!==body.organization_id)throw new WorkflowError('workflow_storage_unavailable',503);
   return reply({...envelope,...(body.operation==='save_context'?{context:result.data}:{workflow:result.data}),...(body.operation==='queue'?{request:result.data.action_request}: {})});
  }catch(error){return reply({ok:false,error:error instanceof WorkflowError?error.code:'customer_workflow_unavailable'},error instanceof WorkflowError?error.status:503)}
 };
}
