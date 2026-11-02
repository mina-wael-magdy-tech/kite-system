/**
 * PULSE STUDIO OS — Module B: Employee Management & HR Directory
 * Full staff directory, role assignments, department allocation, and employee invitations.
 */

import { getSupabase } from '../../supabase-client.js';
import { Permissions } from '../../permissions/permission-service.js';
import { Toast } from '../../services/toast-service.js';
import { CONFIG } from '../../config.js';
import { Api } from '../../services/api.js';
import { escapeHTML, formatDate, getInitials, getAccentHex } from '../../utils/helpers.js';
import { formatEmploymentStatusBadge } from '../../utils/formatters.js';

export class EmployeesModule {
  constructor(app) {
    this.app = app;
    this.employees = [];
    this.departments = [];
    this.roles = [];
  }

  async render(container) {
    const isAdmin = Permissions.isAdmin() || Permissions.hasRole('hr_manager');

    container.innerHTML = `
      <div class="page-container animate-fade-in">
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-4);">
          <div>
            <h1 class="font-display font-bold text-xl text-white">Employee Directory & Hierarchy</h1>
            <p class="text-xs text-muted" style="margin-top: 2px;">
              Manage creative specialists across Branding, BTL, Digital, Media Production & Web Development.
            </p>
          </div>

          ${isAdmin ? `
            <button type="button" class="btn btn-primary btn-sm" id="btnInviteEmployee">
              <i data-lucide="user-plus"></i> Invite / Add Employee
            </button>
          ` : ''}
        </div>

        <!-- Filter bar -->
        <div class="glass-panel" style="padding: var(--space-3); display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3);">
          <div style="position: relative; min-width: 240px; flex: 1;">
            <input 
              type="text" 
              id="empSearchField" 
              placeholder="Search specialists by name, role, skills..." 
              class="form-control" 
              style="height: 36px; padding-left: 32px;"
            />
            <i data-lucide="search" style="position: absolute; left: 10px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; color: var(--text-dim);"></i>
          </div>

          <select id="empDeptFilter" class="form-control" style="width: auto; height: 36px;">
            <option value="ALL">All 5 Departments</option>
          </select>
        </div>

        <!-- Employees Roster Grid -->
        <div id="employeesGrid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--space-4);">
          <div class="empty-state" style="border:none; padding: 40px 0; grid-column: 1 / -1;">
            <div class="empty-state-icon animate-spin">⟳</div>
            <div class="empty-state-title">Loading studio directory...</div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('btnInviteEmployee')?.addEventListener('click', () => {
      this.openInviteModal();
    });

    document.getElementById('empSearchField')?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      this.filterAndRender(q, document.getElementById('empDeptFilter')?.value || 'ALL');
    });

    document.getElementById('empDeptFilter')?.addEventListener('change', (e) => {
      const dept = e.target.value;
      this.filterAndRender(document.getElementById('empSearchField')?.value.toLowerCase() || '', dept);
    });

    await this.loadEmployees();
  }

  async loadEmployees() {
    const supabase = getSupabase();
    if (!supabase) return;

    try {
      // 1. Fetch departments
      const { data: depts } = await supabase.from('departments').select('id, name, code');
      this.departments = depts || [];

      const deptSelect = document.getElementById('empDeptFilter');
      if (deptSelect) {
        deptSelect.innerHTML = `<option value="ALL">All 5 Departments</option>` +
          this.departments.map(d => `<option value="${d.id}">${escapeHTML(d.name)}</option>`).join('');
      }

      // 2. Fetch roles
      const { data: roles } = await supabase.from('roles').select('id, name, display_name');
      this.roles = roles || [];

      // 3. Fetch profiles with department & role
      const { data: profiles, error } = await supabase
        .from('profiles')
        .select(`
          ${CONFIG.PROFILE_COLUMNS},
          departments(id, name, code),
          user_roles(roles(id, name, display_name))
        `)
        .order('created_at', { ascending: true });

      if (error) throw error;
      this.employees = profiles || [];
      this.filterAndRender('', 'ALL');
    } catch (err) {
      console.warn('Employees fetch error:', err);
      this.filterAndRender('', 'ALL');
    }
  }

  filterAndRender(query = '', deptFilter = 'ALL') {
    const container = document.getElementById('employeesGrid');
    if (!container) return;

    let filtered = this.employees;

    if (deptFilter !== 'ALL') {
      filtered = filtered.filter(e => e.department_id === deptFilter);
    }

    if (query) {
      filtered = filtered.filter(e => {
        const nameMatch = (e.full_name || '').toLowerCase().includes(query);
        const titleMatch = (e.job_title || '').toLowerCase().includes(query);
        const emailMatch = (e.email || '').toLowerCase().includes(query);
        return nameMatch || titleMatch || emailMatch;
      });
    }

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <div class="empty-state-icon">👥</div>
          <div class="empty-state-title">No specialists found</div>
          <div class="empty-state-desc">Try clearing your filters or invite new team members.</div>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map(emp => {
      const initials = getInitials(emp.full_name || emp.email);
      const accent = getAccentHex(emp.full_name || emp.email);
      const deptName = emp.departments?.name || 'Studio Member';
      const roleDisplayName = emp.user_roles?.[0]?.roles?.display_name || 'Creative Specialist';

      return `
        <div class="card" style="padding: var(--space-4); display: flex; flex-direction: column; justify-content: space-between; gap: var(--space-3);">
          <div>
            <div style="display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: var(--space-2);">
              <div class="avatar avatar-md" style="background-color: ${accent};">
                ${initials}
              </div>
              ${formatEmploymentStatusBadge(emp.employment_status)}
            </div>

            <h3 class="font-display font-bold text-sm text-white">${escapeHTML(emp.full_name || 'Specialist')}</h3>
            <p class="text-xs text-muted" style="margin-top: 2px;">${escapeHTML(emp.job_title || roleDisplayName)}</p>
            
            <div style="margin-top: var(--space-2); display: flex; flex-wrap: wrap; gap: 4px;">
              <span class="badge badge-indigo">${escapeHTML(deptName)}</span>
              <span class="badge badge-slate font-mono">${emp.employee_id || 'EMP'}</span>
            </div>
          </div>

          <div style="border-top: 1px solid var(--border-subtle); padding-top: var(--space-3); font-size: var(--text-2xs); color: var(--text-dim); display: flex; flex-direction: column; gap: 4px;">
            <span>✉️ ${escapeHTML(emp.email)}</span>
            <span>📅 Joined: ${formatDate(emp.joining_date)}</span>
          </div>

          <div style="display: flex; gap: var(--space-2); border-top: 1px solid var(--border-subtle); padding-top: var(--space-3);">
            <a href="#chat" class="btn btn-secondary btn-sm" style="flex: 1;">
              💬 Chat
            </a>
            <a href="#tasks" class="btn btn-outline btn-sm" style="flex: 1;">
              Tasks
            </a>
          </div>
        </div>
      `;
    }).join('');
  }

  openInviteModal() {
    const modalBackdrop = document.getElementById('globalModalBackdrop');
    const modalDialog = document.getElementById('globalModalDialog');
    if (!modalBackdrop || !modalDialog) return;

    modalDialog.style.maxWidth = '500px';
    modalDialog.innerHTML = `
      <div class="modal-header">
        <h2 class="modal-title font-display">Invite Team Member</h2>
        <button type="button" class="modal-close-btn" id="btnCancelInvite">&times;</button>
      </div>

      <form id="inviteEmployeeForm">
        <div class="modal-body" style="display: flex; flex-direction: column; gap: var(--space-3-5);">
          <div class="form-group">
            <label class="form-label" for="inviteNameInput">Full Name *</label>
            <input id="inviteNameInput" type="text" required placeholder="e.g. Salma Hassan" class="form-control" />
          </div>

          <div class="form-group">
            <label class="form-label" for="inviteEmailInput">Company Email *</label>
            <input id="inviteEmailInput" type="email" required placeholder="name@pulsestudio.agency" class="form-control" />
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
            <div class="form-group">
              <label class="form-label" for="inviteDeptSelect">Department *</label>
              <select id="inviteDeptSelect" required class="form-control">
                ${this.departments.map(d => `<option value="${d.id}">${escapeHTML(d.name)}</option>`).join('')}
              </select>
            </div>

            <div class="form-group">
              <label class="form-label" for="inviteRoleSelect">Assigned Role *</label>
              <select id="inviteRoleSelect" required class="form-control">
                ${this.roles.map(r => `<option value="${r.id}">${escapeHTML(r.display_name)}</option>`).join('')}
              </select>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="inviteTitleInput">Job Title</label>
            <input id="inviteTitleInput" type="text" placeholder="e.g. Senior Branding Lead" class="form-control" />
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary btn-sm" id="btnCancelInviteAction">Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm" id="btnSendInvite">Send Invitation</button>
        </div>
      </form>
    `;

    modalBackdrop.classList.add('active');

    document.getElementById('btnCancelInvite')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));
    document.getElementById('btnCancelInviteAction')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));

    document.getElementById('inviteEmployeeForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();

      const fullName = document.getElementById('inviteNameInput').value.trim();
      const email = document.getElementById('inviteEmailInput').value.trim();
      const departmentId = document.getElementById('inviteDeptSelect').value;
      const roleId = document.getElementById('inviteRoleSelect').value;
      const jobTitle = document.getElementById('inviteTitleInput').value.trim() || 'Creative Specialist';

      const btn = document.getElementById('btnSendInvite');
      if (btn) btn.disabled = true;

      const supabase = getSupabase();
      try {
        // Invoke Edge Function for secure server-side employee invitation
        await Api.inviteEmployee({ fullName, email, departmentId, roleId, jobTitle });

        Toast.success(`Invitation sent to ${email}`, 'Invitation Dispatched');
        modalBackdrop.classList.remove('active');
        await this.loadEmployees();
      } catch (err) {
        console.error('Invite error:', err);
        Toast.error(err.message || 'Failed to dispatch invitation', 'Error');
        if (btn) btn.disabled = false;
      }
    });
  }
}
