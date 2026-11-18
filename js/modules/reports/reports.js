/**
 * KITE SYSTEM — Module M: Reports & Analytics
 * Company-wide deliverable analytics, department productivity indicators & CSV exports.
 */

import { Realtime } from '../../services/realtime-service.js';
import { getSupabase } from '../../supabase-client.js';
import { Toast } from '../../services/toast-service.js';
import { escapeHTML, formatDate } from '../../utils/helpers.js';
import { PAGE_SIZE, fetchPage, mountPager } from '../../ui/pagination.js';

// The CSV export reads the whole list in pages of this size (the database never answers more than this at once)
const EXPORT_CHUNK = 1000;
const EXPORT_MAX = 50000;

export class ReportsModule {
  constructor(app) {
    this.app = app;
    this.tasks = [];          // the page on screen
    this.page = 1;
    this.total = 0;
    this.stats = [];          // grouped counts from task_stats()
    this.charts = {};
  }

  dispose() { this.destroyCharts(); }

  destroyCharts() {
    Object.values(this.charts).forEach(c => { try { c.destroy(); } catch { /* already gone */ } });
    this.charts = {};
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
            <div id="reportsPager" style="padding: var(--space-3);"></div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('btnExportCsv')?.addEventListener('click', () => {
      this.exportToCsv();
    });

    await this.loadReportsData();
    Realtime.watch(['tasks'], () => this.loadReportsData()); // live updates for everyone (coalesced: one refresh per burst)
  }

  /** One page of deliverables for the table + grouped counts for the charts (both from the database, both scoped by RLS). */
  taskQuery(columns = 'id, task_number, title, priority, status, due_date, profiles!tasks_assigned_to_fkey(full_name)') {
    return getSupabase().from('tasks').select(columns, { count: 'exact' })
      .order('created_at', { ascending: false }).order('id', { ascending: true });
  }

  async loadReportsData() {
    const supabase = getSupabase();
    if (!supabase) return;
    try {
      const [res, stats] = await Promise.all([
        fetchPage(() => this.taskQuery(), this.page, PAGE_SIZE.table),
        supabase.rpc('task_stats')
      ]);
      if (res.error) throw res.error;
      this.tasks = res.rows;
      this.total = res.total;
      this.page = res.page;
      if (!stats.error) this.stats = stats.data || [];
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

    mountPager(document.getElementById('reportsPager'), {
      page: this.page, total: this.total, size: PAGE_SIZE.table, label: 'deliverables', top: tbody.closest('.card'),
      onPage: async (n) => { this.page = n; await this.loadReportsData(); }
    });
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

    const by = (dim) => Object.fromEntries(this.stats.filter(r => r.dimension === dim).map(r => [r.key, r.n]));
    const statusN = by('status'), prioN = by('priority');
    const statusData = [statusN.todo || 0, statusN.in_progress || 0, statusN.under_review || 0, (statusN.completed || 0) + (statusN.approved || 0)];
    const prioData = [prioN.urgent || 0, prioN.high || 0, prioN.medium || 0, prioN.low || 0];
    const refill = (key, data) => {
      const c = this.charts[key];
      if (!c) return false;
      c.data.datasets[0].data = data;
      c.update();
      return true;
    };
    // Status Chart
    const statusCtx = document.getElementById('reportStatusChart')?.getContext('2d');
    if (statusCtx && !refill('status', statusData)) {
      this.charts.status = new window.Chart(statusCtx, {
        type: 'pie',
        data: {
          labels: ['To Do', 'In Production', 'Review', 'Completed'],
          datasets: [{
            data: statusData,
            backgroundColor: ['#bccad6', '#12ABE3', '#FBBA48', '#22C58B'],
            borderWidth: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom', labels: { color: '#38424f' } }
          }
        }
      });
    }

    // Priority Chart
    const prioCtx = document.getElementById('reportPriorityChart')?.getContext('2d');
    if (prioCtx && !refill('priority', prioData)) {
      this.charts.priority = new window.Chart(prioCtx, {
        type: 'doughnut',
        data: {
          labels: ['Urgent', 'High', 'Medium', 'Low'],
          datasets: [{
            data: prioData,
            backgroundColor: ['#EB6F69', '#FBBA48', '#12ABE3', '#94a3b1'],
            borderWidth: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom', labels: { color: '#38424f' } }
          },
          cutout: '65%'
        }
      });
    }
  }

  /** Every deliverable this user may see, read in pages of EXPORT_CHUNK (never one unbounded request). */
  async fetchAllForExport() {
    const rows = [];
    for (let from = 0; from < EXPORT_MAX; from += EXPORT_CHUNK) {
      const { data, error } = await this.taskQuery('id, task_number, title, priority, status, due_date').range(from, from + EXPORT_CHUNK - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < EXPORT_CHUNK) return { rows, capped: false };
    }
    return { rows, capped: true };
  }

  async exportToCsv() {
    if (this.total === 0 && this.tasks.length === 0) {
      Toast.warning('No task data available to export', 'Notice');
      return;
    }
    let all;
    try { all = await this.fetchAllForExport(); }
    catch (err) { Toast.error(err.message || 'Export failed', 'Error'); return; }
    if (all.capped) Toast.warning(`The export holds the newest ${EXPORT_MAX} deliverables`, 'Notice');

    // Neutralize spreadsheet formula injection (=, +, -, @, tab, CR) and escape quotes.
    const cell = (value) => {
      let v = String(value ?? '');
      if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
      return `"${v.replace(/"/g, '""')}"`;
    };

    const headers = ['Task Number', 'Title', 'Priority', 'Status', 'Due Date'];
    const rows = all.rows.map(t => [t.task_number, t.title, t.priority, t.status, t.due_date || ''].map(cell));

    const csv = [headers.map(cell).join(','), ...rows.map(r => r.join(','))].join('\r\n');
    const blobUrl = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.setAttribute('href', blobUrl);
    link.setAttribute('download', `KITE_DELIVERABLES_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    document.body.removeChild(link);
    Toast.success('Export downloaded as CSV spreadsheet', 'Export Complete');
  }
}
