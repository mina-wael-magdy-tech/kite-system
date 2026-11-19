# Testing and CI Baseline

Revalidated 2026-11-07, locally, read-only (no repo file changed).

## Executed
| Check | Result | Class |
|---|---|---|
| `cd supabase/tests && node verify-rls.mjs` | **153 passed, 0 failed** (re-run today; matches the earlier result) | LOCAL, runtime |
| Throwaway script (scratchpad, outside repo) applying **all 19 migrations in order** to an in-memory PGlite with Supabase-style stubs | all 19 apply cleanly once `auth`, `storage` and a minimal `realtime` stub exist (without the `realtime` stub, 016 and 018 fail: a stub gap, not a migration defect). Result: 68 public tables, **0 without RLS**, 175 policies (public+storage), 44 triggers, 44 public functions, 141 foreign keys, **0 SECURITY DEFINER functions without `search_path`**, 0 grants to `anon` | LOCAL, runtime |

Caveat: this is a stubbed PGlite, not Postgres 15 with real Supabase extensions/roles; it shows the SQL is internally consistent, not that it matches the live database. The trigger count (44) differs from the 48 quoted in the earlier graph; the counting method may differ, to be confirmed by live check A6.

## The seven questions
| # | Question | Answer |
|---|---|---|
| 1 | Does the test schema match the complete migration chain? | **No.** The suite applies only 001-005, 016, 017 (+ seed and demo seed). Migrations 006-015, 018, 019 are never exercised (OPS-02). |
| 2 | Can a clean database be built from all migrations? | **Yes**, in PGlite with stubs (above). Not yet shown on real Postgres/Supabase. |
| 3 | Are all important roles covered? | Fixtures cover admin, employee x2, hr, finance, suspended, client, stranger. No owner, general_manager, department_manager, team_leader, project_manager, accountant fixtures seen. |
| 4 | Are unauthorized operations tested? | Yes for many table-level RLS cases on the covered migrations; not for the chain after 017 beyond what 016/017 include. |
| 5 | Are Edge Function authorization checks covered? | **No.** No Deno/function tests exist. ARC-01 paths are untested. |
| 6 | Does CI run automatically? | **No.** No `.github/` or other CI config in the repo. |
| 7 | Can an unsafe change be merged without passing tests? | **Yes** from repo evidence (no workflow, no required checks visible). Branch protection on GitHub is **NOT ACCESSIBLE**. |

## Other test layers
| Layer | Found |
|---|---|
| Edge Function tests | none |
| PHP integration tests | none |
| Frontend/unit/e2e tests | none (`package.json` has only `build`) |
| Deployment checks | build-time guards in `scripts/build.mjs` (URL shape, anon-key not service_role, VAPID/ICE format) |

Gap list for later phases (not acted on now): CI running the RLS suite on every push; suite extended to the full chain; role matrix over functions; PHP and e2e smoke tests.
