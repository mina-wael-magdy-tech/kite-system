-- ====================================================================
-- KITE SYSTEM — 014_broadcasts.sql
--   Announcements that the owner / CEO send to employees (history + rate limit).
--   Only the `broadcast` Edge Function writes here (service role); owners/admins can read.
--   Safe to run more than once.
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.broadcasts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    title TEXT NOT NULL CHECK (char_length(title) BETWEEN 2 AND 80),
    message TEXT NOT NULL CHECK (char_length(message) BETWEEN 2 AND 600),
    link TEXT,
    audience_type TEXT NOT NULL CHECK (audience_type IN ('all', 'department', 'role', 'people')),
    audience_label TEXT,
    recipient_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_broadcasts_created ON public.broadcasts (created_at DESC);

ALTER TABLE public.broadcasts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.broadcasts FROM anon, authenticated;
GRANT SELECT ON public.broadcasts TO authenticated;

DROP POLICY IF EXISTS "broadcasts_select" ON public.broadcasts;
CREATE POLICY "broadcasts_select" ON public.broadcasts FOR SELECT TO authenticated
  USING (public.auth_is_admin());
