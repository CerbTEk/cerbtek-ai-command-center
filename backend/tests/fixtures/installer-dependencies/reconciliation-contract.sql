-- LOCAL REVIEW CANDIDATE. No automatic provider resend or timeout-based reset.
begin;
create table public.action_execution_receipts(
 request_id uuid primary key references public.action_requests(id) on delete restrict,
 organization_id uuid not null references public.organizations(id),
 phase text not null check(phase in ('Dispatching','ProviderAccepted','ConfirmedAccepted','ConfirmedNotSent')),
 actor_id uuid not null references auth.users(id),
 dispatch_started_at timestamptz default now(),
 provider_accepted_at timestamptz,
 provider_reference text,
 reconciled_by uuid references auth.users(id),reconciled_at timestamptz,evidence_reference text
);
alter table public.action_execution_receipts enable row level security;
revoke all on public.action_execution_receipts from public,anon,authenticated;
grant select,insert,update on public.action_execution_receipts to service_role;
create or replace function public.record_microsoft_attempt(p_request_id uuid,p_actor_id uuid,p_phase text,p_provider_reference text default null)
returns boolean language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.action_requests; c public.oauth_connections; i public.integrations; bound_run uuid;
begin
 if p_phase='Dispatching' then
  if current_setting('transaction_isolation') is distinct from 'read committed' then raise exception 'Dispatch authority requires READ COMMITTED';end if;
  select workflow_run_id into bound_run from public.action_requests where id=p_request_id;
  if bound_run is not null then perform public.assert_agent_workflow_lineage(bound_run,p_actor_id);end if;
 end if;
 select * into r from public.action_requests where id=p_request_id for update;
 if p_phase='Dispatching' and r.workflow_run_id is distinct from bound_run then raise exception 'Workflow link changed';end if;
 if not found or r.status is distinct from 'Executing' then raise exception 'Request is not claimed';end if;
 if p_phase='Dispatching' and (not exists(select 1 from public.organization_members where organization_id=r.organization_id and user_id=p_actor_id and role in ('owner','admin','consultant'))
 and not exists(select 1 from public.staff_accounts where user_id=p_actor_id and active and role in ('platform_admin','consultant'))) then raise exception 'Actor not authorized';end if;
 if p_phase='Dispatching' then
   perform private.assert_workflow_action_approval(r.workflow_run_id,r.organization_id,r.approved_by,r.action_type);
   if r.approved_by is null or r.approved_at is null or r.requested_by is null or r.approved_by=r.requested_by then raise exception 'Approval invalid';end if;
   if not exists(select 1 from public.organization_members where organization_id=r.organization_id and user_id=r.approved_by and role in ('owner','admin','consultant'))
   and not exists(select 1 from public.staff_accounts where user_id=r.approved_by and active and role in ('platform_admin','consultant')) then raise exception 'Approver authorization revoked';end if;
   if r.workflow_run_id is not null and not exists(select 1 from public.workflow_runs where id=r.workflow_run_id and organization_id=r.organization_id and status='Waiting Approval' and context->>'action_request_id'=r.id::text) then raise exception 'Workflow tenant or approval binding invalid';end if;
   select * into c from public.oauth_connections where id=r.connection_id and organization_id=r.organization_id for share;
   if not found then raise exception 'Connection missing';end if;
   select * into i from public.integrations where id=r.integration_id and organization_id=r.organization_id for share;
   if not found or i.status is distinct from 'Connected' then raise exception 'Integration inactive';end if;
   if c.status is distinct from 'Connected' or c.oauth_verified_version is distinct from 1 or nullif(trim(c.external_account_id),'') is null or not coalesce('Mail.Send'=any(c.scopes),false)
     or r.approved_connection_binding is distinct from private.microsoft_connection_binding(c,i)
     or not exists(select 1 from public.integrations where id=r.integration_id and organization_id=r.organization_id and status='Connected') then raise exception 'Live connection controls changed';end if;
   insert into public.action_execution_receipts(request_id,organization_id,phase,actor_id) values(r.id,r.organization_id,'Dispatching',p_actor_id);
 elsif p_phase='ProviderAccepted' then
   update public.action_execution_receipts set phase='ProviderAccepted',provider_accepted_at=now(),provider_reference=p_provider_reference
   where request_id=r.id and phase='Dispatching' and actor_id=p_actor_id;
   if not found then raise exception 'Dispatch receipt is missing or already accepted';end if;
 else raise exception 'Invalid attempt phase';end if;
 return true;
end $$;
revoke all on function public.record_microsoft_attempt(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.record_microsoft_attempt(uuid,uuid,text,text) to service_role;

-- Operator-only service workflow: caller must authenticate the human and show the
-- exact evidence/decision for approval. There is deliberately no automatic retry API.
create or replace function public.reconcile_microsoft_attempt(p_request_id uuid,p_actor_id uuid,p_outcome text,p_evidence_reference text)
returns public.action_requests language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.action_requests; a public.action_execution_receipts;
begin
 if coalesce(length(trim(p_evidence_reference)),0)<8 then raise exception 'Verified evidence reference required';end if;
 select * into r from public.action_requests where id=p_request_id for update;
 if not found or r.status is distinct from 'Executing' then raise exception 'Only unresolved claimed requests can be reconciled';end if;
 if not exists(select 1 from public.organization_members where organization_id=r.organization_id and user_id=p_actor_id and role in ('owner','admin'))
 and not exists(select 1 from public.staff_accounts where user_id=p_actor_id and active and role='platform_admin') then raise exception 'Reconciliation requires administrator';end if;
 select * into a from public.action_execution_receipts where request_id=r.id for update;
 if not found then
   if r.approval_guard_version is distinct from 1 then raise exception 'Legacy receiptless request requires manual investigation';end if;
   -- The request lock serializes with record_microsoft_attempt. Without a receipt,
   -- no compliant dispatcher has permission to call Graph. Closing Executing here
   -- prevents a delayed worker from recording Dispatching and starting a send.
   if p_outcome is distinct from 'ConfirmedNotSent' then raise exception 'No dispatch receipt: only safe pre-dispatch closure is allowed';end if;
   insert into public.action_execution_receipts(request_id,organization_id,phase,actor_id,dispatch_started_at)
     values(r.id,r.organization_id,'ConfirmedNotSent',p_actor_id,null) returning * into a;
 end if;
 if p_outcome='ConfirmedAccepted' then
   update public.action_requests set status='Executed',executed_at=coalesce(a.provider_accepted_at,now()),error_message=null where id=r.id returning * into r;
 elsif p_outcome='ConfirmedNotSent' then
   if a.phase in ('ProviderAccepted','ConfirmedAccepted') then raise exception 'Provider acceptance contradicts not-sent decision';end if;
   if a.dispatch_started_at is not null then raise exception 'Dispatch was authorized: not-sent reconciliation requires worker fencing not yet supported';end if;
   update public.action_requests set status='Failed',error_message='Operator verified no send; original request remains non-retryable' where id=r.id returning * into r;
 else raise exception 'Uncertainty cannot authorize reconciliation';end if;
 update public.action_execution_receipts set phase=p_outcome,reconciled_by=p_actor_id,reconciled_at=now(),evidence_reference=p_evidence_reference where request_id=r.id;
 insert into public.audit_events(organization_id,actor_user_id,event_type,entity_type,entity_id,summary,metadata)
 values(r.organization_id,p_actor_id,'action_reconciled','action_request',r.id,'Action outcome reconciled without resend',jsonb_build_object('outcome',p_outcome,'evidence_reference',p_evidence_reference));
 return r;
end $$;
revoke all on function public.reconcile_microsoft_attempt(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.reconcile_microsoft_attempt(uuid,uuid,text,text) to service_role;
commit;
