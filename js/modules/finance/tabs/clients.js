/**
 * KITE SYSTEM — Finance › Clients & retainers
 * Billing profile per client (retainer / on-demand, tax number, withholding, payment terms)
 * and the monthly retainer plans that the daily job turns into draft invoices.
 */

import { getSupabase } from '../../../supabase-client.js';
import { Api } from '../../../services/api.js';
import { Toast } from '../../../services/toast-service.js';
import { formDialog } from '../../../ui/dialogs.js';
import { escapeHTML } from '../../../utils/helpers.js';
import { egp, day, today, clientLabel } from '../fin-util.js';

export class ClientsTab {
  constructor(shell) {
    this.shell = shell;
    this.plans = [];
    this.balances = new Map();   // client_id -> open balance
    this.filter = { q: '', type: 'all' };
  }

  html() {
    return `
      <div class="fin-toolbar">
        <input id="cliSearch" type="search" class="form-control" placeholder="Search clients…" aria-label="Search clients" />
        <select id="cliType" class="form-control" aria-label="Filter by billing type">
          <option value="all">All clients</option><option value="retainer">Retainer</option><option value="on_demand">On-demand</option><option value="none">No billing profile</option>
        </select>
        <button type="button" class="btn btn-primary btn-sm" id="btnNewPlan"><i data-lucide="plus"></i> New retainer plan</button>
      </div>
      <div id="cliList" class="fin-list"></div>`;
  }

  async mount() {
    const q = document.getElementById('cliSearch');
    q?.addEventListener('input', () => { this.filter.q = q.value.trim().toLowerCase(); this.render(); });
    document.getElementById('cliType')?.addEventListener('change', (e) => { this.filter.type = e.target.value; this.render(); });
    document.getElementById('btnNewPlan')?.addEventListener('click', () => this.editPlan());
    await this.load();
  }

  async load() {
    const sb = getSupabase();
    const [plans, inv] = await Promise.all([
      sb.from('retainer_plans').select('*, department:departments(name)').order('created_at', { ascending: false }),
      sb.from('invoices').select('client_id, balance, status').in('status', ['sent', 'partially_paid', 'overdue'])
    ]);
    this.plans = plans.data || [];
    this.balances = new Map();
    (inv.data || []).forEach(i => this.balances.set(i.client_id, (this.balances.get(i.client_id) || 0) + Number(i.balance)));
    this.render();
  }

  render() {
    const el = document.getElementById('cliList');
    if (!el) return;
    const { clients, billing } = this.shell.base;
    const { q, type } = this.filter;
    const rows = clients.filter(c => {
      const b = billing.get(c.id);
      if (type === 'none' ? !!b : (type !== 'all' && b?.billing_type !== type)) return false;
      return !q || clientLabel(c).toLowerCase().includes(q);
    });
    if (!rows.length) { el.innerHTML = '<div class="empty-state"><div class="empty-state-title">No clients match</div></div>'; return; }

    el.innerHTML = `<div class="fin-cards">${rows.map(c => {
      const b = billing.get(c.id);
      const plans = this.plans.filter(p => p.client_id === c.id);
      const owed = this.balances.get(c.id) || 0;
      return `<div class="card entity-card">
        <div class="card-header"><div>
          <span class="badge ${b ? (b.billing_type === 'retainer' ? 'badge-indigo' : 'badge-sky') : 'badge-slate'}">${b ? (b.billing_type === 'retainer' ? 'Retainer' : 'On-demand') : 'No billing profile'}</span>
          <div class="card-title" style="margin-top:6px">${escapeHTML(clientLabel(c))}</div></div>
          ${owed > 0 ? `<span class="badge badge-amber" title="Open balance">${egp(owed)}</span>` : ''}</div>
        <div class="card-body" style="display:flex; flex-direction:column; gap: var(--space-2)">
          <div class="text-2xs text-muted">${b?.tax_registration_no ? `Tax ID ${escapeHTML(b.tax_registration_no)} · ` : ''}Withholding ${b?.withholding_rate != null ? Number(b.withholding_rate) + '%' : 'default'} · terms ${b?.payment_terms_days ?? 'default'} days</div>
          ${plans.map(p => `<div class="fin-plan ${p.is_active ? '' : 'inactive'}">
              <div><b>${escapeHTML(p.name)}</b><div class="text-2xs text-dim">${egp(p.monthly_fee)} / month${p.department?.name ? ' · ' + escapeHTML(p.department.name) : ''} · from ${day(p.start_date)}${p.end_date ? ' to ' + day(p.end_date) : ''} · bills on day ${p.billing_day}</div></div>
              <button type="button" class="btn btn-secondary btn-sm" data-plan="${p.id}">Edit</button></div>`).join('')}
        </div>
        <div class="card-footer"><div style="display:flex; gap: var(--space-2); width:100%">
          <button type="button" class="btn btn-secondary btn-sm" style="flex:1" data-bill="${c.id}">Billing profile</button>
          <button type="button" class="btn btn-secondary btn-sm" style="flex:1" data-newplan="${c.id}">Add plan</button>
          <button type="button" class="btn btn-primary btn-sm" style="flex:1" data-invoice="${c.id}">Invoice</button>
        </div></div></div>`;
    }).join('')}</div>`;
    el.querySelectorAll('[data-bill]').forEach(b => b.addEventListener('click', () => this.editBilling(b.dataset.bill)));
    el.querySelectorAll('[data-plan]').forEach(b => b.addEventListener('click', () => this.editPlan(b.dataset.plan)));
    el.querySelectorAll('[data-newplan]').forEach(b => b.addEventListener('click', () => this.editPlan(null, b.dataset.newplan)));
    el.querySelectorAll('[data-invoice]').forEach(b => b.addEventListener('click', () => this.shell.newInvoiceFor(b.dataset.invoice)));
  }

  editBilling(clientId) {
    const { clients, billing } = this.shell.base;
    const c = clients.find(x => x.id === clientId); const b = billing.get(clientId) || {};
    formDialog({
      title: `Billing profile — ${clientLabel(c)}`,
      subtitle: 'Used on invoices. Leave withholding and terms empty to use the company defaults.',
      submitLabel: 'Save profile', maxWidth: '640px',
      fields: [
        { name: 'billing_type', label: 'Billing type', type: 'select', half: true, value: b.billing_type || 'on_demand', options: [{ value: 'on_demand', label: 'On-demand (per request)' }, { value: 'retainer', label: 'Retainer (monthly)' }] },
        { name: 'invoice_language', label: 'Invoice language', type: 'select', half: true, value: b.invoice_language || 'both', options: [{ value: 'both', label: 'Arabic + English' }, { value: 'ar', label: 'Arabic' }, { value: 'en', label: 'English' }] },
        { name: 'legal_name_ar', label: 'Legal name (Arabic)', half: true, value: b.legal_name_ar || '', maxlength: 200 },
        { name: 'legal_name_en', label: 'Legal name (English)', half: true, value: b.legal_name_en || '', maxlength: 200 },
        { name: 'tax_registration_no', label: 'Tax registration no.', half: true, value: b.tax_registration_no || '', maxlength: 40 },
        { name: 'billing_email', label: 'Billing email', type: 'email', half: true, value: b.billing_email || '', maxlength: 200 },
        { name: 'withholding_rate', label: 'Withholding tax %', type: 'number', step: '0.01', min: 0, max: 100, half: true, value: b.withholding_rate ?? '', hint: 'Empty = company default' },
        { name: 'payment_terms_days', label: 'Payment terms (days)', type: 'number', step: '1', min: 0, max: 365, half: true, value: b.payment_terms_days ?? '', hint: 'Empty = company default' },
        { name: 'billing_address', label: 'Billing address', type: 'textarea', rows: 2, value: b.billing_address || '', maxlength: 500 }
      ],
      onSubmit: async (v) => {
        await Api.finance('billing.save', { client_id: clientId, ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === null ? '' : x])) });
        Toast.success('Billing profile saved', 'Saved');
        await this.shell.reloadBase(); await this.load();
      }
    });
  }

  editPlan(planId = null, clientId = null) {
    const { clients, departments } = this.shell.base;
    const p = planId ? this.plans.find(x => x.id === planId) : {};
    formDialog({
      title: planId ? `Edit plan — ${p.name}` : 'New retainer plan',
      subtitle: 'The daily job creates one DRAFT invoice per month per active plan; you review and issue it.',
      submitLabel: planId ? 'Save plan' : 'Create plan', maxWidth: '640px',
      fields: [
        { name: 'client_id', label: 'Client', type: 'select', required: true, value: p.client_id || clientId || '', options: [{ value: '', label: 'Choose…' }, ...clients.map(c => ({ value: c.id, label: clientLabel(c) }))] },
        { name: 'name', label: 'Plan name', required: true, half: true, value: p.name || '', maxlength: 160, placeholder: 'e.g. Social media management' },
        { name: 'department_id', label: 'Department', type: 'select', half: true, value: p.department_id || '', options: [{ value: '', label: '—' }, ...departments.map(d => ({ value: d.id, label: d.name }))] },
        { name: 'monthly_fee', label: 'Monthly fee (EGP, before VAT)', type: 'number', required: true, step: '0.01', min: 0.01, half: true, value: p.monthly_fee ?? '' },
        { name: 'billing_day', label: 'Invoice date (day of month, 1–28)', type: 'number', step: '1', min: 1, max: 28, half: true, value: p.billing_day ?? 1 },
        { name: 'start_date', label: 'Start date', type: 'date', required: true, half: true, value: p.start_date || today() },
        { name: 'end_date', label: 'End date (optional)', type: 'date', half: true, value: p.end_date || '' },
        { name: 'description_en', label: 'Invoice line (English)', half: true, value: p.description_en || '', maxlength: 200 },
        { name: 'description_ar', label: 'Invoice line (Arabic)', half: true, value: p.description_ar || '', maxlength: 200 },
        { name: 'is_active', label: 'Status', type: 'select', value: String(p.is_active ?? true), options: [{ value: 'true', label: 'Active: billed every month' }, { value: 'false', label: 'Paused' }] }
      ],
      onSubmit: async (v) => {
        await Api.finance('plan.save', {
          id: planId || undefined, ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === null ? '' : x])),
          is_active: v.is_active === 'true'
        });
        Toast.success('Plan saved', 'Saved');
        await this.shell.reloadBase(); await this.load();
      }
    });
  }
}
