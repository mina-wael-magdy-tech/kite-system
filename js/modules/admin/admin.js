/**
 * KITE SYSTEM — Module N: Admin Control Center
 * Administrator overview: access model, task override/reassignment & the server-written audit ledger.
 */

import { getSupabase } from '../../supabase-client.js';
import { Permissions } from '../../permissions/permission-service.js';
import { Toast } from '../../services/toast-service.js';
import { Api } from '../../services/api.js';
import { escapeHTML, formatDate } from '../../utils/helpers.js';
import { formatTaskStatusBadge } from '../../utils/formatters.js';

export class AdminModule {
  constructor(app) {
    this.app = app;
    this.auditLogs = [];
    this.tasks = [];
    this.employees = [];
  }

  async render(container) {
    if (!Permissions.isAdmin()) {
      container.innerHTML = `
        <div class="page-container animate-fade-in">
          <div class="glass-panel" style="padding: var(--space-8); text-align: center; max-width: 520px; margin: 40px auto; border-color: var(--color-amber-border);">
            <div style="margin-bottom: var(--space-3);"><i data-lucide="lock"></i></div>
            <h2 class="font-display font-bold text-lg text-white">Administrator Access Required</h2>
            <p class="text-xs text-muted" style="margin-top: var(--space-2); line-height: 1.5;">
              You are signed in as <strong>${escapeHTML(this.app.currentProfile.full_name || 'Specialist')}</strong>. Only authorized agency administrators (Super Admin, Owner, General Manager) can configure system policies or inspect security audit ledgers.
            </p>
            <div style="margin-top: var(--space-5);">
              <a href="#dashboard" class="btn btn-secondary btn-sm">Return to Dashboard</a>
            </div>
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="page-container animate-fade-in">
        <div class="glass-panel" style="padding: var(--space-5); border-color: var(--color-amber-border); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-3);">
          <div>
            <span class="badge badge-amber font-bold">MASTER CONTROL CENTER</span>
            <h1 class="font-display font-bold text-xl text-white" style="margin-top: 4px;">System Administrator Command Center</h1>
            <p class="text-xs text-muted">
              Reassign studio deliverables and inspect the server-written audit log.
            </p>
          </div>
          <span class="badge badge-emerald">Super Admin Privilege Active</span>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: var(--space-4);">
          <!-- 1. Access model (read-only; enforced by database Row Level Security) -->
          <div class="card">
            <div class="card-header">
              <div class="card-title">1. Access Model</div>
              <span class="badge badge-slate">Enforced by the database</span>
            </div>
            <div class="card-body" style="display: flex; flex-direction: column; gap: var(--space-2); font-size: var(--text-2xs); line-height: 1.5;">
              <p class="text-muted">Access rules are enforced server-side with Row Level Security and cannot be toggled from this screen.</p>
              <ul class="text-muted" style="padding-left: 16px; list-style: disc;">
                <li>Specialists see only deliverables they created, are assigned to, or collaborate on.</li>
                <li>Department managers see their department; admins see everything.</li>
                <li>Approving or completing work requires a reviewer (manager, project manager or the task creator).</li>
                <li>Finance and HR records are limited to their respective managers and administrators.</li>
              </ul>
            </div>
          </div>

          <!-- 2. Security Audit Ledger -->
          <div class="card">
            <div class="card-header">
              <div class="card-title">2. Immutable Security Audit Log</div>
              <span class="badge badge-slate">Server-Recorded</span>
            </div>
            <div class="card-body" style="padding: 0;">
              <div style="max-height: 280px; overflow-y: auto; padding: var(--space-3); display: flex; flex-direction: column; gap: var(--space-2);" id="adminAuditLogList">
                <div class="text-2xs text-dim italic">Loading audit ledger...</div>
              </div>
            </div>
          </div>
        </div>

        <!-- 3. Master Task Override Table -->
        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">3. Master Task Override & Reassignment</div>
              <div class="card-subtitle">Global administrative control over all studio deliverables</div>
            </div>
          </div>
          <div class="card-body" style="padding: 0;">
            <div class="table-responsive" style="border: none; border-radius: 0;">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Deliverable</th>
                    <th>Current Assignee</th>
                    <th>Stage</th>
                    <th>Reassign Specialist</th>
                  </tr>
                </thead>
                <tbody id="adminTaskOverrideTable">
                  <tr><td colspan="4" style="text-align: center; color: var(--text-dim); padding: var(--space-6);">Loading deliverables...</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;

    await this.loadAdminData();
  }

  async loadAdminData() {
    const supabase = getSupabase();
    if (!supabase) return;

    try {
      // 1. Fetch Employees
      const { data: emps } = await supabase.from('profiles').select('id, full_name, departments!profiles_department_id_fkey(name)');
      this.employees = emps || [];

      // 2. Fetch All Tasks
      const { data: tasks } = await supabase
        .from('tasks')
        .select('id, task_number, title, status, assigned_to, profiles!tasks_assigned_to_fkey(full_name)')
        .order('created_at', { ascending: false });

      this.tasks = tasks || [];
      this.renderMasterTaskTable();

      // 3. Fetch Audit Logs
      const { data: logs } = await supabase
        .from('audit_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20);

      this.auditLogs = logs || [];
      this.renderAuditLogs();
    } catch (err) {
      console.warn('Admin load error:', err);
      this.renderAuditLogs();
    }
  }

  renderMasterTaskTable() {
    const tbody = document.getElementById('adminTaskOverrideTable');
    if (!tbody) return;

    if (this.tasks.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-dim); padding: var(--space-6);">No studio tasks found.</td></tr>`;
      return;
    }

    tbody.innerHTML = this.tasks.map(t => `
      <tr>
        <td>
          <div class="font-bold text-white">${escapeHTML(t.title)}</div>
          <span class="font-mono text-2xs text-dim">${t.task_number}</span>
        </td>
        <td class="text-xs text-muted">${escapeHTML(t.profiles?.full_name || 'Unassigned')}</td>
        <td>${formatTaskStatusBadge(t.status)}</td>
        <td>
          <select class="form-control select-reassign-emp" data-task-id="${t.id}" style="height: 32px; font-size: 11px;">
            ${this.employees.map(e => `
              <option value="${e.id}" ${t.assigned_to === e.id ? 'selected' : ''}>
                ${escapeHTML(e.full_name)} (${e.departments?.name || 'Studio'})
              </option>
            `).join('')}
          </select>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.select-reassign-emp').forEach(sel => {
      sel.addEventListener('change', async (e) => {
        const taskId = sel.getAttribute('data-task-id');
        const newAssigneeId = e.target.value;
        const newAssigneeName = sel.selectedOptions[0]?.text.split('(')[0].trim();

        try {
          await Api.reassignTask(taskId, newAssigneeId);
          Toast.success(`Reassigned to ${newAssigneeName}`, 'Master Override');
        } catch (err) {
          console.error('Reassign error:', err);
          Toast.error(err.message || 'Failed to reassign', 'Error');
        }
      });
    });
  }

  renderAuditLogs() {
    const container = document.getElementById('adminAuditLogList');
    if (!container) return;

    if (this.auditLogs.length === 0) {
      container.innerHTML = '<div class="text-2xs text-dim italic">No audit events recorded yet.</div>';
      return;
    }

    container.innerHTML = this.auditLogs.map(l => `
      <div class="glass-panel" style="padding: var(--space-2-5); background: var(--studio-950); font-size: var(--text-2xs);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
          <strong class="text-amber-light font-mono font-bold">${escapeHTML(l.action)}</strong>
          <span class="text-dim font-mono">${formatDate(l.created_at, true)}</span>
        </div>
        <p class="text-muted">${escapeHTML(l.entity_type || 'System Event')}${l.new_data ? ' — ' + escapeHTML(JSON.stringify(l.new_data)) : ''}</p>
      </div>
    `).join('');
  }
}
