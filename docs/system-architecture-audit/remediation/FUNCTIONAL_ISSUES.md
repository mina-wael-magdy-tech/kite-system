# Functional & Business Logic Issues

5 issues. Full fields are in MASTER_ISSUE_REGISTER.md; IDs are canonical.

| ID | Title | Sev | Pri | Confidence | Fix pkg | Status |
|---|---|---|---|---|---|---|
| FUN-01 | Router has no render guard or module teardown: stale renders overwrite the page and hijack realtime | MEDIUM | P2 | Strong Evidence | FX-09 | Open |
| FUN-02 | Finance and reminder date logic mixes database UTC with Cairo business time | MEDIUM | P2 | Strong Evidence | FX-02, FX-10 | Open |
| FUN-03 | task.update lets any participant change deadline, priority and project, including on finished tasks | LOW | P3 | Potential | FX-15 | Open |
| FUN-04 | due-reminders digest picks an arbitrary 'Next' item, includes stale items forever, and uses large IN lists | LOW | P3 | Confirmed | FX-15 | Open |
| FUN-05 | Content posts can be published or assigned without approval or role checks | LOW | P3 | Potential | FX-15 | Open |

### FUN-01 — Router has no render guard or module teardown: stale renders overwrite the page and hijack realtime

| Field | Value |
|---|---|
| Category | Functional |
| Severity | MEDIUM |
| Priority | P2 |
| Confidence | Strong Evidence |
| Impact / Likelihood / Effort | Moderate / Medium / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Frontend shell |
| Affected files | `js/router.js:L34-L90`<br>`js/services/realtime-service.js:L25-L69`<br>`js/modules/chat/chat.js:L62,L325,L449-L457` |
| Relevant functions | `handleHashChange`, `Realtime.watch/clear`, `ChatModule.render/teardownRealtime` |
| Graph node IDs | `fe:shell`, `fe:svc:realtime-service`, `fe:chat`, `ext:realtime` |
| Related workflows | Notifications and push |
| Related tables | `messages`, `conversations`, `tasks` |
| Fix package | FX-09 |
| Status | Open |

**Description.** handleHashChange awaits routeConfig.render() into one shared container with no navigation token. A slow render from route A finishing after the user opened route B overwrites B's DOM. Realtime is a singleton: A's late call to Realtime.watch() calls clear() and replaces B's watcher, so B stops live updates and A's reload then redraws into B's container on every change. There is no unmount hook: ChatModule's postgres_changes and typing channels are torn down only when chat renders again, so they keep running after leaving chat.

**Root cause.** No module lifecycle contract (mount/unmount, cancellation).

**Reproduction (safe).** Throttle network, click Chat then Tasks quickly; or open Chat, navigate away and watch websocket frames.

**Impact.** Wrong content shown, missing live updates, wasted connections and background refreshes.

**Fix.** Router keeps a renderId; after each await check it still equals the current id and drop stale output; call module.unmount() on navigation; modules register teardown; Realtime.watch takes an owner token and ignores stale owners; ChatModule implements unmount() calling teardownRealtime().

**Acceptance criteria.** Rapid navigation test ends on the last route with correct content and exactly one active realtime channel; leaving chat removes its channels.

**Required tests.** Playwright test with delayed network; unit test for renderId logic.

**Verification method.** Count supabase channels via devtools before/after navigation.

**Why this classification.** Medium: user-visible incorrect behaviour; no data loss.

---

### FUN-02 — Finance and reminder date logic mixes database UTC with Cairo business time

| Field | Value |
|---|---|
| Category | Functional |
| Severity | MEDIUM |
| Priority | P2 |
| Confidence | Strong Evidence |
| Impact / Likelihood / Effort | Moderate / Medium / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Finance / scheduling |
| Affected files | `supabase/migrations/017_finance_invoicing.sql:L320-L322,L538,L574,L609`<br>`supabase/functions/due-reminders/index.ts:L26-L30`<br>`supabase/functions/retainer-billing/index.ts` |
| Relevant functions | `fin_payment_add`, `fin_refresh_status`, `fin_mark_overdue`, `fin_invoice_issue` |
| Graph node IDs | `sql:fin_payment_add`, `sql:fin_refresh_status`, `sql:fin_mark_overdue`, `sql:fin_invoice_issue`, `fn:due-reminders`, `fn:retainer-billing` |
| Related workflows | Invoice lifecycle (finance), Retainer billing (scheduled) |
| Related tables | `invoices`, `invoice_payments` |
| Fix package | FX-02, FX-10 |
| Status | Open |

**Description.** Payment validation rejects paid_on > current_date and overdue/numbering logic uses current_date, evaluated in the database session time zone (Supabase default UTC). Reminder and retainer functions use REMINDER_TZ (Africa/Cairo). Between 00:00 and 02:00/03:00 Cairo the local date is ahead of UTC, so a payment dated today is rejected as 'in the future'; invoices become overdue and numbers take the year from UTC.

**Root cause.** Business time zone not configured in SQL.

**Reproduction (safe).** Scratch DB with SET timezone='UTC': call fin_payment_add with Cairo's date during the first hours after local midnight.

**Impact.** Blocked payment entry for a few hours daily; overdue transitions and year boundaries off by hours.

**Fix.** Add finance_settings.timezone (default Africa/Cairo) and helper fin_today() = (now() AT TIME ZONE tz)::date; replace current_date in fin_* functions; align cron times.

**Acceptance criteria.** Test sets session time to 23:30 UTC and passes with Cairo date; overdue boundary follows Cairo.

**Required tests.** SQL tests with fixed now().

**Verification method.** SHOW timezone on live; run the boundary test.

**Why this classification.** Medium: recurring functional blocker in finance entry; likelihood depends on live timezone (unverified).

---

### FUN-03 — task.update lets any participant change deadline, priority and project, including on finished tasks

| Field | Value |
|---|---|
| Category | Functional |
| Severity | LOW |
| Priority | P3 |
| Confidence | Potential |
| Impact / Likelihood / Effort | Minor / Medium / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Tasks |
| Affected files | `supabase/functions/workflow/index.ts:L328-L372` |
| Relevant functions | `taskUpdate` |
| Graph node IDs | `fn:workflow`, `fe:tasks`, `tbl:tasks` |
| Related workflows | Task status change |
| Related tables | `tasks` |
| Fix package | FX-15 |
| Status | Open |

**Description.** Authorization is reviewer OR participant. An assignee can push the due date, lower priority or move the task to another visible project, and edits are allowed in any status (including completed/cancelled); updates are unconditional (lost updates). Whether this is intended needs the specification.

**Root cause.** Single edit permission for all fields.

**Reproduction (safe).** As assignee edit dueDate.

**Impact.** Silent deadline slippage; audit trail exists.

**Fix.** Field-level rules: only reviewers change dueDate/priority/project; block edits when status in completed/cancelled unless admin; use updated_at optimistic concurrency.

**Acceptance criteria.** Rules implemented per spec; tests per role/status.

**Required tests.** Edge tests per role and status.

**Verification method.** Run tests.

**Why this classification.** Low/Potential: rule depends on the missing spec.

---

### FUN-04 — due-reminders digest picks an arbitrary 'Next' item, includes stale items forever, and uses large IN lists

| Field | Value |
|---|---|
| Category | Functional |
| Severity | LOW |
| Priority | P3 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Minor / High / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Scheduled reminders |
| Affected files | `supabase/functions/due-reminders/index.ts:L36-L80,L82-L121` |
| Relevant functions | `due-reminders handler` |
| Graph node IDs | `fn:due-reminders`, `job:due-reminders`, `tbl:tasks`, `tbl:content_posts` |
| Related workflows | Notifications and push |
| Related tables | `tasks`, `content_posts`, `notifications` |
| Fix package | FX-15 |
| Status | Open |

**Description.** The task query has no ORDER BY, so 'Next:' shows whichever overdue task came first, not the earliest due. Tasks and posts overdue for months are counted every day. profiles lookups use .in('id', [all ids]) which grows the request URL; beyond a few hundred users it can fail and the digest is silently skipped. Dedupe is read-then-insert (race only if run concurrently).

**Root cause.** Simple implementation without ordering or batching.

**Reproduction (safe).** Create two overdue tasks and run the function.

**Impact.** Misleading reminders, noise, scale limit.

**Fix.** ORDER BY due_date; cap digest to tasks overdue < 30 days or show count only; chunk IN lists (200); store a per-day dedupe key.

**Acceptance criteria.** Digest names the earliest due task; chunking covers 1000 users.

**Required tests.** Function test with fixtures.

**Verification method.** Run against staging data.

**Why this classification.** Low: quality issue.

---

### FUN-05 — Content posts can be published or assigned without approval or role checks

| Field | Value |
|---|---|
| Category | Functional |
| Severity | LOW |
| Priority | P3 |
| Confidence | Potential |
| Impact / Likelihood / Effort | Minor / Low / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Content plans |
| Affected files | `supabase/functions/content-plan/index.ts:L80-L99,L115-L132` |
| Relevant functions | `post.assign`, `post.publish` |
| Graph node IDs | `fn:content-plan`, `tbl:content_posts` |
| Related workflows | Client content approval |
| Related tables | `content_posts`, `content_plans` |
| Fix package | FX-15 |
| Status | Open |

**Description.** post.publish sets status 'published' for any editor or assigned publisher regardless of plan status (client approval not required) and post.assign accepts any active profile, including one holding only the client role. The business rule is not documented.

**Root cause.** No status/approval state machine for posts.

**Reproduction (safe).** Publish a post in a plan not approved.

**Impact.** Posts can go live without client approval (if approval is required by the business).

**Fix.** Decide the rule; if approval is required, reject publish unless plan.status='approved'; require auth_is_staff for the publisher.

**Acceptance criteria.** Rule enforced and tested.

**Required tests.** Edge tests.

**Verification method.** Test in staging.

**Why this classification.** Low/Potential: depends on spec.

---
