import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import { getMicrosoftAccessToken } from '../_shared/microsoft-connection.ts';
import { getGoogleAccessToken } from '../_shared/google-connection.ts';
import { createHandler } from './handler.mjs';
// Source candidate only. This route needs a separately reviewed deployment.
const supabase=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
Deno.serve(createHandler({supabase,getAccessToken:connection=>getMicrosoftAccessToken({supabase,connection}),getGoogleAccessToken:connection=>getGoogleAccessToken({supabase,connection}),allowedOrigins:['https://www.cerbtek.com','https://cerbtek-ai-command-center.webflow.io']}));
