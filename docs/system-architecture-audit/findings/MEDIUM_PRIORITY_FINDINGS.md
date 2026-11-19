# Medium-priority findings
| ID | Title | Primary location |
|---|---|---|
| SEC-01 | Public preview endpoint throttle/state-change | `supabase/functions/client-preview/index.ts` L17, ~L87–130 |
| SEC-02 | Drive token in query string | `integrations/kite-drive/api/index.php` L447–449 |
| ARC-01 | Role lists drift across SQL/Edge/JS | `002` L78, `015` L22, `_shared/auth.ts` L5, `kite-drive/index.ts` L55, `permission-service.js` L72/L83 |
| DAT-01 | Non-transactional Drive link creation | `kite-drive/index.ts` L177–205 |
| OPS-01 | Crons outside repo, no heartbeat | `due-reminders`, `retainer-billing` headers |
| OPS-02 | No CI; partial RLS test coverage | `supabase/tests/verify-rls.mjs` |

Full evidence and fixes: `../10_BUGS_AND_ARCHITECTURAL_DEFECTS.md`.
