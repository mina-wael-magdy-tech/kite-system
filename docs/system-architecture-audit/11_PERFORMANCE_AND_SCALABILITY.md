# 11 — Performance & scalability

**No profiling, query logs, bundle analysis or load tests exist or were run.** Everything here is design-level observation; no concurrency/throughput claims are made.

## Observed design choices
- **No bundler:** native ES modules, many small requests; `no-cache` on HTML/JS (revalidate each load) with service-worker network-first → fast deploys, but each page load revalidates every module. Vendored heavy libs (`pptxgenjs`, `pdf-bundle`, `chart.umd`) — whether lazy-loaded is unverified (Graphify shows `loadLibrary()` in the PPTX exporter, suggesting lazy loading; unconfirmed). Offline precache excludes big files (`BIG` regex in `build.mjs`).
- **Edge Functions** do 2 DB round trips for identity per call (`getUser` + profile/roles in parallel) plus the action's queries; `workflow` helpers (`isDeptManager`, `isProjectManager`, `isParticipant`) issue separate queries → several sequential round-trips per task action (acceptable at small-team scale).
- **Notification fan-out is sequential and inline**: `for … await notify()` in `accept-invitation`, `client-preview` (admins + creator + publisher, each with a Push attempt). Cost grows linearly with admin count; part of SEC-01's amplification.
- **`kite-drive link.options`** calls Drive `clients` list and filters in memory (all Drive clients per call).
- **Drive:** files stream with Range support in 1 MB reads (`send.php`) and release the PHP session lock; uploads chunked (8 MB default, bounded by `post_max_size`); thumbnails generated on demand (GD, ≤50 MP) and cached; `zip_prepare` builds archives on disk; ZIP extraction capped at 5000 entries / 2× max size. Synchronous CPU/disk work on shared hosting is the likeliest bottleneck (unmeasured).
- **Pagination** added in commit `ad3afc2`; coverage across all lists unverified; PHP `list` selects all folder rows and applies a file limit only to files (L92) — folder counts unbounded.
- **Indexes:** 54 index statements exist; query-pattern fit unassessed.
- **Realtime:** `eventsPerSecond: 10` client throttle; chat history/pagination unread.

## Scalability notes (qualitative)
- Supabase handles auth/DB scaling; the RLS predicates call `SECURITY DEFINER` functions per row (`auth_can_see_client`, `auth_in_dept`) — on large `clients`/`tasks` tables these subqueries can dominate; check with `EXPLAIN` once row counts grow. Index `user_roles(user_id)`, `user_departments(user_id)`, `client_departments(client_id)` — presence not verified.
- Cron jobs iterate all matching tasks/users in one invocation (no batching); fine for an agency-sized dataset, should be paginated if it grows ~10⁴+.
- Single Hostinger host is the file-throughput ceiling and a single point of failure.

## Recommendations
1. Add `EXPLAIN (ANALYZE)` baselines for the 10 heaviest list queries and RLS paths. 2. Batch/parallelize notification inserts (`insert([...])`, one push fan-out). 3. Measure Drive upload/zip on production PHP limits. 4. Add basic RUM (page timing) and Edge Function logs/alerts. 5. Load-test the Edge Functions before any claim of capacity.
