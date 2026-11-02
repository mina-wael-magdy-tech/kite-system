/**
 * KITE SYSTEM — Module D: Task Management
 * Complete task engine: Kanban & Table views, 9 lifecycle stages, checklists, comments, and role privacy.
 */

import { getSupabase } from '../../supabase-client.js';
import { Permissions } from '../../permissions/permission-service.js';
import { Toast } from '../../services/toast-service.js';
import { Api } from '../../services/api.js';
import { escapeHTML, formatDate, debounce } from '../../utils/helpers.js';
import { formatTaskStatusBadge, formatPriorityBadge } from '../../utils/formatters.js';

export class TasksModule {
  constructor(app) {
    this.app = app;
    this.tasks = [];
    this.departments = [];
    this.projects = [];
    this.viewMode = 'kanban'; // 'kanban' or 'table'
    this.scopeFilter = 'all'; // 'all', 'assigned', 'sent'
    this.searchQuery = '';
    this.selectedDept = 'ALL';
    this.selectedPriority = 'ALL';
  }

  async render(container) {
    container.innerHTML = `
      <div class="page-container animate-fade-in">
        <!-- Header & Action Bar -->
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-4);">
          <div>
            <div style="display: flex; align-items: center; gap: var(--space-2-5);">
              <h1 class="font-display font-bold text-xl text-white">Studio Task Workspace</h1>
              <span class="badge badge-indigo">5-Dept Creative Hub</span>
            </div>
            <p class="text-xs text-muted" style="margin-top: 2px;">
              Manage and collaborate on creative deliverables with strict role-based task isolation.
            </p>
          </div>

          <button type="button" class="btn btn-primary" id="btnCreateTask">
            <i data-lucide="plus"></i> Dispatch / Assign Task
          </button>
        </div>

        <!-- Filter & View Controls Bar -->
        <div class="glass-panel" style="padding: var(--space-3-5); display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3);">
          <div style="display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2-5); flex: 1;">
            <!-- Search -->
            <div style="position: relative; min-width: 220px; flex: 1;">
              <input 
                type="text" 
                id="taskSearchField" 
                placeholder="Search deliverables, specs, brief..." 
                class="form-control" 
                style="height: 36px; padding-left: 32px;"
              />
              <i data-lucide="search" style="position: absolute; left: 10px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; color: var(--text-dim);"></i>
            </div>

            <!-- Department Filter -->
            <select id="filterDeptSelect" class="form-control" style="width: auto; height: 36px;">
              <option value="ALL">All 5 Departments</option>
            </select>

            <!-- Priority Filter -->
            <select id="filterPrioritySelect" class="form-control" style="width: auto; height: 36px;">
              <option value="ALL">All Priorities</option>
              <option value="urgent">🔥 Urgent</option>
              <option value="high">⚡ High</option>
              <option value="medium">📌 Medium</option>
              <option value="low">🌿 Low</option>
            </select>

            <!-- Employee Scope Toggle -->
            <div id="empScopeToggle" class="glass-panel-subtle" style="display: inline-flex; padding: 2px; border-radius: var(--radius-lg);">
              <button type="button" class="btn btn-ghost btn-sm" id="btnScopeAll" style="font-size: 11px;">All Visible</button>
              <button type="button" class="btn btn-ghost btn-sm" id="btnScopeAssigned" style="font-size: 11px;">My Tasks</button>
            </div>
          </div>

          <!-- View Mode Switcher -->
          <div class="glass-panel-subtle" style="display: inline-flex; padding: 2px; border-radius: var(--radius-lg);">
            <button type="button" class="btn btn-ghost btn-sm active" id="btnViewKanban" style="font-size: 11px;">
              <i data-lucide="kanban"></i> Board
            </button>
            <button type="button" class="btn btn-ghost btn-sm" id="btnViewTable" style="font-size: 11px;">
              <i data-lucide="list"></i> Table
            </button>
          </div>
        </div>

        <!-- Task Content Area: Kanban vs Table -->
        <div id="taskContentContainer">
          <div class="empty-state" style="border:none; padding: 40px 0;">
            <div class="empty-state-icon animate-spin">⟳</div>
            <div class="empty-state-title">Loading studio deliverables...</div>
          </div>
        </div>
      </div>
    `;

    this.attachEventListeners();
    await this.loadData();
  }

  attachEventListeners() {
    document.getElementById('btnCreateTask')?.addEventListener('click', () => {
      this.openTaskModal();
    });

    document.getElementById('taskSearchField')?.addEventListener('input', debounce((e) => {
      this.searchQuery = e.target.value.toLowerCase();
      this.renderCurrentView();
    }, 250));

    document.getElementById('filterDeptSelect')?.addEventListener('change', (e) => {
      this.selectedDept = e.target.value;
      this.renderCurrentView();
    });

    document.getElementById('filterPrioritySelect')?.addEventListener('change', (e) => {
      this.selectedPriority = e.target.value;
      this.renderCurrentView();
    });

    document.getElementById('btnViewKanban')?.addEventListener('click', () => {
      this.viewMode = 'kanban';
      document.getElementById('btnViewKanban')?.classList.add('btn-secondary');
      document.getElementById('btnViewTable')?.classList.remove('btn-secondary');
      this.renderCurrentView();
    });

    document.getElementById('btnViewTable')?.addEventListener('click', () => {
      this.viewMode = 'table';
      document.getElementById('btnViewTable')?.classList.add('btn-secondary');
      document.getElementById('btnViewKanban')?.classList.remove('btn-secondary');
      this.renderCurrentView();
    });

    document.getElementById('btnScopeAll')?.addEventListener('click', () => {
      this.scopeFilter = 'all';
      this.renderCurrentView();
    });

    document.getElementById('btnScopeAssigned')?.addEventListener('click', () => {
      this.scopeFilter = 'assigned';
      this.renderCurrentView();
    });
  }

  async loadData() {
    const supabase = getSupabase();
    if (!supabase) return;

    try {
      // 1. Fetch departments
      const { data: depts } = await supabase.from('departments').select('id, name, code');
      this.departments = depts || [];

      const deptSelect = document.getElementById('filterDeptSelect');
      if (deptSelect) {
        deptSelect.innerHTML = `<option value="ALL">All 5 Departments</option>` +
          this.departments.map(d => `<option value="${d.id}">${escapeHTML(d.name)}</option>`).join('');
      }

      // 2. Fetch projects for linking
      const { data: projs } = await supabase.from('projects').select('id, name, code');
      this.projects = projs || [];

      // 3. Fetch Tasks (RLS will automatically enforce peer isolation & hierarchy permissions)
      const { data: tasks, error } = await supabase
        .from('tasks')
        .select(`
          *,
          profiles!tasks_assigned_to_fkey(id, full_name, job_title),
          creator:profiles!tasks_created_by_fkey(id, full_name),
          departments!tasks_department_id_fkey(id, name, code),
          projects(id, name, code)
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;
      this.tasks = tasks || [];

      // Update badge in sidebar
      const badge = document.getElementById('tasksBadge');
      if (badge) badge.textContent = String(this.tasks.length);

      this.renderCurrentView();
    } catch (err) {
      console.error('Error loading tasks:', err);
      Toast.error('Could not load tasks from database', 'Fetch Error');
    }
  }

  getFilteredTasks() {
    return this.tasks.filter(t => {
      // Search
      if (this.searchQuery) {
        const titleMatch = t.title.toLowerCase().includes(this.searchQuery);
        const descMatch = (t.description || '').toLowerCase().includes(this.searchQuery);
        const numMatch = (t.task_number || '').toLowerCase().includes(this.searchQuery);
        if (!titleMatch && !descMatch && !numMatch) return false;
      }

      // Dept
      if (this.selectedDept !== 'ALL' && t.department_id !== this.selectedDept) {
        return false;
      }

      // Priority
      if (this.selectedPriority !== 'ALL' && t.priority !== this.selectedPriority) {
        return false;
      }

      // Scope
      if (this.scopeFilter === 'assigned' && t.assigned_to !== this.app.currentUser.id) {
        return false;
      }

      return true;
    });
  }

  renderCurrentView() {
    const container = document.getElementById('taskContentContainer');
    if (!container) return;

    const filtered = this.getFilteredTasks();

    if (this.viewMode === 'kanban') {
      this.renderKanbanBoard(container, filtered);
    } else {
      this.renderTableView(container, filtered);
    }

    if (window.lucide) window.lucide.createIcons();
  }

  renderKanbanBoard(container, tasks) {
    const columns = [
      { id: 'todo', title: 'To Do / Queued', dot: 'var(--text-dim)' },
      { id: 'in_progress', title: 'In Production', dot: 'var(--color-sky)' },
      { id: 'under_review', title: 'Creative Review', dot: 'var(--color-amber)' },
      { id: 'completed', title: 'Approved & Done', dot: 'var(--color-emerald)' }
    ];

    container.innerHTML = `
      <div class="kanban-board">
        ${columns.map(col => {
          const colTasks = tasks.filter(t => {
            if (col.id === 'completed') return t.status === 'completed' || t.status === 'approved';
            return t.status === col.id;
          });

          return `
            <div class="kanban-column">
              <div class="kanban-column-header">
                <div class="kanban-column-title">
                  <span class="kanban-column-dot" style="background-color: ${col.dot};"></span>
                  <span>${col.title}</span>
                </div>
                <span class="badge badge-slate">${colTasks.length}</span>
              </div>

              <div class="kanban-tasks-list">
                ${colTasks.length === 0 ? `
                  <div style="padding: var(--space-8); text-align: center; color: var(--text-dim); font-size: var(--text-2xs);">
                    No deliverables in this stage
                  </div>
                ` : colTasks.map(t => this.renderTaskCardHTML(t)).join('')}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    // Attach card click handlers
    container.querySelectorAll('.task-card').forEach(el => {
      el.addEventListener('click', () => {
        const taskId = el.getAttribute('data-task-id');
        this.openTaskDetailModal(taskId);
      });
    });
  }

  renderTaskCardHTML(t) {
    const deptName = t.departments?.name || 'Studio';
    const assigneeName = t.profiles?.full_name || 'Unassigned';
    const projectName = t.projects?.name || 'Internal Studio Work';

    return `
      <div class="task-card" data-task-id="${t.id}">
        <div class="task-card-meta-top">
          <span class="badge badge-slate font-mono">${t.task_number}</span>
          ${formatPriorityBadge(t.priority)}
        </div>

        <div class="task-card-title">${escapeHTML(t.title)}</div>
        <div class="task-card-desc line-clamp-2">${escapeHTML(t.description || '')}</div>

        <div class="task-card-route">
          <span>📁 ${escapeHTML(projectName)}</span>
          <span class="badge badge-indigo" style="font-size: 10px;">${escapeHTML(deptName)}</span>
        </div>

        <div class="task-card-footer">
          <span class="text-2xs text-muted">👤 ${escapeHTML(assigneeName)}</span>
          <span class="text-2xs font-mono text-dim">📅 ${formatDate(t.due_date)}</span>
        </div>
      </div>
    `;
  }

  renderTableView(container, tasks) {
    container.innerHTML = `
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>ID & Deliverable</th>
              <th>Department</th>
              <th>Assigned To</th>
              <th>Priority</th>
              <th>Stage</th>
              <th>Due Date</th>
              <th style="text-align: right;">Action</th>
            </tr>
          </thead>
          <tbody>
            ${tasks.length === 0 ? `
              <tr><td colspan="7" style="text-align: center; color: var(--text-dim); padding: var(--space-8);">No matching deliverables found.</td></tr>
            ` : tasks.map(t => `
              <tr>
                <td>
                  <div class="font-semibold text-white">${escapeHTML(t.title)}</div>
                  <div class="text-2xs text-dim">${t.task_number} • ${escapeHTML(t.projects?.name || 'General')}</div>
                </td>
                <td><span class="badge badge-indigo">${escapeHTML(t.departments?.name || 'Studio')}</span></td>
                <td>${escapeHTML(t.profiles?.full_name || 'Unassigned')}</td>
                <td>${formatPriorityBadge(t.priority)}</td>
                <td>${formatTaskStatusBadge(t.status)}</td>
                <td class="font-mono text-2xs text-muted">${formatDate(t.due_date)}</td>
                <td style="text-align: right;">
                  <button type="button" class="btn btn-secondary btn-sm btn-inspect-task" data-task-id="${t.id}">
                    Inspect
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    container.querySelectorAll('.btn-inspect-task').forEach(el => {
      el.addEventListener('click', () => {
        const taskId = el.getAttribute('data-task-id');
        this.openTaskDetailModal(taskId);
      });
    });
  }

  // ====================================================================
  // TASK DETAILS DRAWER / MODAL
  // ====================================================================
  async openTaskDetailModal(taskId) {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) return;

    const modalBackdrop = document.getElementById('globalModalBackdrop');
    const modalDialog = document.getElementById('globalModalDialog');
    if (!modalBackdrop || !modalDialog) return;

    modalDialog.style.maxWidth = '680px';
    modalDialog.innerHTML = `
      <div class="modal-header">
        <div>
          <div style="display: flex; align-items: center; gap: var(--space-2); margin-bottom: 2px;">
            <span class="font-mono text-2xs text-muted">${task.task_number}</span>
            <span class="badge badge-indigo">${escapeHTML(task.departments?.name || 'Studio')}</span>
            ${formatPriorityBadge(task.priority)}
            ${formatTaskStatusBadge(task.status)}
          </div>
          <h2 class="modal-title font-display">${escapeHTML(task.title)}</h2>
        </div>
        <button type="button" class="modal-close-btn" id="btnCloseModal">&times;</button>
      </div>

      <div class="modal-body" style="display: flex; flex-direction: column; gap: var(--space-4);">
        <!-- Metadata Info Grid -->
        <div class="glass-panel" style="padding: var(--space-3-5); display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3); font-size: var(--text-xs);">
          <div>
            <span class="text-dim text-2xs block">Assigned Specialist</span>
            <strong class="text-white">${escapeHTML(task.profiles?.full_name || 'Unassigned')}</strong>
          </div>
          <div>
            <span class="text-dim text-2xs block">Created / Sent By</span>
            <strong class="text-white">${escapeHTML(task.creator?.full_name || 'Admin')}</strong>
          </div>
          <div>
            <span class="text-dim text-2xs block">Deadline</span>
            <strong class="font-mono text-white">${formatDate(task.due_date)}</strong>
          </div>
        </div>

        <!-- Creative Brief -->
        <div>
          <h4 class="text-2xs font-bold uppercase tracking-wider text-dim mb-1">Creative Brief & Specifications</h4>
          <div class="glass-panel" style="padding: var(--space-3-5); font-size: var(--text-xs); color: var(--text-main); line-height: 1.5;">
            ${escapeHTML(task.description || 'No detailed specifications provided.')}
          </div>
        </div>

        <!-- Stage Advance Control -->
        <div class="glass-panel" style="padding: var(--space-3); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-2);">
          <span class="text-xs font-semibold text-white">Update Lifecycle Stage:</span>
          <div style="display: flex; gap: var(--space-1-5); flex-wrap: wrap;">
            ${['todo', 'in_progress', 'under_review', 'completed'].map(st => `
              <button 
                type="button" 
                class="btn btn-sm ${task.status === st ? 'btn-primary' : 'btn-secondary'}" 
                id="btnSetStatus_${st}"
              >
                ${st.replace('_', ' ').toUpperCase()}
              </button>
            `).join('')}
          </div>
        </div>

        <!-- Task Comments / Collaboration Notes -->
        <div>
          <h4 class="text-2xs font-bold uppercase tracking-wider text-dim mb-2">Creative Review & Asset Feedback</h4>
          <div id="taskCommentsList" style="display: flex; flex-direction: column; gap: var(--space-2); max-height: 160px; overflow-y: auto; margin-bottom: var(--space-3);">
            <div class="text-2xs text-dim italic">Loading discussion...</div>
          </div>

          <form id="commentForm" style="display: flex; gap: var(--space-2);">
            <input 
              type="text" 
              id="commentInput" 
              required 
              placeholder="Leave deliverable feedback or handoff notes..." 
              class="form-control" 
              style="height: 36px;"
            />
            <button type="submit" class="btn btn-primary btn-sm">Post Note</button>
          </form>
        </div>
      </div>

      <div class="modal-footer">
        <a href="#chat" class="btn btn-secondary btn-sm" id="btnDiscussChat">
          💬 Message Collaborator in Chat
        </a>
        <button type="button" class="btn btn-ghost btn-sm" id="btnModalCloseAction">Close</button>
      </div>
    `;

    modalBackdrop.classList.add('active');

    // Close handlers
    document.getElementById('btnCloseModal')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));
    document.getElementById('btnModalCloseAction')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));

    // Status change handlers
    ['todo', 'in_progress', 'under_review', 'completed'].forEach(st => {
      document.getElementById(`btnSetStatus_${st}`)?.addEventListener('click', async () => {
        await this.advanceTaskStatus(taskId, st);
      });
    });

    // Load comments
    await this.loadTaskComments(taskId);

    // Post comment handler
    document.getElementById('commentForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('commentInput');
      if (!input || !input.value.trim()) return;

      const text = input.value.trim();
      input.value = '';

      const supabase = getSupabase();
      await supabase.from('task_comments').insert({
        task_id: taskId,
        user_id: this.app.currentUser.id,
        content: text
      });

      Toast.success('Feedback note posted', 'Collaboration');
      await this.loadTaskComments(taskId);
    });
  }

  async advanceTaskStatus(taskId, newStatus) {
    try {
      await Api.setTaskStatus(taskId, newStatus);

      Toast.success(`Deliverable status updated to ${newStatus.toUpperCase()}`, 'Updated');
      document.getElementById('globalModalBackdrop')?.classList.remove('active');
      await this.loadData();
    } catch (err) {
      console.error('Status advance error:', err);
      Toast.error(err.message || 'Failed to update task status', 'Permission Denied');
    }
  }

  async loadTaskComments(taskId) {
    const supabase = getSupabase();
    const container = document.getElementById('taskCommentsList');
    if (!supabase || !container) return;

    const { data: comments } = await supabase
      .from('task_comments')
      .select('*, profiles!task_comments_user_id_fkey(full_name)')
      .eq('task_id', taskId)
      .order('created_at', { ascending: true });

    if (!comments || comments.length === 0) {
      container.innerHTML = `<div class="text-2xs text-dim italic">No notes posted yet on this task.</div>`;
      return;
    }

    container.innerHTML = comments.map(c => `
      <div class="glass-panel" style="padding: var(--space-2-5); font-size: var(--text-2xs); background: var(--studio-950);">
        <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
          <strong class="text-white">${escapeHTML(c.profiles?.full_name || 'Specialist')}</strong>
          <span class="text-dim font-mono">${formatDate(c.created_at, true)}</span>
        </div>
        <p class="text-muted">${escapeHTML(c.content)}</p>
      </div>
    `).join('');
  }

  // ====================================================================
  // TASK CREATION MODAL
  // ====================================================================
  async openTaskModal() {
    const modalBackdrop = document.getElementById('globalModalBackdrop');
    const modalDialog = document.getElementById('globalModalDialog');
    if (!modalBackdrop || !modalDialog) return;

    // Fetch employees for assignment dropdown
    const supabase = getSupabase();
    const { data: employees } = await supabase
      .from('profiles')
      .select('id, full_name, job_title, department_id, departments!profiles_department_id_fkey(name)')
      .eq('employment_status', 'active');

    modalDialog.style.maxWidth = '580px';
    modalDialog.innerHTML = `
      <div class="modal-header">
        <div>
          <h2 class="modal-title font-display">Dispatch / Assign Studio Task</h2>
          <p class="text-2xs text-muted">Create a new creative deliverable with deadline and specifications.</p>
        </div>
        <button type="button" class="modal-close-btn" id="btnCancelModal">&times;</button>
      </div>

      <form id="createTaskForm">
        <div class="modal-body" style="display: flex; flex-direction: column; gap: var(--space-3-5);">
          <div class="form-group">
            <label class="form-label" for="taskTitleInput">Deliverable Title *</label>
            <input 
              id="taskTitleInput" 
              type="text" 
              required 
              placeholder="e.g. 3D Exhibition Booth Blueprints & CNC Die-Cuts" 
              class="form-control" 
            />
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
            <div class="form-group">
              <label class="form-label" for="taskAssigneeSelect">Assignee Specialist *</label>
              <select id="taskAssigneeSelect" required class="form-control">
                ${(employees || []).map(emp => `
                  <option value="${emp.id}" data-dept="${emp.department_id || ''}">
                    ${escapeHTML(emp.full_name)} (${emp.departments?.name || 'Studio'})
                  </option>
                `).join('')}
              </select>
            </div>

            <div class="form-group">
              <label class="form-label" for="taskProjectSelect">Client Project / Campaign</label>
              <select id="taskProjectSelect" class="form-control">
                <option value="">General Studio Work</option>
                ${this.projects.map(p => `
                  <option value="${p.id}">${escapeHTML(p.name)} (${escapeHTML(p.code)})</option>
                `).join('')}
              </select>
            </div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
            <div class="form-group">
              <label class="form-label" for="taskPrioritySelect">Priority Level</label>
              <select id="taskPrioritySelect" class="form-control">
                <option value="urgent">🔥 Urgent Priority</option>
                <option value="high">⚡ High Priority</option>
                <option value="medium" selected>📌 Medium Priority</option>
                <option value="low">🌿 Low Priority</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label" for="taskDueDateInput">Deadline *</label>
              <input id="taskDueDateInput" type="date" required class="form-control" />
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="taskDescInput">Creative Brief & Production Specifications</label>
            <textarea 
              id="taskDescInput" 
              rows="3" 
              placeholder="Include required dimensions, color profiles, file formats, and handoff guidelines..." 
              class="form-control"
            ></textarea>
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary btn-sm" id="btnCancelCreate">Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm" id="btnSubmitTask">Dispatch Deliverable</button>
        </div>
      </form>
    `;

    // Set default due date to 5 days ahead
    const d = new Date();
    d.setDate(d.getDate() + 5);
    const dateInput = document.getElementById('taskDueDateInput');
    if (dateInput) dateInput.value = d.toISOString().split('T')[0];

    modalBackdrop.classList.add('active');

    document.getElementById('btnCancelModal')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));
    document.getElementById('btnCancelCreate')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));

    document.getElementById('createTaskForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();

      const title = document.getElementById('taskTitleInput').value.trim();
      const assigneeSelect = document.getElementById('taskAssigneeSelect');
      const assignedTo = assigneeSelect.value;
      const projectId = document.getElementById('taskProjectSelect').value || null;
      const priority = document.getElementById('taskPrioritySelect').value;
      const dueDate = document.getElementById('taskDueDateInput').value;
      const description = document.getElementById('taskDescInput').value.trim();

      const submitBtn = document.getElementById('btnSubmitTask');
      if (submitBtn) submitBtn.disabled = true;

      try {
        await Api.createTask({ title, assignedTo, projectId, priority, dueDate, description });

        Toast.success('Deliverable task dispatched successfully', 'Created');
        modalBackdrop.classList.remove('active');
        await this.loadData();
      } catch (err) {
        console.error('Task creation error:', err);
        Toast.error(err.message || 'Failed to dispatch task', 'Creation Error');
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }
}
