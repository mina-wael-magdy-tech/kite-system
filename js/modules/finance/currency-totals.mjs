/**
 * KITE SYSTEM — per-currency totals for the finance screens.
 * Amounts in different currencies are NEVER added together: one total per currency ("EGP 1,000.00 · USD 50.00").
 * Pure functions, no imports (also run by supabase/tests/verify-integrity.mjs).
 */
const fmt = (n) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);

/** rows [{ currency, amount }] -> Map(currency -> total). A row without a currency counts as EGP (the legacy default). */
export function totalsByCurrency(rows, amountKey = 'amount') {
  const m = new Map();
  for (const r of rows || []) {
    const cur = r.currency || 'EGP';
    m.set(cur, (m.get(cur) || 0) + (Number(r[amountKey]) || 0));
  }
  return m;
}

/** Map(currency -> total) -> "EGP 1,000.00 · USD 50.00"; an empty map shows zero in `fallback` (EGP). */
export function formatTotals(map, fallback = 'EGP') {
  if (!map || map.size === 0) return `${fallback} ${fmt(0)}`;
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([c, v]) => `${c} ${fmt(v)}`).join(' · ');
}

/** fin_kpis() rows [{ metric, currency, amount }] -> { outstanding, overdue, collected } as display strings */
export function kpiTexts(rows) {
  const by = (metric) => formatTotals(totalsByCurrency((rows || []).filter((r) => r.metric === metric)));
  return { outstanding: by('outstanding'), overdue: by('overdue'), collected: by('collected') };
}

/** fin_client_balances() rows [{ client_id, currency, balance }] -> Map(client_id -> Map(currency -> balance)) */
export function balancesByClient(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const cur = r.currency || 'EGP';
    if (!out.has(r.client_id)) out.set(r.client_id, new Map());
    const m = out.get(r.client_id);
    m.set(cur, (m.get(cur) || 0) + (Number(r.balance) || 0));
  }
  return out;
}
