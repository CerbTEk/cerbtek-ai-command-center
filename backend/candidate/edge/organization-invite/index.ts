import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import {createHandler} from './handler.mjs';

const origin = 'https://cerbtek-ai-command-center.webflow.io';
Deno.serve(createHandler({
  allowedOrigins: [origin], inviteOrigin: origin,
  makeUserClient: (jwt: string) => createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
    {global: {headers: {Authorization: `Bearer ${jwt}`}}, auth: {persistSession: false, autoRefreshToken: false}},
  ),
}));
