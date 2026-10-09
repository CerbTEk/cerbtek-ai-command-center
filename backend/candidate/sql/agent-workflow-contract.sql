-- LOCAL REVIEW CANDIDATE ONLY. Requires OAuth, guard, and workflow contracts.
-- Human-approved existing workflows only; descriptive agent fields are frozen for review,
-- not interpreted as an autonomous policy language. No confidence value grants authority.
begin;
alter table public.agent_run_requests add column execution_snapshot jsonb;
alter table public.workflow_runs add column agent_run_request_id uuid references public.agent_run_requests(id) on delete restrict;
create unique index one_agent_request_per_workflow_run on public.agent_run_requests(workflow_run_id) where workflow_run_id is not null;
create unique index one_workflow_run_per_agent_request on public.workflow_runs(agent_run_request_id) where agent_run_request_id is not null;
create table private.agent_daily_reservations(
 agent_id uuid not null references public.ai_agents(id) on delete restrict,
 reservation_day date not null, reserved_count integer not null check(reserved_count>0),
 primary key(agent_id,reservation_day)
);
create table private.agent_run_reservations(
 request_id uuid primary key references public.agent_run_requests(id) on delete restrict,
 run_id uuid not null unique references public.workflow_runs(id) deferrable initially deferred,
 agent_id uuid not null references public.ai_agents(id) on delete restrict,
 organization_id uuid not null references public.organizations(id) on delete restrict,
 reservation_day date not null, reserved_at timestamptz not null default now()
);
alter table private.agent_daily_reservations enable row level security;
alter table private.agent_run_reservations enable row level security;
revoke all on private.agent_daily_reservations,private.agent_run_reservations from public,anon,authenticated;
grant select,insert,update on private.agent_daily_reservations to service_role;
grant select,insert on private.agent_run_reservations to service_role;

create function private.agent_actor_allowed(p_org uuid,p_actor uuid,p_approve boolean,p_roles text[] default null)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select p_actor is not null and (
  exists(select 1 from public.organization_members where organization_id=p_org and user_id=p_actor
   and (not p_approve or role in ('owner','admin','consultant')) and (p_roles is null or role=any(p_roles)))
  or exists(select 1 from public.staff_accounts where user_id=p_actor and active
   and (not p_approve or role in ('platform_admin','consultant')) and (p_roles is null or role=any(p_roles)))
 )
$$;
create function private.agent_context_clean(v jsonb) returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare k text; x jsonb;
begin
 if jsonb_typeof(v)='object' then
  for k,x in select * from jsonb_each(v) loop
   if k ~* '^agent(_|$)' or k=any(array['outputs','action_request_id','workflow_run_id','workflow_id','run_id','approved_by','approved_at','requested_by','initiated_by','__proto__','prototype','constructor','_agent_run_request_id']) then return false;end if;
   if not private.agent_context_clean(x) then return false;end if;
  end loop;
 elsif jsonb_typeof(v)='array' then
  for x in select * from jsonb_array_elements(v) loop if not private.agent_context_clean(x) then return false;end if;end loop;
 end if;
 return true;
end $$;

create function private.build_agent_snapshot(p_agent_id uuid,p_workflow_id uuid,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.ai_agents; w public.workflow_definitions; m public.agent_workflows;
 c public.oauth_connections; i public.integrations; im public.agent_integrations;
 step jsonb; operation text; needs_read boolean:=false; needs_write boolean:=false; scopes text[]:='{}'; bindings jsonb:='[]'; policy jsonb:='null';
begin
 if current_setting('transaction_isolation') is distinct from 'read committed' then raise exception 'Agent authority requires READ COMMITTED';end if;
 select * into a from public.ai_agents where id=p_agent_id for share;
 if not found or a.status is distinct from 'Active' then raise exception 'Agent inactive';end if;
 if a.max_daily_runs is not null and a.max_daily_runs<1 then raise exception 'Invalid agent daily quota';end if;
 select * into w from public.workflow_definitions where id=p_workflow_id and organization_id=a.organization_id for share;
 if not found or w.status is distinct from 'Active' or w.updated_at is null or jsonb_typeof(w.steps) is distinct from 'array' or jsonb_array_length(w.steps)>100 then raise exception 'Workflow unavailable';end if;
 select * into m from public.agent_workflows where agent_id=a.id and workflow_id=w.id for share;
 if not found or not m.active or m.execution_mode not in ('Propose','Execute') then raise exception 'Workflow mapping unavailable';end if;
 if jsonb_typeof(p_context) is distinct from 'object' or not private.agent_context_clean(p_context) or octet_length(p_context::text)>100000 then raise exception 'Invalid or reserved agent context';end if;
 policy:=coalesce(private.workflow_policy_snapshot(w),'null'::jsonb);
 for step in select * from jsonb_array_elements(w.steps) loop
  if jsonb_typeof(step) is distinct from 'object' then raise exception 'Invalid workflow step';end if;
  operation:=step->>'type';
  if operation in ('microsoft.health','microsoft.profile','microsoft.inbox-status','microsoft.calendar-next') then
   if step-'type'<>'{}'::jsonb then raise exception 'Unsupported read step fields';end if;
   needs_read:=true;
   scopes:=array_append(scopes,case operation when 'microsoft.inbox-status' then 'Mail.Read' when 'microsoft.calendar-next' then 'Calendars.Read' else 'User.Read' end);
  elsif operation='approval.email' then
   if step-array['type','to','subject','message']<>'{}'::jsonb or jsonb_typeof(step->'to') is distinct from 'string' or jsonb_typeof(step->'subject') is distinct from 'string' or jsonb_typeof(step->'message') is distinct from 'string' then raise exception 'Invalid approval email step';end if;
   needs_write:=true;scopes:=array_append(scopes,'Mail.Send');
  elsif operation='note' then
   if step-array['type','text']<>'{}'::jsonb or jsonb_typeof(step->'text') is distinct from 'string' then raise exception 'Invalid note step';end if;
  else raise exception 'Unsupported workflow operation';end if;
 end loop;
 if needs_read or needs_write then
  select * into c from public.oauth_connections where organization_id=a.organization_id and provider='microsoft' for share;
  if not found or c.status is distinct from 'Connected' or c.oauth_verified_version is distinct from 1 or nullif(btrim(c.external_account_id),'') is null or not c.scopes@>scopes then raise exception 'Verified provider scope unavailable';end if;
  select * into i from public.integrations where id=c.integration_id and organization_id=a.organization_id for share;
  if not found or i.status is distinct from 'Connected' or i.provider is distinct from 'Microsoft' or i.integration_type is distinct from 'OAuth' then raise exception 'Provider integration unavailable';end if;
  select * into im from public.agent_integrations where agent_id=a.id and integration_id=i.id for share;
  if not found or im.access_mode not in ('Read','Write','Read/Write') or (needs_read and im.access_mode not in ('Read','Read/Write')) or (needs_write and im.access_mode not in ('Write','Read/Write')) then raise exception 'Literal integration access does not allow this workflow';end if;
  bindings:=jsonb_build_array(jsonb_build_object('mapping',to_jsonb(im),'connection',private.microsoft_connection_binding(c,i)));
 end if;
 return jsonb_build_object('version',1,'agent',to_jsonb(a),'workflow',to_jsonb(w),'workflow_mapping',to_jsonb(m),'policy',policy,'integration_bindings',bindings,'context',p_context);
end $$;

create function private.agent_required_roles(snapshot jsonb) returns text[] language sql immutable security invoker set search_path=pg_catalog as $$
 select case when snapshot->'policy'='null'::jsonb then null else array(select jsonb_array_elements_text(snapshot->'policy'->'required_roles')) end
$$;

create function private.guard_agent_request() returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare live_snapshot jsonb; linked public.workflow_runs;
begin
 if TG_OP='INSERT' then
  if new.status is distinct from 'Pending' or new.approved_by is not null or new.approved_at is not null or new.executed_at is not null or new.workflow_run_id is not null or new.confidence is not null then raise exception 'Agent requests require an unapproved human proposal';end if;
  live_snapshot:=private.build_agent_snapshot(new.agent_id,new.workflow_id,new.context);
  if live_snapshot->'agent'->>'organization_id' is distinct from new.organization_id::text or not private.agent_actor_allowed(new.organization_id,new.requested_by,false) then raise exception 'Agent requester tenant authorization invalid';end if;
  new.execution_snapshot:=live_snapshot;
  return new;
 end if;
 if (to_jsonb(new)-array['status','approved_by','approved_at','executed_at','error_message','workflow_run_id']) is distinct from (to_jsonb(old)-array['status','approved_by','approved_at','executed_at','error_message','workflow_run_id']) then raise exception 'Agent execution snapshot is immutable';end if;
 if old.status is distinct from 'Pending' and (new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at) then raise exception 'Agent approval evidence is immutable';end if;
 if new.status='Approved' and old.status='Pending' then
  if new.approved_by is null or new.approved_at is null or new.approved_by=new.requested_by then raise exception 'Distinct human agent approval required';end if;
  if not private.agent_actor_allowed(new.organization_id,new.approved_by,true,private.agent_required_roles(new.execution_snapshot)) then raise exception 'Literal policy role cannot approve';end if;
  if new.execution_snapshot is distinct from private.build_agent_snapshot(new.agent_id,new.workflow_id,new.context) then raise exception 'Agent proposal changed before approval';end if;
 elsif new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at then raise exception 'Approval requires explicit human review';end if;
 if new.workflow_run_id is distinct from old.workflow_run_id then
  if old.workflow_run_id is not null or new.workflow_run_id is null or old.status is distinct from 'Approved' or new.status is distinct from 'Approved' or not exists(select 1 from private.agent_run_reservations where request_id=new.id and run_id=new.workflow_run_id and agent_id=new.agent_id and organization_id=new.organization_id) then raise exception 'Agent workflow linkage is immutable and reservation managed';end if;
  select * into linked from public.workflow_runs where id=new.workflow_run_id;
  if not found or linked.agent_run_request_id is distinct from new.id or linked.organization_id is distinct from new.organization_id or linked.workflow_id is distinct from new.workflow_id then raise exception 'Agent linked workflow mismatch';end if;
 end if;
 if new.status is distinct from old.status and not ((old.status='Pending' and new.status in ('Approved','Rejected')) or (old.status='Approved' and new.status in ('Executed','Failed'))) then raise exception 'Invalid agent transition';end if;
 if new.status in ('Executed','Failed') and new.status is distinct from old.status then
  select * into linked from public.workflow_runs where id=old.workflow_run_id and agent_run_request_id=old.id and organization_id=old.organization_id and workflow_id=old.workflow_id;
  if not found or (new.status='Executed' and (linked.status is distinct from 'Success' or linked.completed_at is null or linked.current_step is distinct from jsonb_array_length(linked.workflow_steps) or new.executed_at is null)) or (new.status='Failed' and (linked.status not in ('Error','Canceled') or new.executed_at is not null)) then raise exception 'Only the exact terminal workflow can finish its agent request';end if;
 elsif new.executed_at is distinct from old.executed_at then raise exception 'Execution timestamp requires terminal success';end if;
 return new;
end $$;
drop trigger if exists harden_agent_request on public.agent_run_requests;
create trigger harden_agent_request before insert or update on public.agent_run_requests for each row execute function private.guard_agent_request();

create function public.create_agent_workflow_request(p_agent_id uuid,p_workflow_id uuid,p_actor_id uuid,p_context jsonb)
returns public.agent_run_requests language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.agent_run_requests; org uuid;
begin
 select organization_id into org from public.ai_agents where id=p_agent_id;
 insert into public.agent_run_requests(organization_id,agent_id,workflow_id,requested_by,context,status) values(org,p_agent_id,p_workflow_id,p_actor_id,p_context,'Pending') returning * into r;
 return r;
end $$;
create function public.review_agent_workflow_request(p_request_id uuid,p_actor_id uuid,p_approve boolean)
returns public.agent_run_requests language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.agent_run_requests;
begin
 perform 1 from public.ai_agents where id=(select agent_id from public.agent_run_requests where id=p_request_id) for share;
 select * into r from public.agent_run_requests where id=p_request_id for update;
 if not found or r.status is distinct from 'Pending' then raise exception 'Agent proposal unavailable';end if;
 if not private.agent_actor_allowed(r.organization_id,p_actor_id,true,private.agent_required_roles(r.execution_snapshot)) then raise exception 'Agent reviewer not authorized by literal policy roles';end if;
 update public.agent_run_requests set status=case when p_approve then 'Approved' else 'Rejected' end, approved_by=case when p_approve then p_actor_id else null end, approved_at=case when p_approve then now() else null end where id=r.id returning * into r;
 return r;
end $$;

create function public.assert_agent_workflow_lineage(p_run_id uuid,p_actor_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare run public.workflow_runs; r public.agent_run_requests; agent uuid; request uuid;
begin
 if current_setting('transaction_isolation') is distinct from 'read committed' then raise exception 'Agent authority requires READ COMMITTED';end if;
 -- Read immutable linkage first; then use one lock order: agent, request, workflow.
 select agent_run_request_id into request from public.workflow_runs where id=p_run_id;
 if request is not null then
  select agent_id into agent from public.agent_run_requests where id=request;
  perform 1 from public.ai_agents where id=agent for share;
  perform 1 from public.agent_run_requests where id=request for share;
 end if;
 select * into run from public.workflow_runs where id=p_run_id for share;
 if not found then raise exception 'Workflow run missing';end if;
 if not private.agent_context_clean(run.workflow_context) then raise exception 'Forged agent workflow context';end if;
 if run.agent_run_request_id is null then
  if exists(select 1 from public.agent_run_requests where workflow_run_id=run.id) or exists(select 1 from private.agent_run_reservations where run_id=run.id) then raise exception 'Agent lineage cannot fall back to manual';end if;
  return null;
 end if;
 if run.status not in ('Running','Waiting Approval','Success') then raise exception 'Agent workflow is not active or successfully completed';end if;
 select * into r from public.agent_run_requests where id=run.agent_run_request_id for share;
 if not found or r.workflow_run_id is distinct from run.id or r.status is distinct from 'Approved' or r.organization_id is distinct from run.organization_id or r.workflow_id is distinct from run.workflow_id or r.requested_by is distinct from run.initiated_by or r.approved_by is null or r.approved_by=r.requested_by or r.approved_at is null then raise exception 'Agent approval or linked lineage invalid';end if;
 if not private.agent_actor_allowed(r.organization_id,p_actor_id,true) or not private.agent_actor_allowed(r.organization_id,r.requested_by,false) or not private.agent_actor_allowed(r.organization_id,r.approved_by,true,private.agent_required_roles(r.execution_snapshot)) then raise exception 'Current agent human authority revoked';end if;
 if not exists(select 1 from private.agent_run_reservations where request_id=r.id and run_id=run.id and agent_id=r.agent_id and organization_id=r.organization_id) then raise exception 'Agent quota reservation missing';end if;
 if r.execution_snapshot is distinct from private.build_agent_snapshot(r.agent_id,r.workflow_id,r.context) or run.workflow_revision is distinct from (r.execution_snapshot->'workflow'->>'updated_at')::timestamptz or run.workflow_steps is distinct from r.execution_snapshot->'workflow'->'steps' or run.workflow_context is distinct from r.context or run.workflow_policy_snapshot is distinct from nullif(r.execution_snapshot->'policy','null'::jsonb) then raise exception 'Agent execution authority changed';end if;
 return jsonb_build_object('agent_request_id',r.id,'run_id',run.id,'agent_id',r.agent_id,'organization_id',r.organization_id,'snapshot',r.execution_snapshot);
end $$;

create function public.reserve_agent_workflow(p_request_id uuid,p_actor_id uuid)
returns public.workflow_runs language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.agent_run_requests; run public.workflow_runs; run_id uuid:=gen_random_uuid(); day date; cap integer;
begin
 if current_setting('transaction_isolation') is distinct from 'read committed' then raise exception 'Agent authority requires READ COMMITTED';end if;
 -- Serialize this agent before choosing the UTC day; no previous-day quota row wait.
 perform 1 from public.ai_agents where id=(select agent_id from public.agent_run_requests where id=p_request_id) for update;
 select * into r from public.agent_run_requests where id=p_request_id for update;
 if not found or r.status is distinct from 'Approved' or r.workflow_run_id is not null or r.approved_by is null or r.approved_at is null or r.approved_by=r.requested_by then raise exception 'Agent request is not approved or already reserved';end if;
 if not private.agent_actor_allowed(r.organization_id,p_actor_id,true) or not private.agent_actor_allowed(r.organization_id,r.requested_by,false) or not private.agent_actor_allowed(r.organization_id,r.approved_by,true,private.agent_required_roles(r.execution_snapshot)) then raise exception 'Current agent human authority revoked';end if;
 if r.execution_snapshot is distinct from private.build_agent_snapshot(r.agent_id,r.workflow_id,r.context) then raise exception 'Agent execution authority changed';end if;
 cap:=(r.execution_snapshot->'agent'->>'max_daily_runs')::integer;
 if cap is not null and cap<1 then raise exception 'Invalid agent daily quota';end if;
 day:=(clock_timestamp() at time zone 'UTC')::date;
 insert into private.agent_daily_reservations as q(agent_id,reservation_day,reserved_count) values(r.agent_id,day,1)
 on conflict(agent_id,reservation_day) do update set reserved_count=q.reserved_count+1 where cap is null or q.reserved_count<cap;
 if not found then raise exception 'Agent daily quota exhausted';end if;
 insert into private.agent_run_reservations(request_id,run_id,agent_id,organization_id,reservation_day) values(r.id,run_id,r.agent_id,r.organization_id,day);
 insert into public.workflow_runs(id,organization_id,workflow_id,status,current_step,context,initiated_by,started_at,workflow_revision,workflow_steps,workflow_context,agent_run_request_id,workflow_policy_snapshot)
 values(run_id,r.organization_id,r.workflow_id,'Running',0,r.context,r.requested_by,now(),(r.execution_snapshot->'workflow'->>'updated_at')::timestamptz,r.execution_snapshot->'workflow'->'steps',r.context,r.id,nullif(r.execution_snapshot->'policy','null'::jsonb)) returning * into run;
 update public.agent_run_requests set workflow_run_id=run.id where id=r.id;
 perform public.assert_agent_workflow_lineage(run.id,p_actor_id);
 return run;
end $$;

create function private.guard_agent_workflow_link() returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if TG_OP='UPDATE' and new.agent_run_request_id is distinct from old.agent_run_request_id then raise exception 'Workflow agent lineage is immutable';end if;
 if TG_OP='INSERT' and new.agent_run_request_id is not null and not exists(select 1 from private.agent_run_reservations q join public.agent_run_requests r on r.id=q.request_id where q.request_id=new.agent_run_request_id and q.run_id=new.id and r.organization_id=new.organization_id and r.workflow_id=new.workflow_id and r.status='Approved' and r.workflow_run_id is null) then raise exception 'Trusted agent reservation required';end if;
 return new;
end $$;
create trigger guard_agent_workflow_link before insert or update on public.workflow_runs for each row execute function private.guard_agent_workflow_link();
create function public.finish_agent_workflow(p_run_id uuid,p_actor_id uuid)
returns boolean language plpgsql security invoker set search_path=pg_catalog as $$
declare run public.workflow_runs; r public.agent_run_requests; request uuid;
begin
 if current_setting('transaction_isolation') is distinct from 'read committed' then raise exception 'Agent authority requires READ COMMITTED';end if;
 select agent_run_request_id into request from public.workflow_runs where id=p_run_id;
 if request is null then
  perform public.assert_agent_workflow_lineage(p_run_id,p_actor_id);
  return true;
 end if;
 perform 1 from public.ai_agents where id=(select agent_id from public.agent_run_requests where id=request) for share;
 select * into r from public.agent_run_requests where id=request for update;
 select * into run from public.workflow_runs where id=p_run_id for share;
 if not found or run.agent_run_request_id is distinct from r.id or r.workflow_run_id is distinct from run.id or run.organization_id is distinct from r.organization_id or run.workflow_id is distinct from r.workflow_id or run.status is distinct from 'Success' or run.completed_at is null or run.current_step is distinct from jsonb_array_length(run.workflow_steps) then raise exception 'Exact linked workflow has not succeeded';end if;
 if r.status='Executed' then return true;end if;
 perform public.assert_agent_workflow_lineage(run.id,p_actor_id);
 update public.agent_run_requests set status='Executed',executed_at=run.completed_at,error_message=null where id=r.id and status='Approved';
 if not found then raise exception 'Agent terminal linkage missing';end if;
 return true;
end $$;

revoke all on function private.agent_actor_allowed(uuid,uuid,boolean,text[]),private.agent_context_clean(jsonb),private.build_agent_snapshot(uuid,uuid,jsonb),private.agent_required_roles(jsonb),private.guard_agent_request(),private.guard_agent_workflow_link() from public,anon,authenticated;
grant execute on function private.agent_actor_allowed(uuid,uuid,boolean,text[]),private.agent_context_clean(jsonb),private.build_agent_snapshot(uuid,uuid,jsonb),private.agent_required_roles(jsonb),private.guard_agent_request(),private.guard_agent_workflow_link() to service_role;
revoke all on function public.create_agent_workflow_request(uuid,uuid,uuid,jsonb),public.review_agent_workflow_request(uuid,uuid,boolean),public.reserve_agent_workflow(uuid,uuid),public.assert_agent_workflow_lineage(uuid,uuid),public.finish_agent_workflow(uuid,uuid) from public,anon,authenticated;
grant execute on function public.create_agent_workflow_request(uuid,uuid,uuid,jsonb),public.review_agent_workflow_request(uuid,uuid,boolean),public.reserve_agent_workflow(uuid,uuid),public.assert_agent_workflow_lineage(uuid,uuid),public.finish_agent_workflow(uuid,uuid) to service_role;
commit;
