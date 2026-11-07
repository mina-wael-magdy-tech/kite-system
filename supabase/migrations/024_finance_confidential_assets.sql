-- ====================================================================
-- 024  Confidential Finance files in the document library are executive-only   (ARC-01 policy)
--
-- Policy: only super_admin, owner and ceo may view confidential Finance data or files, and "contracts" are on that list.
-- The studio document library (`assets` + the private `studio-assets` bucket) ships with a free-text "Contracts"
-- folder; its files followed the normal asset rules (studio-wide by default, every admin sees everything, private
-- ones included). No column linked any file to a financial record, so nothing could be restricted by relationship.
--
--   1. assets.finance_confidential (default false) marks a file as confidential Finance material.
--   2. A trigger sets it for the Contracts folder (fail-closed: the folder name can only RESTRICT, never relax) and
--      stops anyone but an executive from clearing it. An executive can flag any other file by updating the column.
--   3. RLS on assets: a flagged file is visible, creatable, editable and deletable by executives only (executives, incl. ceo,
--      may also flag any unflagged file by updating it).
--   4. Storage: the studio-assets read policy (007) already requires a VISIBLE assets row for the object, so the file
--      content, signed-URL creation and direct object reads follow the new rule with no storage-policy change.
--   5. Existing rows in a Contracts folder are flagged (one additive UPDATE of the new column; nothing else changes).
--
-- Not changed: assets visibility rules for unflagged files, other buckets, Kite Drive (see FINANCE_ACCESS_AUDIT.md).
-- Limits: signed URLs issued before a file was flagged stay valid until they expire (up to 1 hour). Storage DELETE
-- by the uploader or an admin (007) is unchanged: deleting is not viewing.
-- Apply AFTER 007 and 022, as a single script on its own (do NOT use `supabase db push` on live). Safe to run again.
-- Rollback: DROP TRIGGER assets_finance_flag ON public.assets; restore the 007 policies; ALTER TABLE public.assets DROP COLUMN finance_confidential;
-- ====================================================================

ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS finance_confidential BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.assets_finance_flag()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW.folder ILIKE 'contract%' THEN
    NEW.finance_confidential := true;                                   -- fail closed
  ELSIF TG_OP = 'UPDATE' AND OLD.finance_confidential AND NOT NEW.finance_confidential AND NOT public.auth_is_finance() THEN
    NEW.finance_confidential := true;                                   -- only an executive may clear the flag
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assets_finance_flag ON public.assets;
CREATE TRIGGER assets_finance_flag BEFORE INSERT OR UPDATE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.assets_finance_flag();

DROP POLICY IF EXISTS "assets_select" ON public.assets;
CREATE POLICY "assets_select" ON public.assets FOR SELECT TO authenticated
    USING (
      public.auth_is_staff() AND CASE WHEN finance_confidential THEN public.auth_is_finance() ELSE (
        visibility = 'studio'
        OR uploaded_by = auth.uid()
        OR public.auth_is_admin()
        OR (visibility = 'department' AND EXISTS (
              SELECT 1 FROM public.user_departments ud
              WHERE ud.user_id = auth.uid() AND ud.department_id = assets.department_id))
      ) END
    );

DROP POLICY IF EXISTS "assets_insert" ON public.assets;
CREATE POLICY "assets_insert" ON public.assets FOR INSERT TO authenticated
    WITH CHECK (public.auth_is_staff() AND uploaded_by = auth.uid() AND (NOT finance_confidential OR public.auth_is_finance()));

DROP POLICY IF EXISTS "assets_update" ON public.assets;
CREATE POLICY "assets_update" ON public.assets FOR UPDATE TO authenticated
    USING (public.auth_is_staff() AND CASE WHEN finance_confidential THEN public.auth_is_finance() ELSE (uploaded_by = auth.uid() OR public.auth_is_admin() OR public.auth_is_finance()) END)
    WITH CHECK (public.auth_is_staff() AND CASE WHEN finance_confidential THEN public.auth_is_finance() ELSE (uploaded_by = auth.uid() OR public.auth_is_admin() OR public.auth_is_finance()) END);

DROP POLICY IF EXISTS "assets_delete" ON public.assets;
CREATE POLICY "assets_delete" ON public.assets FOR DELETE TO authenticated
    USING (public.auth_is_staff() AND CASE WHEN finance_confidential THEN public.auth_is_finance() ELSE (uploaded_by = auth.uid() OR public.auth_is_admin()) END);

-- flag what is already in a Contracts folder (the trigger sets the column)
UPDATE public.assets SET finance_confidential = true WHERE folder ILIKE 'contract%' AND NOT finance_confidential;
