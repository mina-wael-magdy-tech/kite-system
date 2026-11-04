// KITE SYSTEM — Edge Function: finance
// Clients & invoicing. Every write goes through a fin_* SQL function (migration 017), which does all the money
// maths in NUMERIC, numbers invoices without gaps, freezes issued invoices and writes the audit log.
// This function only authenticates, checks the role and passes the request on. The browser never sends totals.
//
//   settings.update   owner / finance manager   { vat_rate?, default_withholding_rate?, ... }
//   billing.save      finance tier              { client_id, billing_type, tax_registration_no, withholding_rate, ... }
//   plan.save         finance tier              { id?, client_id, name, monthly_fee, start_date, billing_day, ... }
//   invoice.save      finance tier              { id?, client_id, kind, items[], ... }   (drafts only)
//   invoice.issue     finance tier              { id }          -> sequential number
//   invoice.void      owner / finance manager   { id, reason }
//   payment.add       finance tier              { invoiceId, amount, paidOn, method, reference?, notes? }
//   payment.reverse   owner / finance manager   { paymentId, reason }
//   retainer.run      finance tier              { month: "YYYY-MM-01" }   (creates the month's draft retainer invoices)
//
// Finance tier = super_admin, owner, ceo, finance_manager, accountant. Payroll (later) is owner-only.

import { HttpError, json, readJson, serveJson } from "../_shared/http.ts";
import { adminClient, Caller, getCaller } from "../_shared/auth.ts";
import * as v from "../_shared/validate.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";

const FINANCE_ROLES = ["super_admin", "owner", "ceo", "finance_manager", "accountant"];
const SENIOR_ROLES = ["super_admin", "owner", "ceo", "finance_manager"];

const canFinance = (c: Caller) => FINANCE_ROLES.some((r) => c.has(r));
const canSenior = (c: Caller) => SENIOR_ROLES.some((r) => c.has(r));

function requireFinance(c: Caller) {
  if (!canFinance(c)) throw new HttpError(403, "Finance access is limited to the owner, finance manager and accountant");
}
function requireSenior(c: Caller) {
  if (!canSenior(c)) throw new HttpError(403, "Only the owner or the finance manager can do this");
}

serveJson(async (req) => {
  const admin = adminClient();
  const caller = await getCaller(req, admin);
  requireFinance(caller);
  const b = await readJson(req, 200_000);

  switch (b.action) {
    case "settings.update": requireSenior(caller); return json(req, await rpc(admin, "fin_settings_update", { p_actor: caller.id, p: pick(b, SETTINGS_FIELDS) }));
    case "billing.save": return json(req, await rpc(admin, "fin_billing_save", { p_actor: caller.id, p: pick(b, BILLING_FIELDS) }));
    case "plan.save": return json(req, { id: await rpc(admin, "fin_plan_save", { p_actor: caller.id, p: pick(b, PLAN_FIELDS) }) });
    case "invoice.save": return json(req, { id: await rpc(admin, "fin_invoice_save", { p_actor: caller.id, p: invoicePayload(b) }) });
    case "invoice.issue": return json(req, { number: await rpc(admin, "fin_invoice_issue", { p_actor: caller.id, p_id: v.uuid(b.id, "id") }) });
    case "invoice.void":
      requireSenior(caller);
      await rpc(admin, "fin_invoice_void", { p_actor: caller.id, p_id: v.uuid(b.id, "id"), p_reason: v.text(b.reason, "reason", 3, 500) });
      return json(req, { success: true });
    case "payment.add":
      return json(req, { id: await rpc(admin, "fin_payment_add", {
        p_actor: caller.id, p_invoice: v.uuid(b.invoiceId, "invoiceId"), p_amount: money(b.amount, "amount"),
        p_paid_on: v.isoDate(b.paidOn, "paidOn"),
        p_method: v.oneOf(b.method ?? "bank_transfer", ["cash", "bank_transfer", "cheque", "card", "wallet", "other"] as const, "method"),
        p_reference: v.optText(b.reference, "reference", 120), p_notes: v.optText(b.notes, "notes", 500),
      }) });
    case "payment.reverse":
      requireSenior(caller);
      await rpc(admin, "fin_payment_reverse", { p_actor: caller.id, p_payment: v.uuid(b.paymentId, "paymentId"), p_reason: v.text(b.reason, "reason", 3, 500) });
      return json(req, { success: true });
    case "retainer.run": {
      const month = v.isoDate(b.month, "month");
      return json(req, { created: await rpc(admin, "fin_retainer_generate", { p_actor: caller.id, p_month: month }) });
    }
    default: throw new HttpError(400, "Unknown action");
  }
});

const SETTINGS_FIELDS = [
  "vat_rate", "default_withholding_rate", "default_payment_terms_days", "invoice_prefix", "company_name_en", "company_name_ar",
  "address_en", "address_ar", "phone", "email", "tax_registration_no", "commercial_register_no", "bank_details",
];
const BILLING_FIELDS = [
  "client_id", "billing_type", "legal_name_ar", "legal_name_en", "tax_registration_no", "billing_address", "billing_email",
  "withholding_rate", "payment_terms_days", "invoice_language", "eta_receiver_type",
];
const PLAN_FIELDS = [
  "id", "client_id", "department_id", "name", "description_ar", "description_en", "monthly_fee", "start_date", "end_date",
  "billing_day", "is_active",
];
const ITEM_FIELDS = ["description_ar", "description_en", "quantity", "unit_price", "discount_pct", "vat_rate", "item_code", "unit_type"];
const INVOICE_FIELDS = ["id", "client_id", "kind", "department_id", "project_id", "task_id", "issue_date", "due_date", "language", "notes", "withholding_rate"];

/** Only known fields go to the database function (anything else, including computed totals, is dropped). */
function pick(b: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (b[f] !== undefined) out[f] = b[f];
  return out;
}

function invoicePayload(b: Record<string, unknown>) {
  const items = Array.isArray(b.items) ? b.items : [];
  if (items.length > 100) throw new HttpError(400, "Too many line items");
  return {
    ...pick(b, INVOICE_FIELDS),
    items: items.map((it) => pick((it && typeof it === "object" ? it : {}) as Record<string, unknown>, ITEM_FIELDS)),
  };
}

function money(x: unknown, field: string): number {
  const n = typeof x === "string" ? Number(x) : x;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 1e12) throw new HttpError(400, `${field} must be a positive amount`);
  return n;
}

/** Calls a SQL function. Messages the function raised on purpose are shown to the user; anything else is hidden. */
async function rpc(admin: SupabaseClient, fn: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(fn, args);
  if (error) {
    // P0001 = RAISE EXCEPTION in our functions, 42501 = frozen invoice guard, 22xxx / 23xxx = bad value / constraint
    if (["P0001", "42501", "22P02", "22003", "22007", "23502", "23503", "23505", "23514"].includes(error.code)) {
      throw new HttpError(400, friendly(error.message));
    }
    console.error("finance rpc failed:", fn, error.code, error.message);
    throw new Error("finance rpc failed");
  }
  return data;
}

function friendly(m: string): string {
  if (/invalid input syntax for type (numeric|integer|date|uuid)/.test(m)) return "One of the numbers or dates is not valid";
  if (/uq_invoice_retainer_month/.test(m)) return "This plan was already billed for that month";
  if (/violates check constraint/.test(m)) return "One of the values is out of range";
  if (/violates foreign key/.test(m)) return "A linked record was not found";
  return m;
}
