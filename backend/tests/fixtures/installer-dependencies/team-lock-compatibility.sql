-- Verified live membership security contract, captured 2026-10-11.
-- Synthetic fixture data only; this file is not deployment SQL.
ALTER TABLE public.organization_members ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE OR REPLACE FUNCTION private.kairo_guard_membership()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE org_id uuid;
BEGIN
  IF current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Use the team access RPC';
  END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.organization_id,NEW.user_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.organization_id,OLD.user_id,OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Membership identity is immutable';
  END IF;
  org_id:=CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  PERFORM 1 FROM public.organizations WHERE id=org_id FOR UPDATE;
  IF NOT FOUND THEN
    -- A parent company deletion legitimately cascades its entire membership set.
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='Company does not exist';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='25001', MESSAGE='Team access requires READ COMMITTED';
  END IF;
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.role='owner'
    AND (TG_OP='DELETE' OR NEW.role IS DISTINCT FROM 'owner')
    AND NOT EXISTS (SELECT 1 FROM public.organization_members
      WHERE organization_id=org_id AND role='owner' AND user_id<>OLD.user_id) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A company must retain at least one owner';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $function$;

CREATE TRIGGER kairo_guard_membership BEFORE INSERT OR UPDATE OR DELETE ON public.organization_members FOR EACH ROW EXECUTE FUNCTION private.kairo_guard_membership();
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.organization_members FROM service_role;
GRANT SELECT ON public.organization_members TO service_role;
