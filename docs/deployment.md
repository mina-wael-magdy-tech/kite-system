# PULSE STUDIO OS — Production Deployment Guide

## 1. Architecture
- **Static site** (this folder) on any HTTPS host. No build step.
- **Supabase** for database, auth, storage, realtime and Edge Functions.

## 2. Deploying on Vercel (recommended path)

The repo already contains `vercel.json`, `package.json` and `scripts/build.mjs`. The build copies **only** `*.html`, `css/`, `js/`, `vendor/` into `dist/` and generates `dist/env.js` from environment variables, so `supabase/`, `docs/` and scripts are never published.

1. Push this folder to a Git repository. If the repo root is above `pulse-studio-os`, set **Root Directory** to `pulse-studio-os` in Vercel.
2. Import the project in Vercel. Framework preset: **Other**. Build/Output come from `vercel.json` (`npm run build` → `dist`).
3. Project Settings → Environment Variables (Production **and** Preview):

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `SUPABASE_ANON_KEY` | the **anon / publishable** key only |

   The build fails if either is missing or if the key is a `service_role` key.
4. Deploy, then take the production URL (or your custom domain) and use it **everywhere below**:
   - Supabase Auth → Site URL and redirect URLs (`/invitation.html`, `/reset-password.html`)
   - `supabase secrets set ALLOWED_ORIGINS="https://<your-domain>" APP_URL="https://<your-domain>"`
   - `site_url` in `supabase/config.toml`
5. Preview deployments get random URLs that are **not** in `ALLOWED_ORIGINS`, so the Edge Functions will (correctly) reject them. Either test on a separate staging Supabase project with its own env vars, or add that single preview origin temporarily. Never add `*`.
6. Headers (CSP, HSTS, `nosniff`, referrer/permissions policy, `frame-ancestors`) are set in `vercel.json`. `.htaccess` is for Apache only and is ignored by Vercel. If you edit the CSP, change it in `vercel.json` **and** the `<meta>` tag in each HTML page.
7. Custom domain: Vercel → Domains. HTTPS and certificates are automatic.

> The `SUPABASE_ANON_KEY` is public by design and ends up in `env.js`. Security comes from RLS, not from hiding it.

## 3. Other hosts (Apache / Nginx)
### Security headers
The pages carry a strict Content-Security-Policy via `<meta>`. Headers are better and are the only way to set `frame-ancestors`, so configure the host too.

#### Apache / Hostinger
Use the provided `.htaccess` (needs `mod_headers`, `mod_rewrite`). Adjust the `frame-ancestors` list and, if you use a custom Supabase domain, `connect-src`.

#### Nginx
```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https://*.supabase.co; connect-src 'self' https://*.supabase.co wss://*.supabase.co; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://sites.google.com" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()" always;
location = /env.js { add_header Cache-Control "no-store"; }
location ~* \.(html|js)$ { add_header Cache-Control "no-cache"; }
```

#### Netlify / Cloudflare Pages
Create a `_headers` file with the same header values under `/*`.

## 4. Pre-flight
1. HTTPS enforced, certificate valid, HSTS present.
2. Vercel env vars hold the production URL and **anon** key only; no other secrets in the repo or Vercel build output.
3. Auth: signups **off**, 12-char passwords, real SMTP, redirect URLs set (`supabase config push`).
4. Edge Function secrets set (`ALLOWED_ORIGINS`, `APP_URL`); `setup-admin` deleted and `SETUP_TOKEN` unset after bootstrap.
5. Backups: enable daily backups (Supabase Pro) or schedule `pg_dump`; **test a restore**.
6. Walk through `production-checklist.md`.

## 5. Releasing changes
- **Front end:** upload changed files. Bump query strings or rely on `Cache-Control: no-cache` on HTML/JS (already set).
- **Database:** add a new numbered file in `supabase/migrations/`, test on a staging project, then `supabase db push`. Never edit applied migrations.
- **Functions:** `supabase functions deploy <name>`. Roll back by redeploying the previous commit.

## 6. Monitoring
- Supabase Dashboard → Logs: Edge Function errors, Auth failures, Postgres errors.
- Admin Control Center → Audit log: invitations, task/expense/leave decisions.
- Add an uptime monitor on `/login.html` and a Supabase alert on function error rate.
