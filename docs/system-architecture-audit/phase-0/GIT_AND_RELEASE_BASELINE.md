# Git and Release Baseline
Date: 2026-11-07 · Evidence: **Repository/local** (commands run read-only).

| Item | Value |
|---|---|
| Branch | `main` |
| HEAD | `5e951e1212d9ae41ea8114ff5f1403173fa16dea` ("Kite Drive: set a client's login email and password from the system") |
| Commits on branch | 73 |
| Remote | `origin` → github.com/mina-wael-magdy-tech/kite-system (no credentials in URL) |
| Stash | empty |
| Modified tracked files | **none** |
| Untracked (must be preserved) | `docs.zip`, `docs/system-architecture-audit.zip`, `docs/system-architecture-audit/` (audit package incl. `remediation/` and this `phase-0/`), `supabase/tests/package-lock.json` |
| CI/CD | **No `.github/` directory; no workflow files.** Deploy is presumably Vercel Git integration (inferred from `vercel.json`/docs; not verified) |
| Release tagging | no tags/release notes inspected beyond the log (not verified) |

Preservation: nothing was reset, cleaned, committed or deleted. Files created in Phase 0 are the Markdown deliverables in this folder (untracked) plus a short status note in `remediation/README.md`. `docs.zip` pre-existed and was not created by this audit.

Release-relevant facts
- Frontend build: `npm run build` → `scripts/build.mjs` copies public files to `dist/`, writes `env.js` from env vars, stamps the service worker with `VERCEL_GIT_COMMIT_SHA`. The build refuses a `service_role` key.
- `supabase/config.toml` pins `project_id` and Auth settings (sign-up off, 12-char passwords). `supabase config push` is the documented way to apply them; whether it was ever run is **not verified**.
- `docs/deployment.md` says `supabase db push` for migrations; project memory says live migration history is empty and `db push` must not be used on live. **Docs conflict with the operating rule** (RISK-05).
