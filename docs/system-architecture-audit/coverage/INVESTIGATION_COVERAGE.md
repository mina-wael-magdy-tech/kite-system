# Investigation coverage (2026-11-06)
Legend: **I** inspected · **P** partially · **N** not inspected · **B** blocked · **NA** not applicable

| Area | Status | Notes |
|---|---|---|
| Repo inventory / git metadata | I | 183 tracked files, 73 commits |
| Graphify graph | I | AST only; no semantic pass; vendor excluded |
| Notion documentation | **B** | No Notion tool in session |
| In-repo docs (`README`, `docs/*.md`) | P | README, security, database, deployment read; others by heading/size |
| `_shared/auth.ts`, `_shared/http.ts` | I | |
| `workflow`, `finance`, `chat`, `broadcast` | P | `workflow` 1–140 + submitted handlers; `finance` 1–60; `chat` 1–70; `broadcast` grep only |
| `kite-drive`, `client-preview`, `accept-invitation`, `setup-admin`, `retainer-billing` | I | |
| `due-reminders` | P | first 60 lines |
| `invite-employee`, `content-plan`, `_shared/push.ts`, `_shared/validate.ts` | N | |
| Migrations 002 (grants), 012, 015, 019 | I | |
| Migration 017 | P | functions/policies/triggers by grep |
| Migration 001 and all FKs | P | FK list extracted by script; column details not read |
| Migrations 003–011, 013, 014, 016, 018 | N/P | object lists by grep only |
| PHP Drive `api/index.php` 1–470, `send.php`, `file.php`, both `.htaccess` | I | action bodies 470–1089 by grep only |
| Drive `db.php`, `auth.php`, legacy Drive UI | **N** | not in this repo |
| Frontend `js/modules/*` | **P (metrics only)** | not read line by line |
| `config.js`, `supabase-client.js`, `sw.js` (grep), `scripts/build.mjs` (head) | I/P | |
| `supabase/tests/verify-rls.mjs` | P | head + grep |
| Runtime, live DB, live cron, Vercel/Hostinger | **B** | no access |
| Coverage percentages | NA | no coverage data exists |
