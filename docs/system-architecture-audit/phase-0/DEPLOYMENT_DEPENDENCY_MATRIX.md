# Deployment Dependency Matrix

Sources: `vercel.json`, `scripts/build.mjs`, `docs/deployment.md`, `docs/kite-drive.md`, `docs/production-checklist.md`. All REPO evidence; actual live practice is NOT VERIFIED.

## Deployment processes
| Artifact | How deployed (per docs) | Automated? | Rollback |
|---|---|---|---|
| SPA | Vercel Git integration, `npm run build` → `dist/` | assumed yes (no CI gate) | Vercel redeploy of an earlier build (not verified) |
| Edge Functions | `supabase functions deploy <name>` by hand (kite-drive uses `--use-api`) | no | redeploy previous commit (docs L63) |
| DB migrations | manual, one file at a time on live (docs say `db push`; project rule forbids it) | no | none; migrations are forward-only, no down scripts |
| Hostinger PHP | upload `api/` and `file.php` by hand (`kite-drive.md` L37) | no | re-upload old files; no versioning on the host |
| Auth config | `supabase config push` or dashboard | no | n/a |
| Cron jobs | dashboard by hand | no | n/a |

## Who depends on whom
| Change in | Must be compatible with | Break if mismatched |
|---|---|---|
| DB migration (columns, RLS, RPC) | SPA queries, Edge Functions | SPA/functions error on missing column or denied row |
| Edge Function `kite-drive` (token format) | Hostinger `api/index.php` (same HMAC secret/format) | all Drive actions fail with 401/403 |
| Edge Function CORS (`ALLOWED_ORIGINS`) | SPA origin | every function call blocked |
| SPA `vercel.json` CSP | Drive host, Supabase hosts | blocked requests/iframes |
| Hostinger `allowed_origins` | SPA origin | Drive blocked from browser |
| `CRON_SECRET` | both dashboard cron headers | jobs return 403 silently |
| `KITE_DRIVE_API_SECRET` | `api/config.php` | tokens rejected |
| Preview deployments | not in `ALLOWED_ORIGINS` | functions reject them (by design, doc L25) |

## Version-skew risks
| Risk | Mechanism | Mitigation direction (later phase) |
|---|---|---|
| PHP vs Edge mismatch | the two are deployed separately by hand, no version handshake | add a version/capability check (FX-05) |
| SPA before backend | Vercel may ship SPA on push while migrations/functions are still old | order: migration → functions → SPA; feature flags or additive-only migrations |
| Backend before SPA | removing columns/policies breaks the old cached SPA (service worker caches assets) | additive first, remove later |
| Partial deployment | several functions deployed one by one | deploy in a documented order |
| No release coordination | no tags, no changelog, no CI | release checklist in Phase 1+ |
| Rollback | DB has no down path; backups unverified (OPS-04) | verify restore before schema-changing phases |

Recommended order for any release that touches several layers: (1) additive migration on live, applied singly; (2) Edge Functions; (3) Hostinger PHP if token/contract changed; (4) SPA; (5) remove deprecated pieces in a later release.
