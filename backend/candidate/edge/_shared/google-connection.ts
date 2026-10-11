import {canonicalScopes,connectionBinding,rpc,requireTrue,providerJson} from "./microsoft-connection.ts";
const aliases:Record<string,string>={"https://www.googleapis.com/auth/userinfo.email":"email","https://www.googleapis.com/auth/userinfo.profile":"profile"};
export function googleGrantedScopes(scope:unknown,requested:string[]){
 if(typeof scope!=="string"||!scope.trim())throw new Error("Google did not confirm granted scopes");
 const granted=canonicalScopes(scope.trim().split(/\s+/).map(s=>aliases[s]||s));
 if(JSON.stringify(granted)!==JSON.stringify(canonicalScopes(requested.map(s=>aliases[s]||s))))throw new Error("Google granted scopes differ from requested scopes");
 return granted;
}
export function googleTokenResult(value:any,requested:string[],now=Date.now(),requireRefresh=false){
 if(typeof value.access_token!=="string"||!value.access_token||/[\r\n]/.test(value.access_token)||typeof value.token_type!=="string"||value.token_type.toLowerCase()!=="bearer"||!Number.isFinite(value.expires_in)||value.expires_in<=0||value.expires_in>86400||(requireRefresh&&(typeof value.refresh_token!=="string"||!value.refresh_token))||(value.refresh_token!==undefined&&(typeof value.refresh_token!=="string"||!value.refresh_token)))throw new Error("Google returned an incomplete token grant");
 return {accessToken:value.access_token,refreshToken:value.refresh_token??null,expiresAt:new Date(now+value.expires_in*1000).toISOString(),grantedScopes:googleGrantedScopes(value.scope,requested)};
}
export async function verifiedGoogleMailbox(fetchImpl:typeof fetch,accessToken:string,expectedId?:string,expectedEmail?:string){
 const a=await providerJson(fetchImpl,"https://openidconnect.googleapis.com/v1/userinfo",{headers:{Authorization:`Bearer ${accessToken}`,Accept:"application/json"}});
 if(typeof a.sub!=="string"||!a.sub.trim()||a.sub.length>512||/[\x00-\x1f\x7f]/.test(a.sub)||typeof a.email!=="string"||!/^([^\s@]+)@([^\s@]+)$/.test(a.email)||a.email.length>320||a.email_verified!==true||(expectedId!==undefined&&a.sub!==expectedId)||(expectedEmail!==undefined&&a.email.toLowerCase()!==expectedEmail.toLowerCase()))throw new Error("Google mailbox identity could not be verified");
 return {id:a.sub,email:a.email.toLowerCase(),name:typeof a.name==="string"&&a.name.trim()?a.name.slice(0,512):a.email};
}
export async function getGoogleAccessToken({supabase,connection:c,fetchImpl=fetch,now=Date.now}:{supabase:any;connection:any;fetchImpl?:typeof fetch;now?:()=>number}):Promise<string>{
 if(c.provider!=="google"||c.status!=="Connected"||c.oauth_verified_version!==1||!c.external_account_id||!c.external_account_email||!c.access_secret_id||!c.refresh_secret_id||!c.client_secret_id||!c.oauth_refresh_revision)throw new Error("Google connection is unavailable");
 const {data:i,error}=await supabase.from("integrations").select("*").eq("id",c.integration_id).eq("organization_id",c.organization_id).single();
 if(error||!i||i.id!==c.integration_id||i.organization_id!==c.organization_id||i.provider!=="Google"||i.integration_type!=="OAuth"||i.status!=="Connected"||i.scopes!==(c.scopes||[]).join(" ")||!i.oauth_revision)throw new Error("Google integration is unavailable");
 const binding=connectionBinding(c,i),validate=()=>requireTrue(supabase,"validate_email_connection",{p_connection_id:c.id,p_organization_id:c.organization_id,p_expected_binding:binding});
 const secret=async(id:string)=>{const v=await rpc(supabase,"edge_read_secret",{secret_id:id});if(typeof v!=="string"||!v)throw new Error("Google credential unavailable");return v};
 await validate();
 if(Date.parse(c.token_expires_at||"")>now()+120000){const access=await secret(c.access_secret_id);await validate();return access}
 const refresh=await secret(c.refresh_secret_id),clientSecret=await secret(c.client_secret_id);await validate();
 const value=await providerJson(fetchImpl,"https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:c.client_id,client_secret:clientSecret,grant_type:"refresh_token",refresh_token:refresh})});
 const result=googleTokenResult(value,c.scopes,now());
 const account=await verifiedGoogleMailbox(fetchImpl,result.accessToken,c.external_account_id,c.external_account_email);
 await requireTrue(supabase,"commit_email_refresh",{p_connection_id:c.id,p_organization_id:c.organization_id,p_expected_refresh_revision:c.oauth_refresh_revision,p_expected_binding:binding,p_access_token:result.accessToken,p_refresh_token:result.refreshToken,p_expires_at:result.expiresAt,p_account_id:account.id,p_account_email:account.email,p_granted_scopes:result.grantedScopes});
 return result.accessToken;
}
