# PWA, Push Notifications & Calendar

Kite System is an installable web app (PWA). People add it to their phone or desktop, it opens full-screen like a native app, works offline for the app shell, and sends **real push notifications** even when closed.

## 1. What people get
| Feature | How it works |
|---|---|
| **Install** | Android/desktop Chrome & Edge: *Install app* in the user menu (or the browser's install icon). iPhone/iPad: Safari → Share → *Add to Home Screen* (the app shows these steps). |
| **App-like UI** | Standalone window, safe-area aware, bottom tab bar on phones (Home · Tasks · Calendar · Chat · More), modals become bottom sheets. |
| **Offline** | The app shell is cached; a branded offline page appears for uncached pages. Data always comes live from the server and is **never cached** by the service worker. |
| **Push notifications** | Bell → *Turn on notifications* on each device. New tasks, status changes, approvals/leave decisions and a **daily deadline digest** reach the phone/desktop, even when Kite is closed. Tapping opens the right screen. |
| **App icon badge** | Unread count on the installed app icon (supported browsers). |
| **Calendar & Timeline** | Month · Agenda · Timeline (Gantt): tasks (due dates), project deadlines & milestones, campaign launches, approved leave, holidays. Drag a task to another day to reschedule; click a day to add a task. |
| **Updates** | A new deploy is detected automatically; the app reloads onto the new version. |

## 2. One-time server setup

### 2.1 Database
Apply `supabase/migrations/005_push_subscriptions.sql` (one table; browsers can only read their own rows, never the keys).

### 2.2 VAPID keys (identify your server to push services)
```bash
npx web-push generate-vapid-keys
```
Keep the **private** key secret. The **public** key is safe to expose.

### 2.3 Supabase secrets
```bash
npx supabase secrets set \
  VAPID_PUBLIC_KEY="<public key>" \
  VAPID_PRIVATE_KEY="<private key>" \
  VAPID_SUBJECT="mailto:you@your-company.com" \
  CRON_SECRET="<long random string>" \
  REMINDER_TZ="Africa/Cairo" \
  --project-ref <ref>
```

### 2.4 Deploy the functions
```bash
npx supabase functions deploy workflow       --project-ref <ref> --use-api
npx supabase functions deploy due-reminders  --project-ref <ref> --use-api
```

### 2.5 Vercel
Add the environment variable `VAPID_PUBLIC_KEY` (the **public** key only) and redeploy. Without it push stays off and the bell shows "not set up".

### 2.6 Daily deadline reminders
Supabase Dashboard → Integrations → **Cron** → new job:
- Schedule: daily, e.g. `0 5 * * *` (05:00 UTC = 07:00 Cairo)
- Type: HTTP request, `POST https://<ref>.supabase.co/functions/v1/due-reminders`
- Headers: `Authorization: Bearer <anon key>` and `x-cron-secret: <CRON_SECRET>`

Each person gets at most one digest per day ("2 due today, 1 overdue…").

## 3. Using it
1. Open the site → bell icon → **Turn on notifications** → allow.
2. **Send a test** appears once enabled; it should arrive within seconds.
3. iPhone/iPad: install to the Home Screen first; iOS only delivers web push to installed apps (iOS 16.4+).

## 4. Security notes
- Subscriptions are written **only** by the server, which accepts endpoints from real push services only (Google FCM, Mozilla, Windows, Apple); arbitrary URLs are refused (SSRF guard).
- The encryption keys of a device never reach the browser again after subscribing.
- Signing out removes that device's subscription, so a shared phone stops showing the previous person's alerts. Signing in as someone else on the same browser moves the subscription to the new user.
- Notification taps only ever open pages of this app; URLs to other sites are ignored.
- The service worker handles same-origin files only. Supabase traffic (auth, data, storage, functions) bypasses it entirely.

## 5. Troubleshooting
| Symptom | Cause / fix |
|---|---|
| Bell says "Push notifications are not set up" | `VAPID_PUBLIC_KEY` missing in Vercel (redeploy after adding) |
| "Send a test" → "not configured on the server" | VAPID secrets missing, or `workflow` not redeployed |
| "Notifications are blocked" | The browser/OS blocked the site: allow it in site settings, then retry |
| Nothing on iPhone | The app must be installed to the Home Screen and opened from there |
| Works for some people only | Each device must enable notifications once |
| Old version after deploy | Reopen the app: the update banner appears and it reloads itself |
