# Phase 0 Exit Checklist

Legend: DONE = completed with evidence; BLOCKED = needs live access or an owner action (documented, with next step); the prompt allows "verified or explicitly blocked".

| Criterion | Status | Notes |
|---|---|---|
| Git state documented | DONE | GIT_AND_RELEASE_BASELINE |
| Local changes preserved | DONE | no tracked changes; untracked files untouched |
| Environments identified | DONE (partly unknown) | staging not evidenced |
| Production vs staging evidence distinguished | DONE | no live evidence exists for either |
| ARC-01 live role status verified or blocked | **BLOCKED** | `NOT VERIFIED — LIVE ACCESS REQUIRED`; queries ready |
| Backup availability verified or blocked | **BLOCKED** | NOT ACCESSIBLE |
| Restore capability verified or blocked | **BLOCKED** | no restore evidence; test procedure written |
| Scheduler state documented | DONE (repo) / live **BLOCKED** | both jobs dashboard-only |
| Testing and CI gaps documented | DONE | suite re-run 153/0; full chain builds in PGlite; no CI |
| Database migration state documented | DONE (repo) / live **BLOCKED** | live applied set unknown |
| Deployment dependencies documented | DONE | matrix |
| Performance baseline recorded where measurable | DONE (static only) | no runtime numbers measurable safely |
| Every blocker has an owner and next action | DONE | RISK register (owners are workstream roles) |

## Blockers that need a person with access (owner action)
1. Supabase dashboard/SQL access: ARC-01 queries, policy/grant/trigger counts, cron list, function and secret names, backup settings.
2. Hostinger panel/SSH: PHP limits, backups, cron, config permissions.
3. GitHub: branch protection state.
4. Decision whether a staging project exists or will be created.

**Phase 0 exit verdict: INCOMPLETE on live verification.** All repository-side work is done; the live items cannot be closed without credentials. Phase 1 should not start until at least the ARC-01 query (RISK-01) and the backup/restore record (RISK-02) are supplied, or the owner explicitly accepts the risk in writing.
