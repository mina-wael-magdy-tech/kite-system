/**
 * KITE SYSTEM — Module I: Finance & Expense Management
 * Department budgets, studio expense submissions, invoice tracking & manager approvals.
 */

import { getSupabase } from '../../supabase-client.js';
import { Permissions } from '../../permissions/permission-service.js';
import { Toast } from '../../services/toast-service.js';
import { Api } from '../../services/api.js';
import { escapeHTML, formatDate, formatCurrency } from '../../utils/helpers.js';
import { formatExpenseStatusBadge } from '../../utils/formatters.js';

export class FinanceModule {
  constructor(app) {
    this.app = app;
    this.expenses = [];
    this.invoices = [];
    this.departments = [];
  }

  async render(container) {
    const isFinanceOrAdmin = Permissions.isAdmin() || Permissions.hasRole('finance_manager');

    container.innerHTML = `
      <div class="page-container animate-fade-in">
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-4);">
          <div>
            <h1 class="font-display font-bold text-xl text-white">Finance & Operational Budgets</h1>
            <p class="text-xs text-muted" style="margin-top: 2px;">
              Submit expense claims and review approvals.
            </p>
          </div>

          <div style="display: flex; gap: var(--space-2);">
            <button type="button" class="btn btn-primary btn-sm" id="btnSubmitExpense">
              <i data-lucide="receipt"></i> Submit Expense
            </button>
          </div>
        </div>

        <!-- Budget & Expense KPI Cards -->
        <div class="kpi-grid">
          ${isFinanceOrAdmin ? `
          <div class="stat-card border-indigo">
            <div class="stat-card-header">
              <span class="stat-card-label">Annual Budget</span>
              <span class="badge badge-indigo">FY ${new Date().getFullYear()}</span>
            </div>
            <div class="stat-card-value font-mono" id="kpiBudget">—</div>
            <div class="stat-card-footer">Sum of budgets recorded for this fiscal year</div>
          </div>

          <div class="stat-card border-emerald">
            <div class="stat-card-header">
              <span class="stat-card-label">Client Invoices Paid</span>
              <span class="badge badge-emerald">Receivables</span>
            </div>
            <div class="stat-card-value font-mono" id="kpiInvoicesPaid">—</div>
            <div class="stat-card-footer">Total of paid receivable invoices</div>
          </div>
          ` : ''}

          <div class="stat-card border-amber">
            <div class="stat-card-header">
              <span class="stat-card-label">Pending Expense Approvals</span>
              <span class="badge badge-amber">Sign-Off</span>
            </div>
            <div class="stat-card-value" id="kpiPendingExpenses">0</div>
            <div class="stat-card-footer">Awaiting finance review</div>
          </div>

          ${isFinanceOrAdmin ? `
          <div class="stat-card border-sky">
            <div class="stat-card-header">
              <span class="stat-card-label">Vendor Payables</span>
              <span class="badge badge-sky">Suppliers</span>
            </div>
            <div class="stat-card-value font-mono" id="kpiPayables">—</div>
            <div class="stat-card-footer">Unpaid payable invoices</div>
          </div>
          ` : ''}
        </div>

        <!-- Expense Claims Table -->
        <div class="card">
          <div class="card-header">
            <div class="card-title">Studio Expense Submissions</div>
            <span class="badge badge-slate" id="expenseCountBadge">0 Records</span>
          </div>
          <div class="card-body" style="padding: 0;">
            <div class="table-responsive" style="border: none; border-radius: 0;">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Title & Category</th>
                    <th>Submitted By</th>
                    <th>Department</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Date</th>
                    ${isFinanceOrAdmin ? '<th style="text-align: right;">Approval Action</th>' : ''}
                  </tr>
                </thead>
                <tbody id="expensesTableBody">
                  <tr><td colspan="7" style="text-align: center; color: var(--text-dim); padding: var(--space-6);">Loading expenses...</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('btnSubmitExpense')?.addEventListener('click', () => this.openExpenseModal());

    await this.loadFinanceData();
  }

  async loadFinanceData() {
    const supabase = getSupabase();
    if (!supabase) return;

    try {
      // 1. Fetch departments
      const { data: depts } = await supabase.from('departments').select('id, name');
      this.departments = depts || [];

      // 2. Fetch expenses (RLS ensures employees only see own, while finance/admin sees all)
      const { data: expenses, error } = await supabase
        .from('expenses')
        .select(`
          *,
          profiles!expenses_submitted_by_fkey(full_name),
          departments!expenses_department_id_fkey(name)
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;
      this.expenses = expenses || [];
      this.renderExpensesTable();
      await this.loadTotals();
    } catch (err) {
      console.warn('Finance data fetch error:', err);
      this.renderExpensesTable();
    }
  }

  // Real figures from the database. Only finance/admin can read these tables (RLS).
  async loadTotals() {
    if (!(Permissions.isAdmin() || Permissions.hasRole('finance_manager'))) return;
    const supabase = getSupabase();
    const sum = (rows, key) => (rows || []).reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = formatCurrency(value); };
    try {
      const year = new Date().getFullYear();
      const [{ data: budgets, error: e1 }, { data: invoices, error: e2 }] = await Promise.all([
        supabase.from('budgets').select('amount').eq('fiscal_year', year),
        supabase.from('invoices').select('type, status, total')
      ]);
      if (e1 || e2) throw (e1 || e2);
      set('kpiBudget', sum(budgets, 'amount'));
      set('kpiInvoicesPaid', sum((invoices || []).filter(i => i.type === 'receivable' && i.status === 'paid'), 'total'));
      set('kpiPayables', sum((invoices || []).filter(i => i.type === 'payable' && ['draft', 'sent', 'overdue'].includes(i.status)), 'total'));
    } catch (err) {
      console.warn('Finance totals error:', err);
      ['kpiBudget', 'kpiInvoicesPaid', 'kpiPayables'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = 'n/a'; });
    }
  }

  renderExpensesTable() {
    const tbody = document.getElementById('expensesTableBody');
    const badge = document.getElementById('expenseCountBadge');
    const kpiPending = document.getElementById('kpiPendingExpenses');
    if (!tbody) return;

    const displayExpenses = this.expenses;

    if (badge) badge.textContent = `${displayExpenses.length} Claims`;
    if (kpiPending) kpiPending.textContent = String(displayExpenses.filter(e => e.status === 'submitted' || e.status === 'draft').length);
    if (displayExpenses.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-dim); padding: var(--space-6);">No expense claims yet.</td></tr>';
      return;
    }
    const isFinanceOrAdmin = Permissions.isAdmin() || Permissions.hasRole('finance_manager');

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
              <label class="form-label" for="expAmount">Amount (USD) *</label>
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
        const { error } = await supabase.from('expenses').insert({
          title,
          amount,
          category,
          department_id: deptId,
          submitted_by: this.app.currentUser.id,
          status: 'submitted'
        });

        if (error) throw error;
        Toast.success('Expense claim submitted for manager approval', 'Submitted');
        modalBackdrop.classList.remove('active');
        await this.loadFinanceData();
      } catch (err) {
        console.error('Expense submit error:', err);
        Toast.error(err.message || 'Submission failed', 'Error');
      }
    });
  }
}
