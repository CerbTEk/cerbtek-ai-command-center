import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import { createBillingStatusHandler } from './handler.mjs';
// Existing verified app origins only. Keep gateway JWT verification enabled.
Deno.serve(createBillingStatusHandler({
 allowedOrigins:['https://www.cerbtek.com','https://cerbtek.com','https://cerbtek-ai-command-center.webflow.io'],
 makeUserClient:(jwt:string)=>createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{
  global:{headers:{Authorization:`Bearer ${jwt}`}},auth:{persistSession:false,autoRefreshToken:false},
 }),
}));
