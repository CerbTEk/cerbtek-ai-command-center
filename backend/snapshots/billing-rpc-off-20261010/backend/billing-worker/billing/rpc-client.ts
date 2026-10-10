import { PROJECT_URL } from './rpc-edge-host.mjs';
// Built-in server identity is accessed only in the Edge runtime, never returned or
// logged, copied into SQL, browser state, source, or a new custom credential.
export async function makeServiceClient() {
 const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??Deno.env.get('SUPABASE_SECRET_KEY');
 if(!key)throw new Error('billing_host_configuration_invalid');
 const {createClient}=await import('npm:@supabase/supabase-js@2.58.0');
 return createClient(PROJECT_URL,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
  global:{fetch:(input,init)=>fetch(input,{...init,signal:init?.signal??AbortSignal.timeout(10000)})}});
}
