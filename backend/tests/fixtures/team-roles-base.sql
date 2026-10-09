-- Synthetic local schema only. All identities and addresses are fictional.
CREATE SCHEMA auth;
CREATE SCHEMA private;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid; $$;
CREATE TABLE public.organizations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,created_by uuid NOT NULL REFERENCES auth.users ON DELETE RESTRICT);
CREATE TABLE public.organization_members(
 organization_id uuid NOT NULL REFERENCES public.organizations ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
 role text NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','consultant','member','viewer')),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,user_id));
CREATE TABLE public.organization_invitations(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES public.organizations ON DELETE CASCADE,
 email text NOT NULL,role text NOT NULL CHECK(role IN ('admin','consultant','member','viewer')),token_hash text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Accepted','Revoked','Expired')),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',invited_by uuid NOT NULL REFERENCES auth.users ON DELETE RESTRICT,
 accepted_by uuid REFERENCES auth.users ON DELETE SET NULL,accepted_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.audit_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,actor_user_id uuid,event_type text NOT NULL,entity_type text,entity_id uuid,summary text NOT NULL,metadata jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.staff_accounts(user_id uuid PRIMARY KEY,role text,active boolean);
CREATE FUNCTION private.bootstrap_organization_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog' AS $$ BEGIN INSERT INTO public.organization_members(organization_id,user_id,role) VALUES(NEW.id,NEW.created_by,'owner');RETURN NEW; END $$;
CREATE TRIGGER bootstrap_organization_owner AFTER INSERT ON public.organizations FOR EACH ROW EXECUTE FUNCTION private.bootstrap_organization_owner();
CREATE FUNCTION private.can_manage_org(org_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='pg_catalog' AS $$ SELECT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=org_id AND user_id=auth.uid() AND role IN ('owner','admin','consultant')) OR EXISTS(SELECT 1 FROM public.staff_accounts WHERE user_id=auth.uid() AND active AND role IN ('platform_admin','consultant')); $$;
CREATE FUNCTION private.can_access_org(org_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='pg_catalog' AS $$ SELECT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=org_id AND user_id=auth.uid()) OR EXISTS(SELECT 1 FROM public.staff_accounts WHERE user_id=auth.uid() AND active); $$;
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authorized users read memberships" ON public.organization_members FOR SELECT TO authenticated USING(private.can_access_org(organization_id));
CREATE POLICY "authorized managers add memberships" ON public.organization_members FOR INSERT TO authenticated WITH CHECK(private.can_manage_org(organization_id));
CREATE POLICY "authorized managers update memberships" ON public.organization_members FOR UPDATE TO authenticated USING(private.can_manage_org(organization_id)) WITH CHECK(private.can_manage_org(organization_id));
CREATE POLICY "authorized managers delete memberships" ON public.organization_members FOR DELETE TO authenticated USING(private.can_manage_org(organization_id));
CREATE POLICY "admins read invitations" ON public.organization_invitations FOR SELECT TO authenticated USING(private.can_manage_org(organization_id));
CREATE POLICY "admins revoke invitations" ON public.organization_invitations FOR UPDATE TO authenticated USING(private.can_manage_org(organization_id)) WITH CHECK(private.can_manage_org(organization_id));
GRANT USAGE ON SCHEMA public,private,auth TO anon,authenticated,service_role;
GRANT ALL ON public.organization_members,public.organization_invitations TO anon,authenticated,service_role;

-- Synthetic reproduction of the legacy audit ACL; RLS cannot protect TRUNCATE.
GRANT ALL ON public.audit_events TO anon,authenticated,service_role;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON public.audit_events FOR SELECT TO authenticated USING(private.can_access_org(organization_id));
