// KITE SYSTEM — Edge Function: retainer-billing  (scheduled)
//
// Once a day:
//   1. creates, for the current month, a DRAFT invoice for every active retainer plan that has none yet
//      (never twice for the same plan and month; a person reviews and sends it),
//   2. marks unpaid invoices that passed their due date as overdue,
//   3. tells the finance people when new drafts are waiting.
//
// Not callable by users: needs the CRON_SECRET in the `x-cron-secret` header (same secret as due-reminders).
// Schedule: Supabase Dashboard -> Integrations -> Cron -> HTTP request, daily, e.g. 06:00 Cairo time.
//   POST https://<ref>.supabase.co/functions/v1/retainer-billing    Header: x-cron-secret: <CRON_SECRET>
//   (add `Authorization: Bearer <anon key>` as for the other scheduled function)

import { HttpError, json, serveJson } from "../_shared/http.ts";
import { adminClient, notify, userIdsWithRoles } from "../_shared/auth.ts";

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

serveJson(async (req) => {
  const secret = Deno.env.get("CRON_SECRET") ?? "";
  if (secret.length < 24) throw new HttpError(503, "Disabled: CRON_SECRET (min 24 chars) is not configured");
  if (!timingSafeEqual(req.headers.get("x-cron-secret") ?? "", secret)) throw new HttpError(403, "Invalid cron secret");

  const tz = Deno.env.get("REMINDER_TZ") ?? "Africa/Cairo";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const month = `${today.slice(0, 7)}-01`;

  const admin = adminClient();
  const { data: created, error } = await admin.rpc("fin_retainer_generate", { p_actor: null, p_month: month });
  if (error) { console.error("retainer generate failed:", error.message); throw new Error("retainer generate failed"); }
  const { data: overdue, error: e2 } = await admin.rpc("fin_mark_overdue");
  if (e2) console.error("mark overdue failed:", e2.message);

  if ((created ?? 0) > 0) {
    const people = await userIdsWithRoles(admin, ["finance_manager", "accountant", "owner", "super_admin"]);
    await Promise.all(people.map((userId) => notify(admin, {
      userId, type: "invoice_drafts",
      title: "Retainer invoices ready to review",
      content: `${created} draft invoice${created === 1 ? "" : "s"} created for ${month.slice(0, 7)}. Review and send them.`,
      link: "#finance",
    })));
  }
  return json(req, { success: true, month, created: created ?? 0, markedOverdue: overdue ?? 0 });
});
