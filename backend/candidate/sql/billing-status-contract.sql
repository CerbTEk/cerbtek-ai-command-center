-- SOURCE-ONLY: install only after security review of the two narrow RPC grants.
-- Requires billing-foundation and the current Team & Roles authorization contract.
-- Read-only projection: no credentials, Stripe requests, pricing or activation.
BEGIN;
CREATE FUNCTION private.kairo_billing_status(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog' AS $$
DECLARE actor uuid:=auth.uid(); actor_role text; result jsonb;
BEGIN
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=actor AND coalesce(to_jsonb(u)->>'is_anonymous','false')='false') THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Billing status unavailable';
 END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='25001',MESSAGE='Billing status requires READ COMMITTED'; END IF;
 -- Use the same organization mutex as membership revocation, then re-read roles.
 PERFORM 1 FROM public.organizations WHERE id=p_organization_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Billing status unavailable'; END IF;
 SELECT role INTO actor_role FROM public.organization_members WHERE organization_id=p_organization_id AND user_id=actor;
 IF actor_role IS NULL OR actor_role NOT IN ('owner','admin') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Billing status unavailable'; END IF;
 -- All facts below are read in one statement snapshot. Only receipts with the
 -- exact company customer identity are counted; binding-wide holds stay private.
 WITH bindings AS (
  SELECT b.*,c.customer_id FROM kairo_billing.customer_bindings c JOIN kairo_billing.provider_bindings b ON b.id=c.binding_id WHERE c.organization_id=p_organization_id
 ), facts AS (
  SELECT source_kind,source_id,metric,unit,
   max(quantity) FILTER(WHERE state='measured') AS quantity,
   bool_or(state='measured') AS measured
  FROM kairo_billing.usage_events WHERE organization_id=p_organization_id
  GROUP BY source_kind,source_id,metric,unit
 ), usage AS (
  SELECT metric,unit,coalesce(sum(quantity),0)::text AS measured_units,count(*) FILTER(WHERE NOT measured) AS unresolved_sources
  FROM facts GROUP BY metric,unit
 )
 SELECT jsonb_build_object(
  'contract','billing_status_v1','authorized',true,'organization_id',p_organization_id,'actor_id',actor,'actor_role',actor_role,
  'integration_state',CASE WHEN EXISTS(SELECT 1 FROM bindings) THEN 'bound_inactive' ELSE 'not_configured' END,
  'commercial_actions_enabled',false,'credential_state','not_verified','webhook_state','not_verified',
  'provider',CASE WHEN (SELECT count(*) FROM bindings)=1 THEN (SELECT jsonb_build_object('account_id',account_id,'livemode',livemode,'api_version',api_version) FROM bindings) ELSE NULL END,
  'binding_count',(SELECT count(*) FROM bindings),'customer_bound',EXISTS(SELECT 1 FROM bindings),
  'subscription_count',(SELECT count(*) FROM kairo_billing.subscription_projections WHERE organization_id=p_organization_id),
  'unresolved_receipts',(SELECT count(*) FROM kairo_billing.provider_receipts r JOIN bindings b ON b.id=r.binding_id
    WHERE r.kind<>'ignored' AND r.customer_id=b.customer_id
    AND NOT EXISTS(SELECT 1 FROM kairo_billing.receipt_links l WHERE l.binding_id=r.binding_id AND l.event_id=r.event_id)
    AND NOT EXISTS(SELECT 1 FROM kairo_billing.receipt_dispositions d WHERE d.binding_id=r.binding_id AND d.event_id=r.event_id)),
  'policy_versions',(SELECT count(*) FROM kairo_billing.policy_versions p WHERE p.binding_id IN (SELECT id FROM bindings)),
  'usage_scope','lifetime_observations_only','customer_charge',NULL,'provider_spend',NULL,
  'usage',coalesce((SELECT jsonb_agg(jsonb_build_object('metric',metric,'unit',unit,'measured_units',measured_units,'unresolved_sources',unresolved_sources) ORDER BY metric) FROM usage),'[]'::jsonb)
 ) INTO result;
 RETURN result;
END $$;
CREATE FUNCTION public.kairo_billing_status(p_organization_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='pg_catalog' AS $$ SELECT private.kairo_billing_status(p_organization_id); $$;
REVOKE ALL ON FUNCTION private.kairo_billing_status(uuid),public.kairo_billing_status(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION private.kairo_billing_status(uuid),public.kairo_billing_status(uuid) TO authenticated;
COMMIT;
