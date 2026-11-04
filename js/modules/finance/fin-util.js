/**
 * KITE SYSTEM — Finance: shared helpers for the finance tabs.
 * Amounts shown here always come from the server's stored figures; the only maths done in the browser is the
 * live preview inside the invoice editor (the server recalculates everything when you save).
 */

import { getSupabase } from '../../supabase-client.js';
import { escapeHTML } from '../../utils/helpers.js';

export const fmt = (n) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);
export const egp = (n) => `EGP ${fmt(n)}`;
export const day = (d) => (d ? String(d).slice(0, 10) : '—');
export const today = () => new Date().toISOString().slice(0, 10);

const STATUS = {
  draft:          { label: 'Draft',          cls: 'badge-slate' },
  sent:           { label: 'Sent',           cls: 'badge-sky' },
  partially_paid: { label: 'Partially paid', cls: 'badge-amber' },
  paid:           { label: 'Paid',           cls: 'badge-emerald' },
  overdue:        { label: 'Overdue',        cls: 'badge-rose' },
  void:           { label: 'Void',           cls: 'badge-slate' }
};
export const STATUS_LABELS = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [k, v.label]));
export function statusBadge(s) {
  const m = STATUS[s] || { label: s, cls: 'badge-slate' };
  return `<span class="badge ${m.cls}" ${s === 'void' ? 'style="text-decoration: line-through;"' : ''}>${escapeHTML(m.label)}</span>`;
}

export const KIND_LABELS = { retainer: 'Retainer', project: 'Project', adhoc: 'One-off', payable: 'Supplier' };

import { calcLine, calcTotals } from './money-math.mjs';

/** Live preview only (exact integer maths that mirrors the server). The saved figures always come from the server. */
export const previewLine = calcLine;
export const previewTotals = calcTotals;

/** Everything the invoice screens need besides the invoices themselves. */
export async function loadBase() {
  const sb = getSupabase();
  const [clients, billing, depts, settings] = await Promise.all([
    sb.from('clients').select('id, company_name, name').order('company_name', { ascending: true }),
    sb.from('client_billing').select('*'),
    sb.from('departments').select('id, name').order('name', { ascending: true }),
    sb.from('finance_settings').select('*').maybeSingle()
  ]);
  const err = clients.error || billing.error || depts.error || settings.error;
  if (err) throw err;
  return {
    clients: clients.data || [],
    billing: new Map((billing.data || []).map(b => [b.client_id, b])),
    departments: depts.data || [],
    settings: settings.data || { vat_rate: 14, default_withholding_rate: 0, default_payment_terms_days: 30, currency: 'EGP' }
  };
}

export const clientLabel = (c) => c?.company_name || c?.name || 'Client';

export function openModal(html, maxWidth = '720px') {
  const backdrop = document.getElementById('globalModalBackdrop');
  const dialog = document.getElementById('globalModalDialog');
  if (!backdrop || !dialog) throw new Error('Modal container missing');
  dialog.style.maxWidth = maxWidth;
  dialog.innerHTML = html;
  backdrop.classList.add('active');
  const close = () => backdrop.classList.remove('active');
  dialog.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  return { dialog, close };
}
