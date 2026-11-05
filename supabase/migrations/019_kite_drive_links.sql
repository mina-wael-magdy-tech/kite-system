-- ====================================================================
-- KITE SYSTEM — 019_kite_drive_links.sql
--   Connects a client here to their account on Kite Drive (the PHP site on Hostinger).
--   A link decides whose files someone gets access to, so it can't be changed from the browser:
--   only the `kite-drive` Edge Function reads and writes this table, after checking the caller.
--   Safe to run more than once.
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.client_drive_links (
    client_id UUID PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,
    drive_user_id INTEGER NOT NULL UNIQUE CHECK (drive_user_id > 0),  -- users.id on Kite Drive
    drive_name TEXT NOT NULL,
    linked_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.client_drive_links ENABLE ROW LEVEL SECURITY;
-- No policies and no grants on purpose: the service role is the only way in.
REVOKE ALL ON public.client_drive_links FROM anon, authenticated;
