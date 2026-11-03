/**
 * KITE SYSTEM — Module C: Department Management
 * Overview & control for the 5 initial creative studio hubs: Branding, BTL, Digital, Media & Web Dev.
 */

import { Realtime } from '../../services/realtime-service.js';
import { getSupabase } from '../../supabase-client.js';
import { Permissions } from '../../permissions/permission-service.js';
import { Toast } from '../../services/toast-service.js';
import { formDialog, confirmDialog } from '../../ui/dialogs.js';
import { escapeHTML, formatCurrency } from '../../utils/helpers.js';
import { Money } from '../../services/money.js';

export class DepartmentsModule {
  constructor(app) {
    this.app = app;
    this.departments = [];
  }

  async render(container) {
    container.innerHTML = `
      <div class="page-container animate-fade-in">
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-4);">
          <div>
            <h1 class="font-display font-bold text-xl text-white">The 5 Creative Departments</h1>
            <p class="text-xs text-muted" style="margin-top: 2px;">
              Manage studio departments, assign departmental leads, and allocate operational budgets.
            </p>
          </div>

          ${Permissions.isAdmin() ? `
            <button type="button" class="btn btn-primary btn-sm" id="btnCreateDept">
              <i data-lucide="plus"></i> Add Department
            </button>
          ` : ''}
        </div>

        <div id="departmentsGrid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--space-4);">
          <div class="empty-state" style="border:none; padding: 40px 0; grid-column: 1 / -1;">
            <div class="empty-state-icon animate-spin">⟳</div>
            <div class="empty-state-title">Loading departments...</div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('btnCreateDept')?.addEventListener('click', () => {
      this.openDeptModal();
    });

    await this.loadDepartments();
    Realtime.watch(['departments'], () => this.loadDepartments()); // live updates for everyone
  }

  async loadDepartments() {
    const supabase = getSupabase();
    if (!supabase) return;

    try {
      const { data: depts, error } = await supabase
        .from('departments')
        .select(`
          *,
          manager:profiles!fk_dept_manager(full_name, email),
          profiles!profiles_department_id_fkey(id)
        `)
        .order('name', { ascending: true });

      if (error) throw error;
      this.budgets = await Money.map('department_budget'); // empty unless you are the owner / CEO
      this.departments = depts || [];
      this.renderDepartments();
    } catch (err) {
      console.warn('Departments error:', err);
      this.renderDepartments();
    }
  }

  renderDepartments() {
    const container = document.getElementById('departmentsGrid');
    if (!container) return;

    const displayDepts = this.departments;
    if (displayDepts.length === 0) {
      container.innerHTML = '<div class="empty-state" style="grid-column: 1 / -1;"><div class="empty-state-icon"><i data-lucide="building-2"></i></div><div class="empty-state-title">No departments yet</div><div class="empty-state-desc">Add your first department to start organizing the studio.</div></div>';
      return;
    }

    container.innerHTML = displayDepts.map(d => {
      const memberCount = d.profiles ? d.profiles.length : 0;

      return `
        <div class="card entity-card" style="display: flex; flex-direction: column; justify-content: space-between;">
          <div class="card-header">
            <div>
              <span class="badge badge-indigo font-mono text-2xs">${escapeHTML(d.code || 'DEPT')}</span>
              <span class="card-actions">
                ${Permissions.isAdmin() ? `<button type="button" class="card-act card-act-edit" data-id="${d.id}" title="Edit department" aria-label="Edit department"><i data-lucide="pencil"></i></button>
                <button type="button" class="card-act card-act-delete" data-id="${d.id}" title="Delete department" aria-label="Delete department"><i data-lucide="trash-2"></i></button>` : ''}
              </span>
              <div class="card-title" style="margin-top: 4px;">${escapeHTML(d.name)}</div>
            </div>
            <span class="badge badge-slate">${memberCount} Members</span>
          </div>

          <div class="card-body" style="display: flex; flex-direction: column; gap: var(--space-3);">
            <p class="text-xs text-muted line-clamp-3">${escapeHTML(d.description || '')}</p>

            <div class="glass-panel" style="padding: var(--space-3); background: var(--studio-950); display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); font-size: var(--text-2xs);">
              <div>
                <span class="text-dim block">Department Manager</span>
                <strong class="text-white">${escapeHTML(d.manager?.full_name || 'Not assigned')}</strong>
              </div>
              ${Money.canSee() ? `<div>
                <span class="text-dim block">Annual Budget</span>
                <strong class="font-mono text-emerald">${formatCurrency(this.budgets.get(d.id) || 0)}</strong>
              </div>` : ''}
            </div>
          </div>

          <div class="card-footer">
            <a href="#tasks" class="btn btn-secondary btn-sm" style="width: 100%;">
              View ${escapeHTML(d.name)} Deliverables →
            </a>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.card-act-edit').forEach(b => b.addEventListener('click', () => this.openEditDialog(b.dataset.id)));
    container.querySelectorAll('.card-act-delete').forEach(b => b.addEventListener('click', () => this.deleteDepartment(b.dataset.id)));
    if (window.lucide) window.lucide.createIcons();
  }

  async openEditDialog(id) {
    const d = this.departments.find(x => x.id === id);
    if (!d) return;
    const { data: people } = await getSupabase().from('profiles').select('id, full_name').eq('employment_status', 'active').order('full_name', { ascending: true });
    formDialog({
      title: `Edit ${d.name}`,
      subtitle: 'Rename the department, set its code, budget and department manager.',
      fields: [
        { name: 'name', label: 'Department name', required: true, value: d.name, maxlength: 100 },
        { name: 'code', label: 'Code', half: true, value: d.code || '', maxlength: 12 },
        ...(Money.canSee() ? [{ name: 'budget', label: 'Annual budget', type: 'number', half: true, min: 0, value: this.budgets.get(d.id) ?? 0 }] : []),
        { name: 'manager_id', label: 'Department manager', type: 'select', value: d.manager_id || '', options: [
          { value: '', label: 'Not assigned' }, ...(people || []).map(p => ({ value: p.id, label: p.full_name }))],
          hint: 'The manager can see and manage every task in this department.' },
        { name: 'description', label: 'Description', type: 'textarea', value: d.description || '', rows: 3 }
      ],
      onSubmit: async (v) => {
        const { data, error } = await getSupabase().from('departments')
          .update({ name: v.name, code: v.code, manager_id: v.manager_id, description: v.description })
          .eq('id', id).select('id');
        if (error) throw new Error(error.code === '23505' ? 'That name or code is already used.' : error.message);
        if (!data?.length) throw new Error('Only an administrator can edit departments.');
        await Money.save('department_budget', id, v.budget, this.app.currentUser.id);
        Toast.success('Department updated', 'Saved');
        await this.loadDepartments();
      }
    });
  }

  async deleteDepartment(id) {
    const d = this.departments.find(x => x.id === id);
    if (!d) return;
    const ok = await confirmDialog({ title: 'Delete this department?', message: `"${d.name}" will be removed. People and tasks in it are kept but become unassigned to a department.`, confirmLabel: 'Delete department', danger: true });
    if (!ok) return;
    const { data, error } = await getSupabase().from('departments').delete().eq('id', id).select('id');
    if (error || !data?.length) { Toast.error(error?.message || 'Only an administrator can delete departments.', 'Delete refused'); return; }
    Toast.success('Department deleted', 'Deleted');
    await this.loadDepartments();
  }

  openDeptModal() {
    const modalBackdrop = document.getElementById('globalModalBackdrop');
    const modalDialog = document.getElementById('globalModalDialog');
    if (!modalBackdrop || !modalDialog) return;

    modalDialog.style.maxWidth = '480px';
    modalDialog.innerHTML = `
      <div class="modal-header">
        <h2 class="modal-title font-display">Add Studio Department</h2>
        <button type="button" class="modal-close-btn" id="btnCancelDept">&times;</button>
      </div>

      <form id="createDeptForm">
        <div class="modal-body" style="display: flex; flex-direction: column; gap: var(--space-3-5);">
          <div class="form-group">
            <label class="form-label" for="deptNameInput">Department Name *</label>
            <input id="deptNameInput" type="text" required placeholder="e.g. 3D & CGI Rendering" class="form-control" />
          </div>

          <div class="form-group">
            <label class="form-label" for="deptCodeInput">Short Code *</label>
            <input id="deptCodeInput" type="text" required placeholder="e.g. CGI" class="form-control" />
          </div>

          ${Money.canSee() ? `<div class="form-group">
            <label class="form-label" for="deptBudgetInput">Department Budget (EGP)</label>
            <input id="deptBudgetInput" type="number" value="40000" class="form-control" />
          </div>` : ''}

          <div class="form-group">
            <label class="form-label" for="deptDescInput">Specialty Description</label>
            <textarea id="deptDescInput" rows="3" placeholder="Outline core deliverables..." class="form-control"></textarea>
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary btn-sm" id="btnCancelDeptAction">Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm">Save Department</button>
        </div>
      </form>
    `;

    modalBackdrop.classList.add('active');

    document.getElementById('btnCancelDept')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));
    document.getElementById('btnCancelDeptAction')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));

    document.getElementById('createDeptForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();

      const name = document.getElementById('deptNameInput').value.trim();
      const code = document.getElementById('deptCodeInput').value.trim().toUpperCase();
      const budget = Number(document.getElementById('deptBudgetInput')?.value) || 0;
      const description = document.getElementById('deptDescInput').value.trim();

      const supabase = getSupabase();
      try {
        const { data: made, error } = await supabase.from('departments').insert({
          name,
          code,
          description
        }).select('id').single();

        if (error) throw error;
        await Money.save('department_budget', made.id, budget, this.app.currentUser.id);
        Toast.success(`Department "${name}" created!`, 'Department Added');
        modalBackdrop.classList.remove('active');
        await this.loadDepartments();
      } catch (err) {
        console.error('Dept creation error:', err);
        Toast.error(err.message || 'Failed to create department', 'Error');
      }
    });
  }
}
