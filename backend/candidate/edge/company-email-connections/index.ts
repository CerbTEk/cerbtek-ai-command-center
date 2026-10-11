import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "https://esm.sh/@supabase/supabase-js@2.58.0";
import {createHandler} from "./handler.ts";
const supabase=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
Deno.serve(createHandler({supabase,providers:{microsoft:{clientId:Deno.env.get("KAIRO_MICROSOFT_CLIENT_ID")||"",clientSecret:Deno.env.get("KAIRO_MICROSOFT_CLIENT_SECRET")||"",tenantId:Deno.env.get("KAIRO_MICROSOFT_TENANT_ID")||"organizations"},google:{clientId:Deno.env.get("KAIRO_GOOGLE_CLIENT_ID")||"",clientSecret:Deno.env.get("KAIRO_GOOGLE_CLIENT_SECRET")||""}}}));
