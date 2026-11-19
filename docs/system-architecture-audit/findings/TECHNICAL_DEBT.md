# Technical debt
- **DOC-01 (LOW):** `docs/database.md:16` says "48 Tables"; migrations 001-019 create 68. 19 tables are not mentioned in that doc (push_subscriptions, task_links, content_plans, content_plan_shares, content_posts, content_post_assets, content_feedback, client_departments, broadcasts, money_figures, message_reactions, finance_settings, client_billing, retainer_plans, invoice_items, invoice_payments, invoice_number_seq, finance_audit_log, client_drive_links).
- **DOC-02 (LOW):** `docs/database.md:87`, `docs/security.md:6` and the header of `migrations/003_updated_at.sql` say there is only one trigger and no business logic in SQL. The code has 48 trigger instances across 8 trigger functions and runs finance maths, numbering, freezing and delete blocking in SQL (017) and money blanking in a trigger (015).
- LOW: DAT-02 (zeroed legacy money columns), SEC-03, SEC-04, SEC-05, OPS-03, DAT-03 (unverified).
- Demo/test tooling in repo: `supabase/seed-finance-demo.sql`, `supabase/maintenance/remove-test-data.sql`, `docs/finance-poc/*`.
- Constants duplicated across layers: upload limits (`js/config.js` vs `004_storage.sql`), role lists (ARC-01), PROFILE_COLUMNS vs column GRANT in `002`.
- Vendored libraries (`vendor/*`, minified) have no recorded versions/hashes besides the pinned Supabase import in functions (`npm:@supabase/supabase-js@2.118.0`); dependency audit not possible offline.
- No TODO/FIXME markers in `js/`, `supabase/`, `integrations/`.
- Graphify 0.8.36 skill vs 0.8.31 package mismatch warning (tooling only).
