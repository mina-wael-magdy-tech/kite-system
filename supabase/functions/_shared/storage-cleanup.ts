// KITE SYSTEM — storage clean-up worker (migration 029).
// Database rows that point at files are deleted FIRST; a trigger queues each file in storage_cleanup_queue in the same
// transaction. This helper claims a batch (a lease, so two workers never take the same file), removes the objects, and
// reports each result. A failure leaves the file queued with its error and a later retry time: nothing is lost silently.
// It never throws: callers (a task delete, the daily job) must not fail because a file could not be removed yet.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";

export interface CleanupResult { claimed: number; removed: number; failed: number }

export async function drainStorageCleanup(admin: SupabaseClient, limit = 50): Promise<CleanupResult> {
  const out: CleanupResult = { claimed: 0, removed: 0, failed: 0 };
  try {
    const { data, error } = await admin.rpc("storage_cleanup_claim", { p_limit: limit });
    if (error) { console.error("storage cleanup claim failed:", error.message); return out; }
    const rows = (data ?? []) as { id: number; bucket: string; path: string }[];
    out.claimed = rows.length;
    const byBucket = new Map<string, { id: number; path: string }[]>();
    for (const r of rows) byBucket.set(r.bucket, [...(byBucket.get(r.bucket) ?? []), { id: r.id, path: r.path }]);
    for (const [bucket, items] of byBucket) {
      let failure: string | null = null;
      try {
        const { error: rmErr } = await admin.storage.from(bucket).remove(items.map((i) => i.path));
        if (rmErr) failure = rmErr.message || "remove failed";
      } catch (e) {
        failure = (e as Error)?.message || "remove failed";
      }
      for (const it of items) {
        const { error: repErr } = await admin.rpc("storage_cleanup_report", { p_id: it.id, p_ok: failure === null, p_error: failure });
        if (repErr) console.error("storage cleanup report failed:", repErr.message);
        if (failure === null) out.removed++; else out.failed++;
      }
    }
  } catch (e) {
    console.error("storage cleanup failed:", (e as Error)?.message);
  }
  return out;
}
