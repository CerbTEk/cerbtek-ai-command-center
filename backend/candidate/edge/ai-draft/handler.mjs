import {DraftError,validateConfig,validateInput,runDraft,openAIResponse} from './core.mjs';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function createHandler({supabase,catalog=[],liveEnabled=false,apiKey='',allowedOrigins=[],invoke}){
 return async request=>{
  const origin=request.headers.get('origin');
  const headers={'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin'};
  if(origin&&allowedOrigins.includes(origin)){headers['Access-Control-Allow-Origin']=origin;headers['Access-Control-Allow-Headers']='authorization, apikey, content-type, x-client-info';headers['Access-Control-Allow-Methods']='POST, OPTIONS'}
  const reply=(x,s=200)=>new Response(JSON.stringify(x),{status:s,headers});
  if(origin&&!allowedOrigins.includes(origin))return reply({error:'origin_not_allowed'},403);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(request.method!=='POST')return reply({error:'method_not_allowed'},405);
  try{
   const token=request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];if(!token)throw new DraftError('sign_in_required',401);
   const {data:auth,error:authError}=await supabase.auth.getUser(token);if(authError||!auth?.user)throw new DraftError('sign_in_required',401);
   const raw=await request.text();if(new TextEncoder().encode(raw).length>25000)throw new DraftError('request_too_large',413);
   let b;try{b=JSON.parse(raw)}catch{throw new DraftError('invalid_request')}
   if(!uuid(b?.organization_id))throw new DraftError('invalid_organization');
   const {data:membership,error:membershipError}=await supabase.from('organization_members').select('role').eq('organization_id',b.organization_id).eq('user_id',auth.user.id).maybeSingle();
   if(membershipError||!membership||!['owner','admin','consultant'].includes(membership.role))throw new DraftError('organization_access_denied',403);
   const rpc=async(name,args)=>{const r=await supabase.rpc(name,args);if(r.error)throw new DraftError('configuration_or_run_conflict',409);return r.data};
   const common={p_org:b.organization_id,p_actor:auth.user.id};
   if(b.operation==='lookup'){
    const byId=b.run_id!==undefined,byKey=b.request_key!==undefined;
    if(byId===byKey||!uuid(byId?b.run_id:b.request_key))throw new DraftError('invalid_request_reference');
    const {data:run,error}=await supabase.from('ai_draft_runs').select('*').eq('organization_id',b.organization_id).eq(byId?'id':'request_key',byId?b.run_id:b.request_key).limit(1).maybeSingle();
    if(error)throw new DraftError('storage_unavailable',503);
    // A missing ID and an ID belonging to another organization are indistinguishable.
    // This branch never calls a mutation RPC or a provider.
    return reply({run:run||null});
   }
   if(b.operation==='load'){
    const [configs,runs,pending,unresolved]=await Promise.all([supabase.from('ai_draft_configurations').select('*').eq('organization_id',b.organization_id).order('version',{ascending:false}).limit(1),supabase.from('ai_draft_runs').select('*').eq('organization_id',b.organization_id).order('created_at',{ascending:false}).limit(20),supabase.from('ai_draft_runs').select('id',{count:'exact',head:true}).eq('organization_id',b.organization_id).in('status',['reserved','unknown']),supabase.from('ai_draft_runs').select('id,request_key,status,created_at').eq('organization_id',b.organization_id).in('status',['reserved','unknown']).order('created_at',{ascending:true}).limit(20)]);
    if(configs.error||runs.error||pending.error||unresolved.error)throw new DraftError('storage_unavailable',503);
    return reply({configuration:configs.data[0]||null,runs:runs.data,unresolved_count:pending.count||0,unresolved_runs:unresolved.data,unresolved_limit:20,catalog:catalog.map(({provider,model})=>({provider,model})),readiness:{live_enabled:liveEnabled,credential_configured:!!apiKey,status:!apiKey?'provider_unconfigured':!liveEnabled?'live_inference_disabled':catalog.length?'configured':'model_not_configured'}});
   }
   if(b.operation==='save')return reply({configuration:await rpc('ai_draft_save',{...common,p_expected_version:b.expected_version,p_config:validateConfig(b.configuration)})});
   if(b.operation==='review'){
    if(!uuid(b.run_id)||!['accepted','rejected'].includes(b.decision))throw new DraftError('invalid_review');
    return reply({run:await rpc('ai_draft_review',{...common,p_run:b.run_id,p_decision:b.decision})});
   }
   if(b.operation!=='run'||!uuid(b.configuration_id)||!uuid(b.request_key))throw new DraftError('invalid_operation');
   const {data:record,error}=await supabase.from('ai_draft_configurations').select('*').eq('organization_id',b.organization_id).eq('id',b.configuration_id).single();
   if(error||!record)throw new DraftError('configuration_not_found',404);
   const input=validateInput(b.input,record.configuration);
   const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({configuration_id:record.id,input})));
   const requestHash=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
   const run=await runDraft({config:record.configuration,input,catalog,liveEnabled,credentialConfigured:!!apiKey,requestKey:b.request_key,requestHash,
    store:{reserve:({requestKey,requestHash,reserve})=>rpc('ai_draft_reserve',{...common,p_config:record.id,p_request_key:requestKey,p_request_hash:requestHash,p_reserve:reserve}),finish:(id,result)=>rpc('ai_draft_finish',{...common,p_run:id,p_result:result})},
    invoke:invoke||((body)=>openAIResponse(body,{apiKey}))});
   return reply({run});
  }catch(e){return reply({error:e instanceof DraftError?e.code:'service_unavailable'},e instanceof DraftError?e.status:503)}
 };
}
