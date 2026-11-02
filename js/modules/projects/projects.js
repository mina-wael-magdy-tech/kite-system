/**
 * KITE SYSTEM — Module E: Project Management
 * Multi-department creative projects, milestone tracking, budgets & deadlines.
 */

import { getSupabase } from '../../supabase-client.js';
import { Permissions } from '../../permissions/permission-service.js';
import { Toast } from '../../services/toast-service.js';
import { escapeHTML, formatDate, formatCurrency } from '../../utils/helpers.js';

export class ProjectsModule {
  constructor(app) {
    this.app = app;
    this.projects = [];
  }

  async render(container) {
    container.innerHTML = `
      <div class="page-container animate-fade-in">
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-4);">
          <div>
            <h1 class="font-display font-bold text-xl text-white">Client Projects & Deliverables</h1>
            <p class="text-xs text-muted" style="margin-top: 2px;">
              Manage multi-disciplinary client engagements with milestones and budgets.
            </p>
          </div>

          <button type="button" class="btn btn-primary btn-sm" id="btnCreateProject">
            <i data-lucide="plus"></i> New Client Project
          </button>
        </div>

        <div id="projectsGrid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--space-4);">
          <div class="empty-state" style="border:none; padding: 40px 0; grid-column: 1 / -1;">
            <div class="empty-state-icon animate-spin">⟳</div>
            <div class="empty-state-title">Loading studio projects...</div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('btnCreateProject')?.addEventListener('click', () => {
      this.openCreateProjectModal();
    });

    await this.loadProjects();
  }

  async loadProjects() {
    const supabase = getSupabase();
    if (!supabase) return;

    try {
      const { data: projects, error } = await supabase
        .from('projects')
        .select(`
          *,
          client:clients(name, company_name),
          project_manager:profiles!projects_project_manager_id_fkey(full_name),
          tasks(id, status)
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;
      this.projects = projects || [];
      this.renderProjectsGrid();
    } catch (err) {
      console.warn('Projects fetch error:', err);
      this.renderProjectsGrid();
    }
  }

  renderProjectsGrid() {
    const container = document.getElementById('projectsGrid');
    if (!container) return;

    if (this.projects.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <div class="empty-state-icon">📁</div>
          <div class="empty-state-title">No client projects active</div>
          <div class="empty-state-desc">Create your first client engagement to coordinate cross-department deliverables.</div>
          <button class="btn btn-primary btn-sm" id="btnCreateFirstProject">Create First Project</button>
        </div>
      `;
      document.getElementById('btnCreateFirstProject')?.addEventListener('click', () => document.getElementById('btnCreateProject')?.click());
      return;
    }

    container.innerHTML = this.projects.map(p => {
      const totalTasks = p.tasks ? p.tasks.length : 0;
      const completedTasks = p.tasks ? p.tasks.filter(t => t.status === 'completed' || t.status === 'approved').length : 0;
      const pct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : p.progress || 0;

      return `
        <div class="card" style="display: flex; flex-direction: column; justify-content: space-between;">
          <div class="card-header">
            <div>
              <span class="badge badge-indigo font-mono text-2xs">${escapeHTML(p.code || 'PRJ')}</span>
              <div class="card-title" style="margin-top: 4px;">${escapeHTML(p.name)}</div>
              <div class="card-subtitle">Client: ${escapeHTML(p.client?.company_name || p.client?.name || 'No client assigned')}</div>
            </div>
            <span class="badge badge-emerald">${escapeHTML(p.status.toUpperCase())}</span>
          </div>

          <div class="card-body" style="display: flex; flex-direction: column; gap: var(--space-3);">
            <p class="text-xs text-muted line-clamp-2">${escapeHTML(p.description || 'No description provided.')}</p>

            <div>
              <div style="display: flex; justify-content: space-between; font-size: var(--text-2xs); color: var(--text-muted); margin-bottom: 4px;">
                <span>Deliverables Completed</span>
                <span class="font-bold text-white">${completedTasks}/${totalTasks} (${pct}%)</span>
              </div>
              <div class="progress-track">
                <div class="progress-fill" style="width: ${pct}%;"></div>
              </div>
            </div>

            <div class="glass-panel" style="padding: var(--space-2-5); display: flex; justify-content: space-between; font-size: var(--text-2xs); background: var(--studio-950);">
              <div>
                <span class="text-dim block">Project Manager</span>
                <strong class="text-white">${escapeHTML(p.project_manager?.full_name || 'Nour El-Din')}</strong>
              </div>
              <div>
                <span class="text-dim block">Budget</span>
                <strong class="font-mono text-emerald">${formatCurrency(p.budget || 35000)}</strong>
              </div>
              <div>
                <span class="text-dim block">Launch Date</span>
                <strong class="font-mono text-white">${formatDate(p.deadline || '2026-12-01')}</strong>
              </div>
            </div>
          </div>

          <div class="card-footer">
            <a href="#tasks" class="btn btn-secondary btn-sm" style="width: 100%;">
              View Linked Deliverables →
            </a>
          </div>
        </div>
      `;
    }).join('');
  }

  async openCreateProjectModal() {
    const modalBackdrop = document.getElementById('globalModalBackdrop');
    const modalDialog = document.getElementById('globalModalDialog');
    if (!modalBackdrop || !modalDialog) return;

    modalDialog.style.maxWidth = '520px';
    modalDialog.innerHTML = `
      <div class="modal-header">
        <h2 class="modal-title font-display">Create Client Project</h2>
        <button type="button" class="modal-close-btn" id="btnCancelProj">&times;</button>
      </div>

      <form id="createProjectForm">
        <div class="modal-body" style="display: flex; flex-direction: column; gap: var(--space-3-5);">
          <div class="form-group">
            <label class="form-label" for="projNameInput">Project Name *</label>
            <input id="projNameInput" type="text" required placeholder="e.g. Aura Coffee Brand Flagship Launch" class="form-control" />
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
            <div class="form-group">
              <label class="form-label" for="projCodeInput">Project Code *</label>
              <input id="projCodeInput" type="text" required placeholder="e.g. AUR-2026" class="form-control" />
            </div>
            <div class="form-group">
              <label class="form-label" for="projBudgetInput">Budget (USD)</label>
              <input id="projBudgetInput" type="number" value="25000" class="form-control" />
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="projDeadlineInput">Target Launch Deadline</label>
            <input id="projDeadlineInput" type="date" required class="form-control" />
          </div>

          <div class="form-group">
            <label class="form-label" for="projDescInput">Project Scope & Strategic Objective</label>
            <textarea id="projDescInput" rows="3" placeholder="Outline campaign deliverables across studio roles..." class="form-control"></textarea>
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary btn-sm" id="btnCancelProjAction">Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm">Create Project</button>
        </div>
      </form>
    `;

    // Set default deadline 30 days ahead
    const d = new Date();
    d.setDate(d.getDate() + 30);
    const dateInput = document.getElementById('projDeadlineInput');
    if (dateInput) dateInput.value = d.toISOString().split('T')[0];

    modalBackdrop.classList.add('active');

    document.getElementById('btnCancelProj')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));
    document.getElementById('btnCancelProjAction')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));

    document.getElementById('createProjectForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();

      const name = document.getElementById('projNameInput').value.trim();
      const code = document.getElementById('projCodeInput').value.trim().toUpperCase();
      const budget = Number(document.getElementById('projBudgetInput').value) || 0;
      const deadline = document.getElementById('projDeadlineInput').value;
      const description = document.getElementById('projDescInput').value.trim();

      const supabase = getSupabase();
      try {
        const { error } = await supabase.from('projects').insert({
          name,
          code,
          budget,
          deadline,
          description,
          status: 'active',
          created_by: this.app.currentUser.id
        });

        if (error) throw error;
        Toast.success('Client project created successfully', 'Project Added');
        modalBackdrop.classList.remove('active');
        await this.loadProjects();
      } catch (err) {
        console.error('Project creation error:', err);
        Toast.error(err.message || 'Failed to create project', 'Creation Error');
      }
    });
  }
}
