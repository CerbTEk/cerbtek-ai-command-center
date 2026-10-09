-- Unapplied local review contract. Requires existing organizations/organization_members.
-- All public RPCs are service_role-only; Edge verifies the JWT and derives p_actor.
begin;
create table public.ai_draft_configurations(
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 version integer not null check(version>0), configuration jsonb not null,
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 unique(organization_id,version)
);
create table public.ai_draft_runs(
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 configuration_id uuid not null references public.ai_draft_configurations(id), request_key uuid not null,
 request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'), requested_by uuid not null references auth.users(id),
 status text not null default 'reserved' check(status in ('reserved','awaiting_review','failed','unknown','accepted','rejected')),
 reserved_microusd bigint not null check(reserved_microusd>0 and reserved_microusd<=1000000),
 reservation_day date not null,
 draft jsonb, usage jsonb, failure_code text, reviewed_by uuid references auth.users(id), reviewed_at timestamptz,
 created_at timestamptz not null default now(), finished_at timestamptz,
 unique(organization_id,request_key)
);
create index ai_draft_daily on public.ai_draft_runs(organization_id,reservation_day);
alter table public.ai_draft_configurations enable row level security;
alter table public.ai_draft_runs enable row level security;
revoke all on public.ai_draft_configurations,public.ai_draft_runs from public,anon,authenticated,service_role;
grant select,insert on public.ai_draft_configurations to service_role;
grant select,insert,update on public.ai_draft_runs to service_role;
create function public.ai_draft_immutable() returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin raise exception 'AI configuration versions are immutable';end $$;
create trigger ai_draft_configuration_immutable before update or delete on public.ai_draft_configurations for each row execute function public.ai_draft_immutable();
revoke all on function public.ai_draft_immutable() from public,anon,authenticated;
create function public.ai_draft_authorize(p_org uuid,p_actor uuid) returns void language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if not exists(select 1 from public.organization_members where organization_id=p_org and user_id=p_actor and role in ('owner','admin','consultant')) then raise exception 'Organization access denied';end if;
end $$;
create function public.ai_draft_save(p_org uuid,p_actor uuid,p_expected_version integer,p_config jsonb) returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v integer; r public.ai_draft_configurations;
begin
 perform public.ai_draft_authorize(p_org,p_actor);
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'Requires READ COMMITTED';end if;
 perform 1 from public.organizations where id=p_org for update;
 select coalesce(max(version),0) into v from public.ai_draft_configurations where organization_id=p_org;
 if p_expected_version is distinct from v then raise exception 'Configuration changed; reload';end if;
 if jsonb_typeof(p_config) is distinct from 'object' or not p_config ?& array['schema_version','provider','model','task','instructions','source','max_input_bytes','max_output_tokens','max_daily_runs','daily_budget_microusd','human_review']
 or p_config-array['schema_version','provider','model','task','instructions','source','max_input_bytes','max_output_tokens','max_daily_runs','daily_budget_microusd','human_review']<>'{}'::jsonb
 or p_config->>'schema_version' is distinct from '1' or coalesce(p_config->>'provider','') not in ('openai','anthropic','gemini') or p_config->>'source' is distinct from 'manual_context' or p_config->'human_review' is distinct from 'true'::jsonb
 or coalesce(p_config->>'model','') !~ '^[-a-zA-Z0-9._:]{1,100}$'
 or jsonb_typeof(p_config->'task') is distinct from 'string' or jsonb_typeof(p_config->'instructions') is distinct from 'string'
 or jsonb_typeof(p_config->'max_input_bytes') is distinct from 'number' or jsonb_typeof(p_config->'max_output_tokens') is distinct from 'number' or jsonb_typeof(p_config->'max_daily_runs') is distinct from 'number' or jsonb_typeof(p_config->'daily_budget_microusd') is distinct from 'number'
 or p_config->>'task' not in ('customer_reply','internal_summary')
 or length(btrim(p_config->>'instructions')) not between 10 and 2000
 or (p_config->>'max_input_bytes')::integer not between 1 and 12000 or (p_config->>'max_output_tokens')::integer not between 128 and 4000
 or (p_config->>'max_daily_runs')::integer not between 1 and 100 or (p_config->>'daily_budget_microusd')::bigint not between 1 and 100000000
 then raise exception 'Invalid configuration';end if;
 insert into public.ai_draft_configurations(organization_id,version,configuration,created_by) values(p_org,v+1,p_config,p_actor) returning * into r;
 return to_jsonb(r);
end $$;
create function public.ai_draft_reserve(p_org uuid,p_actor uuid,p_config uuid,p_request_key uuid,p_request_hash text,p_reserve bigint) returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare c public.ai_draft_configurations; r public.ai_draft_runs; spent bigint; runs integer; reservation_date date;
begin
 perform public.ai_draft_authorize(p_org,p_actor);
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'Requires READ COMMITTED';end if;
 perform 1 from public.organizations where id=p_org for update;
 select * into r from public.ai_draft_runs where organization_id=p_org and request_key=p_request_key;
 if found then
  if r.configuration_id<>p_config or r.request_hash<>p_request_hash or r.requested_by<>p_actor then raise exception 'Idempotency conflict';end if;
  return jsonb_build_object('created',false,'run',to_jsonb(r));
 end if;
 if exists(select 1 from public.ai_draft_runs where organization_id=p_org and status in ('reserved','unknown')) then raise exception 'Unresolved model request requires reconciliation';end if;
 select * into c from public.ai_draft_configurations where organization_id=p_org order by version desc limit 1;
 if not found or c.id<>p_config then raise exception 'Configuration superseded; reload';end if;
 -- Choose the admission day only after the organization lock and checks.
 -- Reuse this single wall-clock snapshot for both quota accounting and insertion.
 reservation_date:=(clock_timestamp() at time zone 'UTC')::date;
 select coalesce(sum(reserved_microusd),0),count(*) into spent,runs from public.ai_draft_runs where organization_id=p_org and reservation_day=reservation_date;
 if p_reserve is null or p_reserve<1 or p_reserve>1000000 or spent+p_reserve>(c.configuration->>'daily_budget_microusd')::bigint or runs>=(c.configuration->>'max_daily_runs')::integer then raise exception 'Daily allowance exhausted';end if;
 insert into public.ai_draft_runs(organization_id,configuration_id,request_key,request_hash,requested_by,reserved_microusd,reservation_day) values(p_org,p_config,p_request_key,p_request_hash,p_actor,p_reserve,reservation_date) returning * into r;
 return jsonb_build_object('created',true,'run',to_jsonb(r));
end $$;
create function public.ai_draft_finish(p_org uuid,p_actor uuid,p_run uuid,p_result jsonb) returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.ai_draft_runs;
begin
 -- A revoked member cannot start or view new requests. The trusted server must still
 -- record the result of its already-reserved operation, including a billed failure.
 if p_result->>'status' not in ('awaiting_review','failed','unknown') or p_result->>'status' is null then raise exception 'Invalid result';end if;
 select * into r from public.ai_draft_runs where id=p_run and organization_id=p_org and requested_by=p_actor for update;
 if not found or r.status<>'reserved' then raise exception 'Run state conflict';end if;
 if p_result->>'status'='awaiting_review' and (jsonb_typeof(p_result->'draft') is distinct from 'object' or jsonb_typeof(p_result->'usage') is distinct from 'object') then raise exception 'Missing validated output';end if;
 update public.ai_draft_runs set status=p_result->>'status',draft=p_result->'draft',usage=p_result->'usage',failure_code=p_result->>'failure_code',finished_at=now() where id=p_run returning * into r;
 return to_jsonb(r);
end $$;
create function public.ai_draft_review(p_org uuid,p_actor uuid,p_run uuid,p_decision text) returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.ai_draft_runs;
begin
 perform public.ai_draft_authorize(p_org,p_actor);
 if p_decision is null or p_decision not in ('accepted','rejected') then raise exception 'Invalid review';end if;
 update public.ai_draft_runs set status=p_decision,reviewed_by=p_actor,reviewed_at=now() where id=p_run and organization_id=p_org and status='awaiting_review' returning * into r;
 if not found then raise exception 'Review state conflict';end if;
 -- Acceptance records human review only. It does not send, publish, or execute.
 return to_jsonb(r);
end $$;
revoke all on function public.ai_draft_authorize(uuid,uuid),public.ai_draft_save(uuid,uuid,integer,jsonb),public.ai_draft_reserve(uuid,uuid,uuid,uuid,text,bigint),public.ai_draft_finish(uuid,uuid,uuid,jsonb),public.ai_draft_review(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.ai_draft_authorize(uuid,uuid),public.ai_draft_save(uuid,uuid,integer,jsonb),public.ai_draft_reserve(uuid,uuid,uuid,uuid,text,bigint),public.ai_draft_finish(uuid,uuid,uuid,jsonb),public.ai_draft_review(uuid,uuid,uuid,text) to service_role;
commit;
