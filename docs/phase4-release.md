# Phase 4: API, integrations and frontend reliability

Scope: Kite Drive (SEC-02, DAT-01, PERF-04), router and module lifecycle (FUN-01, ARC-02), employee activation (ARC-03).
Applied manually, one step at a time, staging first. Never `db push` on live. Nothing here was deployed by the change itself.

## What changed

| Area | Change |
|---|---|
| SEC-02 | Every Drive token has a unique id (`jti`). The `X-Drive-Token` header is accepted for **every** action. Thumbnails, the logo, text and font previews now use the header (blob addresses); only a token locked to one file (`fid`: video, audio, PDF, "open in a new tab") or a single-use token (download, ZIP) may sit in an address. `url_tokens: 'strict'` in Drive's `config.php` enforces this; the default `'legacy'` keeps an older web app working. Responses send `Referrer-Policy: no-referrer`. Errors and logs never contain a token. |
| DAT-01 | A connection that drops while Drive creates an account no longer discards the intent: the account is looked up by e-mail and linked, or the intent is kept for the retry. Every call to Drive has a 20 s deadline. Drive's `create_client` takes a named lock per e-mail (two identical requests cannot both insert). |
| PERF-04 | Thumbnails are generated one at a time and never for a photo that cannot fit in `memory_limit` (no blank 500); a file that cannot be shrunk answers 404 instead of sending a multi-MB original per grid tile. `upload_complete` takes a per-upload lock (a retry while the first request is still unpacking is told to wait, not unpacked twice). ZIP unpacking refuses compression bombs and archives larger than the free disk; folder lookups are cached (one query per folder, not per file). `_zips` and `_thumbs` are pruned. |
| FUN-01 | The router ignores a render that finishes after the user moved on (each visit draws into its own host element), ignores a repeated event for the page already shown, does not show errors of a page that was left, and `init()` twice adds one listener. |
| ARC-02 | Explicit module contract (`js/core/module-contract.js`): `id`, `title`, `create(app)`, `render(container, query, scope)`, optional `dispose()`. 17 contracts live in `js/modules/registry.js`; `app.js` only walks the list. A `Scope` (`js/core/lifecycle.js`) owns listeners, timers and abort signals and is disposed on every navigation. Chat, the Drive panel and the Client hub implement `dispose()` (chat used to keep its realtime channel, document listener and timers after you left it). |
| ARC-03 | Migration 034: activation is one atomic database function (`accept_invitation`); the invitation is bound to the exact account (`invitations.user_id`); expiry is recorded; a daily sweep marks expired invitations; `invitations.token` stores only a SHA-256 hash and is no longer readable by signed-in users. |

## Release order (one release train)

1. **Migration 034** on staging, then live (additive; old Edge Functions keep working because the old `accept-invitation` does its own updates; the unused `token` column is only hidden from the browser).
2. **Edge Functions**: `kite-drive`, `accept-invitation`, `invite-employee`, `due-reminders` (the new `accept-invitation` needs 034 first; new tokens carry `jti`, which an old Drive ignores).
3. **Kite Drive PHP** (`api/index.php`, `api/lib.php`, `api/send.php`, `api/config.sample.php` -> keep `url_tokens` at `legacy`). Upload the files together: `index.php` requires `lib.php`. The PHP side accepts both token transports, so it is safe before the web app.
4. **Web app (SPA)**: uses header tokens, file-locked tokens and the module lifecycle. Needs steps 2 and 3 (file-locked view tokens come from the new `kite-drive`; header-token thumbnails need the new PHP).
5. After the SPA has been live and cached copies are gone (service-worker update, a day): set `'url_tokens' => 'strict'` in Drive's `config.php`.

Rollback: SPA first (previous build), then PHP files (previous copies; `drive_token_uses` can stay), then the Edge Functions, then `DROP FUNCTION accept_invitation, invitations_expire_pending` and `GRANT SELECT ON public.invitations TO authenticated` (rollback of 034 is in its header). The old SPA works against the new PHP and Edge Functions as long as `url_tokens` is `legacy`.

## Tests

`npm run test:phase4` (frontend lifecycle + the real Drive API under `php -S`), `npm run test:integrity` (section 16, real PostgreSQL), `npm run test:roles` (A22, Edge behaviour), `php integrations/kite-drive/tests/lib_test.php`.
Set `FRONTEND_DIR` / `DRIVE_API_DIR` to run the same tests against an older checkout (the "before" evidence).

## Not done / decisions

* No browser-level (Playwright) test; the lifecycle tests use a counting fake DOM with the real router, chat and Drive panel code.
* Splitting the large modules (`chat.js` 1.2 kLOC, `content-plan.js`, `tasks.js`) into sub-modules was not done: the contract and disposal are in place; a split without UI tests would be a risky unrelated refactor.
* Video / audio / PDF previews still need an address token (a browser cannot send a header for `<video src>`); it is locked to one file and lives 10 minutes. Streaming through a blob was rejected (memory).
* A Hostinger access log can still record the file-locked view token for 10 minutes; single-use download / ZIP tokens are dead after their first use.
* Real Supabase Auth invitation links, real MySQL and real Hostinger limits (memory_limit, max_execution_time) were not exercised.
