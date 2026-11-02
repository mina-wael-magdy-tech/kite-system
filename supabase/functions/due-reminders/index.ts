// PULSE STUDIO OS — Edge Function: due-reminders  (scheduled)
//
// Once a day, tells each person which of their tasks are overdue, due today or due tomorrow
// (in-app notification + push). Idempotent: a person gets at most one digest per day.
//
// Not callable by users: it requires the CRON_SECRET in the `x-cron-secret` header.
// Schedule it from Supabase Dashboard → Integrations → Cron (HTTP request), daily, e.g. 07:00 Cairo time.
//
//   supabase secrets set CRON_SECRET=<long random string>  REMINDER_TZ=Africa/Cairo

import { HttpError, json, serveJson } from "../_shared/http.ts";
import { adminClient, audit, notify } from "../_shared/auth.ts";

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** YYYY-MM-DD in the studio's time zone (so "today" matches what people see on their wall clock). */
function dateInZone(tz: string, plusDays = 0): string {
  const base = new Date(Date.now() + plusDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(base);
}

serveJson(async (req) => {
  const secret = Deno.env.get("CRON_SECRET") ?? "";
  if (secret.length < 24) throw new HttpError(503, "Reminders are disabled: CRON_SECRET (min 24 chars) is not configured");
  if (!timingSafeEqual(req.headers.get("x-cron-secret") ?? "", secret)) throw new HttpError(403, "Invalid cron secret");

  const tz = Deno.env.get("REMINDER_TZ") ?? "Africa/Cairo";
  const today = dateInZone(tz), tomorrow = dateInZone(tz, 1);
  const admin = adminClient();

  const { data: tasks, error } = await admin.from("tasks")
    .select("id, task_number, title, due_date, assigned_to, status")
    .not("assigned_to", "is", null)
    .not("status", "in", "(completed,approved,cancelled,backlog)")
    .lte("due_date", tomorrow);
  if (error) throw error;

  // one digest per person
  const byUser = new Map<string, { overdue: string[]; today: string[]; tomorrow: string[] }>();
  for (const t of tasks ?? []) {
    const d = byUser.get(t.assigned_to) ?? { overdue: [], today: [], tomorrow: [] };
    const label = `${t.task_number} ${t.title}`;
    if (t.due_date < today) d.overdue.push(label);
    else if (t.due_date === today) d.today.push(label);
    else d.tomorrow.push(label);
    byUser.set(t.assigned_to, d);
  }

  // skip people already reminded in the last 20 hours (safe to re-run)
  const since = new Date(Date.now() - 20 * 3_600_000).toISOString();
  const { data: already } = await admin.from("notifications").select("user_id").eq("type", "due_digest").gte("created_at", since);
  const done = new Set((already ?? []).map((r: { user_id: string }) => r.user_id));

  // only active people
  const { data: active } = await admin.from("profiles").select("id").in("id", [...byUser.keys()]).eq("employment_status", "active");
  const activeIds = new Set((active ?? []).map((p: { id: string }) => p.id));

  let notified = 0;
  for (const [userId, d] of byUser) {
    if (done.has(userId) || !activeIds.has(userId)) continue;
    const parts = [
      d.overdue.length ? `${d.overdue.length} overdue` : "",
      d.today.length ? `${d.today.length} due today` : "",
      d.tomorrow.length ? `${d.tomorrow.length} due tomorrow` : "",
    ].filter(Boolean);
    const first = [...d.overdue, ...d.today, ...d.tomorrow][0];
    await notify(admin, {
      userId, type: "due_digest",
      title: "Your deadlines",
      content: `${parts.join(", ")}. Next: ${first}`,
      link: "#calendar",
    });
    notified++;
  }

  await audit(admin, { userId: null, action: "DUE_REMINDERS_SENT", entityType: "tasks", newData: { notified, today, tz } });
  return json(req, { success: true, notified, today });
});
