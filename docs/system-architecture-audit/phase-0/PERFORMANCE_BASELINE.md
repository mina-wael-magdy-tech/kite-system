# Performance Baseline

**No runtime measurements were taken.** There is no isolated environment with the app and test data, and no staging; production load tests are forbidden. p50/p95 latency, payload sizes, query durations, error rates and resource use are therefore **NOT MEASURED** (not estimated).

## Static counts (REPO, grep over `*.js`, excluding `node_modules`)
| Metric | Count | Note |
|---|---|---|
| `.from('…')` call sites | ~241 | grep count of `.from(` with a quote; includes non-Supabase `.from` if any |
| `.rpc(` call sites | ~2 | the app mostly uses direct table access |
| `.channel(` call sites | ~11 | Realtime subscriptions; FUN-01 covers cleanup on fast navigation |
| Files containing `.from(` | 27 | |
| Edge Functions | 12 | |

## Known patterns already in the register (not re-opened here)
PERF-01..04 (see `remediation/PERFORMANCE_ISSUES.md`): RLS predicate/index coverage, unbounded or large queries, repeated requests, Hostinger thumbnail/chunk resources. Pagination was added to most lists in commit `ad3afc2`. Existing caching: service-worker asset cache and `Cache-Control` headers in `vercel.json`; no data-layer cache seen. Existing performance monitoring: none evidenced.

## Not read line by line
About 20k lines of browser module code were scanned by script only; N+1 patterns are therefore **POTENTIAL**, not confirmed.

## What to measure later (isolated environment only)
Requests and DB round trips per page/workflow (login, dashboard, tasks, chat, finance, client Files tab), p50/p95 latency, payload sizes, `pg_stat_statements` top queries, Realtime channel count per session, Hostinger PHP limits (`php -i`: post_max_size, memory_limit, max_execution_time) and disk usage of `_thumbs`/`_chunks`/`_log`.
