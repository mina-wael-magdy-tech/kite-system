# 09 — Dependency & impact analysis

Evidence: Graphify AST graph (`graphify/graph.json`, `GRAPH_REPORT.md`). **All edges are static (EXTRACTED); 5 INFERRED (avg confidence 0.8). Runtime/dynamic wiring (string-keyed module registry, Edge Function names, SQL function names called by string) is invisible to the graph** — those links below are marked *manual*.

## Graph facts
1163 nodes · 2818 edges · 62 communities (45 shown) · **0 import cycles** · communities are unnamed ("Community N").
God nodes: `getSupabase()` 118, `escapeHTML()` 94, `ChatModule` 59, `DrivePanel` 50, `ContentPlanEditor` 46, `formDialog()` 45, `TasksModule` 32, `CallService` 30, `Toast` 29, `confirmDialog()` 28.

Interpretation:
- `getSupabase()` is the single data-access gateway: 118 call sites across modules (matches 162 `.from()` use). Failure/misconfig → every module breaks (returns null if `env.js` isn't configured). *Single point of failure, by design.*
- `escapeHTML()` is the XSS defence; 94 direct graph edges → any change in behaviour affects most views. Treat as a security-critical util; needs unit tests.
- `ChatModule`, `DrivePanel`, `ContentPlanEditor`, `TasksModule` are large classes (59/50/46/32 edges; 1194/904/1094/1081 lines) → God-class candidates.
- Communities that matched real subsystems: finance-PDF/bidi text; chat functions (`channelCreate`…) which are *Edge Function* code in the same graph; Kite Drive PHP functions; docs headings (communities 27, 28, 30, 31, 33, 35 are Markdown docs); community 25 is the RLS test script.
- "Surprising connection" `planColours()` → `pick()` (`js/utils/plan-slide.js` → `supabase/functions/finance/index.ts`) is **INFERRED by name collision** — not a real dependency (browser code cannot import an Edge Function). Treat as false positive.
- No disconnected-module analysis beyond tool output; thin communities (17) omitted by the tool.

## Manual cross-layer dependencies (not in graph)
| From | To | Mechanism |
|---|---|---|
| `drive-panel.js` | `kite-drive` function | `callFunction('kite-drive')` |
| `kite-drive` function | Hostinger PHP | HTTPS + shared HMAC secret + CORS list |
| Finance UI | `finance` function → `fin_*` RPC | string names |
| every function | `_shared/auth.ts` | import; `getCaller`, `notify`, `audit` |
| all browser modules | RLS predicates | implicit |
| `js/config.js` `PROFILE_COLUMNS` | `002` column GRANT | must match (comment says so) |
| `js/config.js` limits | `004_storage.sql` bucket limits | must match |
| role arrays in JS | role arrays in SQL/Edge | duplicated (ARC-01) |

## Change-impact matrix
| Change | Affects | Tables | Endpoints | Background |
|---|---|---|---|---|
| `getCaller` / roles query | all 11 authenticated functions | profiles, user_roles, roles | all | cron unaffected (secret) |
| `auth_is_*` SQL | every RLS read in browser and `userClient` calls | all | PostgREST + workflow/kite-drive | — |
| `notify()` | workflow, chat, broadcast, client-preview, cron jobs, kite-drive(no) | notifications, push_subscriptions | many | digests, retainer alerts |
| `fin_*` SQL | Finance UI, retainer cron | invoices*, payments, settings, audit | finance, retainer-billing | retainer cron |
| `KITE_DRIVE_API_SECRET` | all Drive access | — | kite-drive + PHP | — |
| `escapeHTML` | most views | — | — | — |
| `blank_money` trigger | any budget/value editor | clients, projects, campaigns, departments, leads, opportunities, money_figures | PostgREST | — |
| Hosting CSP | every external call (Supabase, Drive host) | — | — | push/WebRTC unaffected by CSP? (`connect-src` governs fetch/WebSocket; not WebRTC) |

Single points of failure: Supabase project (auth+DB+functions+storage), `getSupabase`, Hostinger (only for files), CRON secret + dashboard schedule. Dependency depth: shallow (browser → function → SQL); no deep chains observed.
