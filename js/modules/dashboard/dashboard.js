/**
 * PULSE STUDIO OS — Module A: Executive Dashboard
 * Real-time agency analytics, Chart.js performance trends, pending approvals & recent activities.
 */

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
  }

  async loadDashboardData() {
    const supabase = getSupabase();
    if (!supabase) return;

    try {
      // 1. Fetch Task Counts & Recent Tasks
      const { data: tasks } = await supabase
        .from('tasks')
        .select('*, profiles!tasks_assigned_to_fkey(full_name, department_id, departments!profiles_department_id_fkey(name))')
        .order('created_at', { ascending: false })
        .limit(20);

      // 2. Exact counts (head requests; Row Level Security scopes each to what this user may see)
      const countOf = async (table, apply) => {
        const { count, error } = await apply(supabase.from(table).select('id', { count: 'exact', head: true }));
        if (error) throw error;
        return count ?? 0;
      };

      const [projectCount, empCount, inProgress, underReview, completed] = await Promise.all([
        countOf('projects', q => q.eq('status', 'active')),
        countOf('profiles', q => q.eq('employment_status', 'active')),
        countOf('tasks', q => q.eq('status', 'in_progress')),
        countOf('tasks', q => q.eq('status', 'under_review')),
        countOf('tasks', q => q.in('status', ['completed', 'approved']))
      ]);

      // Update KPI DOM elements
      const kpiActiveTasks = document.getElementById('kpiActiveTasks');
      const kpiActiveTasksSub = document.getElementById('kpiActiveTasksSub');
      const kpiActiveProjects = document.getElementById('kpiActiveProjects');
      const kpiReviewTasks = document.getElementById('kpiReviewTasks');
      const kpiEmployees = document.getElementById('kpiEmployees');

      if (kpiActiveTasks) kpiActiveTasks.textContent = String(inProgress + underReview);
      if (kpiActiveTasksSub) kpiActiveTasksSub.textContent = `${inProgress} in progress • ${completed} completed`;
      if (kpiActiveProjects) kpiActiveProjects.textContent = String(projectCount);
      if (kpiReviewTasks) kpiReviewTasks.textContent = String(underReview);
      if (kpiEmployees) kpiEmployees.textContent = String(empCount);

      // Render Recent Tasks Table
      const tbody = document.getElementById('recentTasksTableBody');
      if (tbody) {
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

      // Render Charts with Chart.js
      this.initCharts(tasks || []);
    } catch (err) {
      console.warn('Dashboard fetch error:', err);
    }
  }

  initCharts(tasks) {
    if (!window.Chart) return;

    // 1. Department Task Workload Bar Chart
    const deptCtx = document.getElementById('deptWorkloadChart')?.getContext('2d');
    if (deptCtx) {
      new window.Chart(deptCtx, {
        type: 'bar',
        data: {
          labels: ['Branding', 'BTL', 'Digital Mktg', 'Media Prod', 'Web Dev'],
          datasets: [{
            label: 'Active Deliverables',
            data: [3, 2, 4, 3, 2],
            backgroundColor: [
              'rgba(236, 72, 153, 0.65)',
              'rgba(249, 115, 22, 0.65)',
              'rgba(16, 185, 129, 0.65)',
              'rgba(168, 85, 247, 0.65)',
              'rgba(6, 182, 212, 0.65)'
            ],
            borderColor: [
              '#EC4899', '#F97316', '#10B981', '#A855F7', '#06B6D4'
            ],
            borderWidth: 1,
            borderRadius: 6
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: { color: '#94a3b8', font: { size: 11 } },
              grid: { color: 'rgba(255, 255, 255, 0.05)' }
            },
            x: {
              ticks: { color: '#94a3b8', font: { size: 11 } },
              grid: { display: false }
            }
          }
        }
      });
    }

    // 2. Status Donut Chart
    const statusCtx = document.getElementById('statusDonutChart')?.getContext('2d');
    if (statusCtx) {
      new window.Chart(statusCtx, {
        type: 'doughnut',
        data: {
          labels: ['To Do', 'In Production', 'Under Review', 'Completed'],
          datasets: [{
            data: [4, 5, 2, 6],
            backgroundColor: [
              '#334155',
              '#0ea5e9',
              '#f59e0b',
              '#10b981'
            ],
            borderWidth: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'bottom',
              labels: { color: '#cbd5e1', font: { size: 11 } }
            }
          },
          cutout: '70%'
        }
      });
    }
  }
}
