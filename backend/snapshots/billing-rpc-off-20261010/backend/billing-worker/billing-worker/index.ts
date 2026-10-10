import { createSandboxRpcWorkerEntrypoint, createSandboxOperatorVerifier, PROJECT_URL } from '../billing/rpc-edge-host.mjs';
import { makeServiceClient } from '../billing/rpc-client.ts';
// Replaces only this existing endpoint; deploy hard-OFF before approved activation.
// verify_jwt=true plus fresh exact identity and current QA ownership, empty POST only.
Deno.serve(createSandboxRpcWorkerEntrypoint({
 getEnv:(key:string)=>key.endsWith('_ENABLED')?'false':Deno.env.get(key),
 makeServiceClient,
 makeStripeClient:async(secret:string,config:object)=>{const {default:Stripe}=await import('npm:stripe@23.0.0');return new Stripe(secret,{...config,httpClient:Stripe.createFetchHttpClient()})},
 getUser:createSandboxOperatorVerifier({makeUserClient:async(jwt:string)=>{
  const {createClient}=await import('npm:@supabase/supabase-js@2.58.0');
  return createClient(PROJECT_URL,Deno.env.get('SUPABASE_ANON_KEY')!,{auth:{persistSession:false,autoRefreshToken:false},global:{headers:{Authorization:`Bearer ${jwt}`},fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(5000)})}});
 }}),
}));
