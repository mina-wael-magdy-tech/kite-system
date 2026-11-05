/**
 * KITE SYSTEM — Finance › Invoices
 * List, create / edit drafts, issue (sequential number), record payments, void, bilingual PDF.
 * Every figure is stored and calculated by the server (migration 017); the editor only previews.
 */

import { getSupabase } from '../../../supabase-client.js';
import { Api } from '../../../services/api.js';
import { Toast } from '../../../services/toast-service.js';
import { Money } from '../../../services/money.js';
import { formDialog, confirmDialog } from '../../../ui/dialogs.js';
import { escapeHTML, debounce } from '../../../utils/helpers.js';
import { PAGE_SIZE, fetchPage, mountPager, searchFilter } from '../../../ui/pagination.js';
import { fmt, egp, day, today, statusBadge, STATUS_LABELS, KIND_LABELS, previewTotals, previewLine, clientLabel, openModal } from '../fin-util.js';

export class InvoicesTab {
  constructor(shell) {
    this.shell = shell;          // FinanceModule: base data (clients, billing, departments, settings)
    this.invoices = [];          // the invoices on the current page
    this.page = 1;
    this.total = 0;
    this.hasAny = true;          // false only when no invoice exists at all, for the empty message
    this.loadSeq = 0;
    this.filter = { q: '', status: 'open', kind: 'all' };
  }

  html() {
    return `
      <div class="fin-toolbar">
        <input id="invSearch" type="search" class="form-control" placeholder="Search number or client…" aria-label="Search invoices" />
        <select id="invStatus" class="form-control" aria-label="Filter by status">
          <option value="open">Open (not paid / void)</option>
          <option value="all">All statuses</option>
          ${Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
        <select id="invKind" class="form-control" aria-label="Filter by type">
          <option value="all">All types</option>
          ${Object.entries(KIND_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
        <button type="button" class="btn btn-secondary btn-sm" id="btnRetainerRun" title="Create this month's draft invoices for every active retainer plan"><i data-lucide="repeat"></i> Run retainer billing</button>
        <button type="button" class="btn btn-primary btn-sm" id="btnNewInvoice"><i data-lucide="plus"></i> New invoice</button>
      </div>
      <div id="invList" class="fin-list"></div>
      <div id="invPager"></div>`;
  }

  async mount() {
    const q = document.getElementById('invSearch');
    const fromStart = () => { this.page = 1; return this.loadPage(); };
    q?.addEventListener('input', debounce(() => { this.filter.q = q.value.trim(); fromStart(); }, 250));
    document.getElementById('invStatus')?.addEventListener('change', (e) => { this.filter.status = e.target.value; fromStart(); });
    document.getElementById('invKind')?.addEventListener('change', (e) => { this.filter.kind = e.target.value; fromStart(); });
    document.getElementById('btnNewInvoice')?.addEventListener('click', () => this.openEditor());
    document.getElementById('btnRetainerRun')?.addEventListener('click', () => this.runRetainers());
    await this.load();
  }

  /** After a change: the current page and the figures at the top. */
  async load() {
    await this.loadPage();
    this.shell.refreshKpis?.();
  }

  /** Invoices are matched by their number or by their client's name, so the clients are found first. */
  async query() {
    const sb = getSupabase();
    const { q: term, status, kind } = this.filter;
    let search = searchFilter(['invoice_number'], term);
    if (search) {
      const { data: clients } = await sb.from('clients').select('id').or(searchFilter(['company_name', 'name'], term)).limit(200);
      if (clients?.length) search += `,client_id.in.(${clients.map(c => c.id).join(',')})`;
    }
    return () => {
      let qb = sb.from('invoices').select('*, client:clients(company_name, name)', { count: 'exact' })
        .order('created_at', { ascending: false }).order('id', { ascending: true });
      if (status === 'open') qb = qb.not('status', 'in', '("paid","void")');
      else if (status !== 'all') qb = qb.eq('status', status);
      if (kind !== 'all') qb = qb.eq('kind', kind);
      if (search) qb = qb.or(search);
      return qb;
    };
  }

  async loadPage() {
    const seq = ++this.loadSeq;
    const res = await fetchPage(await this.query(), this.page, PAGE_SIZE.table);
    if (seq !== this.loadSeq) return;
    if (res.error) { Toast.error(res.error.message, 'Invoices'); return; }
    this.invoices = res.rows;
    this.total = res.total;
    this.page = res.page;
    if (!res.total) {
      const { count } = await getSupabase().from('invoices').select('id', { count: 'exact', head: true });
      if (seq !== this.loadSeq) return;
      this.hasAny = Boolean(count);
    }
    this.renderList();
  }

  renderList() {
    const el = document.getElementById('invList');
    if (!el) return;
    mountPager(document.getElementById('invPager'), {
      page: this.page, total: this.total, size: PAGE_SIZE.table, label: 'invoices', top: el,
      onPage: (n) => { this.page = n; return this.loadPage(); }
    });
    const rows = this.invoices;
    if (!rows.length) {
      el.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><i data-lucide="receipt"></i></div>
        <div class="empty-state-title">${this.hasAny ? 'No invoices match' : 'No invoices yet'}</div>
        <div class="empty-state-desc">${this.hasAny ? 'Try another filter.' : 'Create the first invoice, or set up a retainer plan under Clients & retainers.'}</div></div>`;
      if (window.lucide) window.lucide.createIcons();
      return;
    }
    el.innerHTML = `<div class="table-responsive"><table class="data-table fin-table">
      <thead><tr><th>Invoice</th><th>Client</th><th>Issued</th><th>Due</th><th style="text-align:right">Total</th><th style="text-align:right">Balance</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.map(i => `
        <tr data-id="${i.id}" class="fin-row">
          <td data-label="Invoice"><b class="font-mono">${escapeHTML(i.invoice_number)}</b><div class="text-2xs text-dim">${escapeHTML(KIND_LABELS[i.kind] || i.kind)}</div></td>
          <td data-label="Client">${escapeHTML(clientLabel(i.client))}</td>
          <td data-label="Issued" class="font-mono text-xs">${day(i.issue_date)}</td>
          <td data-label="Due" class="font-mono text-xs">${day(i.due_date)}</td>
          <td data-label="Total" class="font-mono" style="text-align:right">${fmt(i.total)}</td>
          <td data-label="Balance" class="font-mono font-bold" style="text-align:right">${['void', 'draft'].includes(i.status) ? '—' : fmt(i.balance)}</td>
          <td data-label="Status">${statusBadge(i.status)}</td>
          <td style="text-align:right; white-space:nowrap">
            <button type="button" class="btn btn-secondary btn-sm" data-view="${i.id}">Open</button>
            <button type="button" class="card-act" data-pdf="${i.id}" title="Download PDF" aria-label="Download PDF" style="opacity:1"><i data-lucide="file-down"></i></button>
          </td>
        </tr>`).join('')}</tbody></table></div>`;
    el.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => this.openDetail(b.dataset.view)));
    el.querySelectorAll('[data-pdf]').forEach(b => b.addEventListener('click', () => this.downloadPdf(b.dataset.pdf)));
    el.querySelectorAll('.fin-row').forEach(r => r.addEventListener('dblclick', () => this.openDetail(r.dataset.id)));
    if (window.lucide) window.lucide.createIcons();
  }

  // ------------------------------------------------------------ detail

  async fetchFull(id) {
    const sb = getSupabase();
    const [inv, items, pays] = await Promise.all([
      sb.from('invoices').select('*, client:clients(company_name, name)').eq('id', id).single(),
      sb.from('invoice_items').select('*').eq('invoice_id', id).order('position', { ascending: true }),
      sb.from('invoice_payments').select('*, by:profiles!invoice_payments_recorded_by_fkey(full_name)').eq('invoice_id', id).order('created_at', { ascending: true })
    ]);
    if (inv.error) throw inv.error;
    return { invoice: inv.data, items: items.data || [], payments: pays.data || [] };
  }

  async openDetail(id) {
    let d;
    try { d = await this.fetchFull(id); } catch (err) { Toast.error(err.message || 'Could not load the invoice', 'Invoice'); return; }
    const { invoice: i, items, payments } = d;
    const senior = Money.isSenior();
    const open = ['sent', 'partially_paid', 'overdue'].includes(i.status);
    const { dialog, close } = openModal(`
      <div class="modal-header">
        <div><h2 class="modal-title font-display">${escapeHTML(i.invoice_number)} ${statusBadge(i.status)}</h2>
          <p class="text-2xs text-muted">${escapeHTML(clientLabel(i.client))} · ${escapeHTML(KIND_LABELS[i.kind] || i.kind)} · issued ${day(i.issue_date)} · due ${day(i.due_date)}</p></div>
        <button type="button" class="modal-close-btn" data-close aria-label="Close">&times;</button>
      </div>
      <div class="modal-body" style="display:flex; flex-direction:column; gap: var(--space-4);">
        <div class="table-responsive"><table class="data-table"><thead><tr><th>Description</th><th style="text-align:right">Qty</th><th style="text-align:right">Price</th><th style="text-align:right">Disc %</th><th style="text-align:right">VAT %</th><th style="text-align:right">Total</th></tr></thead>
        <tbody>${items.map(l => `<tr><td>${escapeHTML(l.description_en || '')}${l.description_ar ? `<div dir="rtl" class="text-xs text-muted">${escapeHTML(l.description_ar)}</div>` : ''}</td>
          <td class="font-mono" style="text-align:right">${Number(l.quantity)}</td><td class="font-mono" style="text-align:right">${fmt(l.unit_price)}</td>
          <td class="font-mono" style="text-align:right">${Number(l.discount_pct) || '—'}</td><td class="font-mono" style="text-align:right">${Number(l.vat_rate)}</td>
          <td class="font-mono" style="text-align:right">${fmt(l.line_total)}</td></tr>`).join('')}</tbody></table></div>
        <div class="fin-totals">
          ${Number(i.discount_total) > 0 ? `<div><span>Discount</span><b>(${fmt(i.discount_total)})</b></div>` : ''}
          <div><span>Subtotal</span><b>${fmt(i.subtotal)}</b></div>
          <div><span>VAT</span><b>${fmt(i.vat_amount)}</b></div>
          <div><span>Invoice total</span><b>${fmt(i.total)}</b></div>
          ${Number(i.withholding_amount) > 0 ? `<div><span>Withholding tax ${Number(i.withholding_rate)}%</span><b>(${fmt(i.withholding_amount)})</b></div>` : ''}
          <div class="fin-totals-main"><span>Net payable by client</span><b>${egp(i.net_receivable)}</b></div>
          ${Number(i.amount_paid) > 0 ? `<div><span>Paid</span><b>(${fmt(i.amount_paid)})</b></div><div><span>Balance due</span><b>${fmt(i.balance)}</b></div>` : ''}
        </div>
        ${i.notes ? `<div class="text-xs text-muted" style="white-space:pre-wrap">${escapeHTML(i.notes)}</div>` : ''}
        ${i.status === 'void' ? `<div class="alert alert-error">Voided ${day(i.voided_at)} — ${escapeHTML(i.void_reason || '')}</div>` : ''}
        <div>
          <div class="text-2xs font-bold text-dim uppercase" style="margin-bottom:4px">Payments</div>
          ${payments.length ? payments.map(p => `<div class="fin-pay ${p.reversed_at ? 'reversed' : ''}">
              <span class="font-mono">${day(p.paid_on)}</span><span>${escapeHTML(p.method.replace('_', ' '))}${p.reference ? ' · ' + escapeHTML(p.reference) : ''}</span>
              <b class="font-mono">${fmt(p.amount)}</b>
              ${p.reversed_at ? `<span class="badge badge-slate">reversed: ${escapeHTML(p.reversal_reason || '')}</span>`
                : (senior ? `<button type="button" class="btn btn-secondary btn-sm" data-reverse="${p.id}">Reverse</button>` : '')}
            </div>`).join('') : '<div class="text-xs text-dim">No payments yet.</div>'}
        </div>
      </div>
      <div class="modal-footer" style="justify-content: space-between; flex-wrap: wrap; gap: var(--space-2);">
        <div style="display:flex; gap: var(--space-2); flex-wrap: wrap;">
          ${senior && i.status !== 'void' ? '<button type="button" class="btn btn-danger btn-sm" data-act="void">Void</button>' : ''}
          <button type="button" class="btn btn-secondary btn-sm" data-act="pdf"><i data-lucide="file-down"></i> PDF</button>
        </div>
        <div style="display:flex; gap: var(--space-2); flex-wrap: wrap;">
          ${i.status === 'draft' ? '<button type="button" class="btn btn-secondary btn-sm" data-act="edit">Edit</button><button type="button" class="btn btn-primary btn-sm" data-act="issue">Issue invoice</button>' : ''}
          ${open ? '<button type="button" class="btn btn-primary btn-sm" data-act="pay">Record payment</button>' : ''}
        </div>
      </div>`, '760px');
    if (window.lucide) window.lucide.createIcons();
    const on = (act, fn) => dialog.querySelector(`[data-act="${act}"]`)?.addEventListener('click', fn);
    on('pdf', () => this.downloadPdf(id));
    on('edit', () => { close(); this.openEditor(id); });
    on('issue', async () => { close(); await this.issue(id); });
    on('pay', () => { close(); this.recordPayment(i); });
    on('void', () => { close(); this.voidInvoice(i); });
    dialog.querySelectorAll('[data-reverse]').forEach(b => b.addEventListener('click', () => { close(); this.reversePayment(i, b.dataset.reverse); }));
  }

  // ------------------------------------------------------------ actions

  async issue(id) {
    const ok = await confirmDialog({ title: 'Issue this invoice?', message: 'It gets its sequential number and can no longer be edited. To correct it later you void it and create a new one.', confirmLabel: 'Issue invoice' });
    if (!ok) return;
    try {
      const { number } = await Api.finance('invoice.issue', { id });
      Toast.success(`Invoice ${number} issued`, 'Issued');
      await this.load();
      this.openDetail(id);
    } catch (err) { Toast.error(err.message, 'Could not issue'); }
  }

  recordPayment(inv) {
    formDialog({
      title: `Record payment — ${inv.invoice_number}`,
      subtitle: `Balance due: ${egp(inv.balance)}`,
      submitLabel: 'Save payment',
      fields: [
        { name: 'amount', label: 'Amount (EGP)', type: 'number', required: true, step: '0.01', min: 0.01, value: Number(inv.balance), half: true },
        { name: 'paidOn', label: 'Paid on', type: 'date', required: true, value: today(), half: true },
        { name: 'method', label: 'Method', type: 'select', value: 'bank_transfer', half: true, options: [
          { value: 'bank_transfer', label: 'Bank transfer' }, { value: 'cash', label: 'Cash' }, { value: 'cheque', label: 'Cheque' },
          { value: 'card', label: 'Card' }, { value: 'wallet', label: 'Mobile wallet' }, { value: 'other', label: 'Other' }] },
        { name: 'reference', label: 'Reference', half: true, maxlength: 120, placeholder: 'Transfer / cheque number' },
        { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, maxlength: 500 }
      ],
      onSubmit: async (v) => {
        await Api.finance('payment.add', { invoiceId: inv.id, amount: v.amount, paidOn: v.paidOn, method: v.method, reference: v.reference, notes: v.notes });
        Toast.success('Payment recorded', 'Saved');
        await this.load();
      }
    });
  }

  reversePayment(inv, paymentId) {
    formDialog({
      title: 'Reverse this payment?', subtitle: 'The payment stays in the history marked as reversed; the invoice balance is restored.',
      submitLabel: 'Reverse payment',
      fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, rows: 2, maxlength: 500, placeholder: 'e.g. cheque bounced' }],
      onSubmit: async (v) => { await Api.finance('payment.reverse', { paymentId, reason: v.reason }); Toast.success('Payment reversed', 'Saved'); await this.load(); }
    });
  }

  voidInvoice(inv) {
    formDialog({
      title: `Void ${inv.invoice_number}?`, subtitle: 'Invoices are never deleted. A void invoice keeps its number and stays in the records, marked VOID.',
      submitLabel: 'Void invoice',
      fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true, rows: 2, maxlength: 500, placeholder: 'e.g. issued to the wrong client' }],
      onSubmit: async (v) => { await Api.finance('invoice.void', { id: inv.id, reason: v.reason }); Toast.success('Invoice voided', 'Voided'); await this.load(); }
    });
  }

  async runRetainers() {
    const month = today().slice(0, 7) + '-01';
    const ok = await confirmDialog({ title: 'Run retainer billing?', message: `Creates a DRAFT invoice for every active retainer plan that has none for ${month.slice(0, 7)}. Nothing is sent until you issue it.`, confirmLabel: 'Create drafts' });
    if (!ok) return;
    try {
      const { created } = await Api.finance('retainer.run', { month });
      Toast.success(created ? `${created} draft invoice${created === 1 ? '' : 's'} created` : 'Nothing to create: every active plan already has its invoice', 'Retainer billing');
      await this.load();
    } catch (err) { Toast.error(err.message, 'Retainer billing'); }
  }

  async downloadPdf(id) {
    try {
      Toast.info('Preparing the PDF…', 'PDF');
      const { invoice, items, payments } = await this.fetchFull(id);
      const { FinancePdf } = await import('../../../services/finance-pdf.js');
      const base = this.shell.base || {};
      const blob = await FinancePdf.invoice({
        invoice, items, payments, client: invoice.client || {}, billing: base.billing?.get(invoice.client_id), settings: base.settings || {}
      });
      FinancePdf.download(blob, `${invoice.invoice_number}.pdf`);
    } catch (err) { Toast.error(err.message || 'Could not create the PDF', 'PDF'); }
  }

  // ------------------------------------------------------------ editor

  async openEditor(id = null, preset = {}) {
    const base = this.shell.base;
    let inv = null, items = [];
    if (id) {
      try { ({ invoice: inv, items } = await this.fetchFull(id)); } catch (err) { Toast.error(err.message, 'Invoice'); return; }
      if (inv.status !== 'draft') { Toast.warning('Only drafts can be edited. Void it and create a new one.', 'Invoice'); return; }
    }
    const vat = Number(base.settings.vat_rate ?? 14);
    const startItems = items.length ? items : [{ description_ar: '', description_en: '', quantity: 1, unit_price: '', discount_pct: 0, vat_rate: vat }];
    const sel = (name, opts, val, extra = '') => `<select id="${name}" class="form-control" ${extra}>${opts.map(o => `<option value="${escapeHTML(o.value)}" ${String(o.value) === String(val ?? '') ? 'selected' : ''}>${escapeHTML(o.label)}</option>`).join('')}</select>`;
    const { data: tasks } = await getSupabase().from('tasks').select('id, task_number, title').order('created_at', { ascending: false }).limit(150);

    const { dialog, close } = openModal(`
      <div class="modal-header"><h2 class="modal-title font-display">${id ? `Edit draft ${escapeHTML(inv.invoice_number)}` : 'New invoice'}</h2>
        <button type="button" class="modal-close-btn" data-close aria-label="Close">&times;</button></div>
      <form id="invForm" novalidate>
        <div class="modal-body fin-form">
          <div class="form-group"><label class="form-label" for="fClient">Client *</label>
            ${sel('fClient', [{ value: '', label: 'Choose a client…' }, ...base.clients.map(c => ({ value: c.id, label: clientLabel(c) }))], inv?.client_id ?? preset.client_id, 'required')}</div>
          <div class="form-group"><label class="form-label" for="fKind">Type</label>
            ${sel('fKind', [{ value: 'project', label: 'Project / deliverable' }, { value: 'adhoc', label: 'One-off request' }, { value: 'retainer', label: 'Retainer' }], inv?.kind ?? preset.kind ?? 'project')}</div>
          <div class="form-group"><label class="form-label" for="fDept">Department</label>
            ${sel('fDept', [{ value: '', label: '—' }, ...base.departments.map(d => ({ value: d.id, label: d.name }))], inv?.department_id)}</div>
          <div class="form-group"><label class="form-label" for="fTask">Deliverable (task)</label>
            ${sel('fTask', [{ value: '', label: '—' }, ...(tasks || []).map(t => ({ value: t.id, label: `${t.task_number || ''} ${t.title}`.trim() }))], inv?.task_id)}</div>
          <div class="form-group"><label class="form-label" for="fIssue">Issue date</label><input id="fIssue" type="date" class="form-control" value="${escapeHTML(inv?.issue_date || today())}" /></div>
          <div class="form-group"><label class="form-label" for="fDue">Due date</label><input id="fDue" type="date" class="form-control" value="${escapeHTML(inv?.due_date || '')}" /><p class="text-2xs text-dim">Empty = issue date + the client's payment terms.</p></div>
          <div class="form-group"><label class="form-label" for="fLang">Invoice language</label>
            ${sel('fLang', [{ value: 'both', label: 'Arabic + English' }, { value: 'ar', label: 'Arabic' }, { value: 'en', label: 'English' }], inv?.language ?? 'both')}</div>
          <div class="form-group"><label class="form-label" for="fWht">Withholding tax %</label><input id="fWht" type="number" step="0.01" min="0" max="100" class="form-control" value="${inv ? Number(inv.withholding_rate) : ''}" placeholder="client default" /></div>
          <div class="form-group" style="grid-column: 1 / -1;">
            <div class="text-2xs font-bold text-dim uppercase" style="margin-bottom:6px">Line items</div>
            <div id="fItems" class="fin-items"></div>
            <button type="button" class="btn btn-secondary btn-sm" id="btnAddLine" style="margin-top:6px"><i data-lucide="plus"></i> Add line</button>
          </div>
          <div class="form-group" style="grid-column: 1 / -1;"><label class="form-label" for="fNotes">Notes (printed on the invoice)</label><textarea id="fNotes" rows="2" class="form-control" maxlength="1000">${escapeHTML(inv?.notes || '')}</textarea></div>
          <div class="fin-totals" id="fTotals" style="grid-column: 1 / -1;"></div>
          <div id="fError" class="alert alert-error hidden" style="grid-column: 1 / -1; margin:0"></div>
        </div>
        <div class="modal-footer" style="justify-content: space-between;">
          <span class="text-2xs text-dim">Preview only: the server recalculates every figure when you save.</span>
          <div style="display:flex; gap: var(--space-2)">
            <button type="button" class="btn btn-secondary btn-sm" data-close>Cancel</button>
            <button type="submit" class="btn btn-secondary btn-sm" data-after="save">Save draft</button>
            <button type="submit" class="btn btn-primary btn-sm" data-after="issue">Save &amp; issue</button>
          </div>
        </div>
      </form>`, '880px');

    const $ = (s) => dialog.querySelector(s);
    const itemsEl = $('#fItems');
    const addLine = (l = {}) => {
      const row = document.createElement('div');
      row.className = 'fin-item';
      row.innerHTML = `
        <input data-f="description_en" class="form-control" placeholder="Description (English)" maxlength="300" value="${escapeHTML(l.description_en || '')}" />
        <input data-f="description_ar" dir="rtl" class="form-control" placeholder="الوصف بالعربية" maxlength="300" value="${escapeHTML(l.description_ar || '')}" />
        <label>Qty<input data-f="quantity" type="number" step="0.001" min="0.001" class="form-control" value="${l.quantity ?? 1}" /></label>
        <label>Price<input data-f="unit_price" type="number" step="0.01" min="0" class="form-control" value="${l.unit_price ?? ''}" /></label>
        <label>Disc %<input data-f="discount_pct" type="number" step="0.01" min="0" max="100" class="form-control" value="${l.discount_pct ?? 0}" /></label>
        <label>VAT %<input data-f="vat_rate" type="number" step="0.01" min="0" max="100" class="form-control" value="${l.vat_rate ?? vat}" /></label>
        <div class="fin-line-total font-mono"></div>
        <button type="button" class="card-act card-act-delete" data-remove aria-label="Remove line" style="opacity:1"><i data-lucide="trash-2"></i></button>`;
      itemsEl.appendChild(row);
      row.querySelectorAll('input').forEach(i => i.addEventListener('input', recalc));
      row.querySelector('[data-remove]').addEventListener('click', () => { if (itemsEl.children.length > 1) { row.remove(); recalc(); } });
      if (window.lucide) window.lucide.createIcons();
    };
    const readItems = () => [...itemsEl.children].map(r => {
      const g = (f) => r.querySelector(`[data-f="${f}"]`).value;
      return { description_en: g('description_en').trim(), description_ar: g('description_ar').trim(), quantity: Number(g('quantity')), unit_price: Number(g('unit_price')), discount_pct: Number(g('discount_pct')) || 0, vat_rate: Number(g('vat_rate')) };
    });
    const whtRate = () => {
      const v = $('#fWht').value;
      if (v !== '') return Number(v);
      return Number(base.billing.get($('#fClient').value)?.withholding_rate ?? base.settings.default_withholding_rate ?? 0);
    };
    function recalc() {
      const its = readItems();
      const t = previewTotals(its, whtRate());
      [...itemsEl.children].forEach((r, i) => { r.querySelector('.fin-line-total').textContent = fmt(previewLine(its[i]).total); });
      $('#fTotals').innerHTML = `
        ${t.discount > 0 ? `<div><span>Discount</span><b>(${fmt(t.discount)})</b></div>` : ''}
        <div><span>Subtotal</span><b>${fmt(t.subtotal)}</b></div><div><span>VAT</span><b>${fmt(t.vat)}</b></div>
        <div><span>Invoice total</span><b>${fmt(t.total)}</b></div>
        ${t.wht > 0 ? `<div><span>Withholding tax</span><b>(${fmt(t.wht)})</b></div>` : ''}
        <div class="fin-totals-main"><span>Net payable by client</span><b>${egp(t.net)}</b></div>`;
    }
    startItems.forEach(addLine);
    $('#btnAddLine').addEventListener('click', () => { addLine(); recalc(); });
    $('#fWht').addEventListener('input', recalc);
    $('#fClient').addEventListener('change', () => {
      const b = base.billing.get($('#fClient').value);
      if (b?.invoice_language && !id) $('#fLang').value = b.invoice_language;
      recalc();
    });
    recalc();

    let after = 'save';
    dialog.querySelectorAll('[data-after]').forEach(b => b.addEventListener('click', () => { after = b.dataset.after; }));
    $('#invForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#fError'); err.classList.add('hidden');
      const its = readItems();
      if (!$('#fClient').value) { err.textContent = 'Choose a client.'; err.classList.remove('hidden'); return; }
      if (its.some(l => !l.description_en && !l.description_ar)) { err.textContent = 'Every line needs a description (Arabic or English).'; err.classList.remove('hidden'); return; }
      if (its.some(l => !(l.quantity > 0) || !(l.unit_price >= 0))) { err.textContent = 'Check the quantity and price of every line.'; err.classList.remove('hidden'); return; }
      dialog.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try {
        const { id: savedId } = await Api.finance('invoice.save', {
          id: id || undefined, client_id: $('#fClient').value, kind: $('#fKind').value,
          department_id: $('#fDept').value || undefined, task_id: $('#fTask').value || undefined,
          issue_date: $('#fIssue').value || undefined, due_date: $('#fDue').value || undefined,
          language: $('#fLang').value, withholding_rate: $('#fWht').value === '' ? undefined : Number($('#fWht').value),
          notes: $('#fNotes').value.trim() || undefined, items: its
        });
        close();
        Toast.success('Draft saved', 'Invoice');
        await this.load();
        if (after === 'issue') await this.issue(savedId); else this.openDetail(savedId);
      } catch (ex) {
        err.textContent = ex.message || 'Could not save'; err.classList.remove('hidden');
        dialog.querySelectorAll('button').forEach(b => { b.disabled = false; });
      }
    });
  }
}
