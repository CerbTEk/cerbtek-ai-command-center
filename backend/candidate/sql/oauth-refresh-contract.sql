-- Requires oauth-setup-contract.sql. Local candidate only.
BEGIN;
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
COMMIT;
