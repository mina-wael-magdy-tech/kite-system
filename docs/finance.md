# Finance module

Built in steps. **Step 2 (clients & invoicing) is in.** Still to come: expenses (3), payroll (4), taxes & insurance (5), budgets & dashboard (6).

## Who can do what
| Role | Invoices, clients, retainers, expenses | Void invoice / reverse payment / change settings | Payroll (later) |
|---|---|---|---|
| owner, CEO, super admin | ✔ | ✔ | ✔ |
| finance manager | ✔ | ✔ | ✘ |
| accountant | ✔ | ✘ (read-only settings) | ✘ |
| everyone else | ✘ | ✘ | ✘ |

Enforced in the database (row-level security + `auth_is_finance()`), not just on screen. Even finance users cannot write to the
finance tables directly: every write goes through the `finance` edge function, which calls `fin_*` SQL functions.

## Deploy (in this order)
1. **Back up** is automatic: migration 017 first copies the old invoices / expenses / budgets / vendors / money figures into
   the private schema `finance_backup` (`*_pre017` tables).
2. Run `supabase/migrations/017_finance_invoicing.sql` in the SQL editor. Safe to run twice.
3. `npx supabase functions deploy finance --remote=<ref> --use-api` and `... retainer-billing ...`
4. Redeploy the site (Vercel), reopen the app.
5. Finance → **Settings**: company names, tax registration number, bank details, VAT rate, default withholding, prefix.
6. Finance → **Clients & retainers**: set each client's billing profile; add retainer plans.
7. Daily job (Supabase → Integrations → Cron → HTTP request, daily ~06:00 Cairo):
   `POST https://<ref>.supabase.co/functions/v1/retainer-billing` with headers `x-cron-secret: <CRON_SECRET>` and
   `Authorization: Bearer <anon key>`. It creates the month's **draft** retainer invoices (never twice), marks overdue
   invoices, and notifies the finance team. (The same CRON_SECRET as `due-reminders`.)

Optional demo data: `supabase/seed-finance-demo.sql` (run by hand; invoices can never be deleted, only voided).

## How the money is calculated (server side, `NUMERIC`)
Per line: `gross = qty × price` → `discount = gross × disc% ` → `net = gross − discount` → `VAT = net × vat%`,
each rounded half-up to 2 decimals, then summed. Withholding tax = `subtotal × rate` (on the amount **before** VAT).
`Invoice total = subtotal + VAT`; `Net payable by client = total − withholding`; `Balance = net payable − payments`.
The browser only previews with an exact integer version of the same formula (tested equal on 400 random invoices).

## Invoice life cycle
`draft` (editable, number `DRAFT-xxxx`) → **Issue** (gets `KITE-YYYY-0001`, sequential and gapless; frozen) → `sent` →
`partially paid` / `paid` (follows the payments) → `overdue` (past due date and unpaid, set daily).
Mistakes: **void** (reason required, number kept, stamped VOID) — and create a new invoice. Payments are never edited:
**reverse** them (reason required). Nothing is ever deleted; every change is in `finance_audit_log` (append-only).

## PDF
Real PDF files built in the browser (pdf-lib + Cairo font): Arabic, English or both; RTL layout for Arabic; mixed Arabic /
English / numbers in the right order; multi-page; PAID / VOID / DRAFT stamps. The 1.3 MB PDF engine loads only the first
time someone exports. Sample: `docs/finance-poc/arabic-invoice-poc.pdf`.

## ETA (Egyptian e-invoice), later
Prepared, not connected: seller tax number + branch/activity code (Settings), client tax number and receiver type, per-line
item code and unit type, `invoices.eta_uuid / eta_status / eta_submitted_at / eta_payload`. The integration only has to
map these and fill the ETA columns.

## Tests
`cd supabase/tests && npm install && node verify-rls.mjs` — 70+ finance checks: rounding, totals, numbering without gaps,
freezing, payments, void, retainers (no double billing), audit log, access, legacy-data migration, preview == server.
