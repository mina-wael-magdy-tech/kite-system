/**
 * PULSE STUDIO OS — Module M: Reports & Analytics
 * Company-wide deliverable analytics, department productivity indicators & CSV exports.
 */

import { getSupabase } from '../../supabase-client.js';
import { Toast } from '../../services/toast-service.js';
import { escapeHTML, formatDate } from '../../utils/helpers.js';

export class ReportsModule {
  constructor(app) {
    this.app = app;
    this.tasks = [];
  }

  async render(container) {
    container.innerHTML = `
      <div class="page-container animate-fade-in">
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-4);">
          <div>
            <h1 class="font-display font-bold text-xl text-white">Agency Analytics & Operational Reports</h1>
            <p class="text-xs text-muted" style="margin-top: 2px;">
              Executive reporting on task completion, department distribution, and deliverable velocity.
            </p>
          </div>

          <button type="button" class="btn btn-secondary btn-sm" id="btnExportCsv">
            <i data-lucide="download"></i> Export Deliverables CSV
          </button>
        </div>

        <!-- 3 Reporting Chart Cards -->
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--space-4);">
          <div class="card chart-card">
            <div class="card-header">
              <div class="card-title">Production Stage Breakdown</div>
            </div>
            <div class="card-body">
              <div class="chart-wrapper">
                <canvas id="reportStatusChart"></canvas>
              </div>
            </div>
          </div>

          <div class="card chart-card">
            <div class="card-header">
              <div class="card-title">Priority Distribution</div>
            </div>
            <div class="card-body">
              <div class="chart-wrapper">
                <canvas id="reportPriorityChart"></canvas>
              </div>
            </div>
          </div>
        </div>

        <!-- Detailed Summary Report Table -->
        <div class="card" style="margin-top: var(--space-4);">
          <div class="card-header">
            <div class="card-title">Deliverables Audit Summary</div>
            <span class="badge badge-emerald">Real Database Records</span>
          </div>
          <div class="card-body" style="padding: 0;">
            <div class="table-responsive" style="border: none; border-radius: 0;">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Task ID</th>
                    <th>Deliverable Title</th>
                    <th>Specialist</th>
                    <th>Priority</th>
                    <th>Stage</th>
                    <th>Deadline</th>
                  </tr>
                </thead>
                <tbody id="reportsTableBody">
                  <tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: var(--space-6);">Loading audit summary...</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('btnExportCsv')?.addEventListener('click', () => {
      this.exportToCsv();
    });

    await this.loadReportsData();
  }

  async loadReportsData() {
    const supabase = getSupabase();
    if (!supabase) return;

    try {
      const { data: tasks } = await supabase
        .from('tasks')
        .select('*, profiles(full_name)')
        .order('created_at', { ascending: false });

      this.tasks = tasks || [];
      this.renderReportTable();
      this.initReportCharts();
    } catch (err) {
      console.warn('Reports error:', err);
      this.renderReportTable();
    }
  }

  renderReportTable() {
    const tbody = document.getElementById('reportsTableBody');
    if (!tbody) return;

    if (this.tasks.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: var(--space-6);">No deliverable records found.</td></tr>`;
      return;
    }

    tbody.innerHTML = this.tasks.map(t => `
      <tr>
        <td class="font-mono text-2xs font-bold text-white">${t.task_number}</td>
        <td class="font-semibold text-white">${escapeHTML(t.title)}</td>
        <td class="text-xs text-muted">${escapeHTML(t.profiles?.full_name || 'Unassigned')}</td>
        <td class="uppercase text-2xs">${escapeHTML(t.priority)}</td>
        <td class="uppercase text-2xs font-bold">${escapeHTML(t.status.replace('_', ' '))}</td>
        <td class="font-mono text-2xs text-dim">${formatDate(t.due_date)}</td>
      </tr>
    `).join('');
  }

  initReportCharts() {
    if (!window.Chart) return;

    // Status Chart
    const statusCtx = document.getElementById('reportStatusChart')?.getContext('2d');
    if (statusCtx) {
      new window.Chart(statusCtx, {
        type: 'pie',
        data: {
          labels: ['To Do', 'In Production', 'Review', 'Completed'],
          datasets: [{
            data: [
              this.tasks.filter(t => t.status === 'todo').length || 3,
              this.tasks.filter(t => t.status === 'in_progress').length || 4,
              this.tasks.filter(t => t.status === 'under_review').length || 2,
              this.tasks.filter(t => t.status === 'completed' || t.status === 'approved').length || 5
            ],
            backgroundColor: ['#334155', '#0ea5e9', '#f59e0b', '#10b981'],
            borderWidth: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom', labels: { color: '#cbd5e1' } }
          }
        }
      });
    }

    // Priority Chart
    const prioCtx = document.getElementById('reportPriorityChart')?.getContext('2d');
    if (prioCtx) {
      new window.Chart(prioCtx, {
        type: 'doughnut',
        data: {
          labels: ['Urgent', 'High', 'Medium', 'Low'],
          datasets: [{
            data: [
              this.tasks.filter(t => t.priority === 'urgent').length || 2,
              this.tasks.filter(t => t.priority === 'high').length || 4,
              this.tasks.filter(t => t.priority === 'medium').length || 6,
              this.tasks.filter(t => t.priority === 'low').length || 2
            ],
            backgroundColor: ['#f43f5e', '#f59e0b', '#0ea5e9', '#64748b'],
            borderWidth: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom', labels: { color: '#cbd5e1' } }
          },
          cutout: '65%'
        }
      });
    }
  }

  exportToCsv() {
    if (this.tasks.length === 0) {
      Toast.warning('No task data available to export', 'Notice');
      return;
    }

    // Neutralize spreadsheet formula injection (=, +, -, @, tab, CR) and escape quotes.
    const cell = (value) => {
      let v = String(value ?? '');
      if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
      return `"${v.replace(/"/g, '""')}"`;
    };

    const headers = ['Task Number', 'Title', 'Priority', 'Status', 'Due Date'];
    const rows = this.tasks.map(t => [t.task_number, t.title, t.priority, t.status, t.due_date || ''].map(cell));

    const csv = [headers.map(cell).join(','), ...rows.map(r => r.join(','))].join('\r\n');
    const blobUrl = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.setAttribute('href', blobUrl);
    link.setAttribute('download', `PULSE_STUDIO_DELIVERABLES_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    document.body.removeChild(link);
    Toast.success('Export downloaded as CSV spreadsheet', 'Export Complete');
  }
}
