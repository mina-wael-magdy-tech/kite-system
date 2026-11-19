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
import { PAGE_SIZE, fetchPage, mountPager } from '../../ui/pagination.js';

export class AdminModule {
  constructor(app) {
    this.app = app;
    this.auditLogs = [];
    this.tasks = [];
    this.employees = [];
    this.toolGrants = new Set();
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
            <div id="adminTaskPager" style="padding: var(--space-3);"></div>
          </div>
        </div>

        <!-- 4. Studio AI & External Tools Access Management -->
        <div class="card" style="margin-top: var(--space-4);">
          <div class="card-header" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-2);">
            <div>
              <div class="card-title">4. Studio AI & External Tools Access Control</div>
              <div class="card-subtitle">Authorize specific specialists to access Google Flow (flow.google.com) and creative AI tools</div>
            </div>
            <a href="https://flow.google.com/" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-xs" style="gap: 4px; display: inline-flex; align-items: center;">
              <i data-lucide="sparkles" style="width: 13px; height: 13px;"></i> Open Google Flow
            </a>
          </div>
          <div class="card-body" style="padding: 0;">
            <div class="table-responsive" style="border: none; border-radius: 0;">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Specialist</th>
                    <th>Department</th>
                    <th>Tool</th>
                    <th>Access Status</th>
                    <th style="text-align: right;">Toggle Access</th>
                  </tr>
                </thead>
                <tbody id="adminToolAccessTable">
                  <tr><td colspan="5" style="text-align: center; color: var(--text-dim); padding: var(--space-6);">Loading tool access permissions...</td></tr>
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

      // 2. One page of tasks (the list keeps growing: never the whole table)
      await this.loadTaskPage();

      // 3. Fetch Audit Logs
      const { data: logs } = await supabase
        .from('audit_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20);

      this.auditLogs = logs || [];
      this.renderAuditLogs();

      // 4. Fetch Tool Access Grants
      const { data: grants } = await supabase.from('user_tool_access').select('user_id, tool_key');
      this.toolGrants = new Set((grants || []).map(g => `${g.user_id}:${g.tool_key}`));
      this.renderToolAccessTable();
    } catch (err) {
      console.warn('Admin load error:', err);
      this.renderAuditLogs();
      this.renderToolAccessTable();
    }
  }

  async loadTaskPage() {
    const supabase = getSupabase();
    const res = await fetchPage(() => supabase
      .from('tasks')
      .select('id, task_number, title, status, assigned_to, profiles!tasks_assigned_to_fkey(full_name)', { count: 'exact' })
      .order('created_at', { ascending: false }).order('id', { ascending: true }), this.taskPage || 1, PAGE_SIZE.table);
    if (res.error) throw res.error;
    this.tasks = res.rows;
    this.taskPage = res.page;
    this.taskTotal = res.total;
    this.renderMasterTaskTable();
  }

  renderMasterTaskTable() {
    const tbody = document.getElementById('adminTaskOverrideTable');
    if (!tbody) return;
    mountPager(document.getElementById('adminTaskPager'), {
      page: this.taskPage || 1, total: this.taskTotal || 0, size: PAGE_SIZE.table, label: 'tasks', top: tbody.closest('.card'),
      onPage: async (n) => { this.taskPage = n; await this.loadTaskPage(); }
    });

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

  renderToolAccessTable() {
    const tbody = document.getElementById('adminToolAccessTable');
    if (!tbody) return;

    if (!this.employees || this.employees.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-dim); padding: var(--space-6);">No studio specialists found.</td></tr>`;
      return;
    }

    tbody.innerHTML = this.employees.map(e => {
      const isGranted = this.toolGrants.has(`${e.id}:google_flow`);
      return `
        <tr>
          <td>
            <div class="font-bold text-white">${escapeHTML(e.full_name || 'Specialist')}</div>
          </td>
          <td class="text-xs text-muted">${escapeHTML(e.departments?.name || 'Studio')}</td>
          <td>
            <span class="badge badge-indigo" style="font-size: 10px; display: inline-flex; align-items: center; gap: 4px;">
              <i data-lucide="sparkles" style="width: 11px; height: 11px;"></i> Google Flow (AI Studio)
            </span>
          </td>
          <td id="tool-status-${e.id}">
            ${isGranted 
              ? '<span class="badge badge-emerald" style="font-size: 10px;">Granted</span>' 
              : '<span class="badge badge-slate" style="font-size: 10px;">Restricted</span>'}
          </td>
          <td style="text-align: right;">
            <label style="cursor: pointer; display: inline-flex; align-items: center; gap: 8px;">
              <input type="checkbox" class="tool-grant-checkbox" data-user-id="${e.id}" data-tool-key="google_flow" ${isGranted ? 'checked' : ''} style="accent-color: var(--color-indigo-light); width: 16px; height: 16px; cursor: pointer;" />
              <span class="text-2xs text-muted" id="tool-label-${e.id}">${isGranted ? 'Enabled' : 'Disabled'}</span>
            </label>
          </td>
        </tr>
      `;
    }).join('');

    if (window.lucide) window.lucide.createIcons();

    tbody.querySelectorAll('.tool-grant-checkbox').forEach(cb => {
      cb.addEventListener('change', async (ev) => {
        const userId = cb.getAttribute('data-user-id');
        const toolKey = cb.getAttribute('data-tool-key');
        const checked = ev.target.checked;
        const empName = cb.closest('tr')?.querySelector('.font-bold')?.textContent || 'Specialist';
        const statusBadge = document.getElementById(`tool-status-${userId}`);
        const labelText = document.getElementById(`tool-label-${userId}`);
        const supabase = getSupabase();

        cb.disabled = true;
        try {
          if (checked) {
            const { error } = await supabase.from('user_tool_access').insert({
              user_id: userId,
              tool_key: toolKey,
              granted_by: this.app.currentUser.id
            });
            if (error) throw error;
            this.toolGrants.add(`${userId}:${toolKey}`);
            if (statusBadge) statusBadge.innerHTML = '<span class="badge badge-emerald" style="font-size: 10px;">Granted</span>';
            if (labelText) labelText.textContent = 'Enabled';
            Toast.success(`Google Flow access granted to ${empName}`, 'Access Updated');
          } else {
            const { error } = await supabase.from('user_tool_access')
              .delete()
              .eq('user_id', userId)
              .eq('tool_key', toolKey);
            if (error) throw error;
            this.toolGrants.delete(`${userId}:${toolKey}`);
            if (statusBadge) statusBadge.innerHTML = '<span class="badge badge-slate" style="font-size: 10px;">Restricted</span>';
            if (labelText) labelText.textContent = 'Disabled';
            Toast.info(`Google Flow access revoked from ${empName}`, 'Access Updated');
          }
        } catch (err) {
          console.error('Tool grant error:', err);
          cb.checked = !checked;
          Toast.error(err.message || 'Failed to update tool access', 'Error');
        } finally {
          cb.disabled = false;
        }
      });
    });
  }
}
