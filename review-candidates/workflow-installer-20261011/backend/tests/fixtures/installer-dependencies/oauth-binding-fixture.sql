-- Synthetic columns; no credentials. The binding function below is the existing source snapshot.
ALTER TABLE public.oauth_connections ADD COLUMN tenant_id text, ADD COLUMN client_id text, ADD COLUMN access_secret_id uuid, ADD COLUMN refresh_secret_id uuid, ADD COLUMN client_secret_id uuid;
CREATE OR REPLACE FUNCTION private.microsoft_connection_binding(c public.oauth_connections, i public.integrations)
RETURNS jsonb LANGUAGE sql STABLE SET search_path='pg_catalog' AS $$
 SELECT jsonb_build_object('id',c.id,'organization_id',c.organization_id,'integration_id',c.integration_id,'provider',c.provider,
   'tenant_id',c.tenant_id,'client_id',c.client_id,'external_account_id',c.external_account_id,
   'access_secret_id',c.access_secret_id,'refresh_secret_id',c.refresh_secret_id,'client_secret_id',c.client_secret_id,
   'oauth_verified_version',c.oauth_verified_version,'oauth_revision',c.oauth_revision,
   'scopes',(SELECT coalesce(jsonb_agg(s ORDER BY s),'[]'::jsonb) FROM (SELECT DISTINCT unnest(c.scopes) s) z),
   'integration_revision',i.oauth_revision);
$$;
