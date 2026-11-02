# PULSE STUDIO OS — Installation & Setup Guide

## 1. Overview
Static front end (HTML/CSS/ES modules, **no build step**, third-party libraries vendored in `vendor/`) on top of Supabase (PostgreSQL + RLS, Auth, Storage, Realtime, Edge Functions).

## 2. Prerequisites
- A Supabase project.
- [Supabase CLI](https://supabase.com/docs/guides/cli) (`npm i -g supabase` or `npx supabase`).
- Any static web host (Apache/Hostinger, Nginx, Netlify, Cloudflare Pages…) over **HTTPS**.

## 3. Database
Apply the migrations **in order** (CLI: `supabase db push`, or paste each into the SQL editor):

| File | Contents |
|---|---|
| `001_initial_schema.sql` | Tables, constraints, indexes, ID sequences (as column defaults) |
| `002_rls_policies.sql` | Privileges, access-control predicates, RLS policies |
| `003_updated_at.sql` | `updated_at` timestamp trigger (the only trigger) |
| `004_storage.sql` | Private `task-attachments` bucket + storage policies |
| `seed.sql` | Roles, departments, leave types, default channels, company info |

The migrations are written for a **fresh** project. Do not edit them after they have been applied; add new numbered files instead.

## 4. Auth settings (do this before anyone logs in)
Run `supabase config push` after editing `supabase/config.toml` (set your real `site_url` and redirect URLs), **or** set the same values in the dashboard:
- Authentication → Providers → Email → **disable "Allow new users to sign up"**.
- Minimum password length **12**; require upper/lower case and digits.
- Site URL = your HTTPS origin; add `/invitation.html` and `/reset-password.html` to redirect URLs.
- Configure a real SMTP provider (Authentication → SMTP) — the default mailer is rate-limited and not for production.

## 5. Edge Functions
```bash
supabase link --project-ref <your-project-ref>

# Secrets (SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY are injected automatically)
supabase secrets set ALLOWED_ORIGINS="https://os.example.com" \
                     APP_URL="https://os.example.com" \
                     SETUP_TOKEN="$(openssl rand -hex 32)"

supabase functions deploy workflow
supabase functions deploy invite-employee
supabase functions deploy accept-invitation
supabase functions deploy setup-admin
```
- `ALLOWED_ORIGINS`: comma-separated exact origins that may call the functions (add `http://localhost:8000` only for local testing).
- `APP_URL`: used to build invitation links.
- `SETUP_TOKEN`: one-time bootstrap secret (≥ 32 chars). Note it down for step 7.

## 6. Front-end configuration
**On Vercel:** set `SUPABASE_URL` and `SUPABASE_ANON_KEY` as environment variables (see `deployment.md` §2); `env.js` is generated at build time.

**Local / other hosts:** edit **`env.js`** (the only file you change):
```js
window.ENV_SUPABASE_URL = 'https://<project-ref>.supabase.co';
window.ENV_SUPABASE_ANON_KEY = '<anon / publishable key>';
```
These two values are public by design. **Never** put the `service_role` key or `SETUP_TOKEN` anywhere in the web root.

If your Supabase project uses a custom domain, update the `connect-src` host in the CSP (`<meta>` in each HTML page and `.htaccess`).

## 7. Create the first administrator (once)
```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/setup-admin" \
  -H "Authorization: Bearer <anon key>" \
  -H "x-setup-token: <SETUP_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@company.com","password":"<12+ chars, upper+lower+digit>","fullName":"Your Name","companyName":"Your Studio"}'
```
Then **remove the bootstrap path**:
```bash
supabase functions delete setup-admin
supabase secrets unset SETUP_TOKEN
```
Further employees are added with the **Invite** button in the Employees module.

## 8. Run locally
```bash
python -m http.server 8000     # from the pulse-studio-os folder
```
Open `http://localhost:8000/login.html`. (Add `http://localhost:8000` to `ALLOWED_ORIGINS` and to the Auth redirect URLs while testing.)

## 9. Next
Go through [`production-checklist.md`](production-checklist.md) before inviting your team.
