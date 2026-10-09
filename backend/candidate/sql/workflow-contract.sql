-- ISOLATED REVIEW PROPOSAL ONLY. Not a generated migration; do not apply to production.
begin;
alter table public.workflow_runs add column workflow_revision timestamptz,
 add column workflow_steps jsonb, add column workflow_context jsonb, add column workflow_policy_snapshot jsonb;
create or replace function private.workflow_policy_snapshot(w public.workflow_definitions)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare p public.approval_policies;
begin
 if w.default_approval_policy_id is null then return null;end if;
 select * into p from public.approval_policies where id=w.default_approval_policy_id and organization_id=w.organization_id for share;
 if not found or p.active is distinct from true or p.action_type is distinct from 'send_email'
 or p.required_roles is null or cardinality(p.required_roles)=0 or array_position(p.required_roles,null) is not null
 or not (p.required_roles <@ array['owner','admin','consultant','platform_admin']::text[])
 then raise exception 'Explicit approval policy unavailable or unsupported';end if;
 return to_jsonb(p);
end $$;
revoke all on function private.workflow_policy_snapshot(public.workflow_definitions) from public,anon,authenticated;
grant execute on function private.workflow_policy_snapshot(public.workflow_definitions) to service_role;

create or replace function private.assert_workflow_action_approval(p_run_id uuid,p_org_id uuid,p_approver_id uuid,p_action_type text)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.workflow_runs; w public.workflow_definitions; policy jsonb; roles text[];
begin
 if p_run_id is null then return;end if;
 select * into r from public.workflow_runs where id=p_run_id and organization_id=p_org_id;
 if not found then raise exception 'Workflow approval association invalid';end if;
 select * into w from public.workflow_definitions where id=r.workflow_id and organization_id=r.organization_id for share;
 if not found or w.status is distinct from 'Active' or w.updated_at is distinct from r.workflow_revision or w.steps is distinct from r.workflow_steps then raise exception 'Workflow execution authority changed';end if;
 policy:=private.workflow_policy_snapshot(w);
 if r.workflow_policy_snapshot is distinct from policy then raise exception 'Workflow approval policy changed';end if;
 if policy is null then return;end if;
 if policy->>'action_type' is distinct from p_action_type then raise exception 'Approval policy action does not match';end if;
 select array_agg(x) into roles from jsonb_array_elements_text(policy->'required_roles') x;
 if not exists(select 1 from public.organization_members where organization_id=p_org_id and user_id=p_approver_id and role=any(roles) and role in ('owner','admin','consultant'))
 and not exists(select 1 from public.staff_accounts where user_id=p_approver_id and active and role=any(roles) and role in ('platform_admin','consultant')) then raise exception 'Approver does not match literal workflow policy role';end if;
end $$;
revoke all on function private.assert_workflow_action_approval(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function private.assert_workflow_action_approval(uuid,uuid,uuid,text) to service_role;

revoke insert,update,delete,truncate,references,trigger on public.workflow_runs from public,anon,authenticated;
create or replace function private.guard_workflow_snapshot() returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if new.organization_id is distinct from old.organization_id or new.workflow_id is distinct from old.workflow_id
 or new.initiated_by is distinct from old.initiated_by or new.workflow_revision is distinct from old.workflow_revision
 or new.workflow_steps is distinct from old.workflow_steps or new.workflow_context is distinct from old.workflow_context or new.workflow_policy_snapshot is distinct from old.workflow_policy_snapshot then
  raise exception 'Workflow execution snapshot is immutable';
 end if;
 return new;
end $$;
revoke all on function private.guard_workflow_snapshot() from public,anon,authenticated;
create trigger guard_workflow_snapshot before update on public.workflow_runs for each row execute function private.guard_workflow_snapshot();

create or replace function public.create_trusted_workflow_run(p_workflow_id uuid,p_actor_id uuid,p_context jsonb)
returns public.workflow_runs language plpgsql security invoker set search_path=pg_catalog as $$
declare w public.workflow_definitions; r public.workflow_runs; c jsonb;
begin
 select * into w from public.workflow_definitions where id=p_workflow_id for share;
 if not found or w.status is distinct from 'Active' or w.updated_at is null or jsonb_typeof(w.steps) is distinct from 'array' then raise exception 'Workflow unavailable'; end if;
 if not exists(select 1 from public.organization_members where organization_id=w.organization_id and user_id=p_actor_id)
 and not exists(select 1 from public.staff_accounts where user_id=p_actor_id and active) then raise exception 'Actor not authorized'; end if;
 if jsonb_typeof(p_context) is distinct from 'object' then raise exception 'Workflow context must be an object'; end if;
 if p_context ?| array['outputs','action_request_id','workflow_run_id','run_id','agent_run_request_id','agent_request_id','agent_id','agent_lineage','agent_binding','agent_snapshot','_agent_run_request_id'] then raise exception 'Reserved workflow context or agent lineage is not accepted by manual workflow creation'; end if;
 c:=p_context;
 insert into public.workflow_runs(organization_id,workflow_id,status,current_step,context,initiated_by,started_at,workflow_revision,workflow_steps,workflow_context,workflow_policy_snapshot)
 values(w.organization_id,w.id,'Running',0,c,p_actor_id,now(),w.updated_at,w.steps,c,private.workflow_policy_snapshot(w)) returning * into r;
 return r;
end $$;
revoke all on function public.create_trusted_workflow_run(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.create_trusted_workflow_run(uuid,uuid,jsonb) to service_role;

create or replace function public.claim_workflow_continuation(p_run_id uuid,p_actor_id uuid)
returns public.workflow_runs language plpgsql security invoker set search_path=pg_catalog as $$
declare w public.workflow_definitions; r public.workflow_runs; a public.action_requests;
begin
 perform public.assert_agent_workflow_lineage(p_run_id,p_actor_id);
 select * into r from public.workflow_runs where id=p_run_id for update;
 if not found or r.status is distinct from 'Waiting Approval' then raise exception 'Workflow not waiting or already claimed'; end if;
 if r.workflow_context ?| array['agent_run_request_id','agent_request_id','agent_id','agent_lineage','agent_binding','agent_snapshot','_agent_run_request_id'] then raise exception 'Agent workflow continuation requires trusted agent authorization';end if;
 if r.workflow_revision is null or jsonb_typeof(r.workflow_steps) is distinct from 'array' or jsonb_typeof(r.workflow_context) is distinct from 'object' then raise exception 'Legacy run needs a newly reviewed workflow run'; end if;
 if not exists(select 1 from public.organization_members where organization_id=r.organization_id and user_id=p_actor_id and role in ('owner','admin','consultant'))
 and not exists(select 1 from public.staff_accounts where user_id=p_actor_id and active and role in ('platform_admin','consultant')) then raise exception 'Actor not authorized'; end if;
 select * into w from public.workflow_definitions where id=r.workflow_id and organization_id=r.organization_id for share;
 if not found or w.status is distinct from 'Active' or w.updated_at is distinct from r.workflow_revision or w.steps is distinct from r.workflow_steps then raise exception 'Workflow revision changed or inactive'; end if;
 if r.current_step<0 or r.current_step>=jsonb_array_length(r.workflow_steps) or r.workflow_steps->r.current_step->>'type' is distinct from 'approval.email' then raise exception 'Current step is not an approval step'; end if;
 select * into a from public.action_requests where id::text=r.context->>'action_request_id' and organization_id=r.organization_id and workflow_run_id=r.id for share;
 if not found or a.status is distinct from 'Executed' or a.executed_at is null or a.approval_guard_version is distinct from 1 or a.approved_by is null or a.approved_at is null or a.requested_by is null or a.requested_by=a.approved_by then raise exception 'Exact approved action has not completed'; end if;
 update public.workflow_runs set status='Running' where id=r.id and status='Waiting Approval' returning * into r;
 return r;
end $$;
revoke all on function public.claim_workflow_continuation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_workflow_continuation(uuid,uuid) to service_role;
commit;
