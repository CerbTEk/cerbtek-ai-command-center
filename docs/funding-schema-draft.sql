-- DRAFT ONLY. Never applied to a hosted project by this change.
-- Company-private pipeline, NOT a client-tenant resource.
-- Requires the existing private.is_cerbtek_staff(text[]) helper and staff_accounts.
-- Review and generate a proper migration with the Supabase CLI before release.
BEGIN;
CREATE TABLE public.cerbtek_funding_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venture text NOT NULL CHECK (venture IN ('CerbTek AI Enablement','ForgeCIF Career Intelligence','Company-wide')),
  opportunity text NOT NULL CHECK (length(trim(opportunity)) BETWEEN 1 AND 180),
  provider text NOT NULL CHECK (length(trim(provider)) BETWEEN 1 AND 180),
  category text NOT NULL CHECK (category IN ('Grant','Accelerator','Equity','Cloud credits','Competition','Other')),
  official_url text NOT NULL CHECK (length(official_url) <= 2048 AND official_url ~ '^https://[^/@[:space:]]+([/?#][^[:space:]]*)?$' AND official_url !~ '[<>]'),
  fit text NOT NULL DEFAULT '' CHECK (length(fit) <= 2000),
  eligibility text NOT NULL DEFAULT '' CHECK (length(eligibility) <= 4000),
  readiness text NOT NULL DEFAULT 'Unreviewed' CHECK (readiness IN ('Unreviewed','Potential fit','Needs evidence','Ready','Not eligible')),
  deadline_state text NOT NULL DEFAULT 'Unannounced' CHECK (deadline_state IN ('Unannounced','Rolling','Fixed','Closed')),
  deadline_date date,
  deadline_note text NOT NULL DEFAULT '' CHECK (length(deadline_note) <= 1000),
  amount_terms text NOT NULL DEFAULT '' CHECK (length(amount_terms) <= 2000),
  status text NOT NULL DEFAULT 'Researching' CHECK (status IN ('Researching','Eligibility review','Preparing','Submitted','In conversation','Awarded','Declined','Closed')),
  next_action text NOT NULL DEFAULT '' CHECK (length(next_action) <= 2000),
  owner text NOT NULL DEFAULT '' CHECK (length(owner) <= 180),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 8000),
  last_verified date,
  version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  updated_by uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (deadline_state <> 'Fixed' OR deadline_date IS NOT NULL),
  CHECK (deadline_state IN ('Fixed','Closed') OR deadline_date IS NULL)
);
ALTER TABLE public.cerbtek_funding_opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cerbtek_funding_opportunities FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.cerbtek_funding_opportunities FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cerbtek_funding_opportunities TO authenticated;
GRANT INSERT (id,venture,opportunity,provider,category,official_url,fit,eligibility,readiness,deadline_state,deadline_date,deadline_note,amount_terms,status,next_action,owner,notes,last_verified)
  ON public.cerbtek_funding_opportunities TO authenticated;
GRANT UPDATE (venture,opportunity,provider,category,official_url,fit,eligibility,readiness,deadline_state,deadline_date,deadline_note,amount_terms,status,next_action,owner,notes,last_verified)
  ON public.cerbtek_funding_opportunities TO authenticated;
CREATE POLICY funding_admin_select ON public.cerbtek_funding_opportunities FOR SELECT TO authenticated
  USING ((SELECT private.is_cerbtek_staff(ARRAY['platform_admin'])));
CREATE POLICY funding_admin_insert ON public.cerbtek_funding_opportunities FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.is_cerbtek_staff(ARRAY['platform_admin'])) AND created_by = (SELECT auth.uid()) AND updated_by = (SELECT auth.uid()));
CREATE POLICY funding_admin_update ON public.cerbtek_funding_opportunities FOR UPDATE TO authenticated
  USING ((SELECT private.is_cerbtek_staff(ARRAY['platform_admin'])))
  WITH CHECK ((SELECT private.is_cerbtek_staff(ARRAY['platform_admin'])) AND updated_by = (SELECT auth.uid()));
-- No DELETE grant or policy. Use Closed/Declined status to retain research history.
CREATE FUNCTION private.stamp_funding_opportunity() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authenticated actor required'; END IF;
  IF NEW.last_verified > CURRENT_DATE THEN RAISE EXCEPTION 'Last verified cannot be in the future'; END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.version := 1; NEW.created_at := clock_timestamp(); NEW.created_by := auth.uid();
  ELSE
    NEW.id := OLD.id; NEW.created_by := OLD.created_by; NEW.created_at := OLD.created_at;
    NEW.version := OLD.version + 1;
  END IF;
  NEW.updated_by := auth.uid(); NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.stamp_funding_opportunity() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER stamp_funding_opportunity BEFORE INSERT OR UPDATE ON public.cerbtek_funding_opportunities FOR EACH ROW EXECUTE FUNCTION private.stamp_funding_opportunity();
CREATE INDEX cerbtek_funding_updated_idx ON public.cerbtek_funding_opportunities (updated_at DESC);
COMMENT ON TABLE public.cerbtek_funding_opportunities IS 'CerbTek LLC private fundraising research. Active platform admins only. Never expose through public pages, tenant exports, or bundled seed data.';
COMMIT;
