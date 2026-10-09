import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import {createHandler} from './handler.mjs';
// Read only by deployed server runtime; never exposed in UI/configuration/backups.
// No default model or invented pricing: deployment owner must approve a priced catalog.
let catalog=[];try{const parsed=JSON.parse(Deno.env.get('KAIRO_AI_MODEL_CATALOG')||'[]');if(Array.isArray(parsed))catalog=parsed}catch{}
Deno.serve(createHandler({
 supabase:createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}}),
 // This prelaunch release cannot dispatch paid inference. Enabling it is a separate approved release.
 catalog,apiKey:Deno.env.get('OPENAI_API_KEY')||'',liveEnabled:false,
 // Verified existing Kairo Webflow Cloud origin; retain exact-match CORS and mandatory JWT auth.
 allowedOrigins:['https://cerbtek-ai-command-center.webflow.io']
}));
