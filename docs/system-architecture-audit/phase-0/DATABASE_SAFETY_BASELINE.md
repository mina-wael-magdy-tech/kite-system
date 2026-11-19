# Database Safety Baseline

**Live database: NOT ACCESSIBLE.** Figures below come from applying the repository's migrations to a throwaway in-memory database (LOCAL). They describe what the migrations produce, not what production contains.

## Structure (LOCAL, clean chain 001-019)
| Metric | Value |
|---|---|
| Public tables | 68 (RLS off on 0) |
| Policies (public + storage) | 175 |
| Foreign keys | 141 |
| Triggers (non-internal, public) | 44 |
| Public functions | 44 |
| SECURITY DEFINER without pinned search_path | 0 |
| Grants to `anon` | 0 |

## Migration state
- Repository: 19 numbered files, 001-019, in order.
- Live: history table is empty and migrations were applied manually, so the live applied set is **NOT VERIFIED**. Do not use `supabase db push` on live (project rule); apply single, reviewed migrations. `docs/deployment.md` still recommends `db push` (RISK-05).
- Check A5/A6/A7 in `remediation/VERIFICATION_PLAN.md` compare live policy/trigger/function counts with the numbers above.

## Focus items
| Issue | Why it matters for later migrations | Pre-flight check (read-only, live) |
|---|---|---|
| DAT-04 browser inserts lack validation | new CHECK constraints may fail on existing rows | `SELECT count(*) FROM leave_requests WHERE end_date < start_date;` plus length/empty checks on messages |
| DAT-05 non-atomic role change | a failure between delete and insert can leave a user with no role | count profiles without any `user_roles` row |
| DAT-06 currency model | mixed currencies cannot be summed correctly | `SELECT currency, count(*) FROM expenses GROUP BY 1;` and the same for invoices/payments |
| DAT-02 legacy money columns | two sources of truth possible | compare legacy columns against ledger totals per record |
| Financial consistency | issued invoices must equal their lines and payments | totals of issued invoices vs sum of items vs payments; any `status` inconsistent with balances |
| Time zone (FUN-02) | UTC vs Cairo day boundaries | `SHOW timezone;` |
| Data-quality set | blocks adding unique/CHECK constraints | duplicate DMs (A11), asset path vs uploader (A9), orphan chat-media (A12) |
| Migration 017 uses session-level `set_config('app.migrating', ..., false)` | if a manual run fails midway, finance guards stay bypassed for that session | use `SET LOCAL` inside a transaction when re-running |

No data cleanup or migration was run. Constraint additions in Phase 1+ must each be preceded by the matching count query returning 0 (or an agreed cleanup).
