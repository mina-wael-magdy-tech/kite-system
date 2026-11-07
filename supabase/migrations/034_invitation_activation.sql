-- ====================================================================
-- KITE SYSTEM — 034_invitation_activation.sql   (Phase 4, ARC-03 / FX-15)
--
-- Employee activation used to be two separate statements in the accept-invitation Edge Function (activate the profile,
-- then mark the invitation) with the invitation picked by e-mail address only. This migration makes activation one
-- atomic, race-safe database decision:
--
--   * invitations.user_id      the invitation is bound to the exact account that was created for it. A legacy row without
--                              user_id is still matched by e-mail (compatibility), a bound row is NEVER matched by e-mail.
--   * accept_invitation(user)  one transaction: lock the profile and the invitation, refuse unless the account is
--                              'onboarding' and the invitation is 'pending' and not expired, then activate + mark accepted
--                              + supersede any other pending invitation of the same account. Returns a status text
--                              (accepted | not_onboarding | no_invitation | expired); it never raises for a business
--                              refusal, so marking an invitation 'expired' is not rolled back. Service role only.
--   * invitations_expire_pending()  marks pending invitations past expires_at as 'expired' (called by the daily job).
--   * invitations.token        the Edge Function now stores only a SHA-256 hash of a random value ("sha256:<hex>"); the real
--                              credential is the one-time link issued by Supabase Auth (inviteUserByEmail). The column is
--                              also no longer readable by signed-in users (column grant), so HR / admins cannot read it.
--
-- Rules documented here (nothing invented): an invitation is valid for 7 days (the existing column default); activation is
-- single-use (pending -> accepted, never back); a re-invite supersedes the earlier invitation (revoked).
--
-- Safe to run more than once. Run AFTER 033. Applied manually; never `db push` on live.
--
-- ROLLBACK (no data is deleted):
--   DROP FUNCTION IF EXISTS public.accept_invitation(uuid), public.invitations_expire_pending();
--   GRANT SELECT ON public.invitations TO authenticated;          -- restores the table-wide read (RLS still applies)
--   -- optional: ALTER TABLE public.invitations DROP COLUMN user_id;
-- ====================================================================

ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_invitations_user ON public.invitations (user_id) WHERE user_id IS NOT NULL;

-- the stored token is never needed by the browser
REVOKE SELECT ON public.invitations FROM authenticated;
GRANT SELECT (id, email, full_name, role_id, department_id, job_title, invited_by, status, expires_at, accepted_at, created_at, updated_at, user_id)
  ON public.invitations TO authenticated;

CREATE OR REPLACE FUNCTION public.accept_invitation(p_user UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_prof public.profiles%ROWTYPE;
  v_inv  public.invitations%ROWTYPE;
BEGIN
  SELECT * INTO v_prof FROM public.profiles WHERE id = p_user FOR UPDATE;       -- concurrent accepts of one account queue here
  IF NOT FOUND OR v_prof.employment_status <> 'onboarding' THEN RETURN 'not_onboarding'; END IF;

  SELECT * INTO v_inv FROM public.invitations i
   WHERE i.status = 'pending'
     AND (i.user_id = p_user OR (i.user_id IS NULL AND lower(i.email) = lower(v_prof.email)))
   ORDER BY i.created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN 'no_invitation'; END IF;

  IF v_inv.expires_at < now() THEN
    UPDATE public.invitations SET status = 'expired', updated_at = now() WHERE id = v_inv.id;
    RETURN 'expired';
  END IF;

  UPDATE public.profiles SET employment_status = 'active' WHERE id = p_user;
  UPDATE public.invitations SET status = 'accepted', accepted_at = now(), updated_at = now() WHERE id = v_inv.id;
  UPDATE public.invitations SET status = 'revoked', updated_at = now()
   WHERE status = 'pending' AND id <> v_inv.id
     AND (user_id = p_user OR (user_id IS NULL AND lower(email) = lower(v_prof.email)));
  RETURN 'accepted';
END $$;

CREATE OR REPLACE FUNCTION public.invitations_expire_pending()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE n INTEGER;
BEGIN
  UPDATE public.invitations SET status = 'expired', updated_at = now() WHERE status = 'pending' AND expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.accept_invitation(uuid), public.invitations_expire_pending() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_invitation(uuid), public.invitations_expire_pending() TO service_role;
