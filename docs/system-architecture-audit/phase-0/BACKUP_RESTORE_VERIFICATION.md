# Backup and Restore Verification

## RESULT: backups `NOT ACCESSIBLE`; restore `NOT VERIFIED` (no evidence of any tested restore)
The repository documents no backup configuration, schedule, retention or restore test. An enabled setting would not count as verified anyway.

| Area | Repository evidence | Live status | Evidence needed |
|---|---|---|---|
| Supabase DB backups / PITR | `docs/deployment.md` L57: "enable daily backups (Supabase Pro) or schedule pg_dump; **test a restore**". `production-checklist.md` L11 lists it **unchecked** | NOT ACCESSIBLE (plan tier, PITR unknown) | dashboard: plan, frequency, retention, PITR |
| Latest successful backup | none | NOT ACCESSIBLE | timestamp |
| Supabase Storage objects | no strategy documented | NOT VERIFIED | decision and export procedure |
| Hostinger PHP files (`uploads/`, thumbs) | `kite-drive.md` L27 only says "keep a backup before you start" | NOT ACCESSIBLE | panel backup schedule/retention |
| Hostinger MySQL | none | NOT ACCESSIBLE | panel or dump evidence |
| Independent off-platform copy | none | NOT VERIFIED | location and owner |
| Restore runbook | none | **missing** | written procedure |
| Restore test history | none | **none evidenced** | dated test record |

Live migration history is empty and migrations were applied by hand, so a restore also needs the exact applied-migration list (see DATABASE_SAFETY_BASELINE).

## Manual verification required (never restore over production)
1. Owner records, from the Supabase dashboard: plan, frequency, retention, latest backup timestamp, PITR on/off.
2. Restore the latest backup into a **new empty project** (or local `supabase start`), compare row counts for key tables, run the RLS suite against it, and record date, duration and operator.
3. Hostinger: record the backup schedule; restore one sample file and one MySQL dump to a scratch location; record the result.
4. Write a one-page runbook with RPO/RTO targets.
Until step 2 has a record, restore stays **NOT VERIFIED**.
