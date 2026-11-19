# Graph Report - src  (2026-11-06)

## Corpus Check
- 115 files · ~134,898 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1163 nodes · 2818 edges · 62 communities (45 shown, 17 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 5 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]

## God Nodes (most connected - your core abstractions)
1. `getSupabase()` - 118 edges
2. `escapeHTML()` - 94 edges
3. `ChatModule` - 59 edges
4. `DrivePanel` - 50 edges
5. `ContentPlanEditor` - 46 edges
6. `formDialog()` - 45 edges
7. `TasksModule` - 32 edges
8. `CallService` - 30 edges
9. `Toast` - 29 edges
10. `confirmDialog()` - 28 edges

## Surprising Connections (you probably didn't know these)
- `planColours()` --calls--> `pick()`  [INFERRED]
  js/utils/plan-slide.js → supabase/functions/finance/index.ts
- `BADGE` --calls--> `escapeHTML()`  [EXTRACTED]
  js/modules/campaigns/content-plan.js → js/utils/helpers.js
- `message()` --calls--> `escapeHTML()`  [EXTRACTED]
  js/preview/preview.js → js/utils/helpers.js
- `checkInviteSession()` --calls--> `getSupabase()`  [EXTRACTED]
  js/auth/invitation.js → js/supabase-client.js
- `departmentOptions()` --calls--> `getSupabase()`  [EXTRACTED]
  js/modules/campaigns/content-plan.js → js/supabase-client.js

## Import Cycles
- None detected.

## Communities (62 total, 17 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (94): PAGES, SENDER_ROLES, DONE, KIND, WEEKDAYS, WEEKENDS, STATUS_LABEL, STATUS_TONE (+86 more)

### Community 1 - "Community 1"
Cohesion: 0.08
Nodes (50): BADGE, PLATFORMS, contain(), exportPlanToPptx(), fetchCropped(), fetchImage(), hex(), loadLibrary() (+42 more)

### Community 2 - "Community 2"
Cohesion: 0.08
Nodes (8): canEditPlan(), colourFields(), ContentPlanEditor, ContentPlansSection, departmentOptions(), extOf(), pad(), ymd()

### Community 4 - "Community 4"
Cohesion: 0.09
Nodes (5): DrivePanel, extOf(), kindOf(), sizeText(), wait()

### Community 5 - "Community 5"
Cohesion: 0.07
Nodes (27): protectPage(), redirectIfLoggedIn(), Auth, alertBox, alertText, btnSpinner, btnText, checkInviteSession() (+19 more)

### Community 6 - "Community 6"
Cohesion: 0.13
Nodes (34): callStart(), notifyMembers(), recipientsOf(), notify(), userIdsWithRoles(), ADMIN_LEVEL_ROLES, employeeUpdate(), EMPLOYMENT_STATUSES (+26 more)

### Community 7 - "Community 7"
Cohesion: 0.11
Nodes (3): groupOf(), TasksModule, formatPriorityBadge()

### Community 8 - "Community 8"
Cohesion: 0.15
Nodes (14): ACTIONS, ADMIN_LEVEL, ADMIN_ROLES, adminClient(), env(), getCaller(), MANAGER_ROLES, requireStaff() (+6 more)

### Community 10 - "Community 10"
Cohesion: 0.14
Nodes (25): assert_folder(), base64url_decode_strict(), chunk_bytes(), chunks_dir(), clean_display_name(), detect_file_type(), ensure_folder(), ensure_folder_path() (+17 more)

### Community 11 - "Community 11"
Cohesion: 0.19
Nodes (8): addDays(), CalendarModule, diffDays(), monthName(), pad(), parse(), prettyDate(), ymd()

### Community 12 - "Community 12"
Cohesion: 0.12
Nodes (4): openModal(), today(), ClientsTab, InvoicesTab

### Community 13 - "Community 13"
Cohesion: 0.14
Nodes (6): brandTone(), ClientHubModule, clientName(), day(), iso(), todayISO()

### Community 14 - "Community 14"
Cohesion: 0.16
Nodes (3): BroadcastModule, canBroadcast(), PulseStudioApp

### Community 16 - "Community 16"
Cohesion: 0.20
Nodes (6): buildMatrix(), buildSVG(), drawQR(), normalizeLink(), QrModule, wrap()

### Community 17 - "Community 17"
Cohesion: 0.15
Nodes (12): FinancePdf, fontCache, drawable(), drawBidi(), hasArabic(), isolateNumbers(), measure(), MIRROR (+4 more)

### Community 18 - "Community 18"
Cohesion: 0.18
Nodes (11): ACTIONS, AUDIENCES, SENDER_ROLES, ACTIONS, KINDS, email(), oneOf(), optText() (+3 more)

### Community 20 - "Community 20"
Cohesion: 0.14
Nodes (16): BILLING_FIELDS, canFinance(), canSenior(), FINANCE_ROLES, friendly(), INVOICE_FIELDS, invoicePayload(), ITEM_FIELDS (+8 more)

### Community 21 - "Community 21"
Cohesion: 0.29
Nodes (14): channelArchive(), channelCreate(), channelDelete(), channelMembers(), channelUpdate(), dmCreate(), loadChannel(), MEDIA_TYPES (+6 more)

### Community 22 - "Community 22"
Cohesion: 0.21
Nodes (6): AuthService, getCurrentUser(), getSupabase(), callFunction(), invoke(), RealtimeService

### Community 25 - "Community 25"
Cohesion: 0.14
Nodes (7): db, fq(), items, M, old, save(), U

### Community 26 - "Community 26"
Cohesion: 0.19
Nodes (11): reactionToggle(), ACTIONS, driveClients(), driveConfig(), Scope, SCOPES, signToken(), toBase64Url() (+3 more)

### Community 27 - "Community 27"
Cohesion: 0.15
Nodes (12): 1. Architectural Overview, 2.1 Identity & Access Control (9 Tables), 2.2 Task Management & Lifecycle (9 Tables), 2.3 Projects & Studio Campaigns (7 Tables), 2.4 CRM & Client Accounts (5 Tables), 2.5 HR Operations (5 Tables), 2.6 Finance & Expenses (5 Tables), 2.7 Communication & Collaboration (4 Tables) (+4 more)

### Community 28 - "Community 28"
Cohesion: 0.15
Nodes (12): 1. What people get, 2.1 Database, 2.2 VAPID keys (identify your server to push services), 2.3 Supabase secrets, 2.4 Deploy the functions, 2.5 Vercel, 2.6 Daily deadline reminders, 2. One-time server setup (+4 more)

### Community 30 - "Community 30"
Cohesion: 0.17
Nodes (11): 1. Architecture, 2. Deploying on Vercel (recommended path), 3. Other hosts (Apache / Nginx), 4. Pre-flight, 5. Releasing changes, 6. Monitoring, Apache / Hostinger, Netlify / Cloudflare Pages (+3 more)

### Community 31 - "Community 31"
Cohesion: 0.17
Nodes (11): 1. Overview, 2.1 Hostinger / Apache (`.htaccess`), 2.2 Nginx Server Block (if using VPS), 2. Server-Side Security Configuration (Essential), 3. Embedding into Google Sites (Step-by-Step), 4. Standalone Access Link, PULSE STUDIO OS — Google Sites Embedding Guide, Step 3.1: Copy Your Standalone Application URL (+3 more)

### Community 33 - "Community 33"
Cohesion: 0.17
Nodes (11): 1. System Mission & Core Capabilities, 2. Technical Stack, 3. Key Modules, 4.1 Clone or Download, 4.2 Configure Database, 4.3 Configure Credentials, 4.4 Launch, 4. Quickstart Guide (+3 more)

### Community 34 - "Community 34"
Cohesion: 0.17
Nodes (9): buildId, ice, key, precache, SKIP, sw, url, vapid (+1 more)

### Community 35 - "Community 35"
Cohesion: 0.18
Nodes (10): 1. Overview, 2. Prerequisites, 3. Database, 4. Auth settings (do this before anyone logs in), 5. Edge Functions, 6. Front-end configuration, 7. Create the first administrator (once), 8. Run locally (+2 more)

### Community 36 - "Community 36"
Cohesion: 0.18
Nodes (10): 1. Create the shared secret, 2. Hostinger, 3. Supabase, 4. Kite System, 5. Link a client and test, 6. Protect the file links, How it works, Kite Drive connection (+2 more)

### Community 38 - "Community 38"
Cohesion: 0.20
Nodes (9): 1. Supabase project, 2. Edge Functions, 3. Web host, 4. Role smoke test (use real accounts), 4b. PWA & push (see docs/pwa-and-notifications.md), 5. Re-verify the access model after any change to policies, 6. Operations, 7. Not included (decide consciously) (+1 more)

### Community 40 - "Community 40"
Cohesion: 0.27
Nodes (9): configure(), isAllowedPushEndpoint(), PUSH_HOSTS, pushConfigured(), PushPayload, sendPush(), prunePushSubscriptions(), pushSubscribe() (+1 more)

### Community 41 - "Community 41"
Cohesion: 0.22
Nodes (8): Deploy (in this order), ETA (Egyptian e-invoice), later, Finance module, How the money is calculated (server side, `NUMERIC`), Invoice life cycle, PDF, Tests, Who can do what

### Community 42 - "Community 42"
Cohesion: 0.22
Nodes (8): 1. Principles, 2. Who can see and do what, 3. Threats considered and how they are handled, 4. Where business logic lives, 4b. Push notifications, 5. Known limitations (be aware, not blockers), 6. Verification, PULSE STUDIO OS — Security & Access Control Architecture

### Community 46 - "Community 46"
Cohesion: 0.25
Nodes (7): dependencies, @electric-sql/pglite, name, private, scripts, test, type

### Community 47 - "Community 47"
Cohesion: 0.25
Nodes (7): buildCommand, cleanUrls, framework, headers, outputDirectory, redirects, trailingSlash

### Community 48 - "Community 48"
Cohesion: 0.29
Nodes (6): Android notification troubleshooting, Calls: TURN server, Chat v2: private conversations, voice notes, files, calls, Deploy checklist (in this order), Features, Privacy model

### Community 52 - "Community 52"
Cohesion: 0.73
Nodes (5): calcLine(), calcTotals(), div(), toNum(), units()

### Community 53 - "Community 53"
Cohesion: 0.33
Nodes (5): name, private, scripts, build, version

## Knowledge Gaps
- **213 isolated node(s):** `inviteForm`, `passwordInput`, `confirmInput`, `submitBtn`, `btnText` (+208 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **17 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `getSupabase()` connect `Community 22` to `Community 0`, `Community 1`, `Community 2`, `Community 3`, `Community 5`, `Community 7`, `Community 9`, `Community 11`, `Community 12`, `Community 13`, `Community 14`, `Community 15`, `Community 19`, `Community 23`, `Community 24`, `Community 29`, `Community 32`, `Community 37`, `Community 39`, `Community 43`, `Community 45`, `Community 50`, `Community 51`, `Community 54`?**
  _High betweenness centrality (0.210) - this node is a cross-community bridge._
- **Why does `escapeHTML()` connect `Community 0` to `Community 1`, `Community 2`, `Community 3`, `Community 4`, `Community 7`, `Community 9`, `Community 11`, `Community 44`, `Community 13`, `Community 14`, `Community 15`, `Community 12`, `Community 49`, `Community 51`, `Community 19`, `Community 54`, `Community 29`?**
  _High betweenness centrality (0.157) - this node is a cross-community bridge._
- **Why does `planColours()` connect `Community 1` to `Community 20`?**
  _High betweenness centrality (0.155) - this node is a cross-community bridge._
- **What connects `inviteForm`, `passwordInput`, `confirmInput` to the rest of the system?**
  _213 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05053763440860215 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.07985480943738657 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.07644110275689223 - nodes in this community are weakly interconnected._