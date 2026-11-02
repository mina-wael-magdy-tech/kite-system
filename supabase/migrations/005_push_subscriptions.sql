-- ====================================================================
-- PULSE STUDIO OS — 005_push_subscriptions.sql
-- Storage for Web Push device subscriptions. Access control only.
--
-- Browsers can READ their own rows (to show "enabled on this device").
-- All writes (subscribe / unsubscribe / cleanup of expired endpoints) go through the
-- `workflow` Edge Function with the service role, which also validates that an endpoint
-- belongs to a real push service (the server POSTs to it, so it must never be arbitrary).
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON public.push_subscriptions(user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.push_subscriptions FROM PUBLIC, anon, authenticated;
-- the keys (p256dh/auth) never need to reach the browser: expose only non-secret columns
GRANT SELECT (id, user_id, endpoint, user_agent, created_at, last_seen_at) ON public.push_subscriptions TO authenticated;
GRANT ALL ON public.push_subscriptions TO service_role;

DROP POLICY IF EXISTS "push_subscriptions_select" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_select" ON public.push_subscriptions
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());
