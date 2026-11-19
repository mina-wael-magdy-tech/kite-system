# 06 — Security audit

Scope: backend, SQL, Drive PHP (partial), deployment headers. **Not covered:** per-site frontend XSS review, legacy Drive login/session code, live configuration. No secret values are reproduced; `integrations/kite-drive/api/config.php` holds the shared secret and is **gitignored** (not in git history path checked via `git ls-files`/`check-ignore`).

## Authentication
| Item | Finding |
|---|---|
| Login/session | Supabase Auth, PKCE, session persisted in `localStorage` (`pulse_studio_auth_token`) — standard for supabase-js; XSS would expose it (mitigated by CSP `script-src 'self'`, no inline script) |
| Invitation onboarding | `accept-invitation` requires `onboarding` status, a pending unexpired invitation for the caller's email; conditional activate (race-safe) |
| Bootstrap | `setup-admin`: strong token gate, atomic lock, refuses when super_admin exists, rollback |
| Password policy | `v.password` in `_shared/validate.ts` (not read) |
| MFA / refresh / remember-me | not implemented in repo code read; Supabase defaults apply — unverified |
| Drive login | legacy PHP session (not in repo) — not audited |

## Authorization
- **Server derives identity every call** (`getCaller`): JWT verified with Auth server, roles from `user_roles`/`roles.is_active`, status must be `active`; all privilege predicates include `active`.
- **Reads:** RLS with `SECURITY DEFINER` predicates (`auth_is_active/staff/manager/admin/owner/finance`, `auth_in_dept`, `auth_can_see_client`, `auth_can_edit_plan`) pinned `search_path=''`.
- **Object-level:** client scope by department/account manager/creator (015); Edge Functions re-ask RLS as the caller (`userClient`) for visibility (`kite-drive`, `workflow`) instead of re-implementing it — good.
- **Money:** owner-only `money_figures` + finance-tier policies (017); finance writes only through service-role-only RPCs.
- **Tenant isolation:** single-tenant system; department scoping is the only partition.
- **Direct API access to admin ops:** privileged mutations are Edge Functions with server checks; browser has no INSERT/UPDATE on tasks; `client_drive_links` has no grants at all.
- **Drift risk:** ARC-01.

## Vulnerability checklist
| Class | Result |
|---|---|
| SQL injection | None found: PostgREST/RPC parameters; PHP uses prepared statements with `?` placeholders; dynamic `IN (…)` lists built from placeholder strings |
| IDOR | Edge: ids validated as UUID and re-checked via RLS; PHP: every query includes `user_id = <token cid>`; `load_upload` checks `cid`. `file.php` resolves by `file_path OR filename` then compares `user_id` — safe, though lookups by basename can pick a different row with same filename (random 16-hex prefix makes collisions negligible) |
| Mass assignment | `finance` uses `pick()` whitelists; `profiles` column-level GRANTs; 012 limits post/feedback columns |
| XSS | stored: preview feedback text returned to staff UI (escaped by convention; not verified). CSP blocks inline script. SVG upload sandboxed on Drive (`Content-Security-Policy: sandbox`). SEC-05 |
| CSRF | Edge Functions use bearer JWT (not cookies) + CORS allow-list → not CSRF-prone. Drive API uses header/query token → not cookie-based; `file.php` uses session cookie but is GET-only |
| SSRF | `kite-drive` fetches only `KITE_DRIVE_URL` (must be `https://`); push has `isAllowedPushEndpoint` (body unread) |
| File upload | See "found sound" in `10`: extension denylist across dotted parts, random names, MIME sniff, script execution denied, inline whitelist. Denylist (not allowlist) approach is the residual risk; uploads are admin-only |
| Path traversal | `realpath`+prefix, `..` segment rejection, basename on names |
| Insecure deserialization | JSON only |
| Token leakage | SEC-02; client-preview token in URL **fragment** (`/preview.html#<token>`) so it isn't sent in HTTP requests/Referer — good |
| Rate-limit bypass | SEC-01; no general limiter |
| Business-logic abuse | SEC-03; link holder state changes (SEC-01) |
| Sensitive data exposure | audit logs store old/new data (kite-drive deliberately omits passwords); `notifications` content includes titles; push payloads leave to third-party push services |
| Security headers | CSP, HSTS, nosniff, Referrer-Policy, Permissions-Policy in both hosting configs; `style-src 'unsafe-inline'` remains; `frame-ancestors` allows `https://sites.google.com` by design |

## Secrets handling
Browser gets only URL + anon key (+VAPID public); build script rejects service_role key. Secrets expected in Supabase: `SUPABASE_SERVICE_ROLE_KEY`, `ALLOWED_ORIGINS`, `SETUP_TOKEN`, `CRON_SECRET`, `KITE_DRIVE_API_SECRET`, `KITE_DRIVE_URL`, VAPID keys, `REMINDER_TZ`. Hostinger: `config.php`. **Rotation process undocumented**; the Drive secret signs tokens for *every* client, so its compromise = full Drive access (token forging) — treat as a crown-jewel secret.

## Recommendations (priority)
1. SEC-01 hardening. 2. Add CI RLS suite (OPS-02). 3. Resolve ARC-01. 4. SEC-02. 5. Document and test secret rotation (Edge + `config.php` must change together; tokens live ≤1 h so rotation is safe quickly). 6. Review `innerHTML` sites. 7. Consider MFA for owner/finance roles.
