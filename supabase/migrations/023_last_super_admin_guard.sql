-- ====================================================================
-- 023  The last ACTIVE super_admin can never be removed (database-level invariant)   (ARC-01)
--
-- Edge Functions already refuse to demote / deactivate / suspend / delete the last active super_admin, but
-- two concurrent requests (each seeing "another one is still active") could both pass those checks and
-- leave the system with none. This migration enforces the rule inside the database, atomically:
--
--   * BEFORE triggers on profiles (status leaves 'active', or the row is deleted), user_roles (a super_admin
--     row is deleted or re-pointed) and roles (the super_admin role is deactivated, renamed or deleted) call
--     guard_last_super_admin();
--   * the function takes ONE transaction-level advisory lock, so competing changes are serialized, and then
--     counts the other active super_admins with a fresh snapshot (READ COMMITTED). The second transaction
--     waits for the first to commit and then sees the committed result, so it is refused.
--   * deleting an auth user cascades to profiles and user_roles, so the delete path is covered too.
--   * replace_user_role() is redefined so that re-assigning super_admin never deletes the super_admin row.
--
-- Scope and limits: applies to every writer including the service role. A superuser can bypass triggers with
-- `SET session_replication_role = replica` (fixtures, emergency repair) and TRUNCATE is not guarded.
-- It assumes the default READ COMMITTED isolation (what PostgREST and Edge Functions use).
-- Nothing is changed when no super_admin exists yet (bootstrap by setup-admin still works: INSERTs are not guarded).
--
-- Additive: one function, three triggers, replaces replace_user_role(). No data change.
-- Apply AFTER 020, as a single script on its own (do NOT use `supabase db push` on live). Safe to run again.
-- Rollback: DROP TRIGGER guard_last_super_admin ON public.profiles / public.user_roles / public.roles;
--           DROP FUNCTION public.guard_last_super_admin(); then re-run the function body from 020.
-- ====================================================================

CREATE OR REPLACE FUNCTION public.guard_last_super_admin()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user UUID;
  v_is_active_super BOOLEAN;
  v_others INT;
BEGIN
  IF TG_TABLE_NAME = 'profiles' THEN
    v_user := OLD.id;
    IF TG_OP = 'UPDATE' AND (OLD.employment_status <> 'active' OR NEW.employment_status = 'active') THEN
      RETURN NEW;                       -- not leaving the active state
    END IF;
    IF TG_OP = 'DELETE' AND OLD.employment_status <> 'active' THEN
      RETURN OLD;
    END IF;
  ELSIF TG_TABLE_NAME = 'user_roles' THEN
    v_user := OLD.user_id;
    IF NOT EXISTS (SELECT 1 FROM public.roles r WHERE r.id = OLD.role_id AND r.name = 'super_admin' AND r.is_active) THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;   -- not a super_admin assignment
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.user_id = OLD.user_id AND NEW.role_id = OLD.role_id THEN
      RETURN NEW;                       -- only assigned_by etc. changed
    END IF;
  ELSE  -- roles
    IF OLD.name <> 'super_admin' OR NOT OLD.is_active THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.name = 'super_admin' AND NEW.is_active THEN
      RETURN NEW;
    END IF;
    v_user := NULL;                     -- the role itself goes away: nobody keeps it
  END IF;

  -- serialize every change that could remove an active super_admin
  PERFORM pg_advisory_xact_lock(hashtext('kite_last_super_admin'));

  IF v_user IS NOT NULL THEN
    -- re-read after the lock: is this person an ACTIVE super_admin right now?
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id AND r.name = 'super_admin' AND r.is_active
      JOIN public.profiles p ON p.id = ur.user_id AND p.employment_status = 'active'
      WHERE ur.user_id = v_user
    ) INTO v_is_active_super;
    IF NOT v_is_active_super THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
  END IF;

  SELECT count(*) INTO v_others
  FROM public.user_roles ur
  JOIN public.roles r ON r.id = ur.role_id AND r.name = 'super_admin' AND r.is_active
  JOIN public.profiles p ON p.id = ur.user_id AND p.employment_status = 'active'
  WHERE v_user IS NULL OR ur.user_id <> v_user;

  -- person removed: refuse when nobody else is active.  role removed: refuse when anybody is active.
  IF (v_user IS NOT NULL AND v_others = 0) OR (v_user IS NULL AND v_others > 0) THEN
    RAISE EXCEPTION 'last_super_admin' USING HINT = 'At least one active super_admin must remain.';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_last_super_admin() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_last_super_admin ON public.profiles;
CREATE TRIGGER guard_last_super_admin BEFORE UPDATE OF employment_status OR DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_last_super_admin();

DROP TRIGGER IF EXISTS guard_last_super_admin ON public.user_roles;
CREATE TRIGGER guard_last_super_admin BEFORE UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.guard_last_super_admin();

DROP TRIGGER IF EXISTS guard_last_super_admin ON public.roles;
CREATE TRIGGER guard_last_super_admin BEFORE UPDATE OR DELETE ON public.roles
  FOR EACH ROW EXECUTE FUNCTION public.guard_last_super_admin();

-- replace_user_role(): same contract as 020, but a super_admin keeps the SAME row when re-assigned, and the
-- last-super_admin rule is enforced by the trigger above (same 'last_super_admin' error, under the advisory lock).
CREATE OR REPLACE FUNCTION public.replace_user_role(p_user_id UUID, p_role_id UUID, p_assigned_by UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.roles r WHERE r.id = p_role_id AND r.is_active = true) THEN
    RAISE EXCEPTION 'unknown_role';
  END IF;
  DELETE FROM public.user_roles WHERE user_id = p_user_id AND role_id <> p_role_id;
  INSERT INTO public.user_roles (user_id, role_id, assigned_by) VALUES (p_user_id, p_role_id, p_assigned_by)
    ON CONFLICT (user_id, role_id) DO UPDATE SET assigned_by = EXCLUDED.assigned_by;
END;
$$;
REVOKE ALL ON FUNCTION public.replace_user_role(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_user_role(UUID, UUID, UUID) TO service_role;
