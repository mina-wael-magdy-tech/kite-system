// PULSE STUDIO OS — Edge Function: due-reminders  (scheduled)
//
// Once a day:
//   1. housekeeping FIRST (so a slow digest can never skip it): removes files whose database rows were deleted (migration 029)
//      and marks invitations past their 7 days as expired (migration 034),
//   2. tells each person which of their tasks are overdue, due today or due tomorrow, and which posts they have to publish
//      (in-app notification + push).
//
// Idempotent and resumable (migration 037): the candidates come from due_digest_batch() / publish_digest_batch(), which never return
// a person who already has today's digest. The digest runs in batches of BATCH people inside a time budget; when the budget is used up
// the run ends as "partial" and the next run (or a manual re-run) continues with the people who are still missing.
// Every run is recorded in job_runs.
//
// Not callable by users: it requires the CRON_SECRET in the `x-cron-secret` header.
// Schedule it from Supabase Dashboard → Integrations → Cron (HTTP request), daily, e.g. 07:00 Cairo time (docs/background-jobs.md).
//
//   supabase secrets set CRON_SECRET=<long random string>  REMINDER_TZ=Africa/Cairo
//   optional: JOB_TIME_BUDGET_MS (default 90000): stop starting new batches after this many milliseconds

import { HttpError, json, serveJson } from "../_shared/http.ts";
import { adminClient, audit, notify } from "../_shared/auth.ts";
import { drainStorageCleanup } from "../_shared/storage-cleanup.ts";
import { startJobRun } from "../_shared/jobs.ts";

const BATCH = 200;

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

interface Candidate { user_id: string; late_count: number; today_count: number; tomorrow_count: number; first_label: string }

serveJson(async (req) => {
  const secret = Deno.env.get("CRON_SECRET") ?? "";
  if (secret.length < 24) throw new HttpError(503, "Reminders are disabled: CRON_SECRET (min 24 chars) is not configured");
  if (!timingSafeEqual(req.headers.get("x-cron-secret") ?? "", secret)) throw new HttpError(403, "Invalid cron secret");

  const tz = Deno.env.get("REMINDER_TZ") ?? "Africa/Cairo";
  const today = dateInZone(tz), tomorrow = dateInZone(tz, 1);
  const budgetMs = Math.max(1000, Number(Deno.env.get("JOB_TIME_BUDGET_MS") ?? 90_000) || 90_000);
  const startedAt = Date.now();
  const admin = adminClient();
  const run = await startJobRun(admin, "due-reminders");
  const checkpoint: Record<string, unknown> = { today };

  try {
    // ---- 1. housekeeping first; neither step can stop the other or the digest ----
    // files whose database rows were deleted: remove them now, retry the ones that failed earlier (migration 029)
    const cleanup = await drainStorageCleanup(admin, 200);

    // invitations past their 7 days are marked expired (migration 034)
    let invitationsExpired = 0;
    try {
      const { data } = await admin.rpc("invitations_expire_pending");
      invitationsExpired = typeof data === "number" ? data : 0;
    } catch (err) { console.error("invitation expiry sweep failed:", err); }
    checkpoint.housekeeping = "done";
    await run.progress(checkpoint);

    // ---- 2. digests, in bounded batches ----
    let partial = false;
    const runDigest = async (rpc: "due_digest_batch" | "publish_digest_batch", type: "due_digest" | "publish_reminder", key: string): Promise<number> => {
      let after: string | null = null;
      let sentCount = 0;
      for (;;) {
        if (Date.now() - startedAt > budgetMs) { partial = true; break; }
        const { data, error } = await admin.rpc(rpc, { p_today: today, p_tomorrow: tomorrow, p_after: after, p_limit: BATCH });
        if (error) throw new Error(`${rpc} failed: ${error.message}`);
        const rows = (data ?? []) as Candidate[];
        if (!rows.length) break;
        for (const r of rows) {
          const parts = type === "due_digest"
            ? [
              r.late_count ? `${r.late_count} overdue` : "",
              r.today_count ? `${r.today_count} due today` : "",
              r.tomorrow_count ? `${r.tomorrow_count} due tomorrow` : "",
            ]
            : [
              r.today_count ? `${r.today_count} to publish today` : "",
              r.late_count ? `${r.late_count} overdue` : "",
              r.tomorrow_count ? `${r.tomorrow_count} tomorrow` : "",
            ];
          // dedupeKey: the DATABASE allows one digest per person per day, so two overlapping runs cannot both send (migration 032)
          const sent = await notify(admin, {
            userId: r.user_id, type,
            title: type === "due_digest" ? "Your deadlines" : "Posts to publish",
            content: `${parts.filter(Boolean).join(", ")}. Next: ${r.first_label}`,
            link: "#calendar",
            dedupeKey: `${key}:${today}`,
          });
          if (sent) sentCount++;
          after = r.user_id;
        }
        checkpoint[`${type}_after`] = after;
        checkpoint[`${type}_sent`] = sentCount;
        await run.progress(checkpoint);
        if (rows.length < BATCH) break;
      }
      return sentCount;
    };

    const notified = await runDigest("due_digest_batch", "due_digest", "due_digest");
    const publishNotified = await runDigest("publish_digest_batch", "publish_reminder", "publish_reminder");

    const summary = { notified, publishNotified, today, tz, storageCleanup: cleanup, invitationsExpired, partial };
    await audit(admin, { userId: null, action: "DUE_REMINDERS_SENT", entityType: "tasks", newData: summary });
    await run.finish(partial ? "partial" : "succeeded", summary);
    return json(req, { success: true, ...summary });
  } catch (err) {
    await run.finish("failed", { ...checkpoint }, (err as Error)?.message ?? "failed");
    throw err;
  }
});
