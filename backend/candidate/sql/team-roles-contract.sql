-- LOCAL CANDIDATE ONLY. Requires separately reviewed security/grant deployment approval.
-- Exact company roles are retained. No staff role, business-feature policy, user,
-- membership, invitation, or credential is created by installing this contract.
-- Install together with the candidate organization-invite Edge replacement.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
CREATE SCHEMA IF NOT EXISTS private;

-- All application membership/invitation writes must pass the authenticated RPCs.
-- Remove write policies as well as grants, including TRUNCATE and legacy service
-- writes. Existing organization bootstrap is SECURITY DEFINER and remains intact.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.organization_members, public.organization_invitations
  FROM PUBLIC, anon, authenticated, service_role;
-- RLS does not guard TRUNCATE. Browser roles must not erase transactional audit history.
-- Trusted service-role audit maintenance access is deliberately preserved.
REVOKE TRUNCATE ON public.audit_events FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "authorized managers add memberships" ON public.organization_members;
DROP POLICY IF EXISTS "authorized managers update memberships" ON public.organization_members;
DROP POLICY IF EXISTS "authorized managers delete memberships" ON public.organization_members;
DROP POLICY IF EXISTS "admins revoke invitations" ON public.organization_invitations;

CREATE OR REPLACE FUNCTION private.kairo_lock_team_org(p_organization_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id=auth.uid()) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Sign in to manage team access';
  END IF;
  -- A fresh snapshot after waiting for the organization mutex is mandatory.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='25001', MESSAGE='Team access requires READ COMMITTED';
  END IF;
  PERFORM 1 FROM public.organizations WHERE id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Company access unavailable'; END IF;
END $$;

CREATE OR REPLACE FUNCTION private.kairo_team_manager(p_organization_id uuid)
RETURNS text LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
DECLARE actor_role text;
BEGIN
  PERFORM private.kairo_lock_team_org(p_organization_id);
  SELECT role INTO actor_role FROM public.organization_members
    WHERE organization_id=p_organization_id AND user_id=auth.uid() FOR UPDATE;
  IF actor_role IS NULL OR actor_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Only company owners and admins can manage team access';
  END IF;
  RETURN actor_role;
END $$;

-- Defense in depth: this is SECURITY INVOKER, so legacy service-key writes and
-- browser writes are rejected even if an old grant/policy is accidentally restored.
-- Only the separately ACL-controlled definer RPCs and existing bootstrap run as
-- the database owner. A custom GUC is deliberately not used as a trusted bypass.
CREATE OR REPLACE FUNCTION private.kairo_guard_membership()
RETURNS trigger LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
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
END $$;
DROP TRIGGER IF EXISTS kairo_guard_membership ON public.organization_members;
CREATE TRIGGER kairo_guard_membership BEFORE INSERT OR UPDATE OR DELETE
  ON public.organization_members FOR EACH ROW EXECUTE FUNCTION private.kairo_guard_membership();

CREATE OR REPLACE FUNCTION private.kairo_guard_invitation()
RETURNS trigger LANGUAGE plpgsql SET search_path='pg_catalog' AS $$
BEGIN
  IF current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Use the team invitation RPC';
  END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.organization_id,NEW.email,NEW.role,NEW.token_hash,NEW.invited_by,NEW.expires_at,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.email,OLD.role,OLD.token_hash,OLD.invited_by,OLD.expires_at,OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invitation authority is immutable; create a new invitation';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS kairo_guard_invitation ON public.organization_invitations;
CREATE TRIGGER kairo_guard_invitation BEFORE INSERT OR UPDATE OR DELETE
  ON public.organization_invitations FOR EACH ROW EXECUTE FUNCTION private.kairo_guard_invitation();

-- Read-only readiness handshake: published atomically with the secured contract.
CREATE OR REPLACE FUNCTION private.kairo_team_access_status(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog' AS $$
DECLARE actor_role text;
BEGIN
  actor_role:=private.kairo_team_manager(p_organization_id);
  RETURN jsonb_build_object('ok',true,'version',1,'organization_id',p_organization_id,'actor_role',actor_role);
END $$;

CREATE OR REPLACE FUNCTION private.kairo_set_member_role(p_organization_id uuid,p_user_id uuid,p_role text,p_expected_role text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog' AS $$
DECLARE actor_role text; target_role text;
BEGIN
  actor_role:=private.kairo_team_manager(p_organization_id);
  IF p_user_id=auth.uid() THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='You cannot change your own role'; END IF;
  IF p_role IS NULL OR p_role NOT IN ('owner','admin','consultant','member','viewer')
    OR p_expected_role IS NULL OR p_expected_role NOT IN ('owner','admin','consultant','member','viewer') THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid company role';
  END IF;
  SELECT role INTO target_role FROM public.organization_members
    WHERE organization_id=p_organization_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Team member no longer exists'; END IF;
  IF actor_role='admin' AND (target_role NOT IN ('member','viewer') OR p_role NOT IN ('member','viewer')) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Admins can only manage member and viewer roles';
  END IF;
  IF target_role IS DISTINCT FROM p_expected_role THEN
    RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='This role changed. Refresh and try again';
  END IF;
  IF target_role=p_role THEN
    RETURN jsonb_build_object('ok',true,'organization_id',p_organization_id,'user_id',p_user_id,'role',target_role,'changed',false);
  END IF;
  UPDATE public.organization_members SET role=p_role WHERE organization_id=p_organization_id AND user_id=p_user_id;
  -- Prevent resurrection of authority if an inviter is demoted and later re-added.
  UPDATE public.organization_invitations SET status='Revoked'
    WHERE organization_id=p_organization_id AND invited_by=p_user_id AND status='Pending'
      AND (p_role NOT IN ('owner','admin') OR (p_role='admin' AND role NOT IN ('member','viewer')));
  INSERT INTO public.audit_events(organization_id,actor_user_id,event_type,entity_type,entity_id,summary,metadata)
    VALUES(p_organization_id,auth.uid(),'member_role_changed','organization_member',p_user_id,
      'Company member role changed',jsonb_build_object('previous_role',target_role,'role',p_role));
  RETURN jsonb_build_object('ok',true,'organization_id',p_organization_id,'user_id',p_user_id,'role',p_role,'previous_role',target_role,'changed',true);
END $$;

CREATE OR REPLACE FUNCTION private.kairo_remove_member(p_organization_id uuid,p_user_id uuid,p_expected_role text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog' AS $$
DECLARE actor_role text; target_role text;
BEGIN
  actor_role:=private.kairo_team_manager(p_organization_id);
  IF p_user_id=auth.uid() THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='You cannot remove your own membership'; END IF;
  SELECT role INTO target_role FROM public.organization_members
    WHERE organization_id=p_organization_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Team member no longer exists'; END IF;
  IF actor_role='admin' AND target_role NOT IN ('member','viewer') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Admins can only remove members and viewers';
  END IF;
  IF p_expected_role IS NULL OR target_role IS DISTINCT FROM p_expected_role THEN
    RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='This role changed. Refresh and try again';
  END IF;
  DELETE FROM public.organization_members WHERE organization_id=p_organization_id AND user_id=p_user_id;
  UPDATE public.organization_invitations SET status='Revoked'
    WHERE organization_id=p_organization_id AND status='Pending'
      AND (invited_by=p_user_id OR lower(email)=(SELECT lower(email) FROM auth.users WHERE id=p_user_id));
  INSERT INTO public.audit_events(organization_id,actor_user_id,event_type,entity_type,entity_id,summary,metadata)
    VALUES(p_organization_id,auth.uid(),'member_removed','organization_member',p_user_id,
      'Company member removed',jsonb_build_object('previous_role',target_role));
  RETURN jsonb_build_object('ok',true,'organization_id',p_organization_id,'user_id',p_user_id,'role',target_role,'removed',true);
END $$;

CREATE OR REPLACE FUNCTION private.kairo_create_invitation(p_organization_id uuid,p_email text,p_role text,p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog' AS $$
DECLARE actor_role text; normalized_email text:=lower(btrim(p_email)); invitation public.organization_invitations;
BEGIN
  actor_role:=private.kairo_team_manager(p_organization_id);
  IF p_role IS NULL OR p_role NOT IN ('admin','consultant','member','viewer')
    OR normalized_email IS NULL OR length(normalized_email)>254
    OR normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid invitation';
  END IF;
  IF actor_role='admin' AND p_role NOT IN ('member','viewer') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Admins can only invite members and viewers';
  END IF;
  IF EXISTS (SELECT 1 FROM public.organization_members m JOIN auth.users u ON u.id=m.user_id
    WHERE m.organization_id=p_organization_id AND lower(u.email)=normalized_email) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='This person is already a team member; change their role in Team & Roles';
  END IF;
  IF actor_role='admin' AND EXISTS (SELECT 1 FROM public.organization_invitations
    WHERE organization_id=p_organization_id AND lower(email)=normalized_email AND status='Pending' AND role NOT IN ('member','viewer')) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Only an owner can replace this invitation';
  END IF;
  UPDATE public.organization_invitations SET status='Revoked'
    WHERE organization_id=p_organization_id AND lower(email)=normalized_email AND status='Pending';
  INSERT INTO public.organization_invitations(organization_id,email,role,token_hash,invited_by)
    VALUES(p_organization_id,normalized_email,p_role,p_token_hash,auth.uid()) RETURNING * INTO invitation;
  INSERT INTO public.audit_events(organization_id,actor_user_id,event_type,entity_type,entity_id,summary,metadata)
    VALUES(p_organization_id,auth.uid(),'member_invited','organization_invitation',invitation.id,
      'Company invitation created',jsonb_build_object('role',p_role));
  RETURN jsonb_build_object('organization_id',p_organization_id,'id',invitation.id,'email',invitation.email,'role',invitation.role,'status',invitation.status,'expires_at',invitation.expires_at);
END $$;

CREATE OR REPLACE FUNCTION private.kairo_revoke_invitation(p_organization_id uuid,p_invitation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog' AS $$
DECLARE actor_role text; invitation public.organization_invitations;
BEGIN
  actor_role:=private.kairo_team_manager(p_organization_id);
  SELECT * INTO invitation FROM public.organization_invitations
    WHERE id=p_invitation_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Invitation unavailable'; END IF;
  IF actor_role='admin' AND invitation.role NOT IN ('member','viewer') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Admins can only revoke member and viewer invitations';
  END IF;
  IF invitation.status <> 'Pending' THEN
    RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='This invitation changed. Refresh and try again';
  END IF;
  UPDATE public.organization_invitations SET status='Revoked' WHERE id=invitation.id;
  INSERT INTO public.audit_events(organization_id,actor_user_id,event_type,entity_type,entity_id,summary,metadata)
    VALUES(p_organization_id,auth.uid(),'member_invitation_revoked','organization_invitation',invitation.id,
      'Company invitation revoked',jsonb_build_object('role',invitation.role));
  RETURN jsonb_build_object('ok',true,'organization_id',p_organization_id,'id',invitation.id,'status','Revoked');
END $$;

CREATE OR REPLACE FUNCTION private.kairo_accept_invitation(p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog' AS $$
DECLARE org_id uuid; invitation public.organization_invitations; inviter_role text;
  member_role text; current_email text; email_confirmed timestamptz; existing_member boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Sign in to accept an invitation'; END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid invitation token';
  END IF;
  -- Lookup only. No authority decision or invitation lock precedes the org lock.
  SELECT organization_id INTO org_id FROM public.organization_invitations WHERE token_hash=p_token_hash;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Invite is invalid or no longer available'; END IF;
  PERFORM private.kairo_lock_team_org(org_id);
  SELECT * INTO invitation FROM public.organization_invitations
    WHERE token_hash=p_token_hash AND organization_id=org_id FOR UPDATE;
  IF NOT FOUND OR invitation.status <> 'Pending' THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Invite is invalid or no longer available';
  END IF;
  IF invitation.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invite has expired';
  END IF;
  SELECT lower(email),email_confirmed_at INTO current_email,email_confirmed FROM auth.users WHERE id=auth.uid() FOR SHARE;
  IF current_email IS NULL OR email_confirmed IS NULL OR current_email <> lower(invitation.email) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Sign in with the verified email address this invitation was sent to';
  END IF;
  SELECT role INTO inviter_role FROM public.organization_members
    WHERE organization_id=org_id AND user_id=invitation.invited_by FOR UPDATE;
  IF inviter_role IS NULL OR inviter_role NOT IN ('owner','admin')
    OR (inviter_role='admin' AND invitation.role NOT IN ('member','viewer')) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Invitation author no longer has permission; request a new invitation';
  END IF;
  SELECT role INTO member_role FROM public.organization_members
    WHERE organization_id=org_id AND user_id=auth.uid() FOR UPDATE;
  existing_member:=FOUND;
  IF NOT existing_member THEN
    INSERT INTO public.organization_members(organization_id,user_id,role) VALUES(org_id,auth.uid(),invitation.role);
    member_role:=invitation.role;
  END IF;
  -- Never UPSERT a role. A prior/duplicate invitation cannot downgrade an owner,
  -- re-promote an existing member, or overwrite any intervening role decision.
  UPDATE public.organization_invitations SET status='Accepted',accepted_by=auth.uid(),accepted_at=clock_timestamp()
    WHERE id=invitation.id;
  INSERT INTO public.audit_events(organization_id,actor_user_id,event_type,entity_type,entity_id,summary,metadata)
    VALUES(org_id,auth.uid(),'member_invitation_accepted','organization_invitation',invitation.id,
      'Company invitation accepted',jsonb_build_object('role',member_role,'invited_role',invitation.role,'existing_member',existing_member));
  RETURN jsonb_build_object('organization_id',org_id,'user_id',auth.uid(),'role',member_role,'existing_member',existing_member);
END $$;

-- Public Data API endpoints are thin SECURITY INVOKER wrappers. Privilege-bearing
-- functions live in the non-exposed private schema and check auth.uid themselves.
CREATE OR REPLACE FUNCTION public.kairo_team_access_status(p_organization_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='pg_catalog' AS $$ SELECT private.kairo_team_access_status(p_organization_id); $$;
CREATE OR REPLACE FUNCTION public.kairo_set_member_role(p_organization_id uuid,p_user_id uuid,p_role text,p_expected_role text)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='pg_catalog' AS $$ SELECT private.kairo_set_member_role(p_organization_id,p_user_id,p_role,p_expected_role); $$;
CREATE OR REPLACE FUNCTION public.kairo_remove_member(p_organization_id uuid,p_user_id uuid,p_expected_role text)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='pg_catalog' AS $$ SELECT private.kairo_remove_member(p_organization_id,p_user_id,p_expected_role); $$;
CREATE OR REPLACE FUNCTION public.kairo_create_invitation(p_organization_id uuid,p_email text,p_role text,p_token_hash text)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='pg_catalog' AS $$ SELECT private.kairo_create_invitation(p_organization_id,p_email,p_role,p_token_hash); $$;
CREATE OR REPLACE FUNCTION public.kairo_revoke_invitation(p_organization_id uuid,p_invitation_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='pg_catalog' AS $$ SELECT private.kairo_revoke_invitation(p_organization_id,p_invitation_id); $$;
CREATE OR REPLACE FUNCTION public.kairo_accept_invitation(p_token_hash text)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='pg_catalog' AS $$ SELECT private.kairo_accept_invitation(p_token_hash); $$;

REVOKE ALL ON FUNCTION private.kairo_lock_team_org(uuid),private.kairo_team_manager(uuid),private.kairo_guard_membership(),private.kairo_guard_invitation()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION
  private.kairo_team_access_status(uuid),public.kairo_team_access_status(uuid),
  private.kairo_set_member_role(uuid,uuid,text,text),private.kairo_remove_member(uuid,uuid,text),
  private.kairo_create_invitation(uuid,text,text,text),private.kairo_revoke_invitation(uuid,uuid),private.kairo_accept_invitation(text),
  public.kairo_set_member_role(uuid,uuid,text,text),public.kairo_remove_member(uuid,uuid,text),
  public.kairo_create_invitation(uuid,text,text,text),public.kairo_revoke_invitation(uuid,uuid),public.kairo_accept_invitation(text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION
  private.kairo_team_access_status(uuid),public.kairo_team_access_status(uuid),
  private.kairo_set_member_role(uuid,uuid,text,text),private.kairo_remove_member(uuid,uuid,text),
  private.kairo_create_invitation(uuid,text,text,text),private.kairo_revoke_invitation(uuid,uuid),private.kairo_accept_invitation(text),
  public.kairo_set_member_role(uuid,uuid,text,text),public.kairo_remove_member(uuid,uuid,text),
  public.kairo_create_invitation(uuid,text,text,text),public.kairo_revoke_invitation(uuid,uuid),public.kairo_accept_invitation(text)
  TO authenticated;
COMMIT;
