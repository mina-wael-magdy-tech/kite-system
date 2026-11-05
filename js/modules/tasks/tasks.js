/**
 * KITE SYSTEM — Module D: Task Management
 * Complete task engine: Kanban & Table views, 9 lifecycle stages, checklists, comments, and role privacy.
 */

import { Realtime } from '../../services/realtime-service.js';
import { ASSIGNEE_SELECT, assigneeOptionsHTML, selectedDeptId } from '../../utils/assignees.js';
import { getSupabase } from '../../supabase-client.js';
import { Permissions } from '../../permissions/permission-service.js';
import { Toast } from '../../services/toast-service.js';
import { Api } from '../../services/api.js';
import { formDialog, confirmDialog } from '../../ui/dialogs.js';
import { escapeHTML, formatDate, debounce } from '../../utils/helpers.js';
import { formatTaskStatusBadge, formatPriorityBadge } from '../../utils/formatters.js';
import { linkify } from '../../utils/linkify.js';
import { CONFIG } from '../../config.js';
import { PAGE_SIZE, fetchPage, mountPager, searchFilter } from '../../ui/pagination.js';

const TASK_SELECT = `
  *,
  profiles!tasks_assigned_to_fkey(id, full_name, job_title),
  creator:profiles!tasks_created_by_fkey(id, full_name),
  departments!tasks_department_id_fkey(id, name, code),
  projects(id, name, code)
`;

const BOARD_COLUMNS = [
  { id: 'todo', statuses: ['todo'] },
  { id: 'in_progress', statuses: ['in_progress'] },
  { id: 'under_review', statuses: ['under_review'] },
  { id: 'completed', statuses: ['completed', 'approved'] }
];

export class TasksModule {
  constructor(app) {
    this.app = app;
    this.tasks = [];              // only the rows on screen: a table page, or what each board column has loaded
    this.tablePage = 1;
    this.tableTotal = 0;
    this.columnShown = {};        // board column -> how many cards it has asked for
    this.columnTotals = {};       // board column -> how many cards exist
    this.loadSeq = 0;
    this.departments = [];
    this.projects = [];
    this.viewMode = 'kanban'; // 'kanban' or 'table'
    this.scopeFilter = 'all'; // 'all', 'assigned', 'sent'
    this.searchQuery = '';
    this.selectedDept = 'ALL';
    this.selectedPriority = 'ALL';
  }

  async render(container, query) {
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
              <option value="urgent">Urgent</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
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
    // #tasks?q=... comes from the top search box
    const q = new URLSearchParams(query || '').get('q');
    if (q) {
      this.searchQuery = q.toLowerCase();
      const field = document.getElementById('taskSearchField');
      if (field) field.value = q;
    }
    await this.loadLookups();
    await this.loadData();
    Realtime.watch(['tasks', 'task_comments', 'task_attachments', 'task_links'], async () => {
      await this.loadData();
      // an open task view shows new notes / files / links as they arrive
      if (this.openTaskId && document.getElementById('taskCommentsList')) {
        await Promise.all([this.loadTaskComments(this.openTaskId), this.loadTaskAssets(this.openTaskId)]);
      }
    }); // live updates for everyone
  }

  attachEventListeners() {
    document.getElementById('btnCreateTask')?.addEventListener('click', () => {
      this.openTaskModal();
    });

    document.getElementById('taskSearchField')?.addEventListener('input', debounce((e) => {
      this.searchQuery = e.target.value.toLowerCase();
      this.reloadFromStart();
    }, 250));

    document.getElementById('filterDeptSelect')?.addEventListener('change', (e) => {
      this.selectedDept = e.target.value;
      this.reloadFromStart();
    });

    document.getElementById('filterPrioritySelect')?.addEventListener('change', (e) => {
      this.selectedPriority = e.target.value;
      this.reloadFromStart();
    });

    document.getElementById('btnViewKanban')?.addEventListener('click', () => {
      this.viewMode = 'kanban';
      document.getElementById('btnViewKanban')?.classList.add('btn-secondary');
      document.getElementById('btnViewTable')?.classList.remove('btn-secondary');
      this.reloadFromStart();
    });

    document.getElementById('btnViewTable')?.addEventListener('click', () => {
      this.viewMode = 'table';
      document.getElementById('btnViewTable')?.classList.add('btn-secondary');
      document.getElementById('btnViewKanban')?.classList.remove('btn-secondary');
      this.reloadFromStart();
    });

    document.getElementById('btnScopeAll')?.addEventListener('click', () => {
      this.scopeFilter = 'all';
      this.reloadFromStart();
    });

    document.getElementById('btnScopeAssigned')?.addEventListener('click', () => {
      this.scopeFilter = 'assigned';
      this.reloadFromStart();
    });
  }

  /** Departments and projects for the filter and forms. Loaded once per visit, not on every live update. */
  async loadLookups() {
    const supabase = getSupabase();
    if (!supabase) return;
    const [{ data: depts }, { data: projs }] = await Promise.all([
      supabase.from('departments').select('id, name, code'),
      supabase.from('projects').select('id, name, code')
    ]);
    this.departments = depts || [];
    this.projects = projs || [];
    const deptSelect = document.getElementById('filterDeptSelect');
    if (deptSelect) {
      deptSelect.innerHTML = `<option value="ALL">All 5 Departments</option>` +
        this.departments.map(d => `<option value="${d.id}">${escapeHTML(d.name)}</option>`).join('');
    }
  }

  /** The filtered, newest-first query. RLS still decides which tasks each person gets. */
  taskQuery() {
    let q = getSupabase().from('tasks').select(TASK_SELECT, { count: 'exact' })
      .order('created_at', { ascending: false }).order('id', { ascending: true });
    const search = searchFilter(['title', 'description', 'task_number'], this.searchQuery);
    if (search) q = q.or(search);
    if (this.selectedDept !== 'ALL') q = q.eq('department_id', this.selectedDept);
    if (this.selectedPriority !== 'ALL') q = q.eq('priority', this.selectedPriority);
    if (this.scopeFilter === 'assigned') q = q.eq('assigned_to', this.app.currentUser.id);
    return q;
  }

  reloadFromStart() {
    this.tablePage = 1;
    this.columnShown = {};
    return this.loadData();
  }

  async loadData() {
    const supabase = getSupabase();
    if (!supabase) return;
    const seq = ++this.loadSeq;

    try {
      const load = this.viewMode === 'kanban' ? this.fetchBoard() : this.fetchTablePage();
      const [apply, count] = await Promise.all([
        load,
        supabase.from('tasks').select('id', { count: 'exact', head: true })
      ]);
      if (seq !== this.loadSeq) return; // a newer request has taken over

      apply();
      const badge = document.getElementById('tasksBadge');
      if (badge && count.count != null) badge.textContent = String(count.count);
      this.renderCurrentView();
    } catch (err) {
      console.error('Error loading tasks:', err);
      if (seq === this.loadSeq) Toast.error('Could not load tasks from database', 'Fetch Error');
    }
  }

  /** Each column asks for its own cards, so a long "done" column can't crowd out the others. */
  async fetchBoard() {
    const results = await Promise.all(BOARD_COLUMNS.map(async (col) => {
      const shown = this.columnShown[col.id] || PAGE_SIZE.board;
      const res = await this.taskQuery().in('status', col.statuses).range(0, shown - 1);
      if (res.error) throw res.error;
      return { id: col.id, rows: res.data || [], total: res.count ?? 0 };
    }));
    return () => {
      this.tasks = results.flatMap(r => r.rows);
      this.columnTotals = Object.fromEntries(results.map(r => [r.id, r.total]));
    };
  }

  async fetchTablePage() {
    const res = await fetchPage(() => this.taskQuery(), this.tablePage, PAGE_SIZE.table);
    if (res.error) throw res.error;
    return () => {
      this.tasks = res.rows;
      this.tableTotal = res.total;
      this.tablePage = res.page;
    };
  }

  /** The task on screen, or from the database if a filter or page change has since taken it off screen. */
  async taskById(taskId) {
    const known = this.tasks.find(t => t.id === taskId);
    if (known) return known;
    const { data } = await getSupabase().from('tasks').select(TASK_SELECT).eq('id', taskId).maybeSingle();
    return data || null;
  }

  renderCurrentView() {
    const container = document.getElementById('taskContentContainer');
    if (!container) return;

    if (this.viewMode === 'kanban') {
      this.renderKanbanBoard(container, this.tasks);
    } else {
      this.renderTableView(container, this.tasks);
    }

    if (window.lucide) window.lucide.createIcons();
  }

  renderKanbanBoard(container, tasks) {
    const columns = [
      { id: 'todo', title: 'To Do / Queued', dot: 'var(--color-sky)', tone: 'blue' },
      { id: 'in_progress', title: 'In Production', dot: 'var(--color-amber)', tone: 'amber' },
      { id: 'under_review', title: 'Creative Review', dot: 'var(--color-rose)', tone: 'red' },
      { id: 'completed', title: 'Approved & Done', dot: 'var(--color-emerald)', tone: 'green' }
    ];

    container.innerHTML = `
      <div class="kanban-board">
        ${columns.map(col => {
          const colTasks = tasks.filter(t => {
            if (col.id === 'completed') return t.status === 'completed' || t.status === 'approved';
            return t.status === col.id;
          });
          const total = Math.max(this.columnTotals[col.id] ?? 0, colTasks.length);

          return `
            <div class="kanban-column kanban-tone-${col.tone}" data-column="${col.id}">
              <div class="kanban-column-header">
                <div class="kanban-column-title">
                  <span class="kanban-column-dot" style="background-color: ${col.dot};"></span>
                  <span>${col.title}</span>
                </div>
                <span class="badge badge-slate kanban-count">${total}</span>
              </div>

              <div class="kanban-tasks-list" data-drop-column="${col.id}">
                ${colTasks.length === 0 ? `
                  <div class="kanban-empty">Drop a deliverable here</div>
                ` : colTasks.map(t => this.renderTaskCardHTML(t)).join('')}
                ${total > colTasks.length ? `<button type="button" class="btn btn-secondary btn-sm kanban-more" data-more-column="${col.id}">Show more (${total - colTasks.length} left)</button>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    // Card click opens details; the edit / delete icons act on their own
    container.querySelectorAll('.task-card').forEach(el => {
      const taskId = el.getAttribute('data-task-id');
      el.addEventListener('click', () => this.openTaskDetailModal(taskId));
      el.querySelector('.card-act-edit')?.addEventListener('click', (e) => { e.stopPropagation(); this.openTaskEditDialog(taskId); });
      el.querySelector('.card-act-delete')?.addEventListener('click', (e) => { e.stopPropagation(); this.deleteTask(taskId); });
    });

    container.querySelectorAll('[data-more-column]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.moreColumn;
      this.columnShown[id] = (this.columnShown[id] || PAGE_SIZE.board) + PAGE_SIZE.board;
      b.disabled = true;
      this.loadData();
    }));

    this.bindDragAndDrop(container);
  }

  // ====================================================================
  // DRAG & DROP (HTML5). Dropping on a column moves the task to that stage
  // through the server (same rules as the status buttons); on refusal it snaps back.
  // ====================================================================
  bindDragAndDrop(container) {
    let draggedId = null;

    container.querySelectorAll('.task-card').forEach(card => {
      card.setAttribute('draggable', 'true');
      card.addEventListener('dragstart', (e) => {
        draggedId = card.getAttribute('data-task-id');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggedId);
        requestAnimationFrame(() => card.classList.add('dragging'));
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        container.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        draggedId = null;
      });
    });

    container.querySelectorAll('.kanban-column').forEach(col => {
      const list = col.querySelector('.kanban-tasks-list');
      col.addEventListener('dragover', (e) => {
        if (!draggedId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        col.classList.add('drag-over');
      });
      col.addEventListener('dragleave', (e) => {
        if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over');
      });
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('drag-over');
        const id = draggedId || e.dataTransfer.getData('text/plain');
        if (!id) return;
        await this.moveTaskToColumn(id, list.getAttribute('data-drop-column'));
      });
    });
  }

  async moveTaskToColumn(taskId, columnId) {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) return;
    const groupOf = (s) => (s === 'approved' ? 'completed' : s);
    if (groupOf(task.status) === columnId) return; // dropped where it already is

    const previous = task.status;
    const totals = { ...this.columnTotals };
    if (this.columnTotals[groupOf(previous)]) this.columnTotals[groupOf(previous)]--;
    this.columnTotals[columnId] = (this.columnTotals[columnId] || 0) + 1;
    task.status = columnId;           // optimistic
    this.renderCurrentView();
    try {
      await Api.setTaskStatus(taskId, columnId);
      Toast.success(`Moved ${task.task_number} to ${columnId.replace('_', ' ').toUpperCase()}`, 'Stage updated');
    } catch (err) {
      task.status = previous;         // snap back
      this.columnTotals = totals;
      this.renderCurrentView();
      Toast.error(err.message || 'Could not move this task', 'Move refused');
    }
  }

  // ====================================================================
  // EDIT / DELETE
  // ====================================================================
  canEditTask(t) {
    const me = this.app.currentUser.id;
    return Permissions.isAdmin() || Permissions.isManager() || t.created_by === me || t.assigned_to === me;
  }

  canDeleteTask(t) {
    return Permissions.isAdmin() || Permissions.isManager() || t.created_by === this.app.currentUser.id;
  }

  async openTaskEditDialog(taskId) {
    const t = await this.taskById(taskId);
    if (!t) return;

    const supabase = getSupabase();
    const { data: people } = await supabase
      .from('profiles')
      .select('id, full_name')
      .eq('employment_status', 'active')
      .order('full_name', { ascending: true });

    const canReassign = Permissions.isAdmin() || Permissions.isManager() ||
      (t.created_by === this.app.currentUser.id && t.assigned_to !== this.app.currentUser.id);

    const fields = [
      { name: 'title', label: 'Task name', required: true, value: t.title, maxlength: 200 },
      { name: 'description', label: 'Creative brief', type: 'textarea', value: t.description || '', rows: 4, maxlength: 5000 },
      { name: 'priority', label: 'Priority', type: 'select', half: true, value: t.priority, options: [
        { value: 'urgent', label: 'Urgent' }, { value: 'high', label: 'High' },
        { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }] },
      { name: 'dueDate', label: 'Deadline', type: 'date', half: true, required: true, value: (t.due_date || '').slice(0, 10) },
      { name: 'projectId', label: 'Project', type: 'select', half: true, value: t.project_id || '', options: [
        { value: '', label: 'General studio work' },
        ...this.projects.map(p => ({ value: p.id, label: `${p.name} (${p.code})` }))] }
    ];
    if (canReassign) {
      fields.push({ name: 'assigneeId', label: 'Assigned to', type: 'select', half: true, required: true, value: t.assigned_to || '',
        options: (people || []).map(p => ({ value: p.id, label: p.full_name })) });
    }

    formDialog({
      title: `Edit ${t.task_number}`,
      subtitle: 'Change the name, brief, priority, deadline, project or assignee.',
      fields,
      onSubmit: async (v) => {
        await Api.updateTask(t.id, {
          title: v.title, description: v.description, priority: v.priority,
          dueDate: v.dueDate, projectId: v.projectId
        });
        if (canReassign && v.assigneeId && v.assigneeId !== t.assigned_to) {
          await Api.reassignTask(t.id, v.assigneeId);
        }
        Toast.success('Task updated', 'Saved');
        await this.loadData();
      },
      onDelete: this.canDeleteTask(t) ? async () => {
        await Api.deleteTask(t.id);
        Toast.success(`${t.task_number} deleted`, 'Deleted');
        await this.loadData();
      } : undefined,
      deleteLabel: 'Delete task',
      deleteMessage: `"${t.title}" and its comments, files and history will be permanently removed.`
    });
  }

  async deleteTask(taskId) {
    const t = await this.taskById(taskId);
    if (!t) return;
    const ok = await confirmDialog({
      title: 'Delete this task?',
      message: `"${t.title}" (${t.task_number}) and its comments, files and history will be permanently removed.`,
      confirmLabel: 'Delete task',
      danger: true
    });
    if (!ok) return;
    try {
      await Api.deleteTask(taskId);
      Toast.success(`${t.task_number} deleted`, 'Deleted');
      await this.loadData();
    } catch (err) {
      Toast.error(err.message || 'Could not delete task', 'Delete refused');
    }
  }

  renderTaskCardHTML(t) {
    const deptName = t.departments?.name || 'Studio';
    const assigneeName = t.profiles?.full_name || 'Unassigned';
    const projectName = t.projects?.name || 'Internal Studio Work';

    return `
      <div class="task-card" data-task-id="${t.id}">
        <div class="task-card-meta-top">
          <span class="badge badge-slate font-mono">${t.task_number}</span>
          <span class="card-actions">
            ${this.canEditTask(t) ? '<button type="button" class="card-act card-act-edit" title="Edit task" aria-label="Edit task"><i data-lucide="pencil"></i></button>' : ''}
            ${this.canDeleteTask(t) ? '<button type="button" class="card-act card-act-delete" title="Delete task" aria-label="Delete task"><i data-lucide="trash-2"></i></button>' : ''}
          </span>
          ${formatPriorityBadge(t.priority)}
        </div>

        <div class="task-card-title">${escapeHTML(t.title)}</div>
        <div class="task-card-desc line-clamp-2">${escapeHTML(t.description || '')}</div>

        <div class="task-card-route">
          <span>${escapeHTML(projectName)}</span>
          <span class="badge badge-indigo" style="font-size: 10px;">${escapeHTML(deptName)}</span>
        </div>

        <div class="task-card-footer">
          <span class="text-2xs text-muted">${escapeHTML(assigneeName)}</span>
          <span class="text-2xs font-mono text-dim">${formatDate(t.due_date)}</span>
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
                  ${this.canEditTask(t) ? `<button type="button" class="btn btn-ghost btn-sm btn-edit-task" data-task-id="${t.id}">Edit</button>` : ''}
                  ${this.canDeleteTask(t) ? `<button type="button" class="btn btn-danger btn-sm btn-delete-task" data-task-id="${t.id}">Delete</button>` : ''}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div id="taskPager"></div>
    `;

    mountPager(document.getElementById('taskPager'), {
      page: this.tablePage, total: this.tableTotal, size: PAGE_SIZE.table, label: 'tasks', top: container,
      onPage: (n) => { this.tablePage = n; return this.loadData(); }
    });

    container.querySelectorAll('.btn-inspect-task').forEach(el => {
      el.addEventListener('click', () => this.openTaskDetailModal(el.getAttribute('data-task-id')));
    });
    container.querySelectorAll('.btn-edit-task').forEach(el => {
      el.addEventListener('click', () => this.openTaskEditDialog(el.getAttribute('data-task-id')));
    });
    container.querySelectorAll('.btn-delete-task').forEach(el => {
      el.addEventListener('click', () => this.deleteTask(el.getAttribute('data-task-id')));
    });
  }

  // ====================================================================
  // TASK DETAILS DRAWER / MODAL
  // ====================================================================
  async openTaskDetailModal(taskId) {
    const task = await this.taskById(taskId);
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
            ${task.description ? linkify(task.description) : 'No detailed specifications provided.'}
          </div>
        </div>

        <!-- Files & Links -->
        <div>
          <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-2); flex-wrap: wrap;">
            <h4 class="text-2xs font-bold uppercase tracking-wider text-dim">Files & Links</h4>
            <div style="display: flex; gap: var(--space-2);">
              <button type="button" class="btn btn-secondary btn-sm" id="btnTaskAddLink"><i data-lucide="link"></i> Add link</button>
              <button type="button" class="btn btn-secondary btn-sm" id="btnTaskUpload"><i data-lucide="paperclip"></i> Upload files</button>
              <input type="file" id="taskFileInput" multiple style="display: none;" />
            </div>
          </div>
          <div id="taskAssetsList" style="display: flex; flex-direction: column; gap: var(--space-2);">
            <div class="text-2xs text-dim italic">Loading files...</div>
          </div>
          <p class="text-2xs text-dim" style="margin-top: 6px;">PDF, ZIP, images, video, Office files and more · up to ${Math.round(CONFIG.MAX_TASK_FILE_SIZE_BYTES / 1048576)} MB each. Zip a folder to share it.</p>
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
          Message Collaborator in Chat
        </a>
        ${this.canEditTask(task) ? '<button type="button" class="btn btn-secondary btn-sm" id="btnModalEditTask"><i data-lucide="pencil"></i> Edit</button>' : ''}
        <button type="button" class="btn btn-ghost btn-sm" id="btnModalCloseAction">Close</button>
      </div>
    `;

    modalBackdrop.classList.add('active');

    // Close handlers
    document.getElementById('btnCloseModal')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));
    document.getElementById('btnModalCloseAction')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));
    document.getElementById('btnModalEditTask')?.addEventListener('click', () => this.openTaskEditDialog(taskId));
    if (window.lucide) window.lucide.createIcons();

    // Status change handlers
    ['todo', 'in_progress', 'under_review', 'completed'].forEach(st => {
      document.getElementById(`btnSetStatus_${st}`)?.addEventListener('click', async () => {
        await this.advanceTaskStatus(taskId, st);
      });
    });

    // Load notes + files/links, and wire the upload / link buttons
    this.openTaskId = taskId;
    document.getElementById('btnCloseModal')?.addEventListener('click', () => { this.openTaskId = null; });
    document.getElementById('btnModalCloseAction')?.addEventListener('click', () => { this.openTaskId = null; });
    await Promise.all([this.loadTaskComments(taskId), this.loadTaskAssets(taskId)]);
    document.getElementById('btnTaskUpload')?.addEventListener('click', () => document.getElementById('taskFileInput')?.click());
    document.getElementById('taskFileInput')?.addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      await this.uploadTaskFiles(taskId, files);
    });
    document.getElementById('btnTaskAddLink')?.addEventListener('click', () => this.openAddLinkDialog(taskId, task));

    // Post comment handler
    document.getElementById('commentForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('commentInput');
      if (!input || !input.value.trim()) return;

      const text = input.value.trim();
      input.value = '';

      try {
        await Api.commentTask(taskId, text);
        Toast.success('Feedback note posted', 'Collaboration');
      } catch (err) {
        input.value = text;
        Toast.error(err.message || 'Could not post the comment', 'Comment failed');
      }
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

    const { data: comments, error } = await supabase
      .from('task_comments')
      .select('id, user_id, content, created_at')
      .eq('task_id', taskId)
      .order('created_at', { ascending: true });

    if (error) {
      container.innerHTML = `<div class="text-2xs text-rose">Could not load notes: ${escapeHTML(error.message)}</div>`;
      return;
    }
    if (!comments || comments.length === 0) {
      container.innerHTML = `<div class="text-2xs text-dim italic">No notes posted yet on this task.</div>`;
      return;
    }

    // names looked up separately so one missing profile can never hide the notes
    const ids = [...new Set(comments.map(c => c.user_id))];
    const { data: people } = await supabase.from('profiles').select('id, full_name').in('id', ids);
    const nameOf = (id) => people?.find(p => p.id === id)?.full_name || 'Team member';

    container.innerHTML = comments.map(c => `
      <div class="glass-panel" style="padding: var(--space-2-5); font-size: var(--text-xs); background: var(--studio-950);">
        <div style="display: flex; justify-content: space-between; gap: var(--space-2); margin-bottom: 2px;">
          <strong class="text-white">${escapeHTML(nameOf(c.user_id))}</strong>
          <span class="text-dim font-mono text-2xs">${formatDate(c.created_at, true)}</span>
        </div>
        <p class="text-muted" style="line-height: 1.5; overflow-wrap: anywhere;">${linkify(c.content)}</p>
      </div>
    `).join('');
    container.scrollTop = container.scrollHeight;
  }

  // ---- files & links on a task ------------------------------------------------

  async loadTaskAssets(taskId) {
    const supabase = getSupabase();
    const container = document.getElementById('taskAssetsList');
    if (!supabase || !container) return;

    const [filesRes, linksRes] = await Promise.all([
      supabase.from('task_attachments').select('id, file_name, file_size, storage_path, uploaded_by, created_at').eq('task_id', taskId).order('created_at', { ascending: false }),
      supabase.from('task_links').select('id, title, url, added_by, created_at').eq('task_id', taskId).order('created_at', { ascending: false })
    ]);
    const files = filesRes.data || [];
    // task_links appears with migration 008; before it exists just show the files
    const links = linksRes.error ? [] : (linksRes.data || []);

    if (!files.length && !links.length) {
      container.innerHTML = `<div class="text-2xs text-dim italic">No files or links yet. Upload a PDF/ZIP or add a link.</div>`;
      return;
    }

    const me = this.app.currentUser.id;
    const isAdmin = Permissions.isAdmin();
    const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
    const ext = (n) => (n.includes('.') ? n.split('.').pop().toUpperCase() : 'FILE');

    const row = (icon, main, sub, actions) => `
      <div class="glass-panel" style="padding: var(--space-2-5); display: flex; align-items: center; gap: var(--space-3); background: var(--studio-950);">
        <i data-lucide="${icon}" style="width: 18px; height: 18px; flex-shrink: 0; color: var(--kite-red-600);"></i>
        <div style="min-width: 0; flex: 1;">
          <div class="text-xs font-bold text-white truncate">${main}</div>
          <div class="text-2xs text-dim">${sub}</div>
        </div>
        <div style="display: flex; gap: 4px; flex-shrink: 0;">${actions}</div>
      </div>`;

    container.innerHTML =
      links.map(l => row('link',
        `<a href="${escapeHTML(l.url)}" target="_blank" rel="noopener noreferrer" style="color: inherit;">${escapeHTML(l.title)}</a>`,
        escapeHTML(l.url.replace(/^https?:\/\//, '').slice(0, 60)),
        `<a class="card-act" href="${escapeHTML(l.url)}" target="_blank" rel="noopener noreferrer" title="Open link" style="opacity:1; display:inline-flex;"><i data-lucide="external-link"></i></a>` +
        ((l.added_by === me || isAdmin) ? `<button type="button" class="card-act card-act-delete task-link-del" data-id="${l.id}" title="Remove link" style="opacity:1;"><i data-lucide="trash-2"></i></button>` : '')
      )).join('') +
      files.map(f => row('file',
        escapeHTML(f.file_name),
        `${ext(f.file_name)} · ${size(f.file_size)} · ${formatDate(f.created_at)}`,
        `<button type="button" class="card-act task-file-dl" data-path="${escapeHTML(f.storage_path)}" data-name="${escapeHTML(f.file_name)}" title="Download" style="opacity:1;"><i data-lucide="download"></i></button>` +
        ((f.uploaded_by === me || isAdmin) ? `<button type="button" class="card-act card-act-delete task-file-del" data-id="${f.id}" data-path="${escapeHTML(f.storage_path)}" title="Delete file" style="opacity:1;"><i data-lucide="trash-2"></i></button>` : '')
      )).join('');

    container.querySelectorAll('.task-file-dl').forEach(b => b.addEventListener('click', () => this.downloadTaskFile(b.dataset.path, b.dataset.name)));
    container.querySelectorAll('.task-file-del').forEach(b => b.addEventListener('click', () => this.deleteTaskFile(taskId, b.dataset.id, b.dataset.path)));
    container.querySelectorAll('.task-link-del').forEach(b => b.addEventListener('click', () => this.deleteTaskLink(taskId, b.dataset.id)));
    if (window.lucide) window.lucide.createIcons();
  }

  async downloadTaskFile(path, name) {
    const { data, error } = await getSupabase().storage.from(CONFIG.STORAGE_BUCKETS.TASK_ATTACHMENTS).createSignedUrl(path, 120, { download: name });
    if (error || !data?.signedUrl) { Toast.error('You do not have access to this file, or it no longer exists.', 'Download failed'); return; }
    const a = document.createElement('a');
    a.href = data.signedUrl;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async uploadTaskFiles(taskId, files) {
    if (!files.length) return;
    const supabase = getSupabase();
    const bucket = CONFIG.STORAGE_BUCKETS.TASK_ATTACHMENTS;
    const btn = document.getElementById('btnTaskUpload');
    if (btn) btn.disabled = true;
    let ok = 0;
    for (const file of files) {
      const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
      if (!CONFIG.ALLOWED_FILE_EXTENSIONS.includes(ext)) { Toast.error(`“${file.name}”: .${ext || '?'} files are not allowed`, 'Upload rejected'); continue; }
      if (!file.size || file.size > CONFIG.MAX_TASK_FILE_SIZE_BYTES) { Toast.error(`“${file.name}” must be under ${Math.round(CONFIG.MAX_TASK_FILE_SIZE_BYTES / 1048576)} MB`, 'Upload rejected'); continue; }
      const path = `${taskId}/${crypto.randomUUID()}-${file.name.replace(/[^\w.\-]+/g, '_').slice(-120)}`;
      try {
        const { error: upErr } = await supabase.storage.from(bucket).upload(path, file, { upsert: false, contentType: file.type || 'application/octet-stream' });
        if (upErr) throw upErr;
        const { error: rowErr } = await supabase.from('task_attachments').insert({
          task_id: taskId, file_name: file.name, file_size: file.size,
          file_type: file.type || ext.toUpperCase(), storage_path: path, uploaded_by: this.app.currentUser.id
        });
        if (rowErr) { await supabase.storage.from(bucket).remove([path]); throw rowErr; }
        Api.taskFileAdded(taskId, file.name).catch(() => {});
        ok++;
      } catch (err) {
        console.error('Task upload error:', err);
        Toast.error(`${file.name}: ${err.message || 'upload failed'}`, 'Upload failed');
      }
    }
    if (btn) btn.disabled = false;
    if (ok) Toast.success(`${ok} file${ok === 1 ? '' : 's'} attached`, 'Uploaded');
    await this.loadTaskAssets(taskId);
  }

  async deleteTaskFile(taskId, id, path) {
    const ok = await confirmDialog({ title: 'Delete this file?', message: 'It will be removed from the task for everyone.', confirmLabel: 'Delete file', danger: true });
    if (!ok) return;
    const supabase = getSupabase();
    const { data, error } = await supabase.from('task_attachments').delete().eq('id', id).select('id');
    if (error || !data?.length) { Toast.error(error?.message || 'You are not allowed to delete this file.', 'Delete failed'); return; }
    await supabase.storage.from(CONFIG.STORAGE_BUCKETS.TASK_ATTACHMENTS).remove([path]);
    await this.loadTaskAssets(taskId);
  }

  openAddLinkDialog(taskId, task) {
    formDialog({
      title: 'Add a link',
      subtitle: `${task.task_number} · Google Drive, Figma, Dropbox, a brief…`,
      submitLabel: 'Add link',
      fields: [
        { name: 'title', label: 'Title', required: true, maxlength: 120, placeholder: 'e.g. Brand guidelines (Drive)' },
        { name: 'url', label: 'Link', type: 'url', required: true, maxlength: 1000, placeholder: 'https://…' }
      ],
      onSubmit: async (v) => {
        if (!/^https?:\/\//i.test(v.url)) throw new Error('The link must start with http:// or https://');
        const { error } = await getSupabase().from('task_links').insert({ task_id: taskId, title: v.title, url: v.url, added_by: this.app.currentUser.id });
        if (error) throw new Error(error.message.includes('task_links') ? 'Run migration 008_task_links.sql in Supabase first.' : error.message);
        Api.taskFileAdded(taskId, `link: ${v.title}`).catch(() => {});
        Toast.success('Link added', 'Saved');
      }
    });
    // the dialog replaced the task view; reopen it afterwards so the link is visible
    const backdrop = document.getElementById('globalModalBackdrop');
    const observer = new MutationObserver(() => {
      if (!backdrop.classList.contains('active')) {
        observer.disconnect();
        this.openTaskDetailModal(taskId);
      }
    });
    observer.observe(backdrop, { attributes: true, attributeFilter: ['class'] });
  }

  async deleteTaskLink(taskId, id) {
    const { data, error } = await getSupabase().from('task_links').delete().eq('id', id).select('id');
    if (error || !data?.length) { Toast.error(error?.message || 'You are not allowed to remove this link.', 'Remove failed'); return; }
    await this.loadTaskAssets(taskId);
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
      .select(ASSIGNEE_SELECT)
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
                ${assigneeOptionsHTML(employees)}
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
                <option value="urgent">Urgent Priority</option>
                <option value="high">High Priority</option>
                <option value="medium" selected>Medium Priority</option>
                <option value="low">Low Priority</option>
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
        await Api.createTask({ title, assignedTo, departmentId: selectedDeptId(assigneeSelect) || undefined, projectId, priority, dueDate, description });

        Toast.success('Deliverable task dispatched successfully', 'Created');
        modalBackdrop.classList.remove('active');
        this.tablePage = 1; // the new task is the newest
        await this.loadData();
      } catch (err) {
        console.error('Task creation error:', err);
        Toast.error(err.message || 'Failed to dispatch task', 'Creation Error');
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }
}
