import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {createClient} from "https://esm.sh/@supabase/supabase-js@2.58.0";
import {createHandler} from "./handler.ts";
const supabaseUrl=Deno.env.get("SUPABASE_URL")!;
const supabase=createClient(supabaseUrl,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
Deno.serve(createHandler({supabase,supabaseUrl}));
