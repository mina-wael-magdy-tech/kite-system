# Kite System (pulse-studio-os) — Architecture & Technical Audit

Date: 2026-11-06 · Repo state: `main` @ `5e951e1` · Mode: read-only (no application file was modified; only this folder was added)

## READ THIS FIRST — what this audit is and is not

| Source | Status |
|---|---|
| A. Codebase | **Partially inspected.** Backend (Edge Functions shared layer, `workflow`, `finance`, `kite-drive`, `client-preview`, `accept-invitation`, `setup-admin`, cron functions), the security-relevant SQL (002 grants, 012, 015, 017, 019), the PHP Drive API, build/deploy config and the RLS test harness were read in full or in the relevant parts. **The ~25 browser modules (`js/modules/*`, ~12k lines) were NOT read line-by-line**; they were analysed only through Graphify and grep metrics. Migrations 003–011, 013, 014, 016, 018 and functions `invite-employee`, `broadcast`, `content-plan`, `due-reminders` (tail) and `chat` (beyond the dispatcher) were only skimmed. |
| B. Notion spec | **UNAVAILABLE.** Notion was connected later in the session, but the `Kite System` page is blank with no child pages, so there is no spec to compare. (Earlier: no connector was available.) `13_NOTION_VS_IMPLEMENTATION_GAP_ANALYSIS.md` therefore contains no spec comparison; it lists what is needed. The in-repo `README.md`/`docs/*.md` were used as the only available "documented" source. |
| C. Graphify | **Executed** (AST-only, no LLM; CLI 0.8.36 / package 0.8.31): 1163 nodes, 2818 edges, 62 communities, 0 import cycles. Run on a copy of tracked sources excluding `vendor/ dist/ fonts/ assets/`. Outputs in `graphify/`. Community names are placeholders ("Community N"); 17 thin communities omitted by the tool. Edges are static only. |
| Runtime evidence | **None.** I did not run the app, tests or deployed functions, and had no access to the live Supabase project, Vercel or Hostinger. All "OBSERVED" columns are empty. |

Everything below is **DOCUMENTED (repo docs) vs IMPLEMENTED (code read)**. Nothing is OBSERVED. Items marked *unverified* must not be treated as defects until checked. The Definition of Done in the brief is **not fully met** (Notion blocked, runtime absent, frontend partial). See `coverage/`.

## Update: system graphs and Notion publication (later in the same session)
- **Graph A (code):** `graphify/` — graph.html, graph.json, GRAPH_REPORT.md, plus native `GRAPH_TREE.html` and `callflow.html`. AST-only: no SQL parsed, no LLM extraction (no API key set).
- **Graph B (system architecture) and C (workflows):** `system-graph/` — 410 nodes / 1050 edges (1003 extracted with file:line evidence, 47 curated), 8 workflows. Interactive viewer: `system-graph/system-architecture.html`. See `system-graph/README.md`.
- **Notion:** published under the existing *Kite System* page: System Architecture (11 pages), System Dependencies (3), Business Workflows (6), Database & Data Flow (4), Technical Audit (7), plus a Component Map linking docs, code, Graphify communities and graph node ids. The Notion page itself was empty, so there is still no spec to compare.
- **Correction about "Graphify":** two different things share the name. (1) The `graphify` pip CLI (graphifyy 0.8.x), which I ran: a code-graph tool with no Notion feature. (2) The product at getgraphify.com / docs.getgraphify.com: a web and desktop app that connects to a Notion workspace and draws a graph of Notion pages (nodes) joined by @mentions, database relations and page links. It is not available to this session as a tool; it needs the user's own sign-in (web) or Notion token (desktop). It reads page titles, properties and links only, not page bodies, and never writes to Notion. My earlier statement that no Graphify-Notion integration exists referred only to (1) and was incomplete.
- **Notion databases for Graphify (added later):** `Architecture Graph Data` under Kite System holds three linked databases built from `system-graph.json`: Tables (68; 121 FK relations), Components (74; Calls 120, Reads 130, Writes 74) and Workflows (8). Counts were queried back from Notion and match the graph. Graphify reads titles, properties and relations only, so these databases are what let it draw the architecture. Free web plan limit is 100 pages; the workspace now has about 185.
- **Not done:** hosted link for the interactive viewer (publish step blocked by a permission prompt, not retried); Graphify semantic extraction (needs an LLM API key).
- **New findings:** DOC-01 (docs/database.md says 48 tables, migrations create 68, 19 undocumented), DOC-02 (docs and migration 003 say there is only one trigger and no SQL business logic; there are 48 trigger instances and finance logic in SQL).

## Contents
`01`–`14` numbered reports · `diagrams/` (Mermaid) · `findings/` (by severity) · `coverage/` · `graphify/` (graph.html, graph.json, GRAPH_REPORT.md)

## Executive report

1. **What is it?** A browser-only management suite for a creative agency ("Kite Design Studio"): tasks, projects, campaigns/content plans (with a public client-review link), CRM/clients, HR (leave, attendance), expenses, invoicing/retainers, chat + WebRTC calls, broadcasts, QR tool, reports, PWA with push. Plus an integration with "Kite Drive", a separate legacy PHP file-storage site on Hostinger.
2. **Architecture.** Serverless two-tier plus a satellite: static vanilla-JS ES-module SPA (Vercel, or Apache) → Supabase (Postgres + RLS, Auth, Realtime, Storage, 12 Deno Edge Functions) → Kite Drive PHP/MySQL API (Hostinger). No framework, no bundler, no server of its own.
3. **Modules.** Auth, Dashboard, Tasks, Projects, Campaigns/Content Plans, Clients/Client Hub (+Drive panel), CRM, Employees/HR, Departments, Finance, Documents, Calendar, Chat/Calls, Broadcast, Reports, Admin, QR (`03`).
4. **Connection model.** Reads: browser → Supabase REST under RLS (162 `.from()` call sites). Rule-bearing writes: browser → Edge Function (service role after in-code authorization) → Postgres. Client deliverable files: browser → Drive directly with an HMAC token minted by the `kite-drive` function.
5. **Data flow.** `diagrams/DATA_FLOW.mmd`.
6. **Hidden mechanisms.** Two daily crons configured only in the Supabase dashboard (`due-reminders`, `retainer-billing`); DB triggers that silently rewrite data (`blank_money`, `content_posts_guard`, finance guards/audit); service worker; push fan-out inside `notify()`; Drive stale-upload cleanup and thumbnail cache on Hostinger (`07`).
7. **Critical components.** `getSupabase()` (118 edges), `escapeHTML()` (94), RLS helper functions (`auth_is_*`), `_shared/auth.ts::getCaller`, the `fin_*` SQL functions, the Supabase↔Hostinger shared HMAC secret.
8. **Most dangerous dependencies.** (a) RLS correctness is the whole read-security model; (b) role-name lists duplicated in SQL, Edge Functions and JS and already inconsistent (`ceo` vs `general_manager`); (c) the shared HMAC secret; (d) crons living outside the repo.
9. **Implemented incorrectly / weakly:** findings table below. None rated CRITICAL from code reading.
10. **Incomplete:** no CI; RLS tests do not name most migrations; no frontend/Edge Function tests; no monitoring; payroll referenced as "later" in `finance` header.
11. **Production-failure causes:** cron silently unconfigured/stopped; `ALLOWED_ORIGINS` unset (functions then fail closed for every browser); Drive unreachable (502s); Drive's Apache rewrite dependency; manual migrations on live.
12. **Security risks:** public preview-token endpoint; Drive tokens in URLs; role drift; 163 `innerHTML` sites relying on manual escaping (mitigated by strict CSP). No SQL injection, committed secret, or auth bypass was found in what was read.
13. **DB integrity risks:** non-transactional cross-system link creation; money columns silently zeroed by trigger; client-delete vs invoices behaviour unverified; empty migration history on live.
14. **Performance:** not measured. No load tests exist (`11`).
15. **Reconsider:** role model in three places; dual write paths (direct RLS writes vs Edge Functions); Drive as a separate auth domain.
16–18. See roadmap.

## Findings summary (details in `findings/` and `10`)
| ID | Sev | Title |
|---|---|---|
| SEC-01 | MEDIUM | Public `client-preview`: per-plan-only rate limit, non-atomic, notification flooding, link holder can change plan status |
| SEC-02 | MEDIUM | Drive tokens accepted in query string |
| ARC-01 | MEDIUM | Role lists duplicated and inconsistent across SQL / Edge / JS |
| DAT-01 | MEDIUM | `kite-drive link.create` is a non-transactional two-system write |
| OPS-01 | MEDIUM | Scheduled jobs exist only in Supabase dashboard; no monitoring |
| OPS-02 | MEDIUM | No CI; RLS test script manual, names only part of the migration set |
| DAT-02 | LOW | Silent data discard by `blank_money` trigger; legacy money columns remain |
| SEC-03 | LOW | Notification-trigger endpoints replayable for 10 min |
| SEC-04 | LOW | `readJson` size check after full read; counts chars not bytes |
| SEC-05 | LOW | `innerHTML` surface (163 sites) |
| OPS-03 | LOW | Drive `_log/actions.log` and `_thumbs/` grow unbounded |
| DAT-03 | LOW (unverified) | Client delete vs invoice FK/guard-trigger interplay |

## Roadmap
- **P0:** none from evidence. First obtain Notion access and run `coverage/UNVERIFIED_AREAS.md`, especially the `012` check queries against live and confirming crons.
- **P1:** SEC-01; OPS-02 (CI running `verify-rls.mjs` over all migrations); ARC-01 (single role source); OPS-01 (cron definitions in repo + heartbeat alert).
- **P2:** SEC-02 (one-time/POST handshake); DAT-01 (compensating delete); DAT-02; Drive log rotation; frontend and Edge Function tests.
- **P3:** consolidate write paths; Drive SSO or unified auth; observability; typed API contract.
