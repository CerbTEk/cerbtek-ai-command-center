import {actor,configured,json,cors,sha256,type OAuthConfig} from "../_shared/company-email-oauth.ts";
import {UUID,rpc} from "../_shared/microsoft-connection.ts";
export function createHandler({supabase,providers={}}:{supabase:any;providers?:{microsoft?:OAuthConfig;google?:OAuthConfig}}){
 return async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});if(req.method!=="POST")return json({error:"Method not allowed"},405);
  const user=await actor(supabase,req);if(!user)return json({error:"Invalid session"},401);
  let b:any;try{b=await req.json()}catch{return json({error:"Invalid JSON"},400)}
  if(!b||typeof b!=="object"||Array.isArray(b)||!UUID.test(b.organization_id||"")||!["list","disconnect","finalize"].includes(b.action)||Object.keys(b).some(k=>!["organization_id","action",...(b.action==="finalize"?["state","browser_verifier","completion_secret"]:["connection_id","expected_revision"])].includes(k))||(b.action==="disconnect"&&(!UUID.test(b.connection_id||"")||!UUID.test(b.expected_revision||"")))||(b.action==="list"&&(b.connection_id!==undefined||b.expected_revision!==undefined)))return json({error:"Invalid company email request"},400);
  if(b.action==="finalize"&&(!UUID.test(b.state||"")||typeof b.browser_verifier!=="string"||!/^[A-Za-z0-9_-]{43,128}$/.test(b.browser_verifier)||typeof b.completion_secret!=="string"||!/^[A-Za-z0-9_-]{43,128}$/.test(b.completion_secret)))return json({error:"Invalid email browser confirmation"},400);
  try{
   if(b.action==="finalize"){
    const v=await rpc(supabase,"finish_company_email_oauth_setup",{p_organization_id:b.organization_id,p_actor_id:user.id,p_state:b.state,p_browser_challenge:await sha256(b.browser_verifier),p_completion_challenge:await sha256(b.completion_secret)});
    if(!v||v.organization_id!==b.organization_id||v.state!==b.state||!["microsoft","google"].includes(v.provider)||!UUID.test(v.connection_id||""))throw new Error("Email confirmation failed");
    return json({ok:true,connected:true,organization_id:v.organization_id,provider:v.provider,connection_id:v.connection_id,state:v.state});
   }
   if(b.action==="disconnect"){const result=await rpc(supabase,"disconnect_company_email_connection",{p_organization_id:b.organization_id,p_actor_id:user.id,p_connection_id:b.connection_id,p_expected_revision:b.expected_revision});if(result!==true)throw new Error("Disconnect unconfirmed");return json({ok:true,disconnected:true})}
   const value=await rpc(supabase,"list_company_email_connections",{p_organization_id:b.organization_id,p_actor_id:user.id});
   if(!value||value.organization_id!==b.organization_id||!Array.isArray(value.connections))throw new Error("Invalid company result");
   // Explicit projection is a second boundary: a future SQL change cannot leak token references.
   const connections=value.connections.map((c:any)=>({id:c.id,integration_id:c.integration_id,provider:c.provider,status:c.status,account_email:c.account_email??null,account_name:c.account_name??null,scopes:c.scopes,capabilities:{mail_read:c.capabilities?.mail_read===true,mail_send:c.capabilities?.mail_send===true},connected_by:c.connected_by??null,is_own_connection:c.connected_by===user.id,oauth_revision:c.oauth_revision}));
   return json({ok:true,contract_version:1,organization_id:b.organization_id,can_manage:value.can_manage===true,providers:{microsoft:{configured:configured("microsoft",providers.microsoft)},google:{configured:configured("google",providers.google)}},connections});
  }catch{return json({error:"Company email connection unavailable. Refresh and check your company permission."},409)}
 };
}
