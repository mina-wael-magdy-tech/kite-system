# Unverified areas — verify before acting
1. **Notion spec** — all requirement/permission/workflow comparisons. Needs export or an authorized Notion integration.
2. **Live RLS state** — run the two check queries at the bottom of `supabase/migrations/012_security_hardening.sql` against live (tables without RLS; anything `anon` can touch). Live migration history is empty (project memory), so applied state may differ from the repo.
3. **Cron configuration** — whether `due-reminders` and `retainer-billing` are scheduled, `CRON_SECRET` set, and last-run evidence.
4. **`ALLOWED_ORIGINS`** includes the production app origin (and the origin serving `preview.html`).
5. **`ceo` role** — used by `auth_is_owner()`, `auth_is_finance()`, `kite-drive` and JS, but not inserted by `seed.sql` or any migration read. Does it exist live?
6. **Client deletion** with existing invoices/payments (DAT-03): test on a scratch DB.
7. **RLS tests vs later migrations** — `verify-rls.mjs` names migrations 001–005, 016, 017; whether 006–015, 018, 019 are exercised indirectly was not confirmed.
8. **Frontend modules** — XSS review of 163 `innerHTML` sites; N+1/unbounded queries; error handling; pagination.
9. **Drive legacy code** (`db.php`, `auth.php`, login/session, admin UI) — outside this repo; `file.php` depends on them.
10. **Hostinger** PHP limits (`post_max_size`, `ZipArchive`, GD), `mod_rewrite`/`AllowOverride`, log retention.
11. Performance under load — no data.
