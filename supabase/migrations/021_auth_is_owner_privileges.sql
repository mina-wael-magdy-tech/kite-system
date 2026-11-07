-- ====================================================================
-- 021  Restrict EXECUTE on auth_is_owner() (ARC-01 hygiene)
--
-- Migration 015 created auth_is_owner() without any REVOKE/GRANT, so it is executable by PUBLIC
-- (including the anon role), unlike the other authorization helpers (see auth_is_finance in 017).
-- It only reflects the caller's own status and returns false for anon, so this is a surface-area
-- fix, not an escalation fix.
--
-- IMPORTANT: authenticated MUST keep EXECUTE. Row Level Security evaluates the policy expressions
-- with the caller's privileges; the owner-only policies on budgets, vendors, invoices, expenses and
-- finance settings (015) call this function for every request. The GRANT below keeps that working.
--
-- Pre-flight (below) aborts the script, changing nothing, if any policy that calls the function can
-- apply to a role other than `authenticated` (it would start failing for that role).
--
-- Safe to run more than once. Apply as a single script on its own (do NOT use `supabase db push` on live).
-- Rollback: GRANT EXECUTE ON FUNCTION public.auth_is_owner() TO PUBLIC;
-- ====================================================================

DO $$
DECLARE v_bad TEXT;
BEGIN
  SELECT string_agg(c.relname || '.' || p.polname, ', ') INTO v_bad
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  WHERE (pg_get_expr(p.polqual, p.polrelid) ILIKE '%auth_is_owner%'
      OR pg_get_expr(p.polwithcheck, p.polrelid) ILIKE '%auth_is_owner%')
    AND (p.polroles = ARRAY[0]::oid[]
         OR EXISTS (SELECT 1 FROM unnest(p.polroles) r WHERE r <> 'authenticated'::regrole::oid));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'auth_is_owner() is used by policies for roles other than authenticated: %', v_bad;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.auth_is_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auth_is_owner() TO authenticated, service_role;
