/**
 * KITE SYSTEM — Module A: Executive Dashboard
 * Real-time agency analytics, Chart.js performance trends, pending approvals & recent activities.
 */

import { Realtime } from '../../services/realtime-service.js';
import { getSupabase } from '../../supabase-client.js';
import { Permissions } from '../../permissions/permission-service.js';
import { escapeHTML, formatCurrency, formatDate } from '../../utils/helpers.js';
import { formatTaskStatusBadge } from '../../utils/formatters.js';

export class DashboardModule {
  constructor(app) {
    this.app = app;
  }

  async render(container) {
    container.innerHTML = `
      <div class="page-container animate-fade-in">
        <!-- Dashboard Header & Greeting -->
        <div style="display: flex; flex-direction: column; gap: var(--space-1);">
          <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-3);">
            <div>
              <h1 class="font-display font-bold text-xl text-white">
                Studio Overview — ${escapeHTML(this.app.currentProfile.full_name || 'Specialist')}
              </h1>
              <p class="text-xs text-muted">
                Real-time operational metrics across all 5 studio departments.
              </p>
            </div>
            
            <div style="display: flex; gap: var(--space-2);">
              <a href="#tasks" class="btn btn-primary btn-sm">
                <i data-lucide="plus"></i> New Studio Task
              </a>
              <a href="#projects" class="btn btn-secondary btn-sm">
                <i data-lucide="folder-plus"></i> New Project
              </a>
            </div>
          </div>
        </div>

        <!-- 4 Core KPI Stat Cards -->
        <div class="kpi-grid" id="dashboardKpiGrid">
          <div class="stat-card border-indigo">
            <div class="stat-card-header">
              <span class="stat-card-label">Active Studio Sprints</span>
              <span class="badge badge-indigo">Live Tasks</span>
            </div>
            <div class="stat-card-value" id="kpiActiveTasks">—</div>
            <div class="stat-card-footer" id="kpiActiveTasksSub">Loading tasks in production...</div>
          </div>

          <div class="stat-card border-sky">
            <div class="stat-card-header">
              <span class="stat-card-label">Active Client Projects</span>
              <span class="badge badge-sky">On Track</span>
            </div>
            <div class="stat-card-value" id="kpiActiveProjects">—</div>
            <div class="stat-card-footer">Across Branding, BTL, Web & Media</div>
          </div>

          <div class="stat-card border-amber">
            <div class="stat-card-header">
              <span class="stat-card-label">Awaiting Creative Review</span>
              <span class="badge badge-amber">Sign-Off</span>
            </div>
            <div class="stat-card-value" id="kpiReviewTasks">—</div>
            <div class="stat-card-footer">Pending Lead / Manager Review</div>
          </div>

          <div class="stat-card border-emerald">
            <div class="stat-card-header">
              <span class="stat-card-label">Active Studio Specialists</span>
              <span class="badge badge-emerald">5 Depts</span>
            </div>
            <div class="stat-card-value" id="kpiEmployees">—</div>
            <div class="stat-card-footer">Full-time Creative Staff</div>
          </div>
        </div>

        <!-- Charts Grid (Chart.js) -->
        <div class="dashboard-charts-grid">
          <!-- Main Chart: Department Task Distribution -->
          <div class="card chart-card">
            <div class="card-header">
              <div>
                <div class="card-title">Production Workload by Department</div>
                <div class="card-subtitle">Current task allocation across the 5 studio creative hubs</div>
              </div>
            </div>
            <div class="card-body">
              <div class="chart-wrapper">
                <canvas id="deptWorkloadChart"></canvas>
              </div>
            </div>
          </div>

          <!-- Secondary Chart: Task Completion Velocity -->
          <div class="card chart-card">
            <div class="card-header">
              <div>
                <div class="card-title">Task Status Breakdown</div>
                <div class="card-subtitle">Active lifecycle pipeline</div>
              </div>
            </div>
            <div class="card-body">
              <div class="chart-wrapper">
                <canvas id="statusDonutChart"></canvas>
              </div>
            </div>
          </div>
        </div>

        <!-- Bottom Grid: Recent High Priority Tasks & Quick Hand-offs -->
        <div class="dashboard-charts-grid">
          <!-- Recent Deliverables -->
          <div class="card">
            <div class="card-header">
              <div class="card-title">Recent Urgent Deliverables</div>
              <a href="#tasks" class="btn btn-ghost btn-sm">View All →</a>
            </div>
            <div class="card-body" style="padding: 0;">
              <div class="table-responsive" style="border: none; border-radius: 0;">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Task Deliverable</th>
                      <th>Assigned To</th>
                      <th>Stage</th>
                      <th>Due Date</th>
                    </tr>
                  </thead>
                  <tbody id="recentTasksTableBody">
                    <tr>
                      <td colspan="4" style="text-align: center; color: var(--text-dim); padding: var(--space-6);">Loading recent deliverables...</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <!-- Quick Agency Standup Announcements -->
          <div class="card">
            <div class="card-header">
              <div class="card-title">Studio Handoff Notice</div>
              <span class="badge badge-emerald">Active Policy</span>
            </div>
            <div class="card-body" style="display: flex; flex-direction: column; gap: var(--space-3);">
              <div class="glass-panel" style="padding: var(--space-3-5); background: var(--studio-950);">
                <div class="text-xs font-bold text-white mb-1">Strict Department Task Privacy</div>
                <p class="text-2xs text-muted" style="line-height: 1.4;">
                  Role-Based Isolation is active. Each creative employee focuses strictly on their assigned deliverables. Use <strong>Role Chat</strong> to dispatch handoffs across departments.
                </p>
              </div>

              <div class="glass-panel" style="padding: var(--space-3-5); background: var(--studio-950);">
                <div class="text-xs font-bold text-white mb-1">Deliverable Review Gateway</div>
                <p class="text-2xs text-muted" style="line-height: 1.4;">
                  Completed creative assets must be submitted to <strong>Creative Review</strong> before client sign-off.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    await this.loadDashboardData();
    // live updates for everyone; the refresh is coalesced and re-reads only what the changed tables can affect
    Realtime.watch(['tasks', 'departments'], (changed) => this.loadDashboardData(changed));
  }

  /**
   * @param {Set<string>} [changed] tables that changed since the last refresh; '*' or nothing = refresh everything.
   * Task counts come from ONE database call (task_stats(): grouped counts that Row Level Security scopes to this user)
   * instead of a read of every task plus one count request per status.
   */
  async loadDashboardData(changed) {
    const supabase = getSupabase();
    if (!supabase) return;
    const all = !changed || changed.has('*') || !this.dashLoaded;
    const tasksChanged = all || changed.has('tasks');
    const deptsChanged = all || changed.has('departments');

    try {
      const countOf = async (table, apply) => {
        const { count, error } = await apply(supabase.from(table).select('id', { count: 'exact', head: true }));
        if (error) throw error;
        return count ?? 0;
      };
      const [recent, stats, projectCount, empCount, depts] = await Promise.all([
        tasksChanged
          ? supabase.from('tasks')
              .select('*, profiles!tasks_assigned_to_fkey(full_name, department_id, departments!profiles_department_id_fkey(name))')
              .order('created_at', { ascending: false }).limit(20)
          : null,
        tasksChanged ? supabase.rpc('task_stats') : null,
        all ? countOf('projects', q => q.eq('status', 'active')) : null,       // not affected by task / department changes
        all ? countOf('profiles', q => q.eq('employment_status', 'active')) : null,
        deptsChanged ? supabase.from('departments').select('id, name').order('name', { ascending: true }) : null
      ]);
      if (recent?.error) throw recent.error;
      if (stats?.error) throw stats.error;
      if (stats) this.stats = stats.data || [];
      if (depts?.data) this.deptList = depts.data;
      if (projectCount !== null) this.projectCount = projectCount;
      if (empCount !== null) this.empCount = empCount;
      this.dashLoaded = true;

      const n = (dim, key) => (this.stats || []).find(r => r.dimension === dim && r.key === key)?.n ?? 0;
      const inProgress = n('status', 'in_progress');
      const underReview = n('status', 'under_review');
      const completed = n('status', 'completed') + n('status', 'approved');

      // Update KPI DOM elements
      const kpiActiveTasks = document.getElementById('kpiActiveTasks');
      const kpiActiveTasksSub = document.getElementById('kpiActiveTasksSub');
      const kpiActiveProjects = document.getElementById('kpiActiveProjects');
      const kpiReviewTasks = document.getElementById('kpiReviewTasks');
      const kpiEmployees = document.getElementById('kpiEmployees');

      if (kpiActiveTasks) kpiActiveTasks.textContent = String(inProgress + underReview);
      if (kpiActiveTasksSub) kpiActiveTasksSub.textContent = `${inProgress} in progress • ${completed} completed`;
      if (kpiActiveProjects) kpiActiveProjects.textContent = String(this.projectCount ?? 0);
      if (kpiReviewTasks) kpiReviewTasks.textContent = String(underReview);
      if (kpiEmployees) kpiEmployees.textContent = String(this.empCount ?? 0);

      // Render Recent Tasks Table
      const tasks = recent?.data;
      const tbody = document.getElementById('recentTasksTableBody');
      if (recent && tbody) {
        if (!tasks || tasks.length === 0) {
          tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-dim); padding: var(--space-6);">No active tasks found. Create one to begin.</td></tr>`;
        } else {
          tbody.innerHTML = tasks.slice(0, 5).map(t => `
            <tr>
              <td>
                <div class="font-semibold text-white">${escapeHTML(t.title)}</div>
                <div class="text-2xs text-dim">${t.task_number}</div>
              </td>
              <td>
                <span class="text-xs text-muted">${escapeHTML(t.profiles?.full_name || 'Unassigned')}</span>
              </td>
              <td>${formatTaskStatusBadge(t.status)}</td>
              <td class="font-mono text-2xs text-muted">${formatDate(t.due_date)}</td>
            </tr>
          `).join('');
        }
      }

      // Chart data: every task this user may see (Row Level Security), counted by the database
      this.initCharts(this.stats || [], this.deptList || []);
    } catch (err) {
      console.warn('Dashboard fetch error:', err);
    }
  }

  destroyCharts() {
    Object.values(this.charts || {}).forEach(c => { try { c.destroy(); } catch { /* already gone */ } });
    this.charts = {};
  }

  dispose() { this.destroyCharts(); }

  initCharts(stats, departments) {
    if (!window.Chart) return;
    this.destroyCharts();   // a refresh redraws the charts: the old ones must be released first
    const by = (dim) => Object.fromEntries(stats.filter(r => r.dimension === dim).map(r => [r.key, r.n]));
    const statusN = by('status');
    const activeByDept = by('active_department');
    const sum = (...keys) => keys.reduce((a, k) => a + (statusN[k] || 0), 0);

    // Replace a chart with an honest message when there is nothing to plot
    const emptyState = (canvasId, message) => {
      const canvas = document.getElementById(canvasId);
      if (canvas?.parentElement) {
        canvas.parentElement.innerHTML = `<div class="empty-state" style="border:none; padding: 40px 0;"><div class="empty-state-desc">${message}</div></div>`;
      }
    };

    // 1. Active deliverables per department (real counts)
    const deptCtx = document.getElementById('deptWorkloadChart')?.getContext('2d');
    if (deptCtx) {
      const rows = departments
        .map(d => ({ name: d.name, count: activeByDept[d.id] || 0 }))
        .filter(r => r.count > 0);
      const unassigned = activeByDept[''] || 0;
      if (unassigned > 0) rows.push({ name: 'No department', count: unassigned });

      if (rows.length === 0) {
        emptyState('deptWorkloadChart', 'No active deliverables yet.');
      } else {
        const palette = ['226, 77, 71', '215, 159, 62', '251, 186, 72', '80, 185, 227', '152, 214, 234', '224, 27, 40', '18, 171, 227'];
        this.charts.dept = new window.Chart(deptCtx, {
          type: 'bar',
          data: {
            labels: rows.map(r => r.name),
            datasets: [{
              label: 'Active Deliverables',
              data: rows.map(r => r.count),
              backgroundColor: rows.map((_, i) => `rgba(${palette[i % palette.length]}, 0.72)`),
              borderColor: rows.map((_, i) => `rgb(${palette[i % palette.length]})`),
              borderWidth: 1,
              borderRadius: 6
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              y: { beginAtZero: true, ticks: { color: '#525b68', font: { size: 11 }, precision: 0 }, grid: { color: 'rgba(24, 48, 72, 0.08)' } },
              x: { ticks: { color: '#525b68', font: { size: 11 } }, grid: { display: false } }
            }
          }
        });
      }
    }

    // 2. Status donut (real counts)
    const statusCtx = document.getElementById('statusDonutChart')?.getContext('2d');
    if (statusCtx) {
      const counts = [
        sum('todo', 'backlog'),
        sum('in_progress', 'changes_requested'),
        sum('under_review'),
        sum('completed', 'approved')
      ];
      if (counts.every(c => c === 0)) {
        emptyState('statusDonutChart', 'No tasks yet.');
      } else {
        this.charts.status = new window.Chart(statusCtx, {
          type: 'doughnut',
          data: {
            labels: ['To Do', 'In Production', 'Under Review', 'Completed'],
            datasets: [{ data: counts, backgroundColor: ['#bccad6', '#12ABE3', '#FBBA48', '#22C58B'], borderWidth: 0 }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { color: '#38424f', font: { size: 11 } } } },
            cutout: '70%'
          }
        });
      }
    }
  }
}
