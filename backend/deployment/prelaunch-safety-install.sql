-- Separately assembled prelaunch install for project suohuogalotxhsnkumvy only.
-- Supabase CLI is absent in this execution environment. This is a standalone SQL
-- transaction, not a fabricated CLI migration filename or migration-history record.
-- Source contract comments retain their original candidate warnings. This assembly
-- is for the parent's separately authorized prelaunch deployment decision.
-- Original contract bodies are unchanged; only 14 outer transaction markers removed.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
SET LOCAL idle_in_transaction_session_timeout='30s';
-- Prevent admissions or conflicting DDL between empty-state checks and installation.
LOCK TABLE public.action_requests, public.agent_run_requests, public.workflow_runs,
 public.oauth_connections, public.integrations IN ACCESS EXCLUSIVE MODE;
DO $prelaunch_guard$
BEGIN
 IF current_setting('server_version_num')::integer < 170000 THEN RAISE EXCEPTION 'Unexpected PostgreSQL version'; END IF;
 IF EXISTS(select 1 from public.oauth_connections) OR EXISTS(select 1 from public.action_requests)
 OR EXISTS(select 1 from public.agent_run_requests) OR EXISTS(select 1 from public.workflow_runs)
 THEN RAISE EXCEPTION 'Fresh install requires empty OAuth/action/agent/workflow runtime tables'; END IF;
 IF (SELECT count(*) FROM public.integrations)<>2 THEN RAISE EXCEPTION 'Integration inventory changed since reviewed preflight'; END IF;
 IF EXISTS(select 1 from unnest(array['private.microsoft_oauth_setups','public.action_execution_receipts','private.agent_daily_reservations','private.agent_run_reservations','public.ai_draft_configurations','public.ai_draft_runs']) name where to_regclass(name) is not null)
 THEN RAISE EXCEPTION 'Candidate relation already exists'; END IF;
 IF EXISTS(select 1 from information_schema.columns where table_schema='public' and (table_name,column_name) in (values ('oauth_connections','oauth_verified_version'),('oauth_connections','oauth_revision'),('oauth_connections','oauth_refresh_revision'),('integrations','oauth_revision'),('action_requests','approval_guard_version'),('action_requests','approved_connection_binding'),('workflow_runs','workflow_revision'),('workflow_runs','workflow_steps'),('workflow_runs','workflow_context'),('workflow_runs','workflow_policy_snapshot'),('workflow_runs','agent_run_request_id'),('agent_run_requests','execution_snapshot')))
 THEN RAISE EXCEPTION 'Candidate column already exists'; END IF;
 IF EXISTS(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname in ('agent_actor_allowed','agent_context_clean','agent_required_roles','ai_draft_authorize','ai_draft_finish','ai_draft_immutable','ai_draft_reserve','ai_draft_review','ai_draft_save','assert_agent_workflow_lineage','assert_workflow_action_approval','begin_microsoft_oauth_setup','build_agent_snapshot','claim_microsoft_action','claim_microsoft_oauth_setup','claim_workflow_continuation','commit_microsoft_refresh','complete_microsoft_oauth_setup','create_agent_workflow_request','create_trusted_workflow_run','fail_microsoft_oauth_setup','finish_agent_workflow','guard_agent_request','guard_agent_workflow_link','guard_execution_request','guard_microsoft_oauth_revision','guard_workflow_snapshot','microsoft_connection_binding','microsoft_grant_matches','reconcile_microsoft_attempt','record_microsoft_attempt','require_microsoft_setup_actor','reserve_agent_workflow','review_agent_workflow_request','rotate_microsoft_integration_revision','validate_microsoft_connection','workflow_policy_snapshot'))
 THEN RAISE EXCEPTION 'Candidate function name already exists'; END IF;
 IF EXISTS(select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and t.tgname in ('guard_microsoft_oauth_revision','rotate_microsoft_integration_revision','harden_action_request','harden_agent_request','guard_workflow_snapshot','guard_agent_workflow_link','ai_draft_configuration_immutable'))
 THEN RAISE EXCEPTION 'Candidate trigger name already exists'; END IF;
 IF to_regprocedure('public.edge_read_secret(uuid)') IS NULL OR to_regprocedure('public.edge_store_secret(text,text,text)') IS NULL OR to_regprocedure('public.edge_update_secret(uuid,text)') IS NULL
 THEN RAISE EXCEPTION 'Required existing Vault wrapper absent'; END IF;
 IF NOT EXISTS(select 1 from pg_roles where rolname='service_role' and rolbypassrls) THEN RAISE EXCEPTION 'Expected service role unavailable'; END IF;
END $prelaunch_guard$;

-- Source: oauth-setup-contract.sql
-- Fresh LOCAL CANDIDATE. Derived from 2026-10-08 production metadata and isolated definitions.
-- Not a deployed migration. Production Vault helper functions are existing dependencies.
-- No hosted installation or provider calls have been performed.
CREATE SCHEMA IF NOT EXISTS private;
ALTER TABLE public.oauth_connections ADD COLUMN IF NOT EXISTS oauth_verified_version integer NOT NULL DEFAULT 0;
ALTER TABLE public.oauth_connections ADD COLUMN IF NOT EXISTS oauth_revision uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.oauth_connections ADD COLUMN IF NOT EXISTS oauth_refresh_revision uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.integrations ADD COLUMN IF NOT EXISTS oauth_revision uuid NOT NULL DEFAULT gen_random_uuid();
CREATE TABLE IF NOT EXISTS private.microsoft_oauth_setups (
  state uuid DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  initiated_by uuid NOT NULL,
  connection_revision uuid NOT NULL,
  integration_revision uuid NOT NULL,
  tenant_id text NOT NULL,
  client_id text NOT NULL,
  client_secret_id uuid NOT NULL,
  scopes text[] NOT NULL,
  redirect_uri text NOT NULL,
  code_verifier text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone DEFAULT (now() + '00:10:00'::interval) NOT NULL,
  claimed_at timestamp with time zone,
  finished_at timestamp with time zone,
  outcome text,
  PRIMARY KEY(state)
);
ALTER TABLE private.microsoft_oauth_setups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.microsoft_oauth_setups FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON private.microsoft_oauth_setups TO service_role;
-- Old generic public OAuth state helpers are no longer part of these routes.
-- The existing Vault wrappers must be inaccessible to browser roles.
REVOKE ALL ON FUNCTION public.edge_read_secret(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.edge_store_secret(text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.edge_update_secret(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.edge_read_secret(uuid),public.edge_store_secret(text,text,text),public.edge_update_secret(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION private.microsoft_connection_binding(c public.oauth_connections, i public.integrations)
RETURNS jsonb LANGUAGE sql STABLE SET search_path='pg_catalog' AS $$
 SELECT jsonb_build_object('id',c.id,'organization_id',c.organization_id,'integration_id',c.integration_id,'provider',c.provider,
   'tenant_id',c.tenant_id,'client_id',c.client_id,'external_account_id',c.external_account_id,
   'access_secret_id',c.access_secret_id,'refresh_secret_id',c.refresh_secret_id,'client_secret_id',c.client_secret_id,
   'oauth_verified_version',c.oauth_verified_version,'oauth_revision',c.oauth_revision,
   'scopes',(SELECT coalesce(jsonb_agg(s ORDER BY s),'[]'::jsonb) FROM (SELECT DISTINCT unnest(c.scopes) s) z),
   'integration_revision',i.oauth_revision);
$$;
CREATE OR REPLACE FUNCTION private.microsoft_grant_matches(requested text[], granted text[])
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='pg_catalog' AS $$
 SELECT requested IS NOT NULL AND granted IS NOT NULL AND array_position(granted,NULL) IS NULL
 AND (SELECT coalesce(array_agg(DISTINCT s ORDER BY s),'{}'::text[]) FROM unnest(requested) s WHERE s NOT IN ('openid','profile','offline_access','email'))
   = (SELECT coalesce(array_agg(DISTINCT s ORDER BY s),'{}'::text[]) FROM unnest(granted) s WHERE s NOT IN ('openid','profile','offline_access','email'));
$$;
CREATE OR REPLACE FUNCTION private.require_microsoft_setup_actor(p_organization_id uuid, p_actor_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
begin
  perform 1 from public.organization_members where organization_id=p_organization_id and user_id=p_actor_id
    and role in ('owner','admin','consultant') for share;
  if found then return; end if;
  perform 1 from public.staff_accounts where user_id=p_actor_id and active and role in ('platform_admin','consultant') for share;
  if not found then raise exception 'Actor not authorized to configure this organization'; end if;
end $function$
;
CREATE OR REPLACE FUNCTION private.guard_microsoft_oauth_revision()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
declare trusted boolean := current_user in ('service_role','postgres','supabase_admin'); changed boolean;
begin
  if TG_OP='INSERT' then
    if not trusted and (new.oauth_verified_version<>0 or new.status='Connected'
      or new.access_secret_id is not null or new.refresh_secret_id is not null or new.client_secret_id is not null
      or new.external_account_id is not null) then raise exception 'Verified OAuth setup is server managed'; end if;
    new.oauth_revision=gen_random_uuid(); new.oauth_refresh_revision=gen_random_uuid();
    -- Inserts never assert verified provenance, even by trusted code.
    new.oauth_verified_version=0;
    return new;
  end if;
  changed=(to_jsonb(new)-array['updated_at','created_at','created_by','last_error','token_expires_at','last_connected_at','external_account_name','oauth_revision','oauth_verified_version','oauth_refresh_revision'])
    is distinct from (to_jsonb(old)-array['updated_at','created_at','created_by','last_error','token_expires_at','last_connected_at','external_account_name','oauth_revision','oauth_verified_version','oauth_refresh_revision']);
  if not trusted then
    if new.oauth_verified_version is distinct from old.oauth_verified_version or new.oauth_revision is distinct from old.oauth_revision or new.oauth_refresh_revision is distinct from old.oauth_refresh_revision
      or new.id is distinct from old.id or new.organization_id is distinct from old.organization_id
      or new.integration_id is distinct from old.integration_id or new.provider is distinct from old.provider
      or new.client_id is distinct from old.client_id or new.tenant_id is distinct from old.tenant_id
      or new.scopes is distinct from old.scopes or new.client_secret_id is distinct from old.client_secret_id
      or new.access_secret_id is distinct from old.access_secret_id or new.refresh_secret_id is distinct from old.refresh_secret_id
      or new.external_account_id is distinct from old.external_account_id
      or (new.status='Connected' and old.status is distinct from 'Connected') then
      raise exception 'Verified OAuth setup is server managed';
    end if;
  end if;
  if changed then
    new.oauth_revision=gen_random_uuid(); new.oauth_refresh_revision=gen_random_uuid();
    -- Only a transition from an unverified pending setup may establish provenance.
    if old.oauth_verified_version=1 or new.status is distinct from 'Connected' then new.oauth_verified_version=0; end if;
  else new.oauth_revision=old.oauth_revision; end if;
  if new.oauth_verified_version not in (0,1) then raise exception 'Invalid OAuth provenance'; end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION private.rotate_microsoft_integration_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
BEGIN
  IF TG_OP='INSERT' THEN NEW.oauth_revision=gen_random_uuid(); RETURN NEW; END IF;
  -- Health checks and notes never change authorization. Configuration/status edits do.
  IF ROW(NEW.id,NEW.organization_id,NEW.provider,NEW.integration_type,NEW.status,NEW.scopes,NEW.authentication_method)
    IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.provider,OLD.integration_type,OLD.status,OLD.scopes,OLD.authentication_method)
  THEN NEW.oauth_revision=gen_random_uuid(); ELSE NEW.oauth_revision=OLD.oauth_revision; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_microsoft_oauth_revision ON public.oauth_connections;
CREATE TRIGGER guard_microsoft_oauth_revision BEFORE INSERT OR UPDATE ON public.oauth_connections
FOR EACH ROW EXECUTE FUNCTION private.guard_microsoft_oauth_revision();
DROP TRIGGER IF EXISTS rotate_microsoft_integration_revision ON public.integrations;
CREATE TRIGGER rotate_microsoft_integration_revision BEFORE INSERT OR UPDATE ON public.integrations
FOR EACH ROW EXECUTE FUNCTION private.rotate_microsoft_integration_revision();
CREATE OR REPLACE FUNCTION public.begin_microsoft_oauth_setup(p_organization_id uuid, p_integration_id uuid, p_actor_id uuid, p_tenant_id text, p_client_id text, p_client_secret text, p_scopes text[], p_code_verifier text, p_redirect_uri text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
declare c public.oauth_connections; i public.integrations; s private.microsoft_oauth_setups; secret_id uuid;
begin
  if p_organization_id is null or p_actor_id is null or coalesce(length(p_client_secret),0)=0 or length(p_client_secret)>16384
    or coalesce(p_tenant_id,'') !~ '^[a-zA-Z0-9][a-zA-Z0-9.-]{0,254}$'
    or coalesce(p_client_id,'') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(p_code_verifier,'') !~ '^[A-Za-z0-9_-]{43,128}$'
    or coalesce(p_redirect_uri,'') !~ '^https://[^/?#]+/functions/v1/microsoft-oauth-callback$'
    or p_scopes is null or cardinality(p_scopes)=0 or cardinality(p_scopes)>64
    or array_position(p_scopes,null) is not null or not ('User.Read'=any(p_scopes))
    or not ('offline_access'=any(p_scopes))
    or exists(select 1 from unnest(p_scopes) x where x not in ('openid','profile','offline_access','User.Read','Mail.Read','Mail.Send','Calendars.Read','Files.Read.All')) then raise exception 'Invalid OAuth setup'; end if;
  p_scopes=ARRAY(SELECT DISTINCT x FROM unnest(p_scopes) x ORDER BY x);
  -- Serialize concurrent starts even before the per-org connection exists.
  perform 1 from public.organizations where id=p_organization_id for update;
  if not found then raise exception 'Organization missing'; end if;
  perform private.require_microsoft_setup_actor(p_organization_id,p_actor_id);
  select * into c from public.oauth_connections where organization_id=p_organization_id and provider='microsoft' for update;
  if p_integration_id is not null then
    select * into i from public.integrations where id=p_integration_id and organization_id=p_organization_id
      and provider='Microsoft' and integration_type='OAuth' for update;
    if not found then raise exception 'Integration organization or provider binding invalid'; end if;
  elsif c.integration_id is not null then
    select * into i from public.integrations where id=c.integration_id and organization_id=p_organization_id
      and provider='Microsoft' and integration_type='OAuth' for update;
    if not found then raise exception 'Integration organization or provider binding invalid'; end if;
  else
    -- Preserve the existing single-Microsoft-integration behavior, but fail safely on ambiguity.
    if (select count(*) from public.integrations where organization_id=p_organization_id and provider='Microsoft' and integration_type='OAuth')>1 then
      raise exception 'Choose a Microsoft integration explicitly'; end if;
    select * into i from public.integrations where organization_id=p_organization_id and provider='Microsoft' and integration_type='OAuth' for update;
    if not found then
      insert into public.integrations(organization_id,name,provider,integration_type,status,data_classification,created_by)
        values(p_organization_id,'Microsoft 365 / Graph','Microsoft','OAuth','Configuring','Internal',p_actor_id) returning * into i;
    end if;
  end if;
  -- Each state gets a fresh immutable client-secret reference. Never mutate a secret
  -- that an older callback or existing refresh may already have read.
  secret_id=public.edge_store_secret(p_client_secret,'ms-client-'||p_organization_id||'-'||gen_random_uuid(),'Microsoft Entra client secret for Kairo');
  if secret_id is null then raise exception 'Client credential storage failed'; end if;
  update public.integrations set status='Configuring' where id=i.id and organization_id=p_organization_id returning * into i;
  if c.id is null then
    insert into public.oauth_connections(organization_id,integration_id,provider,tenant_id,client_id,client_secret_id,scopes,status,created_by)
      values(p_organization_id,i.id,'microsoft',p_tenant_id,p_client_id,secret_id,p_scopes,'Consent Required',p_actor_id) returning * into c;
  else
    update public.oauth_connections set integration_id=i.id,tenant_id=p_tenant_id,client_id=p_client_id,client_secret_id=secret_id,
      scopes=p_scopes,status='Consent Required',oauth_verified_version=0,access_secret_id=null,refresh_secret_id=null,
      external_account_id=null,external_account_name=null,token_expires_at=null,last_error=null
      where id=c.id and organization_id=p_organization_id returning * into c;
  end if;
  insert into private.microsoft_oauth_setups(organization_id,connection_id,integration_id,initiated_by,connection_revision,
    integration_revision,tenant_id,client_id,client_secret_id,scopes,redirect_uri,code_verifier)
    values(p_organization_id,c.id,i.id,p_actor_id,c.oauth_revision,i.oauth_revision,p_tenant_id,p_client_id,secret_id,p_scopes,p_redirect_uri,p_code_verifier)
    returning * into s;
  return jsonb_build_object('state',s.state,'connection_id',c.id,'tenant_id',s.tenant_id,'client_id',s.client_id,'scopes',s.scopes,'redirect_uri',s.redirect_uri);
end $function$
;
CREATE OR REPLACE FUNCTION public.claim_microsoft_oauth_setup(p_state uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
declare s private.microsoft_oauth_setups; c public.oauth_connections; i public.integrations;
begin
  select * into s from private.microsoft_oauth_setups where state=p_state for update;
  if not found or s.claimed_at is not null or s.finished_at is not null or s.expires_at<=clock_timestamp() then raise exception 'OAuth state expired or invalid'; end if;
  select * into c from public.oauth_connections where id=s.connection_id and organization_id=s.organization_id for update;
  if not found or c.provider is distinct from 'microsoft' or c.status is distinct from 'Consent Required'
    or c.oauth_revision is distinct from s.connection_revision or c.integration_id is distinct from s.integration_id
    or c.tenant_id is distinct from s.tenant_id or c.client_id is distinct from s.client_id
    or c.client_secret_id is distinct from s.client_secret_id or c.scopes is distinct from s.scopes then raise exception 'OAuth setup superseded'; end if;
  select * into i from public.integrations where id=s.integration_id and organization_id=s.organization_id for update;
  if not found or i.status is distinct from 'Configuring' or i.provider is distinct from 'Microsoft' or i.integration_type is distinct from 'OAuth'
    or i.oauth_revision is distinct from s.integration_revision then raise exception 'OAuth integration changed'; end if;
  perform private.require_microsoft_setup_actor(s.organization_id,s.initiated_by);
  update private.microsoft_oauth_setups set claimed_at=clock_timestamp() where state=s.state;
  return jsonb_build_object('state',s.state,'connection_id',s.connection_id,'organization_id',s.organization_id,'tenant_id',s.tenant_id,
    'client_id',s.client_id,'client_secret_id',s.client_secret_id,'scopes',s.scopes,'redirect_uri',s.redirect_uri,'code_verifier',s.code_verifier);
end $function$
;
CREATE OR REPLACE FUNCTION public.complete_microsoft_oauth_setup(p_state uuid, p_access_token text, p_refresh_token text, p_expires_at timestamp with time zone, p_account_id text, p_account_name text, p_granted_scopes text[])
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
declare s private.microsoft_oauth_setups; c public.oauth_connections; i public.integrations; access_id uuid; refresh_id uuid;
begin
  select * into s from private.microsoft_oauth_setups where state=p_state for update;
  if not found or s.claimed_at is null or s.finished_at is not null or s.expires_at<=clock_timestamp() then raise exception 'OAuth state expired or invalid'; end if;
  select * into c from public.oauth_connections where id=s.connection_id and organization_id=s.organization_id for update;
  if not found or c.status is distinct from 'Consent Required' or c.provider is distinct from 'microsoft'
    or c.oauth_revision is distinct from s.connection_revision or c.integration_id is distinct from s.integration_id
    or c.tenant_id is distinct from s.tenant_id or c.client_id is distinct from s.client_id
    or c.client_secret_id is distinct from s.client_secret_id or c.scopes is distinct from s.scopes then raise exception 'OAuth setup superseded'; end if;
  select * into i from public.integrations where id=s.integration_id and organization_id=s.organization_id for update;
  if not found or i.status is distinct from 'Configuring' or i.provider is distinct from 'Microsoft' or i.integration_type is distinct from 'OAuth'
    or i.oauth_revision is distinct from s.integration_revision then raise exception 'OAuth integration changed'; end if;
  perform private.require_microsoft_setup_actor(s.organization_id,s.initiated_by);
  if coalesce(length(p_access_token),0)=0 or coalesce(length(p_refresh_token),0)=0
    or p_expires_at is null or p_expires_at<=clock_timestamp() or p_expires_at>clock_timestamp()+interval '24 hours'
    or nullif(btrim(p_account_id),'') is null or length(p_account_id)>512 or p_account_id ~ '[[:cntrl:]]'
    or not private.microsoft_grant_matches(s.scopes,p_granted_scopes) then
    raise exception 'Unverified Microsoft account or incomplete token grant'; end if;
  access_id=public.edge_store_secret(p_access_token,'ms-access-'||s.organization_id||'-'||gen_random_uuid(),'Microsoft access token for Kairo');
  refresh_id=public.edge_store_secret(p_refresh_token,'ms-refresh-'||s.organization_id||'-'||gen_random_uuid(),'Microsoft refresh token for Kairo');
  if access_id is null or refresh_id is null then raise exception 'Token storage failed'; end if;
  update public.oauth_connections set status='Connected',oauth_verified_version=1,access_secret_id=access_id,refresh_secret_id=refresh_id,
    token_expires_at=p_expires_at,external_account_id=p_account_id,external_account_name=left(p_account_name,512),
    last_connected_at=clock_timestamp(),last_error=null where id=c.id and organization_id=s.organization_id;
  update public.integrations set status='Connected',last_health_check_at=clock_timestamp(),
    authentication_method='Microsoft OAuth 2.0 / PKCE',scopes=array_to_string(s.scopes,' ') where id=i.id and organization_id=s.organization_id;
  update private.microsoft_oauth_setups set finished_at=clock_timestamp(),outcome='Connected',code_verifier='' where state=s.state;
  return true;
end $function$
;
CREATE OR REPLACE FUNCTION public.fail_microsoft_oauth_setup(p_state uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
declare s private.microsoft_oauth_setups; c public.oauth_connections; i public.integrations;
begin
  select * into s from private.microsoft_oauth_setups where state=p_state for update;
  if not found or s.claimed_at is null or s.finished_at is not null then return false; end if;
  select * into c from public.oauth_connections where id=s.connection_id and organization_id=s.organization_id for update;
  select * into i from public.integrations where id=s.integration_id and organization_id=s.organization_id for update;
  if c.oauth_revision=s.connection_revision and c.status='Consent Required' and i.oauth_revision=s.integration_revision and i.status='Configuring' then
    update public.oauth_connections set status='Error',last_error='Microsoft authorization failed. Start a new connection setup.' where id=c.id;
  end if;
  update private.microsoft_oauth_setups set finished_at=clock_timestamp(),outcome='Error',code_verifier='' where state=s.state;
  return true;
end $function$
;

-- Only the edge service can supply the authenticated actor or attest provider results.
REVOKE ALL ON FUNCTION private.microsoft_connection_binding(public.oauth_connections,public.integrations),private.microsoft_grant_matches(text[],text[]),private.require_microsoft_setup_actor(uuid,uuid),private.guard_microsoft_oauth_revision(),private.rotate_microsoft_integration_revision() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.microsoft_connection_binding(public.oauth_connections,public.integrations),private.microsoft_grant_matches(text[],text[]),private.require_microsoft_setup_actor(uuid,uuid),private.guard_microsoft_oauth_revision(),private.rotate_microsoft_integration_revision() TO service_role;
REVOKE ALL ON FUNCTION public.begin_microsoft_oauth_setup(uuid,uuid,uuid,text,text,text,text[],text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.begin_microsoft_oauth_setup(uuid,uuid,uuid,text,text,text,text[],text,text) TO service_role;
REVOKE ALL ON FUNCTION public.claim_microsoft_oauth_setup(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_microsoft_oauth_setup(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.complete_microsoft_oauth_setup(uuid,text,text,timestamp with time zone,text,text,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_microsoft_oauth_setup(uuid,text,text,timestamp with time zone,text,text,text[]) TO service_role;
REVOKE ALL ON FUNCTION public.fail_microsoft_oauth_setup(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fail_microsoft_oauth_setup(uuid) TO service_role;


-- Source: oauth-refresh-contract.sql
-- Requires oauth-setup-contract.sql. Local candidate only.
CREATE OR REPLACE FUNCTION public.validate_microsoft_connection(
  p_connection_id uuid, p_organization_id uuid, p_expected_binding jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
DECLARE c public.oauth_connections; i public.integrations;
BEGIN
  SELECT * INTO c FROM public.oauth_connections WHERE id=p_connection_id AND organization_id=p_organization_id FOR SHARE;
  IF NOT FOUND OR c.status IS DISTINCT FROM 'Connected' OR c.provider IS DISTINCT FROM 'microsoft'
    OR c.oauth_verified_version IS DISTINCT FROM 1 OR nullif(btrim(c.external_account_id),'') IS NULL
    OR c.access_secret_id IS NULL OR c.client_secret_id IS NULL OR c.refresh_secret_id IS NULL
  THEN RAISE EXCEPTION 'Microsoft connection is unavailable'; END IF;
  SELECT * INTO i FROM public.integrations WHERE id=c.integration_id AND organization_id=c.organization_id FOR SHARE;
  IF NOT FOUND OR i.provider IS DISTINCT FROM 'Microsoft' OR i.integration_type IS DISTINCT FROM 'OAuth'
    OR i.status IS DISTINCT FROM 'Connected'
    OR i.scopes IS DISTINCT FROM array_to_string(c.scopes,' ')
    OR p_expected_binding IS DISTINCT FROM private.microsoft_connection_binding(c,i)
  THEN RAISE EXCEPTION 'Microsoft connection authority changed'; END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.commit_microsoft_refresh(
  connection_id uuid, organization_id uuid, expected_refresh_revision uuid, expected_binding jsonb,
  access_token text, refresh_token text, expires_at timestamptz, verified_account_id text, granted_scopes text[])
RETURNS boolean LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
DECLARE c public.oauth_connections; i public.integrations;
BEGIN
  SELECT * INTO c FROM public.oauth_connections o
    WHERE o.id=connection_id AND o.organization_id=commit_microsoft_refresh.organization_id FOR UPDATE;
  IF NOT FOUND OR c.status IS DISTINCT FROM 'Connected' OR c.provider IS DISTINCT FROM 'microsoft'
    OR c.oauth_verified_version IS DISTINCT FROM 1 OR nullif(btrim(c.external_account_id),'') IS NULL
    OR c.oauth_refresh_revision IS DISTINCT FROM expected_refresh_revision
  THEN RAISE EXCEPTION 'Connection changed during refresh'; END IF;
  SELECT * INTO i FROM public.integrations WHERE id=c.integration_id AND integrations.organization_id=c.organization_id FOR SHARE;
  IF NOT FOUND OR i.provider IS DISTINCT FROM 'Microsoft' OR i.integration_type IS DISTINCT FROM 'OAuth'
    OR i.status IS DISTINCT FROM 'Connected' OR i.scopes IS DISTINCT FROM array_to_string(c.scopes,' ')
    OR expected_binding IS DISTINCT FROM private.microsoft_connection_binding(c,i)
    OR c.access_secret_id IS NULL OR c.refresh_secret_id IS NULL OR c.client_secret_id IS NULL
    OR coalesce(length(access_token),0)=0 OR expires_at IS NULL OR expires_at<=clock_timestamp()
    OR expires_at>clock_timestamp()+interval '24 hours'
    OR (refresh_token IS NOT NULL AND length(refresh_token)=0)
    OR verified_account_id IS DISTINCT FROM c.external_account_id
    OR NOT private.microsoft_grant_matches(c.scopes,granted_scopes)
  THEN RAISE EXCEPTION 'Invalid refresh binding or provider result'; END IF;
  -- Same transaction: failed storage rolls back both secrets and the revision.
  PERFORM public.edge_update_secret(c.access_secret_id,access_token);
  IF refresh_token IS NOT NULL THEN PERFORM public.edge_update_secret(c.refresh_secret_id,refresh_token); END IF;
  -- Refresh never establishes Connected status, changes scopes/account/references, or approval identity.
  UPDATE public.oauth_connections o SET token_expires_at=expires_at,last_error=NULL,oauth_refresh_revision=gen_random_uuid()
    WHERE o.id=c.id AND o.organization_id=c.organization_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.validate_microsoft_connection(uuid,uuid,jsonb),public.commit_microsoft_refresh(uuid,uuid,uuid,jsonb,text,text,timestamptz,text,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.validate_microsoft_connection(uuid,uuid,jsonb),public.commit_microsoft_refresh(uuid,uuid,uuid,jsonb,text,text,timestamptz,text,text[]) TO service_role;


-- Source: guard-contract.sql
-- REVIEW CANDIDATE ONLY. Not a generated migration. Do not apply to production.
-- Generate a migration through the project's supported CLI after review/staging.
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


-- Source: workflow-contract.sql
-- ISOLATED REVIEW PROPOSAL ONLY. Not a generated migration; do not apply to production.
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


-- Source: reconciliation-contract.sql
-- LOCAL REVIEW CANDIDATE. No automatic provider resend or timeout-based reset.
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


-- Source: agent-workflow-contract.sql
-- LOCAL REVIEW CANDIDATE ONLY. Requires OAuth, guard, and workflow contracts.
-- Human-approved existing workflows only; descriptive agent fields are frozen for review,
-- not interpreted as an autonomous policy language. No confidence value grants authority.
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


-- Source: ai-draft-contract.sql
-- Unapplied local review contract. Requires existing organizations/organization_members.
-- All public RPCs are service_role-only; Edge verifies the JWT and derives p_actor.
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
 or p_config->>'schema_version' is distinct from '1' or p_config->>'provider' is distinct from 'openai' or p_config->>'source' is distinct from 'manual_context' or p_config->'human_review' is distinct from 'true'::jsonb
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

-- Assert critical fail-closed invariants before COMMIT; no provider or secret calls.
DO $prelaunch_assert$
BEGIN
 IF (SELECT count(*) FROM pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname||'.'||c.relname=any(array['private.microsoft_oauth_setups','public.action_execution_receipts','private.agent_daily_reservations','private.agent_run_reservations','public.ai_draft_configurations','public.ai_draft_runs']) and c.relkind='r' and c.relrowsecurity)<>6
 THEN RAISE EXCEPTION 'New-table RLS assertion failed'; END IF;
 IF EXISTS(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname in ('agent_actor_allowed','agent_context_clean','agent_required_roles','ai_draft_authorize','ai_draft_finish','ai_draft_immutable','ai_draft_reserve','ai_draft_review','ai_draft_save','assert_agent_workflow_lineage','assert_workflow_action_approval','begin_microsoft_oauth_setup','build_agent_snapshot','claim_microsoft_action','claim_microsoft_oauth_setup','claim_workflow_continuation','commit_microsoft_refresh','complete_microsoft_oauth_setup','create_agent_workflow_request','create_trusted_workflow_run','fail_microsoft_oauth_setup','finish_agent_workflow','guard_agent_request','guard_agent_workflow_link','guard_execution_request','guard_microsoft_oauth_revision','guard_workflow_snapshot','microsoft_connection_binding','microsoft_grant_matches','reconcile_microsoft_attempt','record_microsoft_attempt','require_microsoft_setup_actor','reserve_agent_workflow','review_agent_workflow_request','rotate_microsoft_integration_revision','validate_microsoft_connection','workflow_policy_snapshot') and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')))
 THEN RAISE EXCEPTION 'Candidate RPC unexpectedly executable by a browser role'; END IF;
 IF EXISTS(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname||'.'||c.relname=any(array['private.microsoft_oauth_setups','public.action_execution_receipts','private.agent_daily_reservations','private.agent_run_reservations','public.ai_draft_configurations','public.ai_draft_runs']) and (has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))
 THEN RAISE EXCEPTION 'New table unexpectedly accessible by a browser role'; END IF;
 IF EXISTS(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('action_requests','agent_run_requests','workflow_runs') and (has_table_privilege('anon',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))
 THEN RAISE EXCEPTION 'Browser write bypass remains on guarded runtime table'; END IF;
 IF EXISTS(select 1 from public.oauth_connections) OR EXISTS(select 1 from public.action_requests) OR EXISTS(select 1 from public.agent_run_requests) OR EXISTS(select 1 from public.workflow_runs) OR (SELECT count(*) FROM public.integrations)<>2
 THEN RAISE EXCEPTION 'Reviewed runtime counts changed'; END IF;
END $prelaunch_assert$;
COMMIT;
