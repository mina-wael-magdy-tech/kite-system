-- ====================================================================
-- KITE SYSTEM — 012_security_hardening.sql
-- Findings from the security review of the content-plan / client features. Safe to run more than once.
--   1. The person assigned to publish a post could change ANY column of it. Now: status + published link only.
--   2. A visual's file path could point at someone else's file. Now: it must sit in the uploader's own plan folder.
--   3. A visual could be attached to a post of another plan. Now: post and plan must match.
--   4. Editors could rewrite what the client wrote. Now: they can only mark feedback as resolved.
--   5. Explicitly close the newer tables to the anonymous (not signed-in) role.
-- ====================================================================

-- 1. Publisher may only move a post along (status / published link) -----------------------------------------------
CREATE OR REPLACE FUNCTION public.content_posts_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  -- Edge Functions (service role) have no auth.uid() and are checked in their own code.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF public.auth_can_edit_plan(OLD.plan_id) THEN RETURN NEW; END IF;

  IF (to_jsonb(NEW) - 'status' - 'published_url' - 'published_at' - 'updated_at')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'status' - 'published_url' - 'published_at' - 'updated_at') THEN
    RAISE EXCEPTION 'Only the plan''s team can change a post''s content. The publisher may only update its status and live link.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_content_posts_guard ON public.content_posts;
CREATE TRIGGER trg_content_posts_guard BEFORE UPDATE ON public.content_posts
  FOR EACH ROW EXECUTE FUNCTION public.content_posts_guard();

-- 2 + 3. Visuals: own folder for this plan, and a post that belongs to the same plan ------------------------------
ALTER TABLE public.content_post_assets DROP CONSTRAINT IF EXISTS content_post_assets_path_check;
ALTER TABLE public.content_post_assets ADD CONSTRAINT content_post_assets_path_check
  CHECK (uploaded_by IS NULL OR storage_path LIKE (uploaded_by::text || '/plans/' || plan_id::text || '/%'))
  NOT VALID;  -- enforced for every new or changed row; old rows are left alone

DROP POLICY IF EXISTS "plan_assets_insert" ON public.content_post_assets;
CREATE POLICY "plan_assets_insert" ON public.content_post_assets FOR INSERT TO authenticated
  WITH CHECK (
    public.auth_can_edit_plan(plan_id) AND uploaded_by = auth.uid()
    AND (post_id IS NULL OR EXISTS (SELECT 1 FROM public.content_posts p WHERE p.id = post_id AND p.plan_id = content_post_assets.plan_id))
  );

DROP POLICY IF EXISTS "plan_assets_update" ON public.content_post_assets;
CREATE POLICY "plan_assets_update" ON public.content_post_assets FOR UPDATE TO authenticated
  USING (public.auth_can_edit_plan(plan_id))
  WITH CHECK (
    public.auth_can_edit_plan(plan_id)
    AND (post_id IS NULL OR EXISTS (SELECT 1 FROM public.content_posts p WHERE p.id = post_id AND p.plan_id = content_post_assets.plan_id))
  );

-- 4. Client feedback is read-only for staff, except the "resolved" marker ------------------------------------------
REVOKE UPDATE ON public.content_feedback FROM authenticated;
GRANT UPDATE (resolved, resolved_by, resolved_at) ON public.content_feedback TO authenticated;

-- 5. Nothing for the anonymous role on the newer tables -------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['content_plans', 'content_plan_shares', 'content_posts', 'content_post_assets',
                           'content_feedback', 'client_departments', 'task_links', 'assets'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
  END LOOP;
END $$;

-- --------------------------------------------------------------------
-- CHECKS you can run afterwards (each should return NO rows):
--   -- tables without row level security
--   SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity;
--   -- anything the anonymous role can touch
--   SELECT table_name, privilege_type FROM information_schema.role_table_grants
--    WHERE table_schema = 'public' AND grantee = 'anon';
-- --------------------------------------------------------------------
