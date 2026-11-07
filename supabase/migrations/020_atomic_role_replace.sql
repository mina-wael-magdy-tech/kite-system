-- ====================================================================
-- 020  Atomic role replacement (ARC-01 / DAT-05)
--
-- The employee.update Edge Function used to DELETE a person's roles and then INSERT the new one
-- as two separate calls; a failure in between left the person with no role. This function does
-- both in ONE transaction and also refuses to demote the last ACTIVE super administrator
-- (checked under a row lock so two concurrent demotions cannot both succeed).
--
-- Only the service role can call it (the Edge Function authorizes the caller first).
-- ORDER: apply this migration BEFORE deploying the invite-employee / workflow Edge Functions that call it
-- (without it, role changes fail closed with a 500 and keep the existing role).
-- Additive: creates one function, changes no table, policy or existing grant.
-- Safe to run more than once. Apply as a single script on its own (do NOT use `supabase db push` on live).
-- Rollback: DROP FUNCTION public.replace_user_role(uuid, uuid, uuid);  (then redeploy the previous Edge Functions)
-- ====================================================================

CREATE OR REPLACE FUNCTION public.replace_user_role(p_user_id UUID, p_role_id UUID, p_assigned_by UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_new_name TEXT;
  v_other_active INT;
BEGIN
  SELECT r.name INTO v_new_name FROM public.roles r WHERE r.id = p_role_id AND r.is_active = true;
  IF v_new_name IS NULL THEN
    RAISE EXCEPTION 'unknown_role';
  END IF;

  -- Demoting an ACTIVE super admin: make sure another active one remains.
  IF v_new_name <> 'super_admin' AND EXISTS (
       SELECT 1 FROM public.user_roles ur
       JOIN public.roles r ON r.id = ur.role_id AND r.name = 'super_admin' AND r.is_active = true
       JOIN public.profiles p ON p.id = ur.user_id AND p.employment_status = 'active'
       WHERE ur.user_id = p_user_id) THEN
    -- serialize concurrent demotions
    PERFORM 1 FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id AND r.name = 'super_admin'
      FOR UPDATE OF ur;
    SELECT count(*) INTO v_other_active
      FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id AND r.name = 'super_admin' AND r.is_active = true
      JOIN public.profiles p ON p.id = ur.user_id AND p.employment_status = 'active'
      WHERE ur.user_id <> p_user_id;
    IF v_other_active = 0 THEN
      RAISE EXCEPTION 'last_super_admin';
    END IF;
  END IF;

  DELETE FROM public.user_roles WHERE user_id = p_user_id;
  INSERT INTO public.user_roles (user_id, role_id, assigned_by) VALUES (p_user_id, p_role_id, p_assigned_by);
END;
$$;

REVOKE ALL ON FUNCTION public.replace_user_role(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_user_role(UUID, UUID, UUID) TO service_role;
