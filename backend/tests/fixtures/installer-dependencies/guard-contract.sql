-- REVIEW CANDIDATE ONLY. Not a generated migration. Do not apply to production.
-- Generate a migration through the project's supported CLI after review/staging.
begin;
alter table public.action_requests add column approval_guard_version integer not null default 0,
add column approved_connection_binding jsonb;
-- The existing SELECT policies remain intact. Writes must pass the authenticated Edge API.
revoke insert,update,delete,truncate,references,trigger on public.action_requests,public.agent_run_requests from public,anon,authenticated;
drop policy if exists "contributors create action requests" on public.action_requests;
drop policy if exists "approvers update action requests" on public.action_requests;

create or replace function private.guard_execution_request() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if TG_OP='INSERT' then
    if new.status is distinct from 'Pending' or new.approved_by is not null or new.approved_at is not null
       or new.executed_at is not null then
      raise exception 'New requests must be unapproved pending proposals';
    end if;
    if TG_TABLE_NAME='action_requests' then
      new := jsonb_populate_record(new, '{"approval_guard_version":0,"approved_connection_binding":null}'::jsonb);
    end if;
    return new;
  end if;
  -- Bind the approval to the entire original proposal, not a client hash.
  if (to_jsonb(new)-array['status','approved_by','approved_at','rejected_by','rejected_at','executed_at','error_message','updated_at','workflow_run_id','approval_guard_version','approved_connection_binding'])
     is distinct from
     (to_jsonb(old)-array['status','approved_by','approved_at','rejected_by','rejected_at','executed_at','error_message','updated_at','workflow_run_id','approval_guard_version','approved_connection_binding']) then
    raise exception 'Request proposal is immutable; create a new request';
  end if;
  if TG_TABLE_NAME='action_requests' and new.workflow_run_id is distinct from old.workflow_run_id then
    raise exception 'Approved workflow association is immutable';
  end if;
  if old.status is distinct from 'Pending' and (new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at) then
    raise exception 'Approval evidence is immutable';
  end if;
  if TG_TABLE_NAME='action_requests' and ((to_jsonb(new)->'approval_guard_version') is distinct from (to_jsonb(old)->'approval_guard_version') or (to_jsonb(new)->'approved_connection_binding') is distinct from (to_jsonb(old)->'approved_connection_binding')) then
    raise exception 'Approval guard version is server managed';
  end if;
  if new.status='Approved' and old.status='Pending' then
    if new.approved_by is null or new.approved_at is null or new.requested_by is null or new.approved_by=new.requested_by then
      raise exception 'Distinct human approval is required';
    end if;
    if TG_TABLE_NAME='action_requests' then
      perform private.assert_workflow_action_approval(new.workflow_run_id,new.organization_id,new.approved_by,new.action_type);
      new := jsonb_populate_record(new, jsonb_build_object('approval_guard_version',1,
        'approved_connection_binding',(select private.microsoft_connection_binding(c,i) from public.oauth_connections c join public.integrations i on i.id=c.integration_id and i.organization_id=c.organization_id where c.id=new.connection_id and c.organization_id=new.organization_id)));
      if to_jsonb(new)->'approved_connection_binding'='null'::jsonb then raise exception 'Connection cannot be approved'; end if;
    end if;
  elsif new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at then
    raise exception 'Approval evidence requires an approval transition';
  end if;
  if new.status is distinct from old.status and not (
    (old.status='Pending' and new.status in ('Approved','Rejected')) or
    (TG_TABLE_NAME='action_requests' and old.status='Approved' and new.status='Executing') or
    (TG_TABLE_NAME='action_requests' and old.status='Executing' and new.status in ('Executed','Failed'))
  ) then raise exception 'Invalid or repeated execution transition'; end if;
  return new;
end $$;
revoke all on function private.guard_execution_request() from public,anon,authenticated;
create trigger harden_action_request before insert or update on public.action_requests
for each row execute function private.guard_execution_request();
create trigger harden_agent_request before insert or update on public.agent_run_requests
for each row execute function private.guard_execution_request();

-- Invoker rights: service_role alone is allowed to call this RPC.
create or replace function public.claim_microsoft_action(request_id uuid,actor_id uuid)
returns public.action_requests language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.action_requests; c public.oauth_connections; i public.integrations; bound_run uuid;
begin
  if current_setting('transaction_isolation') is distinct from 'read committed' then raise exception 'Action authority requires READ COMMITTED';end if;
  select workflow_run_id into bound_run from public.action_requests where id=request_id;
  if bound_run is not null then perform public.assert_agent_workflow_lineage(bound_run,actor_id);end if;
  select * into r from public.action_requests where id=request_id for update;
  if r.workflow_run_id is distinct from bound_run then raise exception 'Workflow link changed';end if;
  if not found or r.status is distinct from 'Approved' then raise exception 'Request not approved or already claimed'; end if;
  if r.approval_guard_version is distinct from 1 then raise exception 'Legacy approval requires a new reviewed request'; end if;
  if r.provider is distinct from 'microsoft' or r.action_type is distinct from 'send_email' then raise exception 'Unsupported action'; end if;
  if r.approved_by is null or r.approved_at is null or r.requested_by is null or r.approved_by=r.requested_by then raise exception 'Approval invalid'; end if;
  perform private.assert_workflow_action_approval(r.workflow_run_id,r.organization_id,r.approved_by,r.action_type);
  if not exists(select 1 from public.organization_members where organization_id=r.organization_id and user_id=actor_id and role in ('owner','admin','consultant'))
    and not exists(select 1 from public.staff_accounts where user_id=actor_id and active and role in ('platform_admin','consultant')) then raise exception 'Actor not authorized'; end if;
  if not exists(select 1 from public.organization_members where organization_id=r.organization_id and user_id=r.approved_by and role in ('owner','admin','consultant'))
    and not exists(select 1 from public.staff_accounts where user_id=r.approved_by and active and role in ('platform_admin','consultant')) then raise exception 'Approver authorization revoked'; end if;
  select * into c from public.oauth_connections where id=r.connection_id and organization_id=r.organization_id and provider='microsoft' for share;
  if not found or c.status is distinct from 'Connected' or c.oauth_verified_version is distinct from 1 or nullif(trim(c.external_account_id),'') is null or not coalesce('Mail.Send'=any(c.scopes),false) or c.integration_id is distinct from r.integration_id then raise exception 'Connection unavailable or tenant binding invalid'; end if;
  select * into i from public.integrations where id=r.integration_id and organization_id=r.organization_id for share;
  if not found or i.status is distinct from 'Connected' then raise exception 'Integration inactive'; end if;
  if r.approved_connection_binding is distinct from private.microsoft_connection_binding(c,i) then raise exception 'Approved connection identity changed'; end if;
  if r.workflow_run_id is not null and not exists(select 1 from public.workflow_runs where id=r.workflow_run_id and organization_id=r.organization_id and status='Waiting Approval' and context->>'action_request_id'=r.id::text) then raise exception 'Workflow tenant or approval binding invalid'; end if;
  if jsonb_typeof(r.payload)<>'object' or coalesce(r.payload->>'to','')='' or coalesce(r.payload->>'subject','')='' or coalesce(r.payload->>'message','')='' then raise exception 'Invalid approved payload'; end if;
  update public.action_requests set status='Executing' where id=r.id and status='Approved' returning * into r;
  return r;
end $$;
revoke all on function public.claim_microsoft_action(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_microsoft_action(uuid,uuid) to service_role;
commit;
