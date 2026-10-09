// Only the service-only database verdict authorizes a fresh paid reservation.
// Missing RPCs, partial migrations and malformed responses all stay OFF.
export const activationStatuses=Object.freeze(['activation_missing','activation_disabled','activation_expired','activation_configuration_changed','activation_invalid','activation_budget_exhausted','activation_run_limit','activation_account_mismatch','activation_unavailable','activation_authorized']);
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
export function activationVerdict(value,{organizationId,configurationId,now=Date.now()}={}){
 const denied={contract_version:1,organization_id:organizationId,configuration_id:configurationId??null,enabled:false,status:'activation_unavailable',activation_id:null,expires_at:null,account_binding_verified:false,limits:null};
 if(!value||Array.isArray(value)||value.contract_version!==1||value.organization_id!==organizationId||value.configuration_id!==(configurationId??null)||typeof value.enabled!=='boolean'||typeof value.account_binding_verified!=='boolean'||!activationStatuses.includes(value.status)||value.enabled!==(value.status==='activation_authorized'))return denied;
 if(value.enabled){
  const l=value.limits;
  if(!uuid(value.activation_id)||!uuid(configurationId)||typeof value.expires_at!=='string'||!Number.isFinite(Date.parse(value.expires_at))||Date.parse(value.expires_at)<=now||!l||Array.isArray(l)||Object.keys(l).sort().join(',')!==['request_microusd','daily_microusd','total_microusd','daily_runs','total_runs'].sort().join(',')||!['request_microusd','daily_microusd','total_microusd','daily_runs','total_runs'].every(k=>Number.isSafeInteger(l[k])&&l[k]>0)||l.request_microusd>1000000||l.daily_microusd>100000000||l.total_microusd>100000000||l.request_microusd>l.daily_microusd||l.daily_microusd>l.total_microusd||l.daily_runs>100||l.total_runs>10000||l.daily_runs>l.total_runs)return denied;
 }
 // Explicit projection: never forward unexpected server fields to a browser.
 return Object.fromEntries(Object.keys(denied).map(k=>[k,value[k]??denied[k]]));
}
export async function readActivation(supabase,{organizationId,actorId,configurationId,credential}){
 try{
  const {data,error}=await supabase.rpc('ai_inference_readiness',{p_org:organizationId,p_actor:actorId,p_config:configurationId??null,p_account:credential?.accountReference??null,p_fingerprint:credential?.credentialFingerprint??null});
  return activationVerdict(error?null:data,{organizationId,configurationId});
 }catch{return activationVerdict(null,{organizationId,configurationId})}
}
