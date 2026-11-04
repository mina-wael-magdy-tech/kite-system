/**
 * KITE SYSTEM — exact decimal arithmetic for the invoice PREVIEW in the browser.
 * The server is the source of truth (NUMERIC in Postgres, migration 017); this mirrors its formula with integers
 * (BigInt) so the preview never differs from the saved invoice by a cent. Half away from zero, per line.
 *
 *   gross    = round(qty * price)
 *   discount = round(gross * discount% / 100)
 *   net      = gross - discount
 *   vat      = round(net * vat% / 100)
 *   total    = net + vat
 * Pure functions, no imports: also run by supabase/tests/verify-rls.mjs against the real SQL.
 */

// number typed by a person -> integer count of 10^-scale units (inputs have at most `scale` decimals)
const units = (x, scale) => BigInt(Math.round((Number(x) || 0) * 10 ** scale));
// integer division rounding half away from zero (operands here are never negative)
const div = (a, b) => (a >= 0n ? (a + b / 2n) / b : -((-a + b / 2n) / b));
const toNum = (cents) => Number(cents) / 100;

/** @returns {{ gross:number, discount:number, net:number, vat:number, total:number }} in currency units */
export function calcLine({ quantity, unit_price, discount_pct, vat_rate }) {
  const q = units(quantity, 3), p = units(unit_price, 2), d = units(discount_pct, 2), v = units(vat_rate, 2);
  const gross = div(q * p, 1000n);               // cents
  const discount = div(gross * d, 10000n);
  const net = gross - discount;
  const vat = div(net * v, 10000n);
  return { gross: toNum(gross), discount: toNum(discount), net: toNum(net), vat: toNum(vat), total: toNum(net + vat) };
}

export function calcTotals(items, whtRate) {
  const lines = items.map(calcLine);
  const cents = (n) => BigInt(Math.round(n * 100));
  const sum = (k) => lines.reduce((a, l) => a + cents(l[k]), 0n);
  const subtotal = sum('net'), discount = sum('discount'), vat = sum('vat');
  const wht = div(subtotal * units(whtRate, 2), 10000n);
  const total = subtotal + vat;
  return { lines, subtotal: toNum(subtotal), discount: toNum(discount), vat: toNum(vat), wht: toNum(wht), total: toNum(total), net: toNum(total - wht) };
}
