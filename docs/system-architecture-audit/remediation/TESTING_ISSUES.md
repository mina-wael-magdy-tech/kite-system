# Testing & Quality Issues

1 issues. Full fields are in MASTER_ISSUE_REGISTER.md; IDs are canonical.

| ID | Title | Sev | Pri | Confidence | Fix pkg | Status |
|---|---|---|---|---|---|---|
| TST-01 | No automated tests for Edge Functions, PHP token verification, finance rounding in the browser, or UI flows | MEDIUM | P2 | Confirmed | FX-02 | Open |

### TST-01 — No automated tests for Edge Functions, PHP token verification, finance rounding in the browser, or UI flows

| Field | Value |
|---|---|
| Category | Testing |
| Severity | MEDIUM |
| Priority | P2 |
| Confidence | Confirmed |
| Impact / Likelihood / Effort | Major / High / L |
| Evidence basis | Source/SQL read (not runtime) |
| Previous audit ID | new in this pass |
| Affected module | Testing |
| Affected files | `(absent) *.test.ts / php tests / playwright config` |
| Relevant functions | — |
| Graph node IDs | `shared:auth`, `fn:workflow`, `fn:finance`, `fn:kite-drive`, `php:index`, `fe:finance` |
| Related workflows | Task status change, Invoice lifecycle (finance), Kite Drive file access, Employee invitation to activation |
| Related tables | — |
| Fix package | FX-02 |
| Status | Open |

**Description.** The only tests are the SQL/RLS suite. There are none for getCaller's role/status matrix, workflow state machine, finance function error mapping, kite-drive token signing vs PHP verification (cross-language), upload blocklist/zip handling, or any UI flow. No concurrency tests besides SQL.

**Root cause.** Tests were added only for the database layer.

**Reproduction (safe).** Search the repo.

**Impact.** Regressions in authorization and money paths are caught only manually.

**Fix.** Add deno test for _shared and each function with a mocked service client; shared token vectors (TS signs, PHP verifies); Playwright smoke: login, create task, change status, invoice issue; run in CI (FX-02).

**Acceptance criteria.** CI runs unit, interop and smoke tests; coverage report published.

**Required tests.** As listed.

**Verification method.** CI green.

**Why this classification.** Medium: broad quality gap in security- and money-critical layers.

---
