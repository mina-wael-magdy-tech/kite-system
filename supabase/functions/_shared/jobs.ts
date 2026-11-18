// KITE SYSTEM — job ledger helper (migration 037).
// Every scheduled function records its run in job_runs: started, progress checkpoints, and how it ended.
// The ledger is for visibility only. Nothing here may stop a job: if the ledger cannot be written (for example migration 037 has
// not been applied yet) the job still runs and the problem is logged.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";

export type JobStatus = "succeeded" | "partial" | "failed";

export interface JobRun {
  id: number | null;
  progress(checkpoint: Record<string, unknown>): Promise<void>;
  finish(status: JobStatus, details?: Record<string, unknown>, error?: string | null): Promise<void>;
}

export async function startJobRun(admin: SupabaseClient, job: string): Promise<JobRun> {
  let id: number | null = null;
  try {
    const { data, error } = await admin.rpc("job_run_start", { p_job: job });
    if (error) console.error(`job ledger start failed (${job}):`, error.message);
    else id = typeof data === "number" ? data : Number(data);
  } catch (e) {
    console.error(`job ledger start failed (${job}):`, (e as Error)?.message);
  }
  return {
    id,
    async progress(checkpoint) {
      if (id === null) return;
      try { await admin.rpc("job_run_progress", { p_id: id, p_checkpoint: checkpoint }); } catch { /* visibility only */ }
    },
    async finish(status, details = {}, error = null) {
      if (id === null) return;
      try {
        const { error: e } = await admin.rpc("job_run_finish", { p_id: id, p_status: status, p_error: error, p_details: details });
        if (e) console.error(`job ledger finish failed (${job}):`, e.message);
      } catch (e) {
        console.error(`job ledger finish failed (${job}):`, (e as Error)?.message);
      }
    },
  };
}
