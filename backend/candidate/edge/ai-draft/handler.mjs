import {DraftError,providers,validateProvider,validateConfig,validateInput,providerSpec,runDraft,providerResponse,discoverModels} from './core.mjs';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function createHandler({supabase,catalog=[],liveEnabled=false,resolveCredential=async()=>null,allowedOrigins=[],invoke,discover=discoverModels,fetchImpl=fetch}){
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
   // A deployment-wide key must never masquerade as this organization's connection.
   // The trusted resolver must return an explicit matching organization + provider binding.
   const connections=new Map();
   const connectionFor=async provider=>{
    validateProvider(provider);
    if(!connections.has(provider))connections.set(provider,(async()=>{
     try{
      const c=await resolveCredential({organizationId:b.organization_id,actorId:auth.user.id,provider});
      return c?.organizationId===b.organization_id&&c?.provider===provider&&typeof c.apiKey==='string'&&c.apiKey.trim()?{apiKey:c.apiKey}:null;
     }catch{throw new DraftError('provider_connection_unavailable',503)}
    })());
    return connections.get(provider);
   };
   const modelsFor=async provider=>{
    try{
     const c=await connectionFor(provider);
     if(!c)return {provider,catalog:[],model_status:'not_connected',credential_configured:false};
     const models=await discover(provider,catalog,{apiKey:c.apiKey,fetchImpl});
     return {provider,catalog:models,model_status:models.length?'ready':'no_compatible_models',credential_configured:true};
    }catch(e){
     if(e instanceof DraftError&&e.code==='unsupported_provider')throw e;
     const safeErrors=['provider_auth_failed','provider_rate_limited','provider_failed','provider_discovery_timeout','provider_discovery_failed','invalid_model_catalog','provider_connection_unavailable'];
     return {provider,catalog:[],model_status:'discovery_failed',credential_configured:!!(await connections.get(provider)?.catch(()=>null)),model_error:e instanceof DraftError&&safeErrors.includes(e.code)?e.code:'provider_discovery_failed'};
    }
   };
   const availableModel=async config=>{
    providerSpec(config,catalog); // Even a discoverable model needs approved pricing + schema support.
    const models=await modelsFor(config.provider);
    if(models.model_status==='not_connected')throw new DraftError('provider_unconfigured',409);
    if(models.model_status==='discovery_failed')throw new DraftError(models.model_error,503);
    const found=models.catalog.find(m=>m.model===config.model&&m.available===true&&m.structured_outputs===true);
    if(!found||(found.max_output_tokens!==undefined&&config.max_output_tokens>found.max_output_tokens))throw new DraftError('model_unavailable',409);
    return connectionFor(config.provider);
   };
   if(b.operation==='models')return reply(await modelsFor(validateProvider(b.provider)));
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
    const configuration=configs.data[0]||null;
    const selected=providers.some(p=>p.id===configuration?.configuration?.provider)?configuration.configuration.provider:'openai';
    const models=await modelsFor(selected);
    const connectionsMetadata=await Promise.all(providers.map(async p=>{
     try{const configured=!!(await connectionFor(p.id));return {...p,credential_configured:configured,connection_status:configured?'configured':'not_connected'}}
     catch{return {...p,credential_configured:false,connection_status:'unavailable'}}
    }));
    return reply({configuration,runs:runs.data,unresolved_count:pending.count||0,unresolved_runs:unresolved.data,unresolved_limit:20,providers:connectionsMetadata,...models,readiness:{live_enabled:liveEnabled,credential_configured:models.credential_configured,status:models.model_status==='discovery_failed'?'model_discovery_failed':!models.credential_configured?'provider_unconfigured':!liveEnabled?'live_inference_disabled':models.catalog.length?'configured':'model_not_configured'}});
   }
   if(b.operation==='save'){
    const config=validateConfig(b.configuration);await availableModel(config);
    return reply({configuration:await rpc('ai_draft_save',{...common,p_expected_version:b.expected_version,p_config:config})});
   }
   if(b.operation==='review'){
    if(!uuid(b.run_id)||!['accepted','rejected'].includes(b.decision))throw new DraftError('invalid_review');
    return reply({run:await rpc('ai_draft_review',{...common,p_run:b.run_id,p_decision:b.decision})});
   }
   if(b.operation!=='run'||!uuid(b.configuration_id)||!uuid(b.request_key))throw new DraftError('invalid_operation');
   const {data:record,error}=await supabase.from('ai_draft_configurations').select('*').eq('organization_id',b.organization_id).eq('id',b.configuration_id).single();
   if(error||!record)throw new DraftError('configuration_not_found',404);
   const config=validateConfig(record.configuration);
   let suppliedInput=b.input;
   if(b.customer_workflow_id!==undefined||b.expected_revision!==undefined){
    // A connected inquiry never accepts pasted replacement context or client
    // lineage. SQL derives the exact saved request/context after fresh authority
    // checks; its reserve trigger rechecks the binding before paid dispatch.
    const allowed=['operation','organization_id','configuration_id','request_key','customer_workflow_id','expected_revision'];
    if(Object.keys(b).some(key=>!allowed.includes(key))||!uuid(b.customer_workflow_id)||!Number.isSafeInteger(b.expected_revision)||b.expected_revision<1||config.task!=='customer_reply')throw new DraftError('invalid_customer_workflow');
    const {data,error}=await supabase.rpc('customer_workflow_draft_input',{
     ...common,p_workflow:b.customer_workflow_id,p_expected_revision:b.expected_revision,p_config:record.id,p_request_key:b.request_key,
    });
    if(error||!data||typeof data.context!=='string'||Object.keys(data).some(key=>key!=='context'))throw new DraftError('customer_workflow_conflict',409);
    suppliedInput=data;
   }
   const input=validateInput(suppliedInput,config);
   if(!liveEnabled)throw new DraftError('live_inference_disabled',409);
   const credential=await availableModel(config);
   const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({configuration_id:record.id,input})));
   const requestHash=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
   const run=await runDraft({config:record.configuration,input,catalog,liveEnabled,credentialConfigured:!!credential,requestKey:b.request_key,requestHash,
    store:{reserve:({requestKey,requestHash,reserve})=>rpc('ai_draft_reserve',{...common,p_config:record.id,p_request_key:requestKey,p_request_hash:requestHash,p_reserve:reserve}),finish:(id,result)=>rpc('ai_draft_finish',{...common,p_run:id,p_result:result})},
    invoke:invoke?((body)=>invoke(body,{provider:config.provider,model:config.model})):((body)=>providerResponse(config.provider,config.model,body,{apiKey:credential.apiKey,fetchImpl}))});
   return reply({run});
  }catch(e){return reply({error:e instanceof DraftError?e.code:'service_unavailable'},e instanceof DraftError?e.status:503)}
 };
}
