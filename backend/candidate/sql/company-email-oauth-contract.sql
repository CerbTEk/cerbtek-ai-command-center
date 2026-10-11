-- LOCAL SOURCE CANDIDATE ONLY. Apply after oauth-setup-contract.sql and oauth-refresh-contract.sql.
-- No deployment, provider registration, credential provisioning or OAuth grant is authorized by this file.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
-- Exact read-only production metadata showed Microsoft-only provider check. Widen only
-- this named check after verifying its definition; keep existing status enums intact.
DO $provider_constraint$
DECLARE definition text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
  WHERE conrelid='public.oauth_connections'::regclass AND conname='oauth_connections_provider_check' AND contype='c';
 IF definition IS NULL THEN RAISE EXCEPTION 'Expected OAuth provider check missing; review schema before migration'; END IF;
 IF definition = 'CHECK ((provider = ''microsoft''::text))' THEN
  ALTER TABLE public.oauth_connections DROP CONSTRAINT oauth_connections_provider_check;
  ALTER TABLE public.oauth_connections ADD CONSTRAINT oauth_connections_provider_check CHECK (provider IN ('microsoft','google'));
 ELSIF definition <> 'CHECK ((provider = ANY (ARRAY[''microsoft''::text, ''google''::text])))' THEN
  RAISE EXCEPTION 'Unexpected OAuth provider check; review schema before migration';
 END IF;
END $provider_constraint$;
ALTER TABLE public.oauth_connections ADD COLUMN IF NOT EXISTS external_account_email text;
ALTER TABLE public.oauth_connections ADD COLUMN IF NOT EXISTS oauth_connected_by uuid;
ALTER TABLE public.oauth_connections ADD COLUMN IF NOT EXISTS oauth_granted_scopes text[];
CREATE TABLE IF NOT EXISTS private.company_email_oauth_setups (
 state uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL CHECK(provider IN ('microsoft','google')),
 organization_id uuid NOT NULL, connection_id uuid NOT NULL, integration_id uuid NOT NULL,
 initiated_by uuid NOT NULL, connection_revision uuid NOT NULL, integration_revision uuid NOT NULL,
 tenant_id text NOT NULL, client_id text NOT NULL, client_secret_id uuid NOT NULL, scopes text[] NOT NULL,
 intent text NOT NULL CHECK(intent IN ('read','send','read_send')),redirect_uri text NOT NULL,code_verifier text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
 claimed_at timestamptz,finished_at timestamptz,outcome text,
 browser_challenge text NOT NULL CHECK(browser_challenge ~ '^[a-f0-9]{64}$'),
 completion_challenge text,staged_at timestamptz,staged_access_id uuid,staged_refresh_id uuid,
 staged_expires_at timestamptz,staged_account_id text,staged_account_name text,staged_account_email text,staged_granted_scopes text[]
);
ALTER TABLE private.company_email_oauth_setups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.company_email_oauth_setups FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON private.company_email_oauth_setups TO service_role;

CREATE OR REPLACE FUNCTION private.require_company_email_actor(p_organization_id uuid,p_actor_id uuid,p_manager boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
BEGIN
 IF p_actor_id IS NULL OR p_organization_id IS NULL THEN RAISE EXCEPTION 'Company email authorization denied'; END IF;
 PERFORM 1 FROM public.organization_members WHERE organization_id=p_organization_id AND user_id=p_actor_id
  AND (NOT p_manager OR role IN ('owner','admin','consultant'));
 IF NOT FOUND THEN RAISE EXCEPTION 'Company email authorization denied'; END IF;
END $$;

CREATE OR REPLACE FUNCTION private.email_requested_scopes(p_provider text,p_intent text)
RETURNS text[] LANGUAGE plpgsql IMMUTABLE SET search_path='pg_catalog' AS $$
DECLARE s text[];
BEGIN
 IF p_provider IS NULL OR p_provider NOT IN ('microsoft','google') OR p_intent IS NULL OR p_intent NOT IN ('read','send','read_send') THEN RAISE EXCEPTION 'Invalid email capability intent'; END IF;
 IF p_provider='microsoft' THEN
  s:=ARRAY['openid','profile','offline_access','User.Read'];
  IF p_intent IN ('read','read_send') THEN s:=s||ARRAY['Mail.Read']; END IF;
  IF p_intent IN ('send','read_send') THEN s:=s||ARRAY['Mail.Send']; END IF;
 ELSE
  s:=ARRAY['openid','email','profile'];
  IF p_intent IN ('read','read_send') THEN s:=s||ARRAY['https://www.googleapis.com/auth/gmail.readonly']; END IF;
  IF p_intent IN ('send','read_send') THEN s:=s||ARRAY['https://www.googleapis.com/auth/gmail.send']; END IF;
 END IF;
 RETURN ARRAY(SELECT DISTINCT x FROM unnest(s) x ORDER BY x);
END $$;

CREATE OR REPLACE FUNCTION private.email_grant_matches(p_provider text,requested text[],granted text[])
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='pg_catalog' AS $$
 SELECT CASE WHEN p_provider='microsoft' THEN private.microsoft_grant_matches(requested,granted)
 WHEN p_provider='google' THEN requested IS NOT NULL AND granted IS NOT NULL AND array_position(granted,NULL) IS NULL
  AND ARRAY(SELECT DISTINCT x FROM unnest(requested) x ORDER BY x)=ARRAY(SELECT DISTINCT x FROM unnest(granted) x ORDER BY x)
 ELSE false END;
$$;

CREATE OR REPLACE FUNCTION private.email_connection_binding(c public.oauth_connections,i public.integrations)
RETURNS jsonb LANGUAGE sql STABLE SET search_path='pg_catalog' AS $$
 SELECT private.microsoft_connection_binding(c,i) || CASE WHEN c.provider='google' THEN jsonb_build_object('external_account_email',c.external_account_email) ELSE '{}'::jsonb END;
$$;

-- Existing revision guard already rotates on any changed new columns. Explicitly protect
-- these new authority fields from browser writes even if an older broad grant survives.
CREATE OR REPLACE FUNCTION private.guard_company_email_authority()
RETURNS trigger LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
BEGIN
 IF current_user NOT IN ('service_role','postgres','supabase_admin') AND
  (TG_OP='INSERT' AND (NEW.external_account_email IS NOT NULL OR NEW.oauth_connected_by IS NOT NULL OR NEW.oauth_granted_scopes IS NOT NULL)
   OR TG_OP='UPDATE' AND ROW(NEW.external_account_email,NEW.oauth_connected_by,NEW.oauth_granted_scopes) IS DISTINCT FROM ROW(OLD.external_account_email,OLD.oauth_connected_by,OLD.oauth_granted_scopes)) THEN
  RAISE EXCEPTION 'Company email authority is server managed';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_company_email_authority ON public.oauth_connections;
CREATE TRIGGER guard_company_email_authority BEFORE INSERT OR UPDATE ON public.oauth_connections FOR EACH ROW EXECUTE FUNCTION private.guard_company_email_authority();

-- Clear secret bytes using existing Vault capabilities. No new delete privileges.
-- Caller holds organization then connection locks; callbacks use the same ordering.
CREATE OR REPLACE FUNCTION private.clear_company_email_secrets(p_connection_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
DECLARE secret_id uuid;
BEGIN
 FOR secret_id IN
  SELECT DISTINCT x FROM (
   SELECT unnest(ARRAY[c.access_secret_id,c.refresh_secret_id,c.client_secret_id]) x FROM public.oauth_connections c WHERE c.id=p_connection_id
   UNION ALL SELECT unnest(ARRAY[s.client_secret_id,s.staged_access_id,s.staged_refresh_id]) FROM private.company_email_oauth_setups s WHERE s.connection_id=p_connection_id
   UNION ALL SELECT s.client_secret_id FROM private.microsoft_oauth_setups s WHERE s.connection_id=p_connection_id
  ) refs WHERE x IS NOT NULL
 LOOP
  PERFORM public.edge_update_secret(secret_id,'');
  IF coalesce(public.edge_read_secret(secret_id),'')<>'' THEN RAISE EXCEPTION 'Credential removal failed'; END IF;
 END LOOP;
 UPDATE private.company_email_oauth_setups SET finished_at=coalesce(finished_at,clock_timestamp()),outcome=CASE WHEN finished_at IS NULL THEN 'Superseded' ELSE outcome END,
  code_verifier='',completion_challenge=NULL,staged_access_id=NULL,staged_refresh_id=NULL WHERE connection_id=p_connection_id;
 UPDATE private.microsoft_oauth_setups SET finished_at=coalesce(finished_at,clock_timestamp()),outcome=CASE WHEN finished_at IS NULL THEN 'Superseded' ELSE outcome END,code_verifier='' WHERE connection_id=p_connection_id;
END $$;

CREATE OR REPLACE FUNCTION public.begin_company_email_oauth_setup(
 p_organization_id uuid,p_actor_id uuid,p_provider text,p_intent text,p_connection_id uuid,p_expected_revision uuid,
 p_tenant_id text,p_client_id text,p_client_secret text,p_scopes text[],p_code_verifier text,p_redirect_uri text,p_browser_challenge text)
RETURNS jsonb LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
DECLARE c public.oauth_connections;i public.integrations;s private.company_email_oauth_setups;secret_id uuid;display_provider text;
BEGIN
 IF p_scopes IS DISTINCT FROM private.email_requested_scopes(p_provider,p_intent)
  OR coalesce(p_browser_challenge,'') !~ '^[a-f0-9]{64}$'
  OR coalesce(length(p_client_secret),0)=0 OR length(p_client_secret)>16384
  OR coalesce(p_code_verifier,'') !~ '^[A-Za-z0-9_-]{43,128}$'
  OR coalesce(p_redirect_uri,'') !~ ('^https://[^/?#]+/functions/v1/'||p_provider||'-oauth-callback$')
  OR (p_provider='microsoft' AND (coalesce(p_client_id,'') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR coalesce(p_tenant_id,'') !~* '^(organizations|[0-9a-f-]{36})$'))
  OR (p_provider='google' AND (p_tenant_id IS DISTINCT FROM 'google' OR coalesce(p_client_id,'') !~ '^[A-Za-z0-9._-]{10,255}\.apps\.googleusercontent\.com$'))
  OR ((p_connection_id IS NULL)<>(p_expected_revision IS NULL)) THEN RAISE EXCEPTION 'Invalid company OAuth setup'; END IF;
 -- Organization mutex also serializes first connection, replacement and disconnect.
 PERFORM 1 FROM public.organizations WHERE id=p_organization_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Company email unavailable'; END IF;
 PERFORM private.require_company_email_actor(p_organization_id,p_actor_id);
 IF (SELECT count(*) FROM public.oauth_connections WHERE organization_id=p_organization_id AND provider=p_provider)>1 THEN RAISE EXCEPTION 'Ambiguous company email connection'; END IF;
 SELECT * INTO c FROM public.oauth_connections WHERE organization_id=p_organization_id AND provider=p_provider FOR UPDATE;
 IF c.id IS NOT NULL THEN
  IF c.id IS DISTINCT FROM p_connection_id OR c.oauth_revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'Connection changed; refresh before reconnecting'; END IF;
 ELSIF p_connection_id IS NOT NULL THEN RAISE EXCEPTION 'Connection unavailable'; END IF;
 display_provider:=CASE p_provider WHEN 'microsoft' THEN 'Microsoft' ELSE 'Google' END;
 IF c.integration_id IS NOT NULL THEN
  SELECT * INTO i FROM public.integrations WHERE id=c.integration_id AND organization_id=p_organization_id AND provider=display_provider AND integration_type='OAuth' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Company integration changed'; END IF;
 ELSE
  IF (SELECT count(*) FROM public.integrations WHERE organization_id=p_organization_id AND provider=display_provider AND integration_type='OAuth')>1 THEN RAISE EXCEPTION 'Ambiguous company email integration'; END IF;
  SELECT * INTO i FROM public.integrations WHERE organization_id=p_organization_id AND provider=display_provider AND integration_type='OAuth' FOR UPDATE;
  IF NOT FOUND THEN
   INSERT INTO public.integrations(organization_id,name,provider,integration_type,status,data_classification,created_by)
    VALUES(p_organization_id,CASE p_provider WHEN 'microsoft' THEN 'Microsoft 365 email' ELSE 'Google email' END,display_provider,'OAuth','Configuring','Internal',p_actor_id) RETURNING * INTO i;
  END IF;
 END IF;
 -- Server-owned confidential app credential, stored in encrypted Vault through existing wrappers.
 IF c.id IS NOT NULL THEN PERFORM private.clear_company_email_secrets(c.id); END IF;
 secret_id:=public.edge_store_secret(p_client_secret,p_provider||'-client-'||p_organization_id||'-'||gen_random_uuid(),'CerbTek company email application credential');
 IF secret_id IS NULL OR public.edge_read_secret(secret_id) IS DISTINCT FROM p_client_secret THEN RAISE EXCEPTION 'Credential storage unavailable'; END IF;
 UPDATE public.integrations SET status='Configuring' WHERE id=i.id RETURNING * INTO i;
 IF c.id IS NULL THEN
  INSERT INTO public.oauth_connections(organization_id,integration_id,provider,tenant_id,client_id,client_secret_id,scopes,status,created_by,oauth_connected_by)
   VALUES(p_organization_id,i.id,p_provider,p_tenant_id,p_client_id,secret_id,p_scopes,'Consent Required',p_actor_id,p_actor_id) RETURNING * INTO c;
 ELSE
  UPDATE public.oauth_connections SET integration_id=i.id,tenant_id=p_tenant_id,client_id=p_client_id,client_secret_id=secret_id,
   scopes=p_scopes,status='Consent Required',oauth_verified_version=0,access_secret_id=NULL,refresh_secret_id=NULL,external_account_id=NULL,
   external_account_name=NULL,external_account_email=NULL,oauth_granted_scopes=NULL,oauth_connected_by=p_actor_id,token_expires_at=NULL,last_error=NULL
   WHERE id=c.id RETURNING * INTO c;
 END IF;
 INSERT INTO private.company_email_oauth_setups(provider,organization_id,connection_id,integration_id,initiated_by,connection_revision,integration_revision,
  tenant_id,client_id,client_secret_id,scopes,intent,redirect_uri,code_verifier,browser_challenge)
 VALUES(p_provider,p_organization_id,c.id,i.id,p_actor_id,c.oauth_revision,i.oauth_revision,p_tenant_id,p_client_id,secret_id,p_scopes,p_intent,p_redirect_uri,p_code_verifier,p_browser_challenge) RETURNING * INTO s;
 RETURN jsonb_build_object('state',s.state,'provider',s.provider,'connection_id',s.connection_id,'tenant_id',s.tenant_id,'client_id',s.client_id,'scopes',s.scopes,'redirect_uri',s.redirect_uri);
END $$;

CREATE OR REPLACE FUNCTION private.assert_company_email_setup(s private.company_email_oauth_setups)
RETURNS void LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
DECLARE c public.oauth_connections;i public.integrations;
BEGIN
 PERFORM 1 FROM public.organizations WHERE id=s.organization_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Company email unavailable'; END IF;
 PERFORM private.require_company_email_actor(s.organization_id,s.initiated_by);
 SELECT * INTO c FROM public.oauth_connections WHERE id=s.connection_id AND organization_id=s.organization_id FOR UPDATE;
 IF NOT FOUND OR c.provider IS DISTINCT FROM s.provider OR c.status IS DISTINCT FROM 'Consent Required' OR c.oauth_revision IS DISTINCT FROM s.connection_revision
  OR c.integration_id IS DISTINCT FROM s.integration_id OR c.tenant_id IS DISTINCT FROM s.tenant_id OR c.client_id IS DISTINCT FROM s.client_id
  OR c.client_secret_id IS DISTINCT FROM s.client_secret_id OR c.scopes IS DISTINCT FROM s.scopes OR c.oauth_connected_by IS DISTINCT FROM s.initiated_by
  THEN RAISE EXCEPTION 'OAuth setup superseded'; END IF;
 SELECT * INTO i FROM public.integrations WHERE id=s.integration_id AND organization_id=s.organization_id FOR UPDATE;
 IF NOT FOUND OR i.provider IS DISTINCT FROM (CASE s.provider WHEN 'microsoft' THEN 'Microsoft' ELSE 'Google' END) OR i.integration_type IS DISTINCT FROM 'OAuth'
  OR i.status IS DISTINCT FROM 'Configuring' OR i.oauth_revision IS DISTINCT FROM s.integration_revision THEN RAISE EXCEPTION 'OAuth integration changed'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.claim_company_email_oauth_setup(p_state uuid,p_provider text)
RETURNS jsonb LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
DECLARE s private.company_email_oauth_setups;
BEGIN
 SELECT * INTO s FROM private.company_email_oauth_setups WHERE state=p_state AND provider=p_provider;
 IF NOT FOUND THEN RAISE EXCEPTION 'OAuth state expired or invalid'; END IF;
 PERFORM 1 FROM public.organizations WHERE id=s.organization_id FOR UPDATE;
 SELECT * INTO s FROM private.company_email_oauth_setups WHERE state=p_state AND provider=p_provider FOR UPDATE;
 IF NOT FOUND OR s.claimed_at IS NOT NULL OR s.finished_at IS NOT NULL OR s.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'OAuth state expired or invalid'; END IF;
 PERFORM private.assert_company_email_setup(s);
 UPDATE private.company_email_oauth_setups SET claimed_at=clock_timestamp() WHERE state=s.state;
 RETURN jsonb_build_object('state',s.state,'provider',s.provider,'connection_id',s.connection_id,'organization_id',s.organization_id,
  'tenant_id',s.tenant_id,'client_id',s.client_id,'client_secret_id',s.client_secret_id,'scopes',s.scopes,'redirect_uri',s.redirect_uri,'code_verifier',s.code_verifier);
END $$;
CREATE OR REPLACE FUNCTION public.stage_company_email_oauth_setup(p_state uuid,p_provider text,p_access_token text,p_refresh_token text,p_expires_at timestamptz,p_account_id text,p_account_name text,p_account_email text,p_granted_scopes text[],p_completion_challenge text)
RETURNS boolean LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
DECLARE s private.company_email_oauth_setups;access_id uuid;refresh_id uuid;
BEGIN
 SELECT * INTO s FROM private.company_email_oauth_setups WHERE state=p_state AND provider=p_provider;
 IF NOT FOUND THEN RAISE EXCEPTION 'OAuth state expired or invalid'; END IF;
 PERFORM 1 FROM public.organizations WHERE id=s.organization_id FOR UPDATE;
 SELECT * INTO s FROM private.company_email_oauth_setups WHERE state=p_state AND provider=p_provider FOR UPDATE;
 IF NOT FOUND OR s.claimed_at IS NULL OR s.staged_at IS NOT NULL OR s.finished_at IS NOT NULL OR s.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'OAuth state expired or invalid'; END IF;
 PERFORM private.assert_company_email_setup(s);
 IF coalesce(p_completion_challenge,'') !~ '^[a-f0-9]{64}$' OR coalesce(length(p_access_token),0)=0 OR coalesce(length(p_refresh_token),0)=0 OR p_expires_at IS NULL OR p_expires_at<=clock_timestamp() OR p_expires_at>clock_timestamp()+interval '24 hours'
  OR nullif(btrim(p_account_id),'') IS NULL OR length(p_account_id)>512 OR p_account_id ~ '[[:cntrl:]]'
  OR coalesce(p_account_email,'') !~ '^[^[:space:]@]+@[^[:space:]@]+$' OR length(p_account_email)>320
  OR NOT coalesce(private.email_grant_matches(s.provider,s.scopes,p_granted_scopes),false) THEN RAISE EXCEPTION 'Unverified email identity or grant'; END IF;
 access_id:=public.edge_store_secret(p_access_token,s.provider||'-access-'||s.organization_id||'-'||gen_random_uuid(),'Company email access token');
 refresh_id:=public.edge_store_secret(p_refresh_token,s.provider||'-refresh-'||s.organization_id||'-'||gen_random_uuid(),'Company email refresh token');
 IF access_id IS NULL OR refresh_id IS NULL OR public.edge_read_secret(access_id) IS DISTINCT FROM p_access_token OR public.edge_read_secret(refresh_id) IS DISTINCT FROM p_refresh_token THEN RAISE EXCEPTION 'Token storage failed'; END IF;
 -- Provider grant is encrypted but remains unusable pending independent browser proofs.
 UPDATE private.company_email_oauth_setups SET staged_at=clock_timestamp(),completion_challenge=p_completion_challenge,
  staged_access_id=access_id,staged_refresh_id=refresh_id,staged_expires_at=p_expires_at,staged_account_id=p_account_id,
  staged_account_name=left(p_account_name,512),staged_account_email=lower(p_account_email),
  staged_granted_scopes=ARRAY(SELECT DISTINCT x FROM unnest(p_granted_scopes) x ORDER BY x),code_verifier=''
  WHERE state=s.state;
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.finish_company_email_oauth_setup(p_organization_id uuid,p_actor_id uuid,p_state uuid,p_browser_challenge text,p_completion_challenge text)
RETURNS jsonb LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
DECLARE s private.company_email_oauth_setups;
BEGIN
 PERFORM 1 FROM public.organizations WHERE id=p_organization_id FOR UPDATE;
 SELECT * INTO s FROM private.company_email_oauth_setups WHERE state=p_state AND organization_id=p_organization_id AND initiated_by=p_actor_id FOR UPDATE;
 IF NOT FOUND OR s.claimed_at IS NULL OR s.staged_at IS NULL OR s.finished_at IS NOT NULL OR s.expires_at<=clock_timestamp()
  OR s.staged_at+interval '5 minutes'<=clock_timestamp() OR s.staged_expires_at<=clock_timestamp()
  OR coalesce(p_browser_challenge,'') !~ '^[a-f0-9]{64}$' OR coalesce(p_completion_challenge,'') !~ '^[a-f0-9]{64}$'
  OR s.browser_challenge IS DISTINCT FROM p_browser_challenge OR s.completion_challenge IS DISTINCT FROM p_completion_challenge
  OR s.staged_access_id IS NULL OR s.staged_refresh_id IS NULL THEN RAISE EXCEPTION 'Email browser confirmation unavailable'; END IF;
 PERFORM private.assert_company_email_setup(s);
 UPDATE public.oauth_connections SET status='Connected',oauth_verified_version=1,access_secret_id=s.staged_access_id,refresh_secret_id=s.staged_refresh_id,
  token_expires_at=s.staged_expires_at,external_account_id=s.staged_account_id,external_account_name=s.staged_account_name,external_account_email=s.staged_account_email,
  oauth_granted_scopes=s.staged_granted_scopes,last_connected_at=clock_timestamp(),last_error=NULL
  WHERE id=s.connection_id AND organization_id=s.organization_id;
 UPDATE public.integrations SET status='Connected',last_health_check_at=clock_timestamp(),authentication_method=CASE s.provider WHEN 'microsoft' THEN 'Microsoft OAuth 2.0 / PKCE' ELSE 'Google OAuth 2.0 / PKCE' END,scopes=array_to_string(s.scopes,' ')
  WHERE id=s.integration_id AND organization_id=s.organization_id;
 UPDATE private.company_email_oauth_setups SET finished_at=clock_timestamp(),outcome='Connected',code_verifier='',completion_challenge=NULL,
  staged_access_id=NULL,staged_refresh_id=NULL WHERE state=s.state;
 RETURN jsonb_build_object('state',s.state,'organization_id',s.organization_id,'provider',s.provider,'connection_id',s.connection_id);
END $$;
CREATE OR REPLACE FUNCTION public.fail_company_email_oauth_setup(p_state uuid,p_provider text)
RETURNS boolean LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
DECLARE s private.company_email_oauth_setups;
BEGIN
 SELECT * INTO s FROM private.company_email_oauth_setups WHERE state=p_state AND provider=p_provider;
 IF NOT FOUND THEN RAISE EXCEPTION 'OAuth state expired or invalid'; END IF;
 PERFORM 1 FROM public.organizations WHERE id=s.organization_id FOR UPDATE;
 SELECT * INTO s FROM private.company_email_oauth_setups WHERE state=p_state AND provider=p_provider FOR UPDATE;
 IF NOT FOUND OR s.claimed_at IS NULL OR s.finished_at IS NOT NULL THEN RETURN false; END IF;
 PERFORM 1 FROM public.organizations WHERE id=s.organization_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.oauth_connections WHERE id=s.connection_id AND organization_id=s.organization_id AND oauth_revision=s.connection_revision AND status='Consent Required') THEN PERFORM private.clear_company_email_secrets(s.connection_id); END IF;
 UPDATE public.oauth_connections SET status='Error',last_error='Email authorization failed. Start a new company connection setup.'
  WHERE id=s.connection_id AND organization_id=s.organization_id AND oauth_revision=s.connection_revision AND status='Consent Required';
 UPDATE private.company_email_oauth_setups SET finished_at=clock_timestamp(),outcome='Error',code_verifier='' WHERE state=s.state;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.validate_email_connection(p_connection_id uuid,p_organization_id uuid,p_expected_binding jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
DECLARE c public.oauth_connections;i public.integrations;
BEGIN
 PERFORM 1 FROM public.organizations WHERE id=p_organization_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Company email unavailable'; END IF;
 SELECT * INTO c FROM public.oauth_connections WHERE id=p_connection_id AND organization_id=p_organization_id FOR SHARE;
 IF NOT FOUND OR c.status IS DISTINCT FROM 'Connected' OR c.provider NOT IN ('microsoft','google') OR c.provider IS NULL OR c.oauth_verified_version IS DISTINCT FROM 1
  OR nullif(btrim(c.external_account_id),'') IS NULL OR c.access_secret_id IS NULL OR c.refresh_secret_id IS NULL OR c.client_secret_id IS NULL THEN RAISE EXCEPTION 'Email connection unavailable'; END IF;
 -- Legacy Microsoft connections keep their existing fingerprints; newly consented accounts
 -- additionally remain bound to a current company manager and provider-confirmed grant.
 IF c.provider='google' OR c.oauth_connected_by IS NOT NULL THEN
  PERFORM private.require_company_email_actor(c.organization_id,c.oauth_connected_by);
  IF coalesce(c.external_account_email,'') !~ '^[^[:space:]@]+@[^[:space:]@]+$' OR NOT coalesce(private.email_grant_matches(c.provider,c.scopes,c.oauth_granted_scopes),false) THEN RAISE EXCEPTION 'Email grant unavailable'; END IF;
 END IF;
 SELECT * INTO i FROM public.integrations WHERE id=c.integration_id AND organization_id=c.organization_id FOR SHARE;
 IF NOT FOUND OR i.provider IS DISTINCT FROM (CASE c.provider WHEN 'microsoft' THEN 'Microsoft' ELSE 'Google' END) OR i.integration_type IS DISTINCT FROM 'OAuth'
  OR i.status IS DISTINCT FROM 'Connected' OR i.scopes IS DISTINCT FROM array_to_string(c.scopes,' ') OR p_expected_binding IS DISTINCT FROM private.email_connection_binding(c,i) THEN RAISE EXCEPTION 'Email connection authority changed'; END IF;
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.commit_email_refresh(p_connection_id uuid,p_organization_id uuid,p_expected_refresh_revision uuid,p_expected_binding jsonb,p_access_token text,p_refresh_token text,p_expires_at timestamptz,p_account_id text,p_account_email text,p_granted_scopes text[])
RETURNS boolean LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
DECLARE c public.oauth_connections;
BEGIN
 PERFORM 1 FROM public.organizations WHERE id=p_organization_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Company email unavailable'; END IF;
 SELECT * INTO c FROM public.oauth_connections WHERE id=p_connection_id AND organization_id=p_organization_id FOR UPDATE;
 IF NOT FOUND OR c.oauth_refresh_revision IS DISTINCT FROM p_expected_refresh_revision THEN RAISE EXCEPTION 'Connection changed during refresh'; END IF;
 PERFORM public.validate_email_connection(p_connection_id,p_organization_id,p_expected_binding);
 IF coalesce(length(p_access_token),0)=0 OR (p_refresh_token IS NOT NULL AND length(p_refresh_token)=0) OR p_expires_at IS NULL OR p_expires_at<=clock_timestamp() OR p_expires_at>clock_timestamp()+interval '24 hours'
  OR p_account_id IS DISTINCT FROM c.external_account_id OR lower(p_account_email) IS DISTINCT FROM c.external_account_email
  OR NOT coalesce(private.email_grant_matches(c.provider,c.scopes,p_granted_scopes),false) THEN RAISE EXCEPTION 'Refresh identity or grant changed'; END IF;
 PERFORM public.edge_update_secret(c.access_secret_id,p_access_token);
 IF public.edge_read_secret(c.access_secret_id) IS DISTINCT FROM p_access_token THEN RAISE EXCEPTION 'Refresh credential storage failed'; END IF;
 IF p_refresh_token IS NOT NULL THEN
  PERFORM public.edge_update_secret(c.refresh_secret_id,p_refresh_token);
  IF public.edge_read_secret(c.refresh_secret_id) IS DISTINCT FROM p_refresh_token THEN RAISE EXCEPTION 'Refresh credential storage failed'; END IF;
 END IF;
 UPDATE public.oauth_connections SET token_expires_at=p_expires_at,last_error=NULL,oauth_refresh_revision=gen_random_uuid() WHERE id=c.id;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.disconnect_company_email_connection(p_organization_id uuid,p_actor_id uuid,p_connection_id uuid,p_expected_revision uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
DECLARE c public.oauth_connections;
BEGIN
 PERFORM 1 FROM public.organizations WHERE id=p_organization_id FOR UPDATE;
 PERFORM private.require_company_email_actor(p_organization_id,p_actor_id);
 SELECT * INTO c FROM public.oauth_connections WHERE id=p_connection_id AND organization_id=p_organization_id FOR UPDATE;
 IF NOT FOUND OR c.provider IS NULL OR c.provider NOT IN ('microsoft','google') OR c.oauth_revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'Connection changed; refresh before disconnecting'; END IF;
 PERFORM private.clear_company_email_secrets(c.id);
 UPDATE public.oauth_connections SET status='Disabled',oauth_verified_version=0,access_secret_id=NULL,refresh_secret_id=NULL,client_secret_id=NULL,
  external_account_id=NULL,external_account_name=NULL,external_account_email=NULL,oauth_granted_scopes=NULL,token_expires_at=NULL,last_error=NULL WHERE id=c.id;
 UPDATE public.integrations SET status='Disabled' WHERE id=c.integration_id AND organization_id=p_organization_id;
 RETURN true;
END $$;
-- Invoke at least every five minutes from a separately reviewed service/pg_cron job.
-- This source file does not install a scheduler; deployment must verify the job.
CREATE OR REPLACE FUNCTION public.cleanup_expired_company_email_oauth_setups(p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
DECLARE candidate record;s private.company_email_oauth_setups;secret_id uuid;removed integer:=0;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'Invalid cleanup limit'; END IF;
 FOR candidate IN SELECT state,organization_id FROM private.company_email_oauth_setups
  WHERE finished_at IS NULL AND (expires_at<=clock_timestamp() OR staged_at+interval '5 minutes'<=clock_timestamp()) ORDER BY expires_at LIMIT p_limit
 LOOP
  PERFORM 1 FROM public.organizations WHERE id=candidate.organization_id FOR UPDATE;
  SELECT * INTO s FROM private.company_email_oauth_setups WHERE state=candidate.state FOR UPDATE;
  IF s.finished_at IS NOT NULL OR NOT (s.expires_at<=clock_timestamp() OR coalesce(s.staged_at+interval '5 minutes'<=clock_timestamp(),false)) THEN CONTINUE; END IF;
  FOR secret_id IN SELECT DISTINCT x FROM unnest(ARRAY[s.client_secret_id,s.staged_access_id,s.staged_refresh_id]) x WHERE x IS NOT NULL LOOP
   PERFORM public.edge_update_secret(secret_id,'');
   IF coalesce(public.edge_read_secret(secret_id),'')<>'' THEN RAISE EXCEPTION 'Credential removal failed'; END IF;
  END LOOP;
  UPDATE public.oauth_connections SET status='Error',oauth_verified_version=0,client_secret_id=NULL,access_secret_id=NULL,refresh_secret_id=NULL,last_error='Email consent expired. Start a new connection setup.'
   WHERE id=s.connection_id AND organization_id=s.organization_id AND oauth_revision=s.connection_revision AND status='Consent Required';
  UPDATE private.company_email_oauth_setups SET finished_at=clock_timestamp(),outcome='Expired',code_verifier='',completion_challenge=NULL,staged_access_id=NULL,staged_refresh_id=NULL WHERE state=s.state;
  removed:=removed+1;
 END LOOP;
 RETURN removed;
END $$;
CREATE OR REPLACE FUNCTION private.company_email_connection_live(c public.oauth_connections,i public.integrations)
RETURNS boolean LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
BEGIN
 RETURN public.validate_email_connection(c.id,c.organization_id,private.email_connection_binding(c,i));
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE OR REPLACE FUNCTION public.list_company_email_connections(p_organization_id uuid,p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
DECLARE managed boolean;items jsonb;
BEGIN
 PERFORM 1 FROM public.organizations WHERE id=p_organization_id FOR UPDATE;
 PERFORM private.require_company_email_actor(p_organization_id,p_actor_id,false);
 SELECT role IN ('owner','admin','consultant') INTO managed FROM public.organization_members WHERE organization_id=p_organization_id AND user_id=p_actor_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'integration_id',c.integration_id,'provider',c.provider,'status',CASE WHEN c.status='Connected' AND NOT live.ok THEN 'Reconnect Required' ELSE c.status END,
  'account_email',c.external_account_email,'account_name',c.external_account_name,'connected_by',c.oauth_connected_by,'oauth_revision',c.oauth_revision,
  'scopes',coalesce(c.oauth_granted_scopes,'{}'::text[]),'capabilities',jsonb_build_object(
  'mail_read',live.ok AND coalesce(CASE c.provider WHEN 'microsoft' THEN 'Mail.Read'=ANY(c.scopes) ELSE 'https://www.googleapis.com/auth/gmail.readonly'=ANY(c.oauth_granted_scopes) END,false),
  'mail_send',live.ok AND coalesce(CASE c.provider WHEN 'microsoft' THEN 'Mail.Send'=ANY(c.scopes) ELSE 'https://www.googleapis.com/auth/gmail.send'=ANY(c.oauth_granted_scopes) END,false))) ORDER BY c.provider),'[]'::jsonb)
 INTO items FROM public.oauth_connections c LEFT JOIN public.integrations i ON i.id=c.integration_id AND i.organization_id=c.organization_id CROSS JOIN LATERAL (SELECT private.company_email_connection_live(c,i) ok) live WHERE c.organization_id=p_organization_id AND c.provider IN ('microsoft','google');
 RETURN jsonb_build_object('organization_id',p_organization_id,'can_manage',managed,'connections',items);
END $$;

REVOKE ALL ON FUNCTION private.clear_company_email_secrets(uuid),private.company_email_connection_live(public.oauth_connections,public.integrations),private.require_company_email_actor(uuid,uuid,boolean),private.email_requested_scopes(text,text),private.email_grant_matches(text,text[],text[]),private.email_connection_binding(public.oauth_connections,public.integrations),private.guard_company_email_authority(),private.assert_company_email_setup(private.company_email_oauth_setups) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.clear_company_email_secrets(uuid),private.company_email_connection_live(public.oauth_connections,public.integrations),private.require_company_email_actor(uuid,uuid,boolean),private.email_requested_scopes(text,text),private.email_grant_matches(text,text[],text[]),private.email_connection_binding(public.oauth_connections,public.integrations),private.guard_company_email_authority(),private.assert_company_email_setup(private.company_email_oauth_setups) TO service_role;
REVOKE ALL ON FUNCTION public.begin_company_email_oauth_setup(uuid,uuid,text,text,uuid,uuid,text,text,text,text[],text,text,text),public.claim_company_email_oauth_setup(uuid,text),public.stage_company_email_oauth_setup(uuid,text,text,text,timestamptz,text,text,text,text[],text),public.finish_company_email_oauth_setup(uuid,uuid,uuid,text,text),public.fail_company_email_oauth_setup(uuid,text),public.validate_email_connection(uuid,uuid,jsonb),public.commit_email_refresh(uuid,uuid,uuid,jsonb,text,text,timestamptz,text,text,text[]),public.disconnect_company_email_connection(uuid,uuid,uuid,uuid),public.list_company_email_connections(uuid,uuid),public.cleanup_expired_company_email_oauth_setups(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.begin_company_email_oauth_setup(uuid,uuid,text,text,uuid,uuid,text,text,text,text[],text,text,text),public.claim_company_email_oauth_setup(uuid,text),public.stage_company_email_oauth_setup(uuid,text,text,text,timestamptz,text,text,text,text[],text),public.finish_company_email_oauth_setup(uuid,uuid,uuid,text,text),public.fail_company_email_oauth_setup(uuid,text),public.validate_email_connection(uuid,uuid,jsonb),public.commit_email_refresh(uuid,uuid,uuid,jsonb,text,text,timestamptz,text,text,text[]),public.disconnect_company_email_connection(uuid,uuid,uuid,uuid),public.list_company_email_connections(uuid,uuid),public.cleanup_expired_company_email_oauth_setups(integer) TO service_role;
COMMIT;
