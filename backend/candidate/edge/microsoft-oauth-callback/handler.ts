import {UUID, rpc, requireTrue, providerJson, tokenResult, verifiedMailbox} from "../_shared/microsoft-connection.ts";
const appUrl = "https://cerbtek-ai-command-center.webflow.io/";
const redirect = (connected: boolean) => Response.redirect(`${appUrl}?microsoft=${connected?"connected":"error"}${connected?"":"&message=Microsoft%20authorization%20failed.%20Start%20a%20new%20connection%20setup."}`,302);
export function createHandler({supabase, supabaseUrl, fetchImpl=fetch, now=Date.now}: {
  supabase:any; supabaseUrl:string; fetchImpl?:typeof fetch; now?:()=>number;
}) {
  return async (req: Request) => {
    if (req.method !== "GET") return new Response("Method not allowed", {status:405});
    const query=new URL(req.url).searchParams;
    const state=query.get("state");
    if (!state || !UUID.test(state)) return redirect(false);
    let claimed=false;
    try {
      // Consume even a provider-denial callback so the nonce cannot later succeed.
      const setup=await rpc(supabase,"claim_microsoft_oauth_setup",{p_state:state});
      if (!setup || setup.state!==state || !setup.code_verifier || !setup.client_secret_id) throw new Error("Invalid setup");
      claimed=true;
      const code=query.get("code");
      if (query.has("error") || !code || code.length>16384) throw new Error("Microsoft authorization denied");
      if (setup.redirect_uri!==`${supabaseUrl.replace(/\/$/,"")}/functions/v1/microsoft-oauth-callback`) throw new Error("Callback binding changed");
      const clientSecret=await rpc(supabase,"edge_read_secret",{secret_id:setup.client_secret_id});
      if (typeof clientSecret!=="string" || !clientSecret) throw new Error("Credential unavailable");
      const token=await providerJson(fetchImpl,`https://login.microsoftonline.com/${encodeURIComponent(setup.tenant_id)}/oauth2/v2.0/token`,{
        method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
        body:new URLSearchParams({client_id:setup.client_id,client_secret:clientSecret,grant_type:"authorization_code",code,
          redirect_uri:setup.redirect_uri,code_verifier:setup.code_verifier,scope:setup.scopes.join(" ")}),
      });
      const result=tokenResult(token,setup.scopes,now(),true);
      // Graph /me must succeed with a stable account id and usable mailbox principal.
      const account=await verifiedMailbox(fetchImpl,result.accessToken);
      await requireTrue(supabase,"complete_microsoft_oauth_setup",{p_state:state,p_access_token:result.accessToken,
        p_refresh_token:result.refreshToken,p_expires_at:result.expiresAt,p_account_id:account.id,
        p_account_name:account.name,p_granted_scopes:result.grantedScopes});
      return redirect(true);
    } catch {
      if (claimed) { try { await rpc(supabase,"fail_microsoft_oauth_setup",{p_state:state}); } catch { /* Remains unverified; no raw secrets/errors in redirect. */ } }
      return redirect(false);
    }
  };
}
