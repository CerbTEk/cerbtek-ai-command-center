const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class InputError extends Error { constructor(code,status=400){super(code);this.code=code;this.status=status} }
async function readBody(request) {
 const length=request.headers.get('content-length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)>1024)) throw new InputError('request_too_large',413);
 const reader=request.body?.getReader();if(!reader)throw new InputError('invalid_request');
 const parts=[];let size=0,timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new InputError('request_timeout',408)),2000)});
 try {
  while(true){const {value,done}=await Promise.race([reader.read(),deadline]);if(done)break;size+=value.byteLength;if(size>1024)throw new InputError('request_too_large',413);parts.push(value)}
  const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length}
  let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw new InputError('invalid_request')}
  if(!body||Array.isArray(body)||Object.keys(body).length!==1||typeof body.organization_id!=='string'||!UUID.test(body.organization_id))throw new InputError('invalid_request');
  return {organization_id:body.organization_id.toLowerCase()};
 }finally{clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock()}
}
// Authenticated read-only endpoint. No service role, provider credential or SDK.
export function createBillingStatusHandler({makeUserClient,allowedOrigins=[]}) {
 return async request=>{
  const origin=request.headers.get('origin');
  const headers={'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin',
   'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS',
   ...(origin&&allowedOrigins.includes(origin)?{'Access-Control-Allow-Origin':origin}:{})};
  const respond=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
  if(origin&&!allowedOrigins.includes(origin))return respond({code:'origin_denied'},403);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(request.method!=='POST')return respond({code:'method_not_allowed'},405);
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return respond({code:'json_required'},415);
  const jwt=/^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization')||'')?.[1];
  if(!jwt)return respond({code:'sign_in_required'},401);
  try {
   const body=await readBody(request),client=makeUserClient(jwt);
   const {data:auth,error:authError}=await client.auth.getUser(jwt);
   if(authError||typeof auth?.user?.id!=='string'||!UUID.test(auth.user.id)||auth.user.is_anonymous)return respond({code:'sign_in_required'},401);
   const {data,error}=await client.rpc('kairo_billing_status',{p_organization_id:body.organization_id});
   if(error)return respond({code:error.code==='42501'?'billing_access_denied':'billing_status_unavailable'},error.code==='42501'?403:503);
   if(!data||data.contract!=='billing_status_v1'||data.authorized!==true||data.organization_id!==body.organization_id||data.actor_id!==auth.user.id||!['owner','admin'].includes(data.actor_role)||data.commercial_actions_enabled!==false)throw new Error('Invalid billing status');
   return respond(data);
  }catch(error){if(error instanceof InputError)return respond({code:error.code},error.status);return respond({code:'billing_status_unavailable'},503)}
 };
}
