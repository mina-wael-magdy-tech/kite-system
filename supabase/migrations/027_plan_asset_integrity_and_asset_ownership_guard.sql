-- ====================================================================
-- 027  Plan-asset integrity and asset ownership guard   (Phase 2.1: M1, and the M2 bypass cases)
--
-- M1. content_post_assets.  Migration 012 added a path CHECK
--       uploaded_by IS NULL OR storage_path LIKE (uploaded_by || '/plans/' || plan_id || '/%')   (NOT VALID)
--     but nothing stopped an UPDATE from setting uploaded_by = NULL and storage_path = <any path> in one statement:
--     the CHECK passes for a NULL owner, then plan_assets_storage_read (009) lets every staff member read that object
--     and the public client-preview link signs it with the service role. A trigger now closes this at the database level:
--       * INSERT   : uploaded_by must not be NULL (the CHECK then binds the path to the uploader and the plan).
--       * UPDATE   : storage_path, plan_id and uploaded_by are immutable. The ONE exception is the foreign-key action
--                    "ON DELETE SET NULL": when the uploader's profile has been deleted, uploaded_by may become NULL.
--                    (The "the referenced profile no longer exists" check runs in a SECURITY DEFINER trigger function, so
--                    row-level security cannot hide a live profile from it.)
--     Legacy rows with a NULL uploaded_by are NOT touched or re-owned. They stay editable for what the app does with them
--     (layout, position, post, file_name, delete) but their path, plan and owner can never change, and nobody can claim them.
--     Operational limitation: a legacy NULL-owner row cannot be re-assigned to a new owner or moved to another plan; delete
--     it and re-upload. Metadata edits by plan editors keep working.
--
-- M2 bypass cases. assets (026 made the uploader an exception to client scoping). Without these guards an uploader could
--     re-point their asset to a client they cannot see, or clear client_id to make it studio-wide, or hand ownership to
--     someone else. A trigger now requires, on UPDATE (it does nothing when there is no end-user session, i.e. service
--     role or SQL editor, where auth.uid() IS NULL):
--       * uploaded_by : unchanged, unless the caller is an executive (auth_is_owner).
--       * client_id   : unchanged, unless the caller is an executive; otherwise the NEW client must be one the caller can
--                       see (and the OLD one too), and a non-executive can never detach a file from its client (NULL).
--     The application never changes these columns (the edit form sends name, folder, visibility, description only).
--
-- Not changed: any policy, grant or data. Existing rows are never rewritten or deleted. Storage read policies unchanged.
-- Apply AFTER 026 (and 009, 012, 024), as a single script on its own (do NOT use `supabase db push` on live). Safe to run again.
--
-- ROLLBACK (exact; nothing else changes because this migration modified no data):
--   DROP TRIGGER IF EXISTS content_post_assets_guard ON public.content_post_assets;
--   DROP FUNCTION IF EXISTS public.content_post_assets_guard();
--   DROP TRIGGER IF EXISTS assets_integrity_guard ON public.assets;
--   DROP FUNCTION IF EXISTS public.assets_integrity_guard();
--
-- WARNING: re-running migration 024 AFTER 026 replaces the 026 assets policies (select/insert/update/delete) with the
--   older 024 ones and silently removes the client scoping. Re-run 026 after any re-run of 024. 027 does not touch policies.
-- ====================================================================

-- SECURITY DEFINER on purpose: the "uploader's profile is gone" check must see every profile, whatever the caller's
-- row-level security allows. No other privileged work happens here and the function is not callable through the API.
CREATE OR REPLACE FUNCTION public.content_post_assets_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.uploaded_by IS NULL THEN
      RAISE EXCEPTION 'Plan asset needs an uploader';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.storage_path IS DISTINCT FROM OLD.storage_path THEN
    RAISE EXCEPTION 'Plan asset storage path cannot be changed';
  END IF;
  IF NEW.plan_id IS DISTINCT FROM OLD.plan_id THEN
    RAISE EXCEPTION 'Plan asset cannot move to another plan';
  END IF;
  IF NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by THEN
    -- allowed only for the foreign key action ON DELETE SET NULL (the uploader's profile is gone)
    IF NOT (NEW.uploaded_by IS NULL AND OLD.uploaded_by IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = OLD.uploaded_by)) THEN
      RAISE EXCEPTION 'Plan asset uploader cannot be changed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.content_post_assets_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS content_post_assets_guard ON public.content_post_assets;
CREATE TRIGGER content_post_assets_guard BEFORE INSERT OR UPDATE ON public.content_post_assets
  FOR EACH ROW EXECUTE FUNCTION public.content_post_assets_guard();

CREATE OR REPLACE FUNCTION public.assets_integrity_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;                                            -- service role / SQL editor: no end-user session
  END IF;
  IF NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by THEN
    IF NOT public.auth_is_owner() THEN
      RAISE EXCEPTION 'Asset ownership can only be changed by an executive';
    END IF;
  END IF;
  IF NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    IF NOT public.auth_is_owner() THEN
      IF NEW.client_id IS NULL THEN
        RAISE EXCEPTION 'Only an executive can detach a client file from its client';
      END IF;
      IF NOT public.auth_can_see_client(NEW.client_id)
         OR (OLD.client_id IS NOT NULL AND NOT public.auth_can_see_client(OLD.client_id)) THEN
        RAISE EXCEPTION 'You cannot move a file to or from a client you cannot see';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assets_integrity_guard ON public.assets;
CREATE TRIGGER assets_integrity_guard BEFORE UPDATE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.assets_integrity_guard();
