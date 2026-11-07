-- ====================================================================
-- 026  Client asset department scoping & storage path binding (Phase 2: P2-04, P2-05)
--
-- 1. P2-04: Scope assets linked to a client using auth_can_see_client(client_id).
--    - An asset with client_id is visible only if the caller can see the client (via department,
--      account manager, creator, or executive tier) or uploaded it.
--    - Preserves executive access (super_admin, owner, ceo) and uploader access.
--    - Preserves Phase 1 Finance confidentiality (finance_confidential = true).
-- 2. P2-05: Storage path binding.
--    - On INSERT: the first path segment of storage_path must match uploaded_by::text.
--    - On UPDATE: storage_path is immutable.
--    - Legacy rows are left intact (no backfill or automatic deletion).
--
-- Safe to run more than once. Run AFTER 001-025.
-- ====================================================================

-- --------------------------------------------------------------------
-- 1. Storage path binding trigger (P2-05)
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assets_path_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.storage_path IS NULL OR split_part(NEW.storage_path, '/', 1) <> NEW.uploaded_by::text THEN
      RAISE EXCEPTION 'Asset storage path must start with the uploader id';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.storage_path <> OLD.storage_path THEN
      RAISE EXCEPTION 'Asset storage path cannot be changed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assets_path_guard ON public.assets;
CREATE TRIGGER trg_assets_path_guard BEFORE INSERT OR UPDATE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.assets_path_guard();

-- --------------------------------------------------------------------
-- 2. Scoped RLS policies on public.assets (P2-04)
-- --------------------------------------------------------------------
DROP POLICY IF EXISTS "assets_select" ON public.assets;
CREATE POLICY "assets_select" ON public.assets FOR SELECT TO authenticated
    USING (
      public.auth_is_staff() AND CASE
        WHEN finance_confidential THEN public.auth_is_finance()
        WHEN client_id IS NOT NULL THEN (
          uploaded_by = auth.uid()
          OR public.auth_is_owner()
          OR (public.auth_can_see_client(client_id) AND (
            visibility = 'studio'
            OR public.auth_is_admin()
            OR (visibility = 'department' AND EXISTS (
                  SELECT 1 FROM public.user_departments ud
                  WHERE ud.user_id = auth.uid() AND ud.department_id = assets.department_id))
          ))
        )
        ELSE (
          visibility = 'studio'
          OR uploaded_by = auth.uid()
          OR public.auth_is_admin()
          OR (visibility = 'department' AND EXISTS (
                SELECT 1 FROM public.user_departments ud
                WHERE ud.user_id = auth.uid() AND ud.department_id = assets.department_id))
        )
      END
    );

DROP POLICY IF EXISTS "assets_insert" ON public.assets;
CREATE POLICY "assets_insert" ON public.assets FOR INSERT TO authenticated
    WITH CHECK (
      public.auth_is_staff()
      AND uploaded_by = auth.uid()
      AND (NOT finance_confidential OR public.auth_is_finance())
      AND (client_id IS NULL OR public.auth_can_see_client(client_id))
    );

DROP POLICY IF EXISTS "assets_update" ON public.assets;
CREATE POLICY "assets_update" ON public.assets FOR UPDATE TO authenticated
    USING (
      public.auth_is_staff() AND CASE
        WHEN finance_confidential THEN public.auth_is_finance()
        WHEN client_id IS NOT NULL THEN (
          uploaded_by = auth.uid()
          OR public.auth_is_owner()
          OR (public.auth_is_admin() AND public.auth_can_see_client(client_id))
        )
        ELSE (uploaded_by = auth.uid() OR public.auth_is_admin() OR public.auth_is_finance())
      END
    )
    WITH CHECK (
      public.auth_is_staff() AND CASE
        WHEN finance_confidential THEN public.auth_is_finance()
        WHEN client_id IS NOT NULL THEN (
          uploaded_by = auth.uid()
          OR public.auth_is_owner()
          OR (public.auth_is_admin() AND public.auth_can_see_client(client_id))
        )
        ELSE (uploaded_by = auth.uid() OR public.auth_is_admin() OR public.auth_is_finance())
      END
    );

DROP POLICY IF EXISTS "assets_delete" ON public.assets;
CREATE POLICY "assets_delete" ON public.assets FOR DELETE TO authenticated
    USING (
      public.auth_is_staff() AND CASE
        WHEN finance_confidential THEN public.auth_is_finance()
        WHEN client_id IS NOT NULL THEN (
          uploaded_by = auth.uid()
          OR public.auth_is_owner()
          OR (public.auth_is_admin() AND public.auth_can_see_client(client_id))
        )
        ELSE (uploaded_by = auth.uid() OR public.auth_is_admin())
      END
    );
