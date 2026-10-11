import {getGoogleAccessToken,verifiedGoogleMailbox} from "../_shared/google-connection.ts";
import {emailConnectionBinding, emailProvider, GOOGLE_READ_SCOPE} from "../_shared/email-runtime.ts";
import {assertRunLineage, stable} from "../_shared/approved-runtime.ts";
import {UUID, connectionBinding, getMicrosoftAccessToken, loadMicrosoftIntegration, providerJson, validateConnection} from "../_shared/microsoft-connection.ts";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
const requirements:Record<string,string>={health:"User.Read",profile:"User.Read","inbox-status":"Mail.Read","calendar-next":"Calendars.Read"};
export function createHandler({supabase,fetchImpl=fetch,now=Date.now,getAccessToken=async(args:any)=>args.connection.provider==="google"?getGoogleAccessToken(args):getMicrosoftAccessToken(args)}: {
  supabase:any;fetchImpl?:typeof fetch;now?:()=>number;getAccessToken?:typeof getMicrosoftAccessToken;
}) {
  return async(req:Request)=>{
    if(req.method==="OPTIONS") return new Response("ok",{headers:cors});
    if(req.method!=="POST") return json({error:"Method not allowed"},405);
    const started=now();
    const jwt=req.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if(!jwt)return json({error:"Missing authorization"},401);
    const {data:auth,error:authError}=await supabase.auth.getUser(jwt);
    if(authError||!auth?.user?.id || auth.user.is_anonymous===true)return json({error:"Invalid session"},401);
    let body:any;try{body=await req.json()}catch{return json({error:"Invalid JSON"},400)}
    if(!body || typeof body!=="object" || Array.isArray(body) || Object.keys(body).some(k=>!["organization_id","action","workflow_run_id","provider","connection_id"].includes(k))) return json({error:"Unsupported request fields"},400);
    if(body.workflow_run_id!==undefined && !UUID.test(body.workflow_run_id||""))return json({error:"Invalid workflow run"},400);
    const organization=body?.organization_id, action=body?.action||"health", provider=body.provider??"microsoft";
    if(!emailProvider(provider)||(body.connection_id!==undefined&&!UUID.test(body.connection_id))||(provider==="google"&&(action==="calendar-next"||body.workflow_run_id!==undefined)))return json({error:"Unsupported email account action"},400);
    if(!UUID.test(organization||"")||!Object.hasOwn(requirements,action))return json({error:"Invalid request"},400);
    const [{data:member,error:memberError},{data:staff,error:staffError}]=await Promise.all([
      supabase.from("organization_members").select("role").eq("organization_id",organization).eq("user_id",auth.user.id).maybeSingle(),
      supabase.from("staff_accounts").select("role,active").eq("user_id",auth.user.id).maybeSingle(),
    ]);
    if(memberError||staffError||(!member&&!staff?.active))return json({error:"Not authorized for this organization"},403);
    let query=supabase.from("oauth_connections").select("*").eq("organization_id",organization).eq("provider",provider);
    if(body.connection_id!==undefined)query=query.eq("id",body.connection_id);
    const {data:connection,error}=await query.single();
    if(error||!connection||connection.organization_id!==organization||connection.provider!==provider||connection.status!=="Connected"||connection.oauth_verified_version!==1)
      return json({error:"Email account is not connected"},409);
    const required=provider==="google"?(action==="inbox-status"?GOOGLE_READ_SCOPE:"openid"):requirements[action];
    if(!connection.scopes?.includes(required))return json({error:"This action requires an explicitly granted email permission"},403);
    const log={organization_id:organization,integration_id:connection.integration_id,connection_id:connection.id,provider,action,actor_user_id:auth.user.id};
    const assertRequester=async()=>{
      const [{data:m,error:me},{data:s,error:se}]=await Promise.all([
        supabase.from('organization_members').select('role').eq('organization_id',organization).eq('user_id',auth.user.id).maybeSingle(),
        supabase.from('staff_accounts').select('role,active').eq('user_id',auth.user.id).maybeSingle(),
      ]);
      if(me||se||(!m&&!s?.active))throw new Error('Requesting actor access changed');
    };

    try{
      const assertWorkflow = async () => {
        if(body.workflow_run_id===undefined)return;
        const {data:run,error:runError}=await supabase.from("workflow_runs").select("*").eq("id",body.workflow_run_id).eq("organization_id",organization).single();
        if(runError || !run || run.id!==body.workflow_run_id || run.organization_id!==organization || run.status!=="Running"
            || !Number.isInteger(run.current_step) || run.current_step<0 || !Array.isArray(run.workflow_steps)
            || run.workflow_steps[run.current_step]?.type!==`microsoft.${action}`)throw new Error("Workflow step unavailable");
        const {data:definition,error:definitionError}=await supabase.from("workflow_definitions").select("*").eq("id",run.workflow_id).eq("organization_id",organization).single();
        if(definitionError || !definition || definition.id!==run.workflow_id || definition.organization_id!==organization
            || definition.status!=="Active" || !run.workflow_revision || definition.updated_at!==run.workflow_revision
            || stable(definition.steps)!==stable(run.workflow_steps))throw new Error("Workflow changed or inactive");
        await assertRunLineage(supabase,run,auth.user.id);
      };
      await assertWorkflow();await assertRequester();
      let integration:any, binding:any, result:any={},summary="";
      if(provider==='google'){
        const {data:i,error:ie}=await supabase.from('integrations').select('*').eq('id',connection.integration_id).eq('organization_id',organization).single();
        if(ie||!i||i.provider!=='Google'||i.status!=='Connected'||i.integration_type!=='OAuth')throw new Error('Google integration unavailable');
        integration=i;binding=emailConnectionBinding(connection,i);
        const validate=async()=>{const {data,error}=await supabase.rpc('validate_email_connection',{p_connection_id:connection.id,p_organization_id:organization,p_expected_binding:binding});if(error||data!==true)throw new Error('Google account changed')};
        const token=await getAccessToken({supabase,connection,fetchImpl,now});await validate();await assertRequester();
        const me=await verifiedGoogleMailbox(fetchImpl,token,connection.external_account_id,connection.external_account_email);
        if(action==='inbox-status'){
          await assertRequester();
          const profile=await providerJson(fetchImpl,'https://gmail.googleapis.com/gmail/v1/users/me/profile',{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
          if(typeof profile.emailAddress!=='string'||profile.emailAddress.toLowerCase()!==me.email.toLowerCase()||!Number.isSafeInteger(profile.messagesTotal)||profile.messagesTotal<0||!Number.isSafeInteger(profile.threadsTotal)||profile.threadsTotal<0)throw new Error('Google mailbox response invalid');
          result={messagesTotal:profile.messagesTotal,threadsTotal:profile.threadsTotal};summary=`Gmail account has ${profile.messagesTotal} messages across ${profile.threadsTotal} threads`;
        }else{result={displayName:me.name,mail:me.email};summary='Google email account identity verified'}
        await validate();
      }else{
      integration=await loadMicrosoftIntegration(supabase,connection);
      binding=connectionBinding(connection,integration);
      const token=await getAccessToken({supabase,connection,fetchImpl,now});
      await validateConnection(supabase,connection,binding);
      await assertWorkflow();
      const graph=async(path:string)=>{await assertRequester();return providerJson(fetchImpl,"https://graph.microsoft.com/v1.0"+path,{headers:{Authorization:`Bearer ${token}`,Accept:"application/json"}})};
      if(action==="health"||action==="profile"){
        const me=await graph(action==="health"?"/me?$select=id,displayName,userPrincipalName":"/me?$select=id,displayName,mail,userPrincipalName,jobTitle,officeLocation");
        if(me.id!==connection.external_account_id)throw new Error("Mailbox identity changed");
        result=action==="health"?{displayName:me.displayName,userPrincipalName:me.userPrincipalName}:
          {displayName:me.displayName,mail:me.mail,userPrincipalName:me.userPrincipalName,jobTitle:me.jobTitle,officeLocation:me.officeLocation};
        summary=action==="health"?"Microsoft Graph account health verified":"Microsoft account profile verified";
      }else if(action==="inbox-status"){
        const inbox=await graph("/me/mailFolders/inbox?$select=displayName,totalItemCount,unreadItemCount");
        result={totalItemCount:inbox.totalItemCount,unreadItemCount:inbox.unreadItemCount};
        summary=`Inbox has ${inbox.unreadItemCount||0} unread of ${inbox.totalItemCount||0} total messages`;
      }else{
        const start=new Date(now()).toISOString(),end=new Date(now()+7*86400000).toISOString();
        const cal=await graph(`/me/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$select=subject,start,end&$top=5&$orderby=start/dateTime`);
        if(!Array.isArray(cal.value))throw new Error("Invalid calendar response");
        result={events:cal.value.slice(0,5).map((e:any)=>({subject:e.subject,start:e.start?.dateTime,end:e.end?.dateTime}))};
        summary=`Found ${result.events.length} upcoming events in the next 7 days`;
      }
      await validateConnection(supabase,connection,binding);
      }
      await assertRequester();
      const duration=now()-started;
      const logged=await supabase.from("integration_runs").insert({...log,status:"Success",duration_ms:duration,summary,metadata:result});
      if(logged.error)throw new Error("Unable to record integration result");
      // A health read must not resurrect a disabled or reconfigured integration.
      const health=await supabase.from("integrations").update({last_health_check_at:new Date(now()).toISOString(),notes:summary})
        .eq("id",integration.id).eq("organization_id",organization).eq("oauth_revision",integration.oauth_revision).eq("status","Connected");
      if(health.error)throw new Error("Unable to record integration health");
      await assertRequester();
      return json({ok:true,action,summary,result,duration_ms:duration});
    }catch{
      const duration=now()-started;
      try{await supabase.from("integration_runs").insert({...log,status:"Error",duration_ms:duration,summary:"Email provider read failed",error_message:"Email provider read failed or connection authority changed"})}catch{}
      // No stale error path may overwrite connection or integration status.
      return json({ok:false,error:"Email provider read failed or connection authority changed",duration_ms:duration},502);
    }
  };
}
