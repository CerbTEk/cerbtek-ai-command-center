-- Fresh LOCAL CANDIDATE. Derived from 2026-10-08 production metadata and isolated definitions.
-- Not a deployed migration. Production Vault helper functions are existing dependencies.
-- No hosted installation or provider calls have been performed.
BEGIN;
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
COMMIT;
