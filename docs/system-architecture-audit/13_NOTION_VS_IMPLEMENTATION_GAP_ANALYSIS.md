# 13 — Notion vs implementation gap analysis

## STATUS UPDATE (2026-11-06, later): Notion connected, but the page is EMPTY

The Notion connector now works. Fetching `Kite System` (id `4100e307-0139-808f-841c-e0ab56e82586`, last edited 2026-11-06 18:44 UTC) returns "This page is blank and has no content", and a search scoped to the page found no child pages. Other pages in the workspace (e.g. "Bazary_Notion_Workspace", "GreenQuote") are unrelated projects and were **not** used. Result: still **no Notion requirements to compare**. The analysis below remains the repo-docs-only substitute.

(Original note, before connection:) The page `Kite System` (Notion) was inaccessible. This session had no Notion integration or browser available (only a Claude Docs connector, Google tools and others unrelated to Notion). I did not guess its contents. **No requirement from that page is represented anywhere in this audit.**

To unblock, provide one of:
1. A Notion MCP/integration connected to the workspace with access to that page and its children; or
2. An export (Markdown & CSV, including subpages) placed in the repo or pasted; or
3. A PDF export of the page tree.

## Substitute: repo-documentation vs implementation (limited)
Documented source = `README.md` and `docs/*.md` (written by the same team; not the official spec). Comparison is shallow.

| Claim (repo docs) | Implementation | Status | Evidence |
|---|---|---|---|
| "Production Ready" (README badge) | no CI, no monitoring, partial tests, manual live migrations | Cannot verify / overstated | `10` OPS-01/02 |
| Frontend vanilla JS, Supabase backend, vendored libs | matches | Fully implemented | repo layout |
| Row Level Security everywhere; anon closed | grants revoked, anon revoked on newer tables (012) | Implemented (live unverified) | `002` L28–33, `012` |
| Business rules in Edge Functions, not SQL (`workflow` header) | true for tasks/leave/expense; finance maths and several guards are in SQL by design | Implemented differently | `workflow` header vs `017`, `012`, `015` |
| Money visible only to owner/CEO (`015` header) | owner-only policies + `money_figures`; later 017 grants finance tier read access | Implemented, scope widened by 017 | `015`, `017` L756+ |
| Clients scoped by department (`015`) | `auth_can_see_client` | Fully implemented | `015` |
| Kite Drive: files stay on Hostinger, token bridge (`docs/kite-drive.md`) | matches code | Fully implemented | `kite-drive`, PHP |
| Push + daily reminders need setup (`docs/pwa-and-notifications.md`) | cron/VAPID are external | Cannot verify live | `07` |
| Payroll "later" (finance header) | no payroll tables | Not implemented (planned) | `finance/index.ts` header comment |
| Five creative hubs (Branding, BTL, Digital, Media, Web) (README) | department seed data — not checked | Cannot verify | |
| Role model (README modules) | roles seeded: super_admin, owner, general_manager, hr_manager, finance_manager… `ceo` referenced but not seeded | Partially / inconsistent | ARC-01 |

Contradictions inside the repo's own documentation vs code: owner set differs from admin set (`ceo` vs `general_manager`) — intentional per 015, but not reflected in a single documented permission matrix.

## When Notion is available, check specifically
Role/permission matrix vs `roles/permissions/role_permissions` seed; task statuses and transitions vs `TRANSITIONS`; invoicing rules (VAT, withholding, numbering format); client department scoping; HR leave/attendance rules; Drive permissions (who uploads); notification catalogue; deadlines/reminder timing (`Africa/Cairo`, 07:00?); Arabic/RTL requirements; anything marked planned/out of scope.
