# 12 — Testing & quality

## Inventory
| Layer | Tests | Evidence |
|---|---|---|
| RLS / DB | `supabase/tests/verify-rls.mjs` (≈490 lines, PGlite in-process Postgres with Supabase stubs; attacks policies as different users; includes finance 017 scenarios incl. "017 can be run twice") | manual: `npm install && node verify-rls.mjs` |
| Edge Functions | none | no `*.test.ts` |
| PHP Drive API | none | |
| Browser | none (no unit/component/E2E, no linter config in repo) | |
| Performance / security scans | none | |
| CI | none | no `.github/` |

Coverage percentage: **not available** (no coverage tooling).

## What the RLS harness covers (as read)
Applies 001–005 + `seed.sql`, then 016 and 017 are named explicitly. Migrations 006–015, 018, 019 are **not named** — including 012 (post guard / feedback), 015 (owner-only money, client department scope, blank_money) and 019 (drive links). Whether they run indirectly (e.g. via loops) was not confirmed; treat as a gap until proven (UNVERIFIED #7). Positive: the harness also checks idempotency of 017.

## Critical untested workflows (by risk)
1. Client-preview public endpoint (rate limit, state change, token expiry).
2. `getCaller` role/status matrix (suspended/onboarding/client users) and role-list parity SQL↔Edge↔JS.
3. Kite Drive: token signing ↔ PHP verification interop (cross-language), scope enforcement per action, upload blocklist, zip handling, path resolution.
4. Task state machine (`TRANSITIONS`, review gating, admin override).
5. Finance: totals/VAT/withholding rounding, gapless numbering under concurrency, payment reversal.
6. Cron idempotency (digest 20 h guard, retainer uniqueness).
7. Frontend escaping (`escapeHTML`) and RTL/Arabic (PDF bidi helpers).
8. Concurrency: parallel invoice issue, parallel accept-invitation, feedback burst.

## Prioritized plan
- **P1:** CI (GitHub Actions) running `verify-rls.mjs` over every migration in order against a fresh PGlite; add `deno test` for `_shared/*` and each function's authorization table (mock `adminClient`).
- **P1:** PHP token vectors test (shared fixtures: TS signs, PHP verifies — expired, wrong aud, wrong scope, tampered, cid mismatch).
- **P2:** Unit tests for `escapeHTML`, `money`, `permission-service`; E2E smoke (Playwright) for login → task create → status change; Drive happy path against a local PHP.
- **P2:** Concurrency tests using PGlite or a Supabase branch.
- **P3:** Linting (ESLint with no-unsanitized), dependency audit, accessibility checks.
