import {canonicalScopes, DEFAULT_SCOPES, SUPPORTED_SCOPES, UUID, rpc} from "../_shared/microsoft-connection.ts";
export const cors = {"Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods":"POST, OPTIONS"};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {...cors, "Content-Type":"application/json"}});
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
export function createHandler({supabase, supabaseUrl}: {supabase: any; supabaseUrl: string}) {
  return async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", {headers: cors});
    if (req.method !== "POST") return json({error:"Method not allowed"},405);
    const jwt = req.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!jwt) return json({error:"Missing authorization"},401);
    const {data: auth, error: authError} = await supabase.auth.getUser(jwt);
    if (authError || !auth?.user?.id || auth.user.is_anonymous===true) return json({error:"Invalid session"},401);
    let body: any;
    try { body=await req.json(); } catch { return json({error:"Invalid JSON"},400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({error:"Invalid request"},400);
    const tenant = typeof body.tenant_id === "string" ? body.tenant_id.trim() : "organizations";
    const client = typeof body.client_id === "string" ? body.client_id.trim() : "";
    const secret = typeof body.client_secret === "string" ? body.client_secret : "";
    const scopes = body.scopes === undefined ? DEFAULT_SCOPES : body.scopes;
    if (!UUID.test(body.organization_id || "") || (body.integration_id != null && !UUID.test(body.integration_id))
        || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,254}$/.test(tenant) || !UUID.test(client)
        || !secret || secret.length>16384 || !Array.isArray(scopes) || !scopes.length || scopes.length>64
        || scopes.some((s: unknown) => typeof s !== "string" || !SUPPORTED_SCOPES.includes(s))
        || !scopes.includes("User.Read") || !scopes.includes("offline_access")) return json({error:"Invalid Microsoft setup configuration"},400);
    try {
      const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
      const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier))));
      const redirectUri = `${supabaseUrl.replace(/\/$/,"")}/functions/v1/microsoft-oauth-callback`;
      // SQL checks current actor privilege, same-tenant provider/integration, and stores the frozen setup atomically.
      const setup = await rpc(supabase,"begin_microsoft_oauth_setup", {p_organization_id:body.organization_id,
        p_integration_id:body.integration_id || null,p_actor_id:auth.user.id,p_tenant_id:tenant,p_client_id:client,
        p_client_secret:secret,p_scopes:canonicalScopes(scopes),p_code_verifier:verifier,p_redirect_uri:redirectUri});
      if (!setup || !UUID.test(setup.state || "") || !setup.connection_id || !Array.isArray(setup.scopes)
          || setup.redirect_uri !== redirectUri || setup.tenant_id !== tenant || setup.client_id !== client) throw new Error("Setup was not created");
      const url = new URL(`https://login.microsoftonline.com/${encodeURIComponent(setup.tenant_id)}/oauth2/v2.0/authorize`);
      url.search = new URLSearchParams({client_id:setup.client_id,response_type:"code",redirect_uri:setup.redirect_uri,
        response_mode:"query",scope:setup.scopes.join(" "),state:setup.state,code_challenge:challenge,code_challenge_method:"S256",prompt:"consent"}).toString();
      return json({authorize_url:url.toString(),connection_id:setup.connection_id,redirect_uri:setup.redirect_uri});
    } catch { return json({error:"Microsoft setup could not be started. Check your organization permission and integration configuration."},409); }
  };
}
