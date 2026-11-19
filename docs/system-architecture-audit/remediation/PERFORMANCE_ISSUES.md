# Performance & Scalability Issues

4 issues. Full fields are in MASTER_ISSUE_REGISTER.md; IDs are canonical.

| ID | Title | Sev | Pri | Confidence | Fix pkg | Status |
|---|---|---|---|---|---|---|
| PERF-01 | Notification fan-out is sequential/inline and costs several queries per recipient | MEDIUM | P2 | Potential | FX-11 | Open |
| PERF-02 | RLS predicates call SECURITY DEFINER functions per row; index support unverified | MEDIUM | P2 | Potential | FX-13 | Open |
| PERF-03 | Many browser reads are unbounded or select('*') | LOW | P3 | Potential | FX-13 | Open |
| PERF-04 | Drive PHP does uploads, zip and thumbnails synchronously on shared hosting | LOW | P3 | Unverified | FX-13 | Open |

### PERF-01 — Notification fan-out is sequential/inline and costs several queries per recipient

| Field | Value |
|---|---|
| Category | Performance |
| Severity | MEDIUM |
| Priority | P2 |
| Confidence | Potential |
| Impact / Likelihood / Effort | Moderate / Medium / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Notifications |
| Affected files | `supabase/functions/_shared/auth.ts (notify)`<br>`supabase/functions/_shared/push.ts:L55-L100`<br>`supabase/functions/broadcast/index.ts:L86-L90`<br>`supabase/functions/workflow/index.ts:L229-L234,L363-L368` |
| Relevant functions | `notify`, `sendPush` |
| Graph node IDs | `shared:auth`, `shared:push`, `fn:broadcast`, `fn:workflow`, `tbl:notifications`, `tbl:push_subscriptions` |
| Related workflows | Notifications and push, Client content approval |
| Related tables | `notifications`, `push_subscriptions` |
| Fix package | FX-11 |
| Status | Open |

**Description.** notify() performs an insert, then sendPush does a subscriptions query, an unread-count query and one HTTPS push per device, awaited inside the request. Task events loop sequentially; broadcast batches 10 in parallel (at least 3 queries per user). Large audiences risk Edge time limits and partial delivery (see DAT-08). No measurements exist.

**Root cause.** Synchronous per-recipient delivery.

**Reproduction (safe).** Broadcast to a staging project with 200 users and time it.

**Impact.** Slow actions, timeouts, partial delivery.

**Fix.** Bulk insert notifications in one statement; fetch subscriptions for all recipients in one query; send pushes via a queue/outbox processed by a worker function; cap per-request recipients.

**Acceptance criteria.** Broadcast to 200 users completes under 5 s with one insert statement; failures retry.

**Required tests.** Load test in staging.

**Verification method.** Timing before/after.

**Why this classification.** Medium/Potential: design risk without measurements.

---

### PERF-02 — RLS predicates call SECURITY DEFINER functions per row; index support unverified

| Field | Value |
|---|---|
| Category | Performance |
| Severity | MEDIUM |
| Priority | P2 |
| Confidence | Potential |
| Impact / Likelihood / Effort | Moderate / Medium / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Database |
| Affected files | `supabase/migrations/002_rls_policies.sql:L132-L148,L527-L528`<br>`supabase/migrations/015_owner_only_money_and_client_scope.sql:L38-L53` |
| Relevant functions | `auth_can_view_task`, `auth_can_see_client`, `auth_can_view_conversation` |
| Graph node IDs | `sql:auth_can_view_task`, `sql:auth_can_see_client`, `ext:postgrest`, `tbl:tasks`, `tbl:clients` |
| Related workflows | Task status change |
| Related tables | `tasks`, `clients`, `messages`, `task_assignees`, `user_departments` |
| Fix package | FX-13 |
| Status | Open |

**Description.** tasks_select is USING (auth_can_view_task(id)); the function is STABLE SECURITY DEFINER and cannot be inlined, so non-admin queries evaluate EXISTS subqueries per candidate row. Efficiency depends on indexes on task_assignees(task_id,user_id), user_departments(user_id), tasks(assigned_to), tasks(created_by) which were not verified.

**Root cause.** Row-level function-based policies.

**Reproduction (safe).** EXPLAIN ANALYZE SELECT * FROM tasks as a non-admin on a populated copy.

**Impact.** Slow list queries as tasks and messages grow.

**Fix.** Capture baselines with EXPLAIN (ANALYZE, BUFFERS); add missing indexes; rewrite hot policies with EXISTS subqueries or a membership materialization; consider SELECT ... WHERE assigned_to = auth.uid() fast paths.

**Acceptance criteria.** P95 for task list and chat history queries within agreed budget at 10x current rows.

**Required tests.** Load test with seeded volume.

**Verification method.** pg_stat_statements top queries (VERIFICATION_PLAN).

**Why this classification.** Medium/Potential: structural risk, not yet measured.

---

### PERF-03 — Many browser reads are unbounded or select('*')

| Field | Value |
|---|---|
| Category | Performance |
| Severity | LOW |
| Priority | P3 |
| Confidence | Potential |
| Impact / Likelihood / Effort | Minor / Medium / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Frontend data access |
| Affected files | `js/modules/**/*.js (13 select('*'), 18 limit/range vs 162 .from calls)` |
| Relevant functions | — |
| Graph node IDs | `fe:shell`, `ext:postgrest` |
| Related workflows | — |
| Related tables | `tasks`, `notifications`, `messages` |
| Fix package | FX-13 |
| Status | Open |

**Description.** Counts from source: 162 .from() call sites, 13 select('*'), 18 limit/range. Pagination was added in commit ad3afc2 but not every list is bounded. Per-query review not done.

**Root cause.** Pagination applied module by module.

**Reproduction (safe).** List queries with >1000 rows.

**Impact.** Slow pages and large payloads at scale.

**Fix.** Audit each query; add range/limit and explicit columns; central query helper with default limit.

**Acceptance criteria.** No query without limit except documented exceptions.

**Required tests.** Lint/grep check.

**Verification method.** Count unbounded queries.

**Why this classification.** Low/Potential: unmeasured.

---

### PERF-04 — Drive PHP does uploads, zip and thumbnails synchronously on shared hosting

| Field | Value |
|---|---|
| Category | Performance |
| Severity | LOW |
| Priority | P3 |
| Confidence | Unverified |
| Impact / Likelihood / Effort | Minor / Medium / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Kite Drive |
| Affected files | `integrations/kite-drive/api/index.php (zip_prepare, extract_zip, thumb)`<br>`integrations/kite-drive/api/send.php` |
| Relevant functions | `zip_prepare`, `extract_zip`, `drive_send_thumbnail` |
| Graph node IDs | `php:index`, `php:send`, `ext:hostinger` |
| Related workflows | Kite Drive file access |
| Related tables | — |
| Fix package | FX-13 |
| Status | Open |

**Description.** Zip building, zip extraction (up to 5000 entries), GD thumbnails (up to 50 MP) and 8 MB chunk handling run inside PHP requests. Limits (post_max_size, memory, time) were not observed.

**Root cause.** Synchronous processing.

**Reproduction (safe).** Upload large zip in staging.

**Impact.** Timeouts on large operations.

**Fix.** Measure with representative files; set explicit memory/time limits; thumbnail generation lazily with queue if needed.

**Acceptance criteria.** Documented limits and measured pass/fail for target sizes.

**Required tests.** Manual load script.

**Verification method.** Run on Hostinger staging.

**Why this classification.** Low/Unverified.

---
