import {UUID,canonicalScopes,rpc,requireTrue,providerJson,tokenResult,verifiedMailbox} from "./microsoft-connection.ts";
import {googleTokenResult,verifiedGoogleMailbox} from "./google-connection.ts";
export const APP_RETURN_URL="https://www.cerbtek.com/app/kairo";
export type Provider="microsoft"|"google";
export type OAuthConfig={clientId:string;clientSecret:string;tenantId?:string};
export const cors={"Access-Control-Allow-Origin":"https://www.cerbtek.com","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Vary":"Origin"};
export const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{...cors,"Content-Type":"application/json","Cache-Control":"no-store"}});
export function configured(provider:Provider,config?:OAuthConfig){return !!config && typeof config.clientId==="string" && (provider==="microsoft"?UUID.test(config.clientId):/^[A-Za-z0-9._-]{10,255}\.apps\.googleusercontent\.com$/.test(config.clientId)) && typeof config.clientSecret==="string" && config.clientSecret.length>0 && config.clientSecret.length<=16384 && (provider!=="microsoft" || /^(organizations|[0-9a-f-]{36})$/i.test(config.tenantId||"organizations"));}
export function requestedScopes(provider:Provider,intent:unknown){
 if(!["read","send","read_send"].includes(String(intent)))throw new Error("Select an explicit email permission");
 const read=intent==="read"||intent==="read_send",send=intent==="send"||intent==="read_send";
 return canonicalScopes(provider==="microsoft"?["openid","profile","offline_access","User.Read",...(read?["Mail.Read"]:[]),...(send?["Mail.Send"]:[])]:["openid","email","profile",...(read?["https://www.googleapis.com/auth/gmail.readonly"]:[]),...(send?["https://www.googleapis.com/auth/gmail.send"]:[])]);
}
export async function actor(supabase:any,req:Request){
 const jwt=req.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];if(!jwt)return null;
 const {data,error}=await supabase.auth.getUser(jwt);return !error&&data?.user?.id&&data.user.is_anonymous!==true?data.user:null;
}
export const sha256=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,"0")).join("");
const b64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
export function createConnectHandler({supabase,supabaseUrl,provider,oauthConfig}:{supabase:any;supabaseUrl:string;provider:Provider;oauthConfig?:OAuthConfig}){
 return async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(req.method!=="POST")return json({error:"Method not allowed"},405);
  const user=await actor(supabase,req);if(!user)return json({error:"Invalid session"},401);
  let body:any;try{body=await req.json()}catch{return json({error:"Invalid JSON"},400)}
  const allowed=["organization_id","intent","connection_id","expected_revision","browser_challenge"];
  if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k))||!UUID.test(body.organization_id||"")||!["read","send","read_send"].includes(body.intent)||typeof body.browser_challenge!=="string"||!/^[a-f0-9]{64}$/.test(body.browser_challenge)
   ||(body.connection_id!=null&&!UUID.test(body.connection_id))||(body.expected_revision!=null&&!UUID.test(body.expected_revision))||!!body.connection_id!==!!body.expected_revision)return json({error:"Invalid company email setup request"},400);
  if(!configured(provider,oauthConfig))return json({error:"Company email sign-in has not been configured by CerbTek.",code:"provider_not_configured"},503);
  try{
   const config=oauthConfig!,scopes=requestedScopes(provider,body.intent),verifier=b64(crypto.getRandomValues(new Uint8Array(48)));
   const challenge=b64(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier))));
   const redirectUri=`${supabaseUrl.replace(/\/$/,"")}/functions/v1/${provider}-oauth-callback`;
   const setup=await rpc(supabase,"begin_company_email_oauth_setup",{p_organization_id:body.organization_id,p_actor_id:user.id,p_provider:provider,p_intent:body.intent,p_connection_id:body.connection_id||null,p_expected_revision:body.expected_revision||null,p_tenant_id:provider==="microsoft"?(config.tenantId||"organizations"):"google",p_client_id:config.clientId,p_client_secret:config.clientSecret,p_scopes:scopes,p_code_verifier:verifier,p_redirect_uri:redirectUri,p_browser_challenge:body.browser_challenge});
   if(!setup||!UUID.test(setup.state||"")||!UUID.test(setup.connection_id||"")||setup.provider!==provider||setup.redirect_uri!==redirectUri||setup.client_id!==config.clientId||JSON.stringify(setup.scopes)!==JSON.stringify(scopes))throw new Error("Setup unavailable");
   const url=new URL(provider==="microsoft"?`https://login.microsoftonline.com/${encodeURIComponent(config.tenantId||"organizations")}/oauth2/v2.0/authorize`:"https://accounts.google.com/o/oauth2/v2/auth");
   url.search=new URLSearchParams({client_id:config.clientId,response_type:"code",redirect_uri:redirectUri,scope:scopes.join(" "),state:setup.state,code_challenge:challenge,code_challenge_method:"S256",...(provider==="microsoft"?{response_mode:"query",prompt:"consent"}:{access_type:"offline",prompt:"consent select_account",include_granted_scopes:"false"})}).toString();
   return json({authorize_url:url.toString(),connection_id:setup.connection_id,redirect_uri:redirectUri});
  }catch{return json({error:"Email setup could not be started. Refresh the company connection and check your permission."},409)}
 };
}
const redirect=(provider:Provider,ok:boolean,state?:string,completion?:string)=>{const u=new URL(APP_RETURN_URL);u.searchParams.set(provider,ok?"consent_returned":"error");if(ok&&state&&completion)u.hash=new URLSearchParams({email_oauth_state:state,email_oauth_provider:provider,email_oauth_completion:completion}).toString();if(!ok)u.searchParams.set("message","Email authorization failed. Start a new company connection setup.");return new Response(null,{status:302,headers:{Location:u.toString(),"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}})};
export function createCallbackHandler({supabase,supabaseUrl,provider,fetchImpl=fetch,now=Date.now}:{supabase:any;supabaseUrl:string;provider:Provider;fetchImpl?:typeof fetch;now?:()=>number}){
 return async(req:Request)=>{
  if(req.method!=="GET")return new Response("Method not allowed",{status:405});
  const q=new URL(req.url).searchParams,state=q.get("state");if(!state||!UUID.test(state)||q.getAll("state").length!==1)return redirect(provider,false);
  let claimed=false;
  try{
   const s=await rpc(supabase,"claim_company_email_oauth_setup",{p_state:state,p_provider:provider});
   if(!s||s.state!==state||s.provider!==provider||!s.code_verifier||!s.client_secret_id)throw new Error("Invalid setup");claimed=true;
   const code=q.get("code");if(q.has("error")||!code||code.length>16384||q.getAll("code").length!==1)throw new Error("Authorization denied");
   if(s.redirect_uri!==`${supabaseUrl.replace(/\/$/,"")}/functions/v1/${provider}-oauth-callback`)throw new Error("Callback binding changed");
   const secret=await rpc(supabase,"edge_read_secret",{secret_id:s.client_secret_id});if(typeof secret!=="string"||!secret)throw new Error("Credential unavailable");
   const token=await providerJson(fetchImpl,provider==="microsoft"?`https://login.microsoftonline.com/${encodeURIComponent(s.tenant_id)}/oauth2/v2.0/token`:"https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:s.client_id,client_secret:secret,grant_type:"authorization_code",code,redirect_uri:s.redirect_uri,code_verifier:s.code_verifier,...(provider==="microsoft"?{scope:s.scopes.join(" ")}:{})})});
   const result=provider==="microsoft"?tokenResult(token,s.scopes,now(),true):googleTokenResult(token,s.scopes,now(),true);
   const account=provider==="microsoft"?await verifiedMailbox(fetchImpl,result.accessToken):await verifiedGoogleMailbox(fetchImpl,result.accessToken);
   const completion=b64(crypto.getRandomValues(new Uint8Array(48)));
   await requireTrue(supabase,"stage_company_email_oauth_setup",{p_state:state,p_provider:provider,p_access_token:result.accessToken,p_refresh_token:result.refreshToken,p_expires_at:result.expiresAt,p_account_id:account.id,p_account_name:account.name,p_account_email:account.email,p_granted_scopes:result.grantedScopes,p_completion_challenge:await sha256(completion)});
   return redirect(provider,true,state,completion);
  }catch{if(claimed){try{await rpc(supabase,"fail_company_email_oauth_setup",{p_state:state,p_provider:provider})}catch{}}return redirect(provider,false)}
 };
}
