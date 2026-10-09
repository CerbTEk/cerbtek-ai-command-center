import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import {createHandler} from './handler.mjs';
// This route never invokes providers, reads credentials, or sends mail. The existing
// AI draft and Microsoft action boundaries retain their deployment gates and controls.
Deno.serve(createHandler({
 supabase:createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}}),
 allowedOrigins:['https://cerbtek-ai-command-center.webflow.io'],
}));
