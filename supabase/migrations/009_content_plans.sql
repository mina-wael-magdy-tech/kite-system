-- ====================================================================
-- KITE SYSTEM — 009_content_plans.sql
-- Content plans (feed calendars): one slide per post, edited by the department,
-- shared with the client through a private link, with page-by-page client feedback.
-- Safe to run more than once. Requires 007 (studio-assets bucket) and the auth_* helpers.
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.content_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    subtitle TEXT,
    campaign_id UUID REFERENCES public.campaigns(id) ON DELETE SET NULL,
    client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,
    department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
    direction TEXT NOT NULL DEFAULT 'rtl' CHECK (direction IN ('rtl', 'ltr')),
    accent TEXT NOT NULL DEFAULT '#e01b28' CHECK (accent ~ '^#[0-9a-fA-F]{6}$'),
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft', 'in_review', 'changes_requested', 'approved')),
    created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_content_plans_campaign ON public.content_plans(campaign_id);

-- The private share link. No grants for the browser at all: only the edge functions touch it.
CREATE TABLE IF NOT EXISTS public.content_plan_shares (
    plan_id UUID PRIMARY KEY REFERENCES public.content_plans(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.content_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES public.content_plans(id) ON DELETE CASCADE,
    position INT NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT 'Untitled post',
    post_date DATE,
    post_time TIME,
    content_type TEXT NOT NULL DEFAULT 'static'
      CHECK (content_type IN ('static', 'carousel', 'reel', 'story', 'video', 'other')),
    platform TEXT,
    pillar TEXT,
    objective TEXT,
    idea TEXT,
    caption TEXT,
    links JSONB NOT NULL DEFAULT '[]'::jsonb,       -- [{ "label": "...", "url": "https://..." }]
    status TEXT NOT NULL DEFAULT 'planned'
      CHECK (status IN ('planned', 'designing', 'ready', 'approved', 'published')),
    publisher_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    published_url TEXT,
    published_at TIMESTAMPTZ,
    created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_content_posts_plan ON public.content_posts(plan_id, position);
CREATE INDEX IF NOT EXISTS idx_content_posts_date ON public.content_posts(post_date);
CREATE INDEX IF NOT EXISTS idx_content_posts_publisher ON public.content_posts(publisher_id);

CREATE TABLE IF NOT EXISTS public.content_post_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES public.content_plans(id) ON DELETE CASCADE,
    post_id UUID REFERENCES public.content_posts(id) ON DELETE CASCADE,   -- NULL = plan cover image
    storage_path TEXT NOT NULL UNIQUE,            -- <uploader id>/plans/<plan id>/<random>-<file>
    file_name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size BIGINT NOT NULL CHECK (file_size > 0),
    position INT NOT NULL DEFAULT 0,
    uploaded_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_content_assets_post ON public.content_post_assets(post_id, position);
CREATE INDEX IF NOT EXISTS idx_content_assets_plan ON public.content_post_assets(plan_id);

CREATE TABLE IF NOT EXISTS public.content_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES public.content_plans(id) ON DELETE CASCADE,
    post_id UUID REFERENCES public.content_posts(id) ON DELETE SET NULL,
    slide_no INT,                                  -- page number the client saw (1 = cover)
    slide_title TEXT,
    author_name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('note', 'change', 'approve', 'approve_all')),
    message TEXT,
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_content_feedback_plan ON public.content_feedback(plan_id, created_at DESC);

-- --------------------------------------------------------------------
-- Who may edit a plan: admins, its creator, and everyone in the plan's department.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auth_can_edit_plan(p_plan_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public.auth_is_staff() AND (
    public.auth_is_admin()
    OR EXISTS (
      SELECT 1 FROM public.content_plans p
      WHERE p.id = p_plan_id
        AND (p.created_by = auth.uid()
             OR (p.department_id IS NOT NULL AND EXISTS (
                   SELECT 1 FROM public.user_departments ud
                   WHERE ud.user_id = auth.uid() AND ud.department_id = p.department_id)))
    )
  );
$$;
GRANT EXECUTE ON FUNCTION public.auth_can_edit_plan(UUID) TO authenticated;

ALTER TABLE public.content_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_post_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_feedback ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.content_plans, public.content_posts,
  public.content_post_assets TO authenticated;
GRANT SELECT, UPDATE ON public.content_feedback TO authenticated;
ALTER TABLE public.content_plan_shares ENABLE ROW LEVEL SECURITY;  -- no policies, no grants: service role only

-- plans -------------------------------------------------------------
DROP POLICY IF EXISTS "plans_select" ON public.content_plans;
CREATE POLICY "plans_select" ON public.content_plans FOR SELECT TO authenticated
  USING (public.auth_is_staff());
DROP POLICY IF EXISTS "plans_insert" ON public.content_plans;
CREATE POLICY "plans_insert" ON public.content_plans FOR INSERT TO authenticated
  WITH CHECK (public.auth_is_staff() AND created_by = auth.uid());
DROP POLICY IF EXISTS "plans_update" ON public.content_plans;
CREATE POLICY "plans_update" ON public.content_plans FOR UPDATE TO authenticated
  USING (public.auth_can_edit_plan(id)) WITH CHECK (public.auth_can_edit_plan(id));
DROP POLICY IF EXISTS "plans_delete" ON public.content_plans;
CREATE POLICY "plans_delete" ON public.content_plans FOR DELETE TO authenticated
  USING (public.auth_can_edit_plan(id));

-- posts -------------------------------------------------------------
DROP POLICY IF EXISTS "posts_select" ON public.content_posts;
CREATE POLICY "posts_select" ON public.content_posts FOR SELECT TO authenticated
  USING (public.auth_is_staff());
DROP POLICY IF EXISTS "posts_insert" ON public.content_posts;
CREATE POLICY "posts_insert" ON public.content_posts FOR INSERT TO authenticated
  WITH CHECK (public.auth_can_edit_plan(plan_id));
DROP POLICY IF EXISTS "posts_update" ON public.content_posts;
-- editors change anything; the person assigned to publish may update the status / published link
CREATE POLICY "posts_update" ON public.content_posts FOR UPDATE TO authenticated
  USING (public.auth_can_edit_plan(plan_id) OR (publisher_id = auth.uid() AND public.auth_is_staff()))
  WITH CHECK (public.auth_can_edit_plan(plan_id) OR (publisher_id = auth.uid() AND public.auth_is_staff()));
DROP POLICY IF EXISTS "posts_delete" ON public.content_posts;
CREATE POLICY "posts_delete" ON public.content_posts FOR DELETE TO authenticated
  USING (public.auth_can_edit_plan(plan_id));

-- visuals -----------------------------------------------------------
DROP POLICY IF EXISTS "plan_assets_select" ON public.content_post_assets;
CREATE POLICY "plan_assets_select" ON public.content_post_assets FOR SELECT TO authenticated
  USING (public.auth_is_staff());
DROP POLICY IF EXISTS "plan_assets_insert" ON public.content_post_assets;
CREATE POLICY "plan_assets_insert" ON public.content_post_assets FOR INSERT TO authenticated
  WITH CHECK (public.auth_can_edit_plan(plan_id) AND uploaded_by = auth.uid());
DROP POLICY IF EXISTS "plan_assets_update" ON public.content_post_assets;
CREATE POLICY "plan_assets_update" ON public.content_post_assets FOR UPDATE TO authenticated
  USING (public.auth_can_edit_plan(plan_id)) WITH CHECK (public.auth_can_edit_plan(plan_id));
DROP POLICY IF EXISTS "plan_assets_delete" ON public.content_post_assets;
CREATE POLICY "plan_assets_delete" ON public.content_post_assets FOR DELETE TO authenticated
  USING (public.auth_can_edit_plan(plan_id));

-- client feedback: staff read it; editors resolve it. Clients write through the edge function.
DROP POLICY IF EXISTS "feedback_select" ON public.content_feedback;
CREATE POLICY "feedback_select" ON public.content_feedback FOR SELECT TO authenticated
  USING (public.auth_is_staff());
DROP POLICY IF EXISTS "feedback_update" ON public.content_feedback;
CREATE POLICY "feedback_update" ON public.content_feedback FOR UPDATE TO authenticated
  USING (public.auth_can_edit_plan(plan_id)) WITH CHECK (public.auth_can_edit_plan(plan_id));

-- Storage: plan visuals live in the studio-assets bucket, in the uploader's own folder.
DROP POLICY IF EXISTS "plan_assets_storage_read" ON storage.objects;
CREATE POLICY "plan_assets_storage_read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'studio-assets' AND public.auth_is_staff()
         AND EXISTS (SELECT 1 FROM public.content_post_assets a WHERE a.storage_path = name));
DROP POLICY IF EXISTS "plan_assets_storage_delete" ON storage.objects;
CREATE POLICY "plan_assets_storage_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'studio-assets' AND split_part(name, '/', 2) = 'plans'
         AND CASE WHEN split_part(name, '/', 3) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                  THEN public.auth_can_edit_plan(split_part(name, '/', 3)::uuid) ELSE FALSE END);

-- updated_at triggers (helper comes from 003)
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'set_updated_at') THEN
    FOREACH t IN ARRAY ARRAY['content_plans', 'content_posts'] LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
      EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
    END LOOP;
  END IF;
END $$;

-- Realtime
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['content_plans', 'content_posts', 'content_post_assets', 'content_feedback'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                   WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
