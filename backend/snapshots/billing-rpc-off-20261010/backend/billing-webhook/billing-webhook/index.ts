import { createSandboxRpcWebhookEntrypoint } from '../billing/rpc-edge-host.mjs';
import { makeServiceClient } from '../billing/rpc-client.ts';
// Replaces only this existing endpoint; deploy hard-OFF before approved activation.
// verify_jwt=false: authentication remains the verified raw-body Stripe signature.
Deno.serve(createSandboxRpcWebhookEntrypoint({
 getEnv:(key:string)=>key.endsWith('_ENABLED')?'false':Deno.env.get(key),
 makeServiceClient,
}));
