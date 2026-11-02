# Production Checklist

Tick every box before inviting the team. Items marked 🔴 are security-critical.

## 1. Supabase project
- [ ] 🔴 Migrations `001`–`004` and `seed.sql` applied in order, without errors
- [ ] 🔴 Auth → **Sign-ups disabled** (verify by trying to sign up with a new email: must be refused)
- [ ] 🔴 Minimum password length 12, complexity on; email confirmations on
- [ ] Custom SMTP configured; invitation and reset emails arrive (check spam)
- [ ] Site URL and redirect URLs point to the production HTTPS origin only
- [ ] Daily backups on; **a restore has been tested**
- [ ] Database password rotated from the one you used during setup; access restricted (Network restrictions) if available
- [ ] Storage: only the private `task-attachments` bucket exists (no public buckets)

## 2. Edge Functions
- [ ] 🔴 `ALLOWED_ORIGINS` = exactly your production origin(s) (no `*`, no localhost)
- [ ] `APP_URL` set; an invitation e-mail links to `https://…/invitation.html`
- [ ] 🔴 First admin created, then `setup-admin` **deleted** and `SETUP_TOKEN` **unset**
- [ ] `workflow`, `invite-employee`, `accept-invitation` deployed from the current code

## 3. Web host
- [ ] 🔴 HTTPS only, HSTS header present
- [ ] 🔴 CSP header present (`curl -sI https://your-host/ | grep -i content-security`) and no console CSP violations on login, dashboard, each module
- [ ] `frame-ancestors` lists only origins that should embed the app
- [ ] Vercel env vars: `SUPABASE_URL` and the **anon** key only; `curl https://your-host/env.js` shows no service_role key
- [ ] `curl -I https://your-host/supabase/seed.sql` and `/docs/security.md` → 404 (dist/ publishes only web files)
- [ ] `supabase/`, `docs/`, `*.sql`, `*.toml`, `*.ts` are not downloadable (`curl -I https://your-host/supabase/seed.sql` → 403/404)

## 4. Role smoke test (use real accounts)
For each of: admin, department manager, employee A, employee B, HR, finance, suspended user.
- [ ] Employee B cannot see employee A's tasks, expenses, leave, attendance, DMs
- [ ] Employee cannot approve own task (`completed`), expense, or leave (server returns 403)
- [ ] Finance/Admin can approve someone else's expense; the requester gets a notification; an audit row appears
- [ ] HR can invite an employee but cannot grant `owner`/`general_manager`/`super_admin`
- [ ] Invited user sets a password → lands in the app as **active**; invitation shows `accepted`
- [ ] Suspending a profile (`employment_status = 'suspended'`) blocks that user immediately, even with an open session
- [ ] File upload works for a task you can see, fails for one you can't; download works through the signed link

## 4b. PWA & push (see docs/pwa-and-notifications.md)
- [ ] Migration `005` applied; `workflow` and `due-reminders` deployed; VAPID secrets set; `VAPID_PUBLIC_KEY` in Vercel
- [ ] On a real phone: install the app, turn on notifications, **Send a test** arrives with the screen locked
- [ ] Assign yourself a task from another account: a push arrives and tapping it opens Tasks
- [ ] iPhone: installed to Home Screen before enabling notifications
- [ ] Daily Cron job created for `due-reminders` (header `x-cron-secret`)
- [ ] Sign out on a shared device and confirm that device no longer receives your alerts

## 5. Re-verify the access model after any change to policies
```bash
cd supabase/tests
npm install            # installs @electric-sql/pglite (in-process Postgres, no Docker needed)
node verify-rls.mjs    # applies all migrations and runs 79 attack scenarios; expect "79 passed, 0 failed"
```

## 6. Operations
- [ ] Uptime check on `/login.html`
- [ ] Alert on Edge Function error rate and on Auth failures
- [ ] Named owner for: user lifecycle (invite/suspend), backups, dependency updates (`vendor/` libraries), Supabase plan limits
- [ ] Offboarding procedure documented: set `employment_status = 'inactive'` **and** ban the auth user (Authentication → Users → Ban)
- [ ] Incident contact + procedure to rotate the `service_role` key and database password

## 7. Not included (decide consciously)
Client portal for the `client` role · UI to manage private-channel members · UI for role/permission administration · rate limiting/WAF (use Cloudflare) · automated end-to-end browser tests.
