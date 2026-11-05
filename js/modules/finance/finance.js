/**
 * KITE SYSTEM — Module I: Finance & Expense Management
 * Department budgets, studio expense submissions, invoice tracking & manager approvals.
 */

import { Realtime } from '../../services/realtime-service.js';
import { getSupabase } from '../../supabase-client.js';
import { Toast } from '../../services/toast-service.js';
import { Api } from '../../services/api.js';
import { Money } from '../../services/money.js';
import { escapeHTML, formatDate, formatCurrency } from '../../utils/helpers.js';
import { formatExpenseStatusBadge } from '../../utils/formatters.js';
import { loadBase, egp } from './fin-util.js';
import { InvoicesTab } from './tabs/invoices.js';
import { ClientsTab } from './tabs/clients.js';
import { SettingsTab } from './tabs/settings.js';
import { PAGE_SIZE, fetchPage, mountPager } from '../../ui/pagination.js';

const TABS = [
  { id: 'invoices', label: 'Invoices', icon: 'receipt' },
  { id: 'clients', label: 'Clients & retainers', icon: 'repeat' },
  { id: 'expenses', label: 'Expenses', icon: 'wallet' },
  { id: 'settings', label: 'Settings', icon: 'settings' }
];

export class FinanceModule {
  constructor(app) {
    this.app = app;
    this.expenses = [];          // the expenses on the current page
    this.expensePage = 1;
    this.expenseTotal = 0;
    this.expensePending = 0;
    this.expenseSeq = 0;
    this.invoices = [];
    this.departments = [];
  }

  async render(container, query = '') {
    if (!Money.canFinance()) {
      container.innerHTML = `<div class="page-container"><div class="empty-state"><div class="empty-state-icon"><i data-lucide="lock"></i></div>
        <div class="empty-state-title">Finance team only</div><div class="empty-state-desc">Finance is available to the owner, the finance manager and the accountant.</div></div></div>`;
      return;
    }
    const wanted = new URLSearchParams(query || '').get('tab');
    this.tab = TABS.some(t => t.id === wanted) ? wanted : (this.tab || 'invoices');

    container.innerHTML = `
      <div class="page-container animate-fade-in">
        <div>
          <h1 class="font-display font-bold text-xl text-white">Finance & Operational Budgets</h1>
          <p class="text-xs text-muted" style="margin-top: 2px;">Invoices, retainers, expenses and company finance settings. All figures in EGP.</p>
        </div>

        <div class="kpi-grid">
          <div class="stat-card border-sky"><div class="stat-card-header"><span class="stat-card-label">Outstanding</span><span class="badge badge-sky">Receivables</span></div>
            <div class="stat-card-value font-mono" id="kpiOutstanding">—</div><div class="stat-card-footer">Unpaid balance on issued invoices</div></div>
          <div class="stat-card border-rose"><div class="stat-card-header"><span class="stat-card-label">Overdue</span><span class="badge badge-rose">Past due date</span></div>
            <div class="stat-card-value font-mono" id="kpiOverdue">—</div><div class="stat-card-footer">Needs a reminder or a call</div></div>
          <div class="stat-card border-emerald"><div class="stat-card-header"><span class="stat-card-label">Collected this month</span><span class="badge badge-emerald">Payments</span></div>
            <div class="stat-card-value font-mono" id="kpiCollected">—</div><div class="stat-card-footer">Payments received, reversals excluded</div></div>
          <div class="stat-card border-amber"><div class="stat-card-header"><span class="stat-card-label">Pending expense approvals</span><span class="badge badge-amber">Sign-off</span></div>
            <div class="stat-card-value" id="kpiPendingExpenses">0</div><div class="stat-card-footer">Awaiting finance review</div></div>
        </div>

        <div class="tabs-nav" role="tablist" id="finTabs">
          ${TABS.map(t => `<button type="button" class="tab-btn ${t.id === this.tab ? 'active' : ''}" role="tab" data-tab="${t.id}"><i data-lucide="${t.icon}"></i> ${t.label}</button>`).join('')}
        </div>
        <div id="financePanel"></div>
      </div>
    `;
    document.querySelectorAll('#finTabs [data-tab]').forEach(b => b.addEventListener('click', () => this.showTab(b.dataset.tab)));
    if (window.lucide) window.lucide.createIcons();

    try { await this.reloadBase(); } catch (err) {
      document.getElementById('financePanel').innerHTML = `<div class="alert alert-error">Could not load finance data: ${escapeHTML(err.message || 'unknown error')}. Has migration 017 been applied?</div>`;
      return;
    }
    await this.showTab(this.tab);
    this.refreshKpis();
    Realtime.watch(['invoices', 'invoice_payments', 'retainer_plans', 'client_billing', 'expenses'], async () => {
      await this.current?.load?.();
      this.refreshKpis();
    });
  }

  async reloadBase() { this.base = await loadBase(); }

  async showTab(id) {
    this.tab = id;
    document.querySelectorAll('#finTabs [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
    const panel = document.getElementById('financePanel');
    if (!panel) return;
    const Tab = { invoices: InvoicesTab, clients: ClientsTab, settings: SettingsTab }[id];
    this.current = Tab ? new Tab(this) : null;
    if (this.current) {
      panel.innerHTML = this.current.html();
      if (window.lucide) window.lucide.createIcons();
      await this.current.mount();
    } else {
      panel.innerHTML = this.expensesHtml();
      document.getElementById('btnSubmitExpense')?.addEventListener('click', () => this.openExpenseModal());
      await this.loadFinanceData();
    }
  }

  /** "Invoice" button on a client card: open the editor with that client already chosen. */
  async newInvoiceFor(clientId) {
    await this.showTab('invoices');
    this.current.openEditor(null, { client_id: clientId });
  }

  async refreshKpis() {
    const sb = getSupabase();
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    try {
      const monthStart = new Date().toISOString().slice(0, 7) + '-01';
      const [inv, pay] = await Promise.all([
        sb.from('invoices').select('balance, status').in('status', ['sent', 'partially_paid', 'overdue']),
        sb.from('invoice_payments').select('amount').gte('paid_on', monthStart).is('reversed_at', null)
      ]);
      if (inv.error || pay.error) throw (inv.error || pay.error);
      const sum = (rows, k) => (rows || []).reduce((a, r) => a + (Number(r[k]) || 0), 0);
      set('kpiOutstanding', egp(sum(inv.data, 'balance')));
      set('kpiOverdue', egp(sum((inv.data || []).filter(i => i.status === 'overdue'), 'balance')));
      set('kpiCollected', egp(sum(pay.data, 'amount')));
    } catch (err) {
      console.warn('Finance KPIs:', err);
      ['kpiOutstanding', 'kpiOverdue', 'kpiCollected'].forEach(id => set(id, 'n/a'));
    }
  }

  expensesHtml() {
    const isFinanceOrAdmin = Money.canFinance();
    return `
      <div style="display: flex; justify-content: flex-end; margin-bottom: var(--space-3);">
        <button type="button" class="btn btn-primary btn-sm" id="btnSubmitExpense"><i data-lucide="receipt"></i> Submit Expense</button>
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">Studio Expense Submissions</div><span class="badge badge-slate" id="expenseCountBadge">0 Records</span></div>
        <div class="card-body" style="padding: 0;">
          <div class="table-responsive" style="border: none; border-radius: 0;">
            <table class="data-table">
              <thead><tr><th>Title & Category</th><th>Submitted By</th><th>Department</th><th>Amount</th><th>Status</th><th>Date</th>
                ${isFinanceOrAdmin ? '<th style="text-align: right;">Approval Action</th>' : ''}</tr></thead>
              <tbody id="expensesTableBody"><tr><td colspan="7" style="text-align: center; color: var(--text-dim); padding: var(--space-6);">Loading expenses...</td></tr></tbody>
            </table>
          </div>
          <div id="expensesPager"></div>
        </div>
      </div>`;
  }

  async loadFinanceData() {
    const supabase = getSupabase();
    if (!supabase) return;
    const seq = ++this.expenseSeq;

    try {
      // RLS ensures employees only see their own expenses, while finance/admin sees all
      const build = () => supabase
        .from('expenses')
        .select(`
          *,
          profiles!expenses_submitted_by_fkey(full_name),
          departments!expenses_department_id_fkey(name)
        `, { count: 'exact' })
        .order('created_at', { ascending: false }).order('id', { ascending: true });
      const [{ data: depts }, res, pending] = await Promise.all([
        supabase.from('departments').select('id, name'),
        fetchPage(build, this.expensePage, PAGE_SIZE.table),
        supabase.from('expenses').select('id', { count: 'exact', head: true }).in('status', ['submitted', 'draft'])
      ]);
      if (seq !== this.expenseSeq) return;
      if (res.error) throw res.error;
      this.departments = depts || [];
      this.expenses = res.rows;
      this.expenseTotal = res.total;
      this.expensePage = res.page;
      this.expensePending = pending.count ?? 0;
      this.renderExpensesTable();
    } catch (err) {
      console.warn('Finance data fetch error:', err);
      this.renderExpensesTable();
    }
  }

  renderExpensesTable() {
    const tbody = document.getElementById('expensesTableBody');
    const badge = document.getElementById('expenseCountBadge');
    const kpiPending = document.getElementById('kpiPendingExpenses');
    if (!tbody) return;

    const displayExpenses = this.expenses;

    if (badge) badge.textContent = `${this.expenseTotal} Claims`;
    if (kpiPending) kpiPending.textContent = String(this.expensePending);
    mountPager(document.getElementById('expensesPager'), {
      page: this.expensePage, total: this.expenseTotal, size: PAGE_SIZE.table, label: 'claims', top: tbody.closest('.card'),
      onPage: (n) => { this.expensePage = n; return this.loadFinanceData(); }
    });
    if (displayExpenses.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-dim); padding: var(--space-6);">No expense claims yet.</td></tr>';
      return;
    }
    const isFinanceOrAdmin = Money.canFinance();

    tbody.innerHTML = displayExpenses.map(e => `
      <tr>
        <td>
          <div class="font-bold text-white">${escapeHTML(e.title)}</div>
          <span class="badge badge-slate uppercase" style="font-size: 9px;">${escapeHTML(e.category)}</span>
        </td>
        <td class="text-xs text-muted">${escapeHTML(e.profiles?.full_name || 'Specialist')}</td>
        <td><span class="badge badge-indigo">${escapeHTML(e.departments?.name || 'Studio')}</span></td>
        <td class="font-mono font-bold text-emerald">${formatCurrency(e.amount)}</td>
        <td>${formatExpenseStatusBadge(e.status)}</td>
        <td class="font-mono text-2xs text-dim">${formatDate(e.created_at)}</td>
        ${isFinanceOrAdmin ? `
          <td style="text-align: right; white-space: nowrap;">
            ${e.status === 'submitted' ? `
              <button type="button" class="btn btn-primary btn-sm btn-approve-exp" data-id="${e.id}">Approve</button>
              <button type="button" class="btn btn-danger btn-sm btn-reject-exp" data-id="${e.id}">Reject</button>
            ` : '<span class="text-2xs text-dim">Settled</span>'}
          </td>
        ` : ''}
      </tr>
    `).join('');

    if (isFinanceOrAdmin) {
      tbody.querySelectorAll('.btn-approve-exp').forEach(btn => {
        btn.addEventListener('click', () => this.handleReviewExpense(btn.getAttribute('data-id'), 'approved'));
      });
      tbody.querySelectorAll('.btn-reject-exp').forEach(btn => {
        btn.addEventListener('click', () => this.handleReviewExpense(btn.getAttribute('data-id'), 'rejected'));
      });
    }
  }

  async handleReviewExpense(expenseId, decision) {
    try {
      await Api.decideExpense(expenseId, decision);
      Toast.success(`Expense ${decision}!`, 'Finance Decision');
      await this.loadFinanceData();
    } catch (err) {
      console.error('Expense review error:', err);
      Toast.error(err.message || 'Action failed', 'Error');
    }
  }

  openExpenseModal() {
    const modalBackdrop = document.getElementById('globalModalBackdrop');
    const modalDialog = document.getElementById('globalModalDialog');
    if (!modalBackdrop || !modalDialog) return;

    modalDialog.style.maxWidth = '480px';
    modalDialog.innerHTML = `
      <div class="modal-header">
        <h2 class="modal-title font-display">Submit Studio Expense Claim</h2>
        <button type="button" class="modal-close-btn" id="btnCancelExp">&times;</button>
      </div>

      <form id="createExpenseForm">
        <div class="modal-body" style="display: flex; flex-direction: column; gap: var(--space-3-5);">
          <div class="form-group">
            <label class="form-label" for="expTitle">Expense Description *</label>
            <input id="expTitle" type="text" required placeholder="e.g. 4K Camera Lens Rental for Veloce Shoot" class="form-control" />
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
            <div class="form-group">
              <label class="form-label" for="expAmount">Amount (EGP) *</label>
              <input id="expAmount" type="number" required step="0.01" value="450.00" class="form-control" />
            </div>

            <div class="form-group">
              <label class="form-label" for="expCategory">Category *</label>
              <select id="expCategory" class="form-control">
                <option value="software">Software & Subscriptions</option>
                <option value="hardware">Hardware & Fabrication</option>
                <option value="marketing">Marketing & Paid Ads</option>
                <option value="travel">Travel & Client Meetings</option>
                <option value="office">Studio Office Supplies</option>
                <option value="contractor">External Talent / VO</option>
              </select>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="expDept">Department</label>
            <select id="expDept" class="form-control">
              ${this.departments.map(d => `<option value="${d.id}">${escapeHTML(d.name)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary btn-sm" id="btnCancelExpAction">Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm">Submit for Approval</button>
        </div>
      </form>
    `;

    modalBackdrop.classList.add('active');

    document.getElementById('btnCancelExp')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));
    document.getElementById('btnCancelExpAction')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));

    document.getElementById('createExpenseForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();

      const title = document.getElementById('expTitle').value.trim();
      const amount = Number(document.getElementById('expAmount').value) || 0;
      const category = document.getElementById('expCategory').value;
      const deptId = document.getElementById('expDept').value || null;

      const supabase = getSupabase();
      try {
        const { data: created, error } = await supabase.from('expenses').insert({
          title,
          amount,
          category,
          department_id: deptId,
          submitted_by: this.app.currentUser.id,
          status: 'submitted'
        }).select('id').single();

        if (error) throw error;
        Api.expenseSubmitted(created.id).catch(() => {}); // notify the approvers; never blocks the user
        Toast.success('Expense claim submitted for manager approval', 'Submitted');
        modalBackdrop.classList.remove('active');
        this.expensePage = 1; // the new claim is the newest
        await this.loadFinanceData();
      } catch (err) {
        console.error('Expense submit error:', err);
        Toast.error(err.message || 'Submission failed', 'Error');
      }
    });
  }
}
