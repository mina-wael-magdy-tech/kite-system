/**
 * PULSE STUDIO OS — Module C: Department Management
 * Overview & control for the 5 initial creative studio hubs: Branding, BTL, Digital, Media & Web Dev.
 */

import { getSupabase } from '../../supabase-client.js';
import { Permissions } from '../../permissions/permission-service.js';
import { Toast } from '../../services/toast-service.js';
import { escapeHTML, formatCurrency } from '../../utils/helpers.js';

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
  }

  async loadDepartments() {
    const supabase = getSupabase();
    if (!supabase) return;

    try {
      const { data: depts, error } = await supabase
        .from('departments')
        .select(`
          *,
          manager:profiles!departments_manager_id_fkey(full_name, email),
          profiles(id)
        `)
        .order('name', { ascending: true });

      if (error) throw error;
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

    const displayDepts = this.departments.length > 0 ? this.departments : [
      { name: 'Branding', code: 'BRAND', description: 'Visual identities, typography hierarchy, logo systems & style manuals.', budget: 50000 },
      { name: 'BTL', code: 'BTL', description: 'Below The Line activations, exhibition booths, pop-up kiosks & print production.', budget: 45000 },
      { name: 'Digital Marketing', code: 'MKTG', description: 'Meta/TikTok campaigns, ad copy hooks, analytics & conversion funnels.', budget: 60000 },
      { name: 'Media Production', code: 'MEDIA', description: '4K video commercial edits, 3D motion graphics reels, grading & sound.', budget: 75000 },
      { name: 'Web Development', code: 'DEV', description: 'Interactive WebGL applications, responsive UI/UX & e-commerce flows.', budget: 65000 }
    ];

    container.innerHTML = displayDepts.map(d => {
      const memberCount = d.profiles ? d.profiles.length : 1;

      return `
        <div class="card" style="display: flex; flex-direction: column; justify-content: space-between;">
          <div class="card-header">
            <div>
              <span class="badge badge-indigo font-mono text-2xs">${escapeHTML(d.code || 'DEPT')}</span>
              <div class="card-title" style="margin-top: 4px;">${escapeHTML(d.name)}</div>
            </div>
            <span class="badge badge-slate">${memberCount} Members</span>
          </div>

          <div class="card-body" style="display: flex; flex-direction: column; gap: var(--space-3);">
            <p class="text-xs text-muted line-clamp-3">${escapeHTML(d.description || '')}</p>

            <div class="glass-panel" style="padding: var(--space-3); background: var(--studio-950); display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); font-size: var(--text-2xs);">
              <div>
                <span class="text-dim block">Department Manager</span>
                <strong class="text-white">${escapeHTML(d.manager?.full_name || 'Designated Lead')}</strong>
              </div>
              <div>
                <span class="text-dim block">Annual Budget</span>
                <strong class="font-mono text-emerald">${formatCurrency(d.budget || 50000)}</strong>
              </div>
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

          <div class="form-group">
            <label class="form-label" for="deptBudgetInput">Department Budget (USD)</label>
            <input id="deptBudgetInput" type="number" value="40000" class="form-control" />
          </div>

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
      const budget = Number(document.getElementById('deptBudgetInput').value) || 0;
      const description = document.getElementById('deptDescInput').value.trim();

      const supabase = getSupabase();
      try {
        const { error } = await supabase.from('departments').insert({
          name,
          code,
          budget,
          description
        });

        if (error) throw error;
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
