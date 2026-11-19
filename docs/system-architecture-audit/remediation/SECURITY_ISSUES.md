# Security Issues

8 issues. Full fields are in MASTER_ISSUE_REGISTER.md; IDs are canonical.

| ID | Title | Sev | Pri | Confidence | Fix pkg | Status |
|---|---|---|---|---|---|---|
| SEC-01 | Public client-preview endpoint: weak throttling, non-atomic limit, link-holder can change plan state | MEDIUM | P1 | Confirmed | FX-04 | Open |
| SEC-02 | Kite Drive tokens accepted in URL query strings | MEDIUM | P2 | Confirmed | FX-05 | Open |
| SEC-06 | Asset library paths are not bound to the uploader; storage read access derives from user-editable rows | MEDIUM | P2 | Strong Evidence | FX-02, FX-08 | Open |
| SEC-07 | No rate limiting on authenticated actions that trigger push notifications | LOW | P2 | Confirmed | FX-04, FX-11 | Open |
| SEC-03 | Client-triggered notification endpoints are replayable or unverified | LOW | P3 | Confirmed | FX-11 | Open |
| SEC-04 | Request body size guard reads whole body and counts characters | LOW | P3 | Confirmed | FX-15 | Open |
| SEC-05 | innerHTML surface relies on manual escaping | LOW | P3 | Potential | FX-09 | Open |
| SEC-08 | Employee directory exposes phone, joining date and employment type to all staff | LOW | P3 | Potential | FX-01 | Open |

### SEC-01 — Public client-preview endpoint: weak throttling, non-atomic limit, link-holder can change plan state

| Field | Value |
|---|---|
| Category | Security |
| Severity | MEDIUM |
| Priority | P1 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Moderate / Medium / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | SEC-01 |
| Affected module | Content plans / client review |
| Affected files | `supabase/functions/client-preview/index.ts:L17,L87-L130`<br>`supabase/functions/content-plan/index.ts:L65-L74`<br>`supabase/config.toml:L69-L70` |
| Relevant functions | `client-preview (feedback, approve_all)`, `content-plan share.enable` |
| Graph node IDs | `fn:client-preview`, `fe:preview`, `tbl:content_plan_shares`, `tbl:content_feedback`, `tbl:content_plans`, `tbl:notifications` |
| Related workflows | Client content approval, Notifications and push |
| Related tables | `content_plan_shares`, `content_feedback`, `content_plans`, `notifications` |
| Fix package | FX-04 |
| Status | Open |

**Description.** The unauthenticated function limits feedback to 60/hour per plan using a count query followed by a separate insert. approve_all and change requests set plan status with no confirmation or idempotency. Every accepted call notifies all admins, the creator and the publisher, each with push. Share links default to never expiring (days=0 in content-plan) and the token is returned to any department member who can edit the plan.

**Root cause.** The only abuse control is a per-plan counter that is read and written in two steps; the share token is a bearer credential with no expiry, rotation or per-client throttle.

**Reproduction (safe).** On a test project: create a plan, enable sharing, then POST {action:'approve_all'} and 70 'feedback' calls (use a script against a non-production project). Observe status flips, >60 rows when parallel, and one notification per admin per call.

**Impact.** A forwarded or leaked link lets a third party approve or reject a plan and generate up to 60 x (admins+2) notifications and pushes per hour per plan. Concurrent requests exceed the limit. No data exfiltration: 'get' returns presentation fields and 1-hour signed image URLs.

**Fix.** 1) Add table content_feedback_rate(plan_id, window_start, n) updated with INSERT ... ON CONFLICT DO UPDATE ... RETURNING n so the limit is atomic; add a per-IP key (x-forwarded-for hash). 2) approve_all becomes a no-op when status is already approved. 3) share.enable default expiry 30 days; regenerate token on staff request and when the creator leaves. 4) Coalesce feedback notifications (one per plan per 10 minutes). 5) Staff UI shows link expiry and a Revoke button.

**Acceptance criteria.** Parallel burst of 200 calls yields at most the configured number of rows; second approve_all returns 200 without notifying; link with expiry returns 410 after expiry; revoke returns 404.

**Required tests.** Deno test with 50 concurrent requests; SQL test for the atomic counter; test that expired/disabled tokens return 410/404; notification-count assertion.

**Verification method.** Run the burst test against a staging project; confirm audit_logs and notifications counts equal the limit.

**Why this classification.** Medium: public write path with real (internal) notification amplification and state change, but no confidentiality loss and requires possession of a 192-bit token.

---

### SEC-02 — Kite Drive tokens accepted in URL query strings

| Field | Value |
|---|---|
| Category | Security |
| Severity | MEDIUM |
| Priority | P2 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Moderate / Medium / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | SEC-02 |
| Affected module | Kite Drive |
| Affected files | `integrations/kite-drive/api/index.php:L447-L449`<br>`js/modules/clients/drive-panel.js:L164,L263,L598`<br>`supabase/functions/kite-drive/index.ts:L24-L33` |
| Relevant functions | `PHP verify_token/query token path`, `DrivePanel url builders` |
| Graph node IDs | `php:index`, `fn:kite-drive`, `fe:clients`, `ext:hostinger` |
| Related workflows | Kite Drive file access |
| Related tables | `client_drive_links` |
| Fix package | FX-05 |
| Status | Open |

**Description.** For download, view, thumb, zip and logo the HMAC token is read from ?token=. Tokens live 120-600 s and are scoped, but they appear in Hostinger access logs, browser history and any proxy. A 'view' token exposes every file of that client for up to 10 minutes.

**Root cause.** <img> and navigation requests cannot send headers, so the design put the token in the URL.

**Reproduction (safe).** Open a client's files in a test environment and inspect network requests and the Hostinger access log for token= values.

**Impact.** Anyone with log access within the token lifetime can read that client's files. Limited by short TTL and scope.

**Fix.** Exchange the token once for an HttpOnly, SameSite=None; Secure cookie scoped to /api/ (PHP sets it on a header-authenticated 'session' action); read file actions from the cookie. Alternative: single-use per-file URLs (nonce stored 60 s). Add Referrer-Policy: no-referrer and strip token from access logs. Deploy order: PHP accepts both, then SPA switches, then remove query path.

**Acceptance criteria.** No request URL contains token=; replayed cookie after 10 minutes returns 401; cross-client file access returns 403.

**Required tests.** PHP test vectors for cookie auth, expiry and cid binding; browser E2E for preview/download.

**Verification method.** Grep access log for 'token=' after deploy: zero matches.

**Why this classification.** Medium: credential exposure channel with short validity and scope; requires log or history access.

---

### SEC-06 — Asset library paths are not bound to the uploader; storage read access derives from user-editable rows

| Field | Value |
|---|---|
| Category | Security |
| Severity | MEDIUM |
| Priority | P2 |
| Confidence | Strong Evidence |
| Impact / Likelihood / Effort | Moderate / Low / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Asset library / storage |
| Affected files | `supabase/migrations/007_assets_and_realtime.sql:L24-L83`<br>`supabase/migrations/012_security_hardening.sql:L33-L55 (same class fixed for content assets)` |
| Relevant functions | `assets_insert / assets_update policies`, `studio_assets_read storage policy` |
| Graph node IDs | `tbl:assets`, `bkt:studio-assets`, `fe:documents`, `ext:postgrest` |
| Related workflows | — |
| Related tables | `assets`, `content_post_assets` |
| Fix package | FX-02, FX-08 |
| Status | Open |

**Description.** studio_assets_read lets any authenticated user read an object in studio-assets if an assets row with that storage_path is visible to them. assets_insert/assets_update only require uploaded_by = auth.uid(); storage_path is unconstrained (the comment says '<uploader id>/...' but nothing enforces it). A user who learns another object's path can insert their own assets row pointing at it and then read the file; also an existence oracle via the UNIQUE violation. Migration 012 closed exactly this class for content_post_assets only.

**Root cause.** Authorization of a storage object is delegated to a row the caller can create.

**Reproduction (safe).** Staging: user A creates a private asset; user B inserts an assets row with A's storage_path and requests a signed URL.

**Impact.** Revocation bypass and cross-user file access when a path is known (paths are random, so needs a leak: past access, logs, shared screenshots).

**Fix.** Migration: CHECK (storage_path LIKE uploaded_by::text || '/%') NOT VALID then VALIDATE; update assets_insert/assets_update WITH CHECK to require the prefix; trigger forbidding storage_path changes on UPDATE; add the scenario to the RLS suite.

**Acceptance criteria.** Insert/update with a foreign prefix fails; suite scenario passes; existing rows validated or listed for cleanup.

**Required tests.** RLS scenario: foreign-path insert denied; update of storage_path denied.

**Verification method.** SELECT count(*) FROM assets WHERE split_part(storage_path,'/',1) <> uploaded_by::text;

**Why this classification.** Medium: defence-in-depth gap of a class the team already judged worth fixing; exploitation needs path knowledge.

---

### SEC-07 — No rate limiting on authenticated actions that trigger push notifications

| Field | Value |
|---|---|
| Category | Security |
| Severity | LOW |
| Priority | P2 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Minor / Medium / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Chat / notifications |
| Affected files | `supabase/functions/chat/index.ts:L248-L273,L326-L350`<br>`supabase/functions/workflow/index.ts:L543-L576`<br>`supabase/functions/_shared/auth.ts (notify)` |
| Relevant functions | `messageSend`, `callStart`, `taskComment` |
| Graph node IDs | `fn:chat`, `fn:workflow`, `shared:auth`, `shared:push`, `tbl:notifications` |
| Related workflows | Notifications and push |
| Related tables | `notifications`, `messages`, `conversation_members` |
| Fix package | FX-04, FX-11 |
| Status | Open |

**Description.** Only broadcast (10/hour) and client-preview are throttled. Any staff member can call chat call.start in a public channel repeatedly: each call inserts a call message and sends an urgent requireInteraction push to every member. message.send, task.comment and task.file_added have no limits.

**Root cause.** No shared limiter in the Edge layer.

**Reproduction (safe).** Staging: loop call.start 50 times in a channel with several members.

**Impact.** Harassment/denial of attention by a malicious or compromised staff account; push-service quota consumption.

**Fix.** Add a rate_limits table with atomic upsert (key, window, n) and helper rateLimit(caller, action, max, windowSec) in _shared; apply to message.send (30/min), call.start (3/min per conversation), comments, push.test.

**Acceptance criteria.** Exceeding the limit returns 429; limits covered by tests.

**Required tests.** Edge tests with burst calls.

**Verification method.** Burst test in staging.

**Why this classification.** Low: internal users only; real but limited impact.

---

### SEC-03 — Client-triggered notification endpoints are replayable or unverified

| Field | Value |
|---|---|
| Category | Security |
| Severity | LOW |
| Priority | P3 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Minor / Medium / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | SEC-03 |
| Affected module | Notifications |
| Affected files | `supabase/functions/workflow/index.ts:L564-L576,L582-L614` |
| Relevant functions | `leaveSubmitted`, `expenseSubmitted`, `taskFileAdded` |
| Graph node IDs | `fn:workflow`, `shared:auth`, `tbl:notifications` |
| Related workflows | Expense and leave approval, Notifications and push |
| Related tables | `notifications`, `leave_requests`, `expenses` |
| Fix package | FX-11 |
| Status | Open |

**Description.** leave.submitted and expense.submitted verify ownership but allow repeated calls within 10 minutes. task.file_added performs no check that an attachment exists: any user who can see a task can send 'X uploaded <free text>' to all participants, repeatedly.

**Root cause.** Notifications are driven by browser calls rather than by the database event.

**Reproduction (safe).** Call task.file_added twice with arbitrary fileName; both notify.

**Impact.** Nuisance and message spoofing inside a task audience.

**Fix.** Insert a notifications dedupe key (type+entity+recipient) with a unique index and ON CONFLICT DO NOTHING; verify an attachment row for file_added; or move to DB triggers/outbox (FX-11).

**Acceptance criteria.** Second identical call creates no notification; file_added without an attachment returns 404.

**Required tests.** Edge tests for replay and missing attachment.

**Verification method.** Count notifications after replay.

**Why this classification.** Low: internal audience, no data exposure.

---

### SEC-04 — Request body size guard reads whole body and counts characters

| Field | Value |
|---|---|
| Category | Security |
| Severity | LOW |
| Priority | P3 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Minor / Low / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | SEC-04 |
| Affected module | Edge shared |
| Affected files | `supabase/functions/_shared/http.ts:L44-L46` |
| Relevant functions | `readJson` |
| Graph node IDs | `shared:http` |
| Related workflows | — |
| Related tables | — |
| Fix package | FX-15 |
| Status | Open |

**Description.** readJson awaits req.text() before comparing text.length (characters) to maxBytes; finance allows 200 000.

**Root cause.** Check after full read.

**Reproduction (safe).** Send a multi-megabyte body; platform limits apply first.

**Impact.** Weak resource bound.

**Fix.** Check Content-Length first and read via a capped stream; compare bytes.

**Acceptance criteria.** 413 returned before the body is buffered.

**Required tests.** Unit test with oversized body and multi-byte text.

**Verification method.** Test in staging.

**Why this classification.** Low: platform limits mitigate.

---

### SEC-05 — innerHTML surface relies on manual escaping

| Field | Value |
|---|---|
| Category | Security |
| Severity | LOW |
| Priority | P3 |
| Confidence | Potential |
| Impact / Likelihood / Effort | Moderate / Low / M |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | SEC-05 |
| Affected module | Frontend |
| Affected files | `js/utils/helpers.js:L9-L17`<br>`js/utils/linkify.js:L11-L22`<br>`js/ui/dialogs.js:L66-L82`<br>`js/router.js:L106` |
| Relevant functions | `escapeHTML`, `linkify`, `fieldHTML`, `renderBreadcrumbs` |
| Graph node IDs | `fe:utils`, `fe:ui`, `fe:shell` |
| Related workflows | — |
| Related tables | — |
| Fix package | FX-09 |
| Status | Open |

**Description.** 163 innerHTML uses vs 429 escapeHTML calls. Read in full and found correct: escapeHTML (text and quoted attribute contexts), linkify (escapes first, http/https only, entity-encoded quotes cannot break the attribute), preview.js, dialogs fieldHTML (labels/values escaped). A heuristic scan flagged 27 unescaped-looking interpolations; the 8 inspected were static labels or select labels that formDialog escapes. router.renderBreadcrumbs inserts crumbs unescaped (static today). No confirmed XSS sink.

**Root cause.** Escaping is a convention, not enforced; strict CSP (script-src 'self') is the backstop.

**Reproduction (safe).** n/a (no confirmed sink).

**Impact.** A future unescaped interpolation of user data becomes stored XSS limited by CSP (no inline script).

**Fix.** Add ESLint rule (no-unsanitized/property + a custom rule flagging template literals in innerHTML without escapeHTML); introduce html`` tagged template that escapes by default; escape breadcrumbs.

**Acceptance criteria.** Lint passes with zero unescaped interpolations of non-literal data.

**Required tests.** Lint in CI; unit tests for escapeHTML/linkify with attribute-breaking payloads.

**Verification method.** Run the lint rule over js/.

**Why this classification.** Low: no confirmed defect; strong evidence of disciplined escaping where read; remaining sites unreviewed.

---

### SEC-08 — Employee directory exposes phone, joining date and employment type to all staff

| Field | Value |
|---|---|
| Category | Security |
| Severity | LOW |
| Priority | P3 |
| Confidence | Potential |
| Impact / Likelihood / Effort | Minor / Medium / S |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Identity / privacy |
| Affected files | `supabase/migrations/002_rls_policies.sql:L246-L249,L265-L268`<br>`js/config.js (PROFILE_COLUMNS)` |
| Relevant functions | `profiles_select`, `column GRANT SELECT` |
| Graph node IDs | `tbl:profiles`, `fe:employees` |
| Related workflows | — |
| Related tables | `profiles` |
| Fix package | FX-01 |
| Status | Open |

**Description.** profiles_select allows any staff to read every profile; the column grant includes email, phone, joining_date, employment_type, manager_id and location. Whether all staff should see these is a policy decision that the empty Notion spec cannot confirm.

**Root cause.** Single directory policy for all staff.

**Reproduction (safe).** As a normal employee query profiles.

**Impact.** Privacy exposure of HR attributes to junior staff.

**Fix.** Decide per field; move sensitive fields (phone, joining_date, employment_type) to an HR-visible view or restrict via column grants plus a SECURITY DEFINER directory view.

**Acceptance criteria.** Documented decision implemented and tested.

**Required tests.** RLS scenario per role.

**Verification method.** Query as employee.

**Why this classification.** Low: possibly intended; needs the spec.

---
