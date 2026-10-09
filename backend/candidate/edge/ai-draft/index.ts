import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import {createHandler} from './handler.mjs';
import {validateProvider} from './core.mjs';
// Read only by deployed server runtime; never exposed in UI/configuration/backups.
// No default model or invented pricing: deployment owner must approve a priced catalog.
let catalog=[];try{const parsed=JSON.parse(Deno.env.get('KAIRO_AI_MODEL_CATALOG')||'[]');if(Array.isArray(parsed))catalog=parsed}catch{}
Deno.serve(createHandler({
 supabase:createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}}),
 // This release cannot dispatch paid inference. Enabling it is a separate approved release.
 catalog,liveEnabled:false,
 // Existing deployment-wide OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY are
 // deliberately NOT tenant connections. Only explicitly organization-bound secrets count.
 // Provisioning a secret requires its own approved secure setup; this code provisions none.
 resolveCredential:async({organizationId,provider})=>{
  validateProvider(provider);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId))return null;
  const name=`KAIRO_AI_${provider.toUpperCase()}_${organizationId.replaceAll('-','').toUpperCase()}_KEY`;
  const apiKey=Deno.env.get(name)||'';
  return apiKey?{organizationId,provider,apiKey}:null;
 },
 // Verified existing Kairo Webflow Cloud origin; retain exact-match CORS and mandatory JWT auth.
 allowedOrigins:['https://cerbtek-ai-command-center.webflow.io']
}));
