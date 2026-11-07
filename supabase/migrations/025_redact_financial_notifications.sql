-- ====================================================================
-- 025  Redact financial details in EXISTING notifications of non-executives   (ARC-01 policy, data change)
--
-- Before the executive-only policy, two functions wrote notifications that carry financial details to people who may
-- no longer see Finance data:
--   * type 'expense_request'  (workflow expense.submitted): "<who>: <claim title> (EGP 500)" to admins incl. general_manager,
--                             finance_manager and accountant
--   * type 'invoice_drafts'   (retainer-billing): "<N> draft invoices created for <month>" to finance_manager, accountant, owner, super_admin
-- New notifications of these types now go to executives only (code change). This migration cleans up the history.
--
-- What it does, and nothing else:
--   * only rows of those two types whose RECIPIENT is not an active executive (super_admin, owner, ceo);
--   * replaces ONLY the `content` text with a generic sentence; id, user_id, type, title, link, is_read, metadata and
--     created_at are untouched; no row is deleted; executives' copies are untouched; other types are untouched
--     (expense_decision carries only the submitter's own claim title and is left as is);
--   * first saves the original text into finance_backup.notifications_pre025 (schema unreachable through the API),
--     so the change is reversible; running it again changes nothing.
--
-- It cannot recall what was already delivered: push messages already shown on a device stay there.
-- Apply AFTER 022, as a single script on its own, ONLY after the owner approves (it edits existing rows). Not part of
-- the automatic deploy of the other migrations.
-- Rollback:  UPDATE public.notifications n SET content = b.original_content
--              FROM finance_backup.notifications_pre025 b WHERE b.id = n.id;
-- ====================================================================

CREATE SCHEMA IF NOT EXISTS finance_backup;
REVOKE ALL ON SCHEMA finance_backup FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS finance_backup.notifications_pre025 (
    id UUID PRIMARY KEY,
    user_id UUID,
    type TEXT NOT NULL,
    original_content TEXT NOT NULL,
    original_metadata JSONB,
    redacted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
REVOKE ALL ON finance_backup.notifications_pre025 FROM PUBLIC, anon, authenticated;

WITH targets AS (
  SELECT n.id, n.user_id, n.type, n.content, n.metadata,
         CASE n.type
           WHEN 'expense_request' THEN 'An expense claim was submitted. Details are visible to executives only.'
           WHEN 'invoice_drafts'  THEN 'Retainer invoices were prepared. Details are visible to executives only.'
         END AS redacted
  FROM public.notifications n
  WHERE n.type IN ('expense_request', 'invoice_drafts')
    AND NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id AND r.is_active
      JOIN public.profiles p ON p.id = ur.user_id AND p.employment_status = 'active'
      WHERE ur.user_id = n.user_id AND r.name IN ('super_admin', 'owner', 'ceo'))
    AND n.content IS DISTINCT FROM CASE n.type
           WHEN 'expense_request' THEN 'An expense claim was submitted. Details are visible to executives only.'
           WHEN 'invoice_drafts'  THEN 'Retainer invoices were prepared. Details are visible to executives only.'
         END
), saved AS (
  INSERT INTO finance_backup.notifications_pre025 (id, user_id, type, original_content, original_metadata)
  SELECT id, user_id, type, content, metadata FROM targets
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
UPDATE public.notifications n SET content = t.redacted FROM targets t WHERE n.id = t.id;
