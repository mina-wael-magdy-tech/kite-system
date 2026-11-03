/**
 * KITE SYSTEM — Clients hub
 * One page that gathers every client. Opening a client shows everything about them in one place:
 * tasks, timeline, calendar, deliverables (milestones, content plans), the departments working on them, and files.
 *
 * A client's work is found through links that already exist: projects.client_id, campaigns.client_id,
 * content_plans.client_id, assets.client_id and client_departments. Tasks belong to a client through their
 * project or campaign, so no extra column is needed.
 */

import { getSupabase } from '../../supabase-client.js';
import { CONFIG } from '../../config.js';
import { Toast } from '../../services/toast-service.js';
import { Realtime } from '../../services/realtime-service.js';
import { formDialog } from '../../ui/dialogs.js';
import { escapeHTML, formatDate, formatCurrency, debounce } from '../../utils/helpers.js';

const DONE = new Set(['completed', 'approved']);
const CLOSED = new Set(['completed', 'approved', 'cancelled']);
const DAY = 86_400_000;

const STATUS = {
  backlog: ['Backlog', 'slate'], todo: ['To do', 'slate'], in_progress: ['In progress', 'indigo'],
  under_review: ['In review', 'amber'], changes_requested: ['Changes requested', 'rose'],
  approved: ['Approved', 'emerald'], completed: ['Completed', 'emerald'], cancelled: ['Cancelled', 'slate'], on_hold: ['On hold', 'slate']
};
const TONE_VAR = { slate: '#64748b', indigo: '#6366f1', amber: '#fbba48', rose: '#e01b28', emerald: '#10b981', blue: '#7bcbe3' };

const TABS = [
  ['overview', 'Overview', 'layout-dashboard'], ['tasks', 'Tasks', 'check-square'], ['timeline', 'Timeline', 'gantt-chart'],
  ['calendar', 'Calendar', 'calendar-days'], ['deliverables', 'Deliverables', 'package-check'], ['assets', 'Files', 'folder-open']
];

const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const day = (s) => (s ? new Date(String(s).slice(0, 10) + 'T00:00:00') : null);
const todayISO = () => iso(new Date());
const clientName = (c) => c?.company_name || c?.name || 'Client';
const badge = (label, tone = 'slate') => `<span class="badge badge-${tone}">${escapeHTML(label)}</span>`;
const sizeText = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const taskStatus = (t) => STATUS[t.status] || [t.status, 'slate'];

export class ClientHubModule {
  constructor(app) {
    this.app = app;
    this.supabase = getSupabase();
    this.root = null;
    this.clients = [];
    this.departments = [];
    this.stats = new Map();      // clientId -> { open, done, projects, late }
    this.fType = 'all';
    this.fDept = 'all';
    this.search = '';
    this.clientId = null;        // opened client
    this.tab = 'overview';
    this.data = null;            // everything about the opened client
    this.calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  }

  async render(container, query) {
    this.root = container;
    const params = new URLSearchParams(query || '');
    this.clientId = params.get('client');
    this.tab = TABS.some(t => t[0] === params.get('tab')) ? params.get('tab') : 'overview';
    if (this.clientId) await this.showClient();
    else await this.showHub();
  }

  // ====================================================================== HUB (all clients)

  async showHub() {
    this.root.innerHTML = `
      <div class="page-container animate-fade-in">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:var(--space-4);">
          <div>
            <h1 class="font-display font-bold text-xl text-white">Clients</h1>
            <p class="text-xs text-muted" style="margin-top:2px;">Open a client to see their tasks, timeline, calendar, deliverables, departments and files in one place.</p>
          </div>
          <a href="#crm" class="btn btn-secondary btn-sm"><i data-lucide="building"></i> Manage clients &amp; deals</a>
        </div>
        <div class="glass-panel" style="padding:var(--space-3);display:flex;flex-wrap:wrap;gap:var(--space-2-5);align-items:center;">
          <div style="position:relative;min-width:220px;flex:1;">
            <input id="chSearch" class="form-control" style="height:36px;padding-left:32px;" placeholder="Search clients…" value="${escapeHTML(this.search)}" />
            <i data-lucide="search" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);width:14px;height:14px;color:var(--text-dim);"></i>
          </div>
          <select id="chType" class="form-control" style="width:auto;height:36px;">
            <option value="all">All client types</option><option value="retainer">Regular (monthly)</option><option value="project">Project-based</option>
          </select>
          <select id="chDept" class="form-control" style="width:auto;height:36px;"><option value="all">All departments</option></select>
        </div>
        <div id="chGrid" class="ch-grid"><div class="empty-state" style="border:none;padding:40px 0;grid-column:1/-1;"><div class="empty-state-icon animate-spin">⟳</div><div class="empty-state-title">Loading clients…</div></div></div>
      </div>`;
    document.getElementById('chType').value = this.fType;
    document.getElementById('chSearch').addEventListener('input', debounce((e) => { this.search = e.target.value.trim().toLowerCase(); this.paintGrid(); }, 200));
    document.getElementById('chType').addEventListener('change', (e) => { this.fType = e.target.value; this.paintGrid(); });
    document.getElementById('chDept').addEventListener('change', (e) => { this.fDept = e.target.value; this.paintGrid(); });
    window.lucide?.createIcons();

    await this.loadHub();
    Realtime.watch(['clients', 'client_departments', 'projects', 'tasks', 'campaigns'], () => this.loadHub());
  }

  async loadHub() {
    const sb = this.supabase;
    const [cl, dp, pr, tk] = await Promise.all([
      sb.from('clients').select('*, client_departments(department_id)').order('company_name'),
      sb.from('departments').select('id, name, code').order('name'),
      sb.from('projects').select('id, client_id, status'),
      sb.from('tasks').select('id, status, due_date, project_id, campaign_id')
    ]);
    if (cl.error) { Toast.error(cl.error.message, 'Could not load clients'); return; }
    const camps = await sb.from('campaigns').select('id, client_id');
    this.clients = cl.data || [];
    this.departments = dp.data || [];

    const projClient = new Map((pr.data || []).map(p => [p.id, p.client_id]));
    const campClient = new Map((camps.data || []).map(c => [c.id, c.client_id]));
    const today = todayISO();
    this.stats = new Map();
    const stat = (id) => { if (!this.stats.has(id)) this.stats.set(id, { open: 0, done: 0, projects: 0, late: 0 }); return this.stats.get(id); };
    (pr.data || []).forEach(p => { if (p.client_id && !['completed', 'cancelled'].includes(p.status)) stat(p.client_id).projects++; });
    (tk.data || []).forEach(t => {
      const cid = projClient.get(t.project_id) || campClient.get(t.campaign_id);
      if (!cid) return;
      const s = stat(cid);
      if (DONE.has(t.status)) s.done++;
      else if (t.status !== 'cancelled') { s.open++; if (t.due_date && t.due_date.slice(0, 10) < today) s.late++; }
    });

    const sel = document.getElementById('chDept');
    if (sel) {
      sel.innerHTML = '<option value="all">All departments</option>' + this.departments.map(d => `<option value="${d.id}">${escapeHTML(d.name)}</option>`).join('');
      sel.value = this.fDept;
    }
    this.paintGrid();
  }

  paintGrid() {
    const grid = document.getElementById('chGrid');
    if (!grid) return;
    const deptName = new Map(this.departments.map(d => [d.id, d.name]));
    const list = this.clients.filter(c => {
      if (this.fType !== 'all' && c.client_type !== this.fType) return false;
      if (this.fDept !== 'all' && !(c.client_departments || []).some(x => x.department_id === this.fDept)) return false;
      if (this.search && !`${c.name || ''} ${c.company_name || ''} ${c.industry || ''}`.toLowerCase().includes(this.search)) return false;
      return true;
    });
    if (!list.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-state-icon">🏢</div>
        <div class="empty-state-title">${this.clients.length ? 'No clients match' : 'No clients yet'}</div>
        <div class="empty-state-desc">${this.clients.length ? 'Try another filter.' : 'Add your first client from the CRM page.'}</div></div>`;
      return;
    }
    grid.innerHTML = list.map(c => {
      const s = this.stats.get(c.id) || { open: 0, done: 0, projects: 0, late: 0 };
      const total = s.open + s.done;
      const pct = total ? Math.round((s.done / total) * 100) : 0;
      const regular = c.client_type === 'retainer';
      const depts = (c.client_departments || []).map(x => deptName.get(x.department_id)).filter(Boolean);
      return `<a href="#clients?client=${c.id}" class="card entity-card ch-card ${regular ? 'is-regular' : 'is-project'}">
        <div class="ch-card-top">
          <div class="ch-avatar">${escapeHTML(clientName(c).slice(0, 1).toUpperCase())}</div>
          <div style="min-width:0;flex:1;">
            <div class="card-title ch-ellipsis">${escapeHTML(clientName(c))}</div>
            <div class="card-subtitle ch-ellipsis">${escapeHTML(c.industry || c.name || '')}</div>
          </div>
          ${badge(regular ? 'Regular' : 'Project-based', regular ? 'emerald' : 'slate')}
        </div>
        <div class="ch-money">${regular && c.monthly_budget != null
          ? `<strong>${formatCurrency(c.monthly_budget)}</strong><span>per month</span>` : '<span>Budget set per project</span>'}</div>
        <div class="ch-depts">${depts.length ? depts.slice(0, 4).map(n => `<span class="ch-chip">${escapeHTML(n)}</span>`).join('') + (depts.length > 4 ? `<span class="ch-chip">+${depts.length - 4}</span>` : '') : '<span class="text-2xs text-dim">No departments yet</span>'}</div>
        <div>
          <div class="ch-row"><span>${s.open} open · ${s.done} done${s.late ? ` · <b class="ch-late">${s.late} late</b>` : ''}</span><span>${pct}%</span></div>
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="ch-foot"><span>${s.projects} active project${s.projects === 1 ? '' : 's'}</span><span class="ch-open">Open →</span></div>
      </a>`;
    }).join('');
  }

  // ====================================================================== ONE CLIENT

  async showClient() {
    this.root.innerHTML = `<div class="page-container animate-fade-in"><div class="empty-state" style="border:none;padding:60px 0;"><div class="empty-state-icon animate-spin">⟳</div><div class="empty-state-title">Loading client…</div></div></div>`;
    const ok = await this.loadClient();
    if (!ok) return;
    this.paintClient();
    const reload = debounce(async () => { if (await this.loadClient()) this.paintTab(); }, 400);
    Realtime.watch(['clients', 'client_departments', 'projects', 'milestones', 'tasks', 'campaigns', 'content_plans', 'content_posts', 'assets', 'task_attachments'], reload);
  }

  async loadClient() {
    const sb = this.supabase, id = this.clientId;
    const { data: client, error } = await sb.from('clients').select('*, client_departments(department_id)').eq('id', id).maybeSingle();
    if (error || !client) {
      this.root.innerHTML = `<div class="page-container"><div class="empty-state"><div class="empty-state-icon">🏢</div>
        <div class="empty-state-title">Client not found</div><a href="#clients" class="btn btn-secondary btn-sm">Back to clients</a></div></div>`;
      return false;
    }
    const [dp, pr, cp, pl] = await Promise.all([
      sb.from('departments').select('id, name, code').order('name'),
      sb.from('projects').select('*, milestones(*), project_manager:profiles!projects_project_manager_id_fkey(full_name)').eq('client_id', id).order('created_at', { ascending: false }),
      sb.from('campaigns').select('id, name, status').eq('client_id', id),
      sb.from('content_plans').select('id, title, status, accent, created_at').eq('client_id', id).order('created_at', { ascending: false })
    ]);
    const projects = pr.data || [], campaigns = cp.data || [], plans = pl.data || [];
    const pIds = projects.map(p => p.id), cIds = campaigns.map(c => c.id), planIds = plans.map(p => p.id);

    // tasks reach a client through a project or a campaign
    const conds = [];
    if (pIds.length) conds.push(`project_id.in.(${pIds.join(',')})`);
    if (cIds.length) conds.push(`campaign_id.in.(${cIds.join(',')})`);
    const taskQ = conds.length
      ? sb.from('tasks').select(`id, task_number, title, status, priority, start_date, due_date, progress, project_id, campaign_id, department_id, created_at,
          assignee:profiles!tasks_assigned_to_fkey(id, full_name), departments!tasks_department_id_fkey(id, name)`).or(conds.join(',')).order('due_date', { ascending: true, nullsFirst: false })
      : Promise.resolve({ data: [] });
    const assetQ = sb.from('assets').select('*').or([`client_id.eq.${id}`, ...(pIds.length ? [`project_id.in.(${pIds.join(',')})`] : [])].join(',')).order('created_at', { ascending: false });
    const postQ = planIds.length ? sb.from('content_posts').select('id, plan_id, title, post_date, status, content_type').in('plan_id', planIds) : Promise.resolve({ data: [] });

    const [tk, as, po] = await Promise.all([taskQ, assetQ, postQ]);
    const tasks = tk.data || [];
    let attachments = [];
    if (tasks.length) {
      const { data } = await sb.from('task_attachments').select('id, task_id, file_name, file_size, storage_path, created_at').in('task_id', tasks.map(t => t.id)).order('created_at', { ascending: false });
      attachments = data || [];
    }
    this.departments = dp.data || [];
    this.data = { client, projects, campaigns, plans, posts: po.data || [], tasks, assets: as.data || [], attachments };
    return true;
  }

  paintClient() {
    const { client: c } = this.data;
    const regular = c.client_type === 'retainer';
    this.root.innerHTML = `
      <div class="page-container animate-fade-in">
        <a href="#clients" class="ch-back"><i data-lucide="arrow-left"></i> All clients</a>
        <div class="ch-head glass-panel">
          <div class="ch-avatar ch-avatar-lg">${escapeHTML(clientName(c).slice(0, 1).toUpperCase())}</div>
          <div style="flex:1;min-width:200px;">
            <h1 class="font-display font-bold text-xl text-white">${escapeHTML(clientName(c))}</h1>
            <div class="ch-meta">
              ${badge(regular ? 'Regular client' : 'Project-based', regular ? 'emerald' : 'slate')}
              ${regular && c.monthly_budget != null ? `<span><b>${formatCurrency(c.monthly_budget)}</b> / month</span>` : ''}
              ${c.industry ? `<span>${escapeHTML(c.industry)}</span>` : ''}
              ${c.email ? `<span>${escapeHTML(c.email)}</span>` : ''}
              ${c.phone ? `<span dir="ltr">${escapeHTML(c.phone)}</span>` : ''}
            </div>
          </div>
          <div class="ch-actions">
            <button type="button" class="btn btn-primary btn-sm" id="chNewProject"><i data-lucide="folder-plus"></i> New project</button>
            <a class="btn btn-secondary btn-sm" href="#campaigns"><i data-lucide="sparkles"></i> Content plans</a>
          </div>
        </div>
        <div class="ch-tabs" role="tablist">${TABS.map(([k, label, icon]) =>
          `<button type="button" role="tab" class="ch-tab${k === this.tab ? ' active' : ''}" data-tab="${k}"><i data-lucide="${icon}"></i><span>${label}</span></button>`).join('')}</div>
        <div id="chBody"></div>
      </div>`;
    this.root.querySelectorAll('.ch-tab').forEach(b => b.addEventListener('click', () => {
      this.tab = b.dataset.tab;
      history.replaceState(null, '', `#clients?client=${this.clientId}&tab=${this.tab}`);
      this.root.querySelectorAll('.ch-tab').forEach(x => x.classList.toggle('active', x === b));
      this.paintTab();
    }));
    document.getElementById('chNewProject').addEventListener('click', () => this.newProject());
    this.paintTab();
  }

  paintTab() {
    const body = document.getElementById('chBody');
    if (!body || !this.data) return;
    body.innerHTML = ({ overview: () => this.overviewHTML(), tasks: () => this.tasksHTML(), timeline: () => this.timelineHTML(),
      calendar: () => this.calendarHTML(), deliverables: () => this.deliverablesHTML(), assets: () => this.assetsHTML() })[this.tab]();
    this.bindTab(body);
    window.lucide?.createIcons();
  }

  // ---------------------------------------------------------------- Overview
  overviewHTML() {
    const { client: c, projects, tasks, plans, posts, assets, attachments } = this.data;
    const today = todayISO();
    const open = tasks.filter(t => !CLOSED.has(t.status));
    const late = open.filter(t => t.due_date && t.due_date.slice(0, 10) < today);
    const done = tasks.filter(t => DONE.has(t.status));
    const next = open.filter(t => t.due_date && t.due_date.slice(0, 10) >= today)[0];
    const kpi = (v, l, icon, tone) => `<div class="ch-kpi t-${tone}"><div class="ch-kpi-ic"><i data-lucide="${icon}"></i></div><div><strong>${v}</strong><span>${l}</span></div></div>`;

    const deptIds = new Set((c.client_departments || []).map(x => x.department_id));
    tasks.forEach(t => t.department_id && deptIds.add(t.department_id));
    const deptRows = this.departments.filter(d => deptIds.has(d.id)).map(d => {
      const mine = tasks.filter(t => t.department_id === d.id);
      const o = mine.filter(t => !CLOSED.has(t.status)).length, dn = mine.filter(t => DONE.has(t.status)).length;
      const people = [...new Set(mine.filter(t => !CLOSED.has(t.status)).map(t => t.assignee?.full_name).filter(Boolean))];
      const pct = mine.length ? Math.round((dn / mine.length) * 100) : 0;
      return `<div class="ch-dept"><div class="ch-row"><b>${escapeHTML(d.name)}</b><span>${o} open · ${dn} done</span></div>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="text-2xs text-dim" style="margin-top:4px;">${people.length ? 'Working: ' + people.map(escapeHTML).join(', ') : 'Nobody has open work here'}</div></div>`;
    }).join('');

    return `
      <div class="ch-kpis">
        ${kpi(open.length, 'Open tasks', 'list-checks', 'blue')}${kpi(late.length, 'Late', 'alarm-clock', late.length ? 'red' : 'green')}${kpi(done.length, 'Delivered', 'package-check', 'green')}
        ${kpi(projects.filter(p => !['completed', 'cancelled'].includes(p.status)).length, 'Active projects', 'folder-kanban', 'amber')}
        ${kpi(plans.length + ' / ' + posts.length, 'Plans / posts', 'sparkles', 'red')}${kpi(assets.length + attachments.length, 'Files', 'folder-open', 'blue')}
      </div>
      <div class="ch-cols">
        <section class="glass-panel ch-sec"><h3>Departments working on ${escapeHTML(clientName(c))}</h3>
          ${deptRows || '<p class="ch-empty">No departments are linked yet. Tag them from Manage clients &amp; deals, or assign a task from a department.</p>'}</section>
        <section class="glass-panel ch-sec"><h3>Next up</h3>
          ${next ? `<a class="ch-item" href="#tasks?q=${encodeURIComponent(next.task_number)}"><b>${escapeHTML(next.title)}</b><span>${escapeHTML(next.task_number)} · due ${formatDate(next.due_date)}</span></a>` : '<p class="ch-empty">No upcoming deadlines.</p>'}
          ${late.slice(0, 3).map(t => `<a class="ch-item ch-late" href="#tasks?q=${encodeURIComponent(t.task_number)}"><b>${escapeHTML(t.title)}</b><span>Late since ${formatDate(t.due_date)}</span></a>`).join('')}
        </section>
      </div>
      <section class="glass-panel ch-sec"><h3>Projects</h3>
        ${projects.length ? `<div class="ch-projects">${projects.map(p => this.projectCard(p)).join('')}</div>`
          : '<p class="ch-empty">No projects for this client yet. Use “New project” above.</p>'}</section>`;
  }

  projectCard(p) {
    const mine = this.data.tasks.filter(t => t.project_id === p.id);
    const done = mine.filter(t => DONE.has(t.status)).length;
    const pct = mine.length ? Math.round((done / mine.length) * 100) : (p.progress || 0);
    return `<div class="ch-project">
      <div class="ch-row"><b class="ch-ellipsis">${escapeHTML(p.name)}</b>${badge(String(p.status).replace('_', ' '), p.status === 'completed' ? 'emerald' : 'indigo')}</div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="ch-row text-2xs"><span>${done}/${mine.length} tasks · ${pct}%</span><span>${p.deadline ? 'Due ' + formatDate(p.deadline) : ''}</span></div>
      <div class="ch-row text-2xs"><span>${escapeHTML(p.code || '')}</span><span>Budget ${formatCurrency(p.budget || 0)}</span></div>
    </div>`;
  }

  // ---------------------------------------------------------------- Tasks
  tasksHTML() {
    const { tasks, projects } = this.data;
    if (!tasks.length) return `<div class="empty-state"><div class="empty-state-icon">✅</div><div class="empty-state-title">No tasks for this client yet</div>
      <div class="empty-state-desc">Create a project for the client, then add tasks to it from the Tasks page.</div><a class="btn btn-secondary btn-sm" href="#tasks">Open Tasks</a></div>`;
    const name = new Map(projects.map(p => [p.id, p.name]));
    const today = todayISO();
    return `<div class="glass-panel" style="padding:0;overflow:auto;"><table class="data-table ch-table"><thead><tr>
      <th>Task</th><th>Project</th><th>Department</th><th>Assignee</th><th>Status</th><th>Due</th></tr></thead><tbody>
      ${tasks.map(t => {
        const [label, tone] = taskStatus(t);
        const late = t.due_date && t.due_date.slice(0, 10) < today && !CLOSED.has(t.status);
        return `<tr data-open-task="${escapeHTML(t.task_number)}" class="ch-click">
          <td><b>${escapeHTML(t.title)}</b><div class="text-2xs text-dim">${escapeHTML(t.task_number)}</div></td>
          <td>${escapeHTML(name.get(t.project_id) || 'Campaign')}</td><td>${escapeHTML(t.departments?.name || '—')}</td>
          <td>${escapeHTML(t.assignee?.full_name || 'Unassigned')}</td><td>${badge(label, tone)}</td>
          <td style="${late ? 'color:#e01b28;font-weight:600' : ''}">${t.due_date ? formatDate(t.due_date) : '—'}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  // ---------------------------------------------------------------- Timeline
  timelineHTML() {
    const { tasks, projects } = this.data;
    const dated = tasks.filter(t => t.due_date);
    if (!dated.length && !projects.some(p => p.deadline)) {
      return '<div class="empty-state"><div class="empty-state-icon">📅</div><div class="empty-state-title">Nothing to plot yet</div><div class="empty-state-desc">Tasks with a deadline appear here as bars.</div></div>';
    }
    const barOf = (t) => {
      const end = day(t.due_date);
      let start = day(t.start_date) || day(t.created_at) || end;
      if (start > end) start = end;
      return { start, end };
    };
    const items = [];
    projects.forEach(p => {
      const mine = dated.filter(t => t.project_id === p.id);
      items.push({ head: p.name, deadline: p.deadline });
      mine.forEach(t => items.push({ t, ...barOf(t) }));
    });
    dated.filter(t => !projects.some(p => p.id === t.project_id)).forEach(t => items.push({ t, ...barOf(t) }));

    const stamps = items.flatMap(i => (i.t ? [i.start, i.end] : i.deadline ? [day(i.deadline)] : [])).concat([day(todayISO())]);
    const min = new Date(Math.min(...stamps) - 2 * DAY), max = new Date(Math.max(...stamps) + 3 * DAY);
    const span = Math.max(DAY, max - min);
    const pos = (d) => ((d - min) / span) * 100;
    const todayX = pos(day(todayISO()));

    // month ticks
    const ticks = [];
    for (let m = new Date(min.getFullYear(), min.getMonth() + 1, 1); m < max; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
      ticks.push(`<i class="ch-tick" style="left:${pos(m)}%"><em>${m.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}</em></i>`);
    }
    const rows = items.map(i => {
      if (!i.t) {
        return `<div class="ch-tl-row ch-tl-head"><div class="ch-tl-label">${escapeHTML(i.head)}</div><div class="ch-tl-track">${
          i.deadline ? `<i class="ch-flag" style="left:${pos(day(i.deadline))}%" title="Project deadline ${formatDate(i.deadline)}"></i>` : ''}</div></div>`;
      }
      const [label, tone] = taskStatus(i.t);
      const left = pos(i.start), width = Math.max(1.2, pos(i.end) - left + (DAY / span) * 100);
      return `<div class="ch-tl-row ch-click" data-open-task="${escapeHTML(i.t.task_number)}">
        <div class="ch-tl-label" title="${escapeHTML(i.t.title)}">${escapeHTML(i.t.title)}</div>
        <div class="ch-tl-track"><span class="ch-bar" style="left:${left}%;width:${width}%;background:${TONE_VAR[tone] || TONE_VAR.slate}" title="${escapeHTML(label)} · ${formatDate(i.t.due_date)}">
          <u style="width:${DONE.has(i.t.status) ? 100 : i.t.progress || 0}%"></u></span></div></div>`;
    }).join('');
    return `<div class="glass-panel ch-tl"><div class="ch-tl-scroll"><div class="ch-tl-inner">
      <div class="ch-tl-row ch-tl-axis"><div class="ch-tl-label"></div><div class="ch-tl-track">${ticks.join('')}</div></div>
      <div class="ch-tl-body">${rows}<i class="ch-today" style="left:calc(var(--lbl) + (100% - var(--lbl)) * ${todayX / 100})" title="Today"></i></div>
    </div></div></div>
    <p class="text-2xs text-dim" style="margin-top:6px;">Each bar runs from the task’s start to its deadline; the darker part is its progress. The red line is today.</p>`;
  }

  // ---------------------------------------------------------------- Calendar
  calendarHTML() {
    const { tasks, projects, posts, plans } = this.data;
    const y = this.calMonth.getFullYear(), m = this.calMonth.getMonth();
    const first = new Date(y, m, 1), startOffset = (first.getDay() + 6) % 7; // week starts Monday
    const gridStart = new Date(y, m, 1 - startOffset);
    const byDay = new Map();
    const add = (date, item) => { if (!date) return; const k = String(date).slice(0, 10); (byDay.get(k) || byDay.set(k, []).get(k)).push(item); };
    tasks.forEach(t => add(t.due_date, { kind: 'task', label: t.title, tone: DONE.has(t.status) ? 'emerald' : (t.due_date.slice(0, 10) < todayISO() && !CLOSED.has(t.status) ? 'rose' : 'indigo'), href: `#tasks?q=${encodeURIComponent(t.task_number)}` }));
    posts.forEach(p => add(p.post_date, { kind: 'post', label: p.title, tone: p.status === 'published' ? 'emerald' : 'blue', href: `#campaigns?plan=${p.plan_id}&post=${p.id}` }));
    projects.forEach(p => {
      add(p.deadline, { kind: 'project', label: `🏁 ${p.name}`, tone: 'amber', href: null });
      (p.milestones || []).forEach(ms => add(ms.due_date, { kind: 'milestone', label: `◆ ${ms.title}`, tone: ms.status === 'completed' ? 'emerald' : 'amber', href: null }));
    });
    const today = todayISO();
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i), k = iso(d), list = byDay.get(k) || [];
      cells += `<div class="ch-cell${d.getMonth() !== m ? ' ch-out' : ''}${k === today ? ' ch-today-cell' : ''}"><span class="ch-dn">${d.getDate()}</span>
        ${list.slice(0, 3).map(it => it.href ? `<a href="${it.href}" class="ch-ev" style="--c:${TONE_VAR[it.tone]}" title="${escapeHTML(it.label)}">${escapeHTML(it.label)}</a>`
          : `<span class="ch-ev" style="--c:${TONE_VAR[it.tone]}" title="${escapeHTML(it.label)}">${escapeHTML(it.label)}</span>`).join('')}
        ${list.length > 3 ? `<span class="text-2xs text-dim">+${list.length - 3} more</span>` : ''}</div>`;
    }
    return `<div class="glass-panel ch-cal-card">
      <div class="ch-row" style="margin-bottom:var(--space-3);">
        <div style="display:flex;gap:6px;"><button type="button" class="btn btn-secondary btn-sm" id="chPrev" aria-label="Previous month">‹</button>
          <button type="button" class="btn btn-secondary btn-sm" id="chNow">Today</button>
          <button type="button" class="btn btn-secondary btn-sm" id="chNext" aria-label="Next month">›</button></div>
        <b class="text-white">${first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</b>
        <span class="text-2xs text-dim">${plans.length ? 'Tasks · posts · milestones' : 'Tasks · milestones'}</span></div>
      <div class="ch-cal"><div class="ch-dow">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<span>${d}</span>`).join('')}</div>
      <div class="ch-days">${cells}</div></div></div>`;
  }

  // ---------------------------------------------------------------- Deliverables
  deliverablesHTML() {
    const { projects, plans, posts, tasks } = this.data;
    const ms = projects.flatMap(p => (p.milestones || []).map(x => ({ ...x, project: p.name })));
    const delivered = tasks.filter(t => DONE.has(t.status));
    const planStatus = { draft: ['Draft', 'slate'], in_review: ['With client', 'amber'], changes_requested: ['Client wants edits', 'rose'], approved: ['Approved', 'emerald'] };
    return `
      <section class="glass-panel ch-sec"><h3>Milestones</h3>${ms.length ? ms.sort((a, b) => String(a.due_date || '9').localeCompare(String(b.due_date || '9'))).map(x =>
        `<div class="ch-item"><div class="ch-row"><b>${escapeHTML(x.title)}</b>${badge(String(x.status).replace('_', ' '), x.status === 'completed' ? 'emerald' : x.status === 'in_progress' ? 'indigo' : 'slate')}</div>
          <span>${escapeHTML(x.project)}${x.due_date ? ' · due ' + formatDate(x.due_date) : ''}</span></div>`).join('') : '<p class="ch-empty">No milestones set on this client’s projects.</p>'}</section>
      <section class="glass-panel ch-sec"><h3>Content plans for the client</h3>${plans.length ? plans.map(pl => {
        const mine = posts.filter(p => p.plan_id === pl.id), pub = mine.filter(p => p.status === 'published').length;
        const [label, tone] = planStatus[pl.status] || [pl.status, 'slate'];
        return `<a class="ch-item" href="#campaigns?plan=${pl.id}"><div class="ch-row"><b>${escapeHTML(pl.title)}</b>${badge(label, tone)}</div><span>${pub}/${mine.length} posts published</span></a>`;
      }).join('') : '<p class="ch-empty">No content plans yet. Create one from Studio Campaigns.</p>'}</section>
      <section class="glass-panel ch-sec"><h3>Delivered work (${delivered.length})</h3>${delivered.length ? delivered.slice(0, 40).map(t =>
        `<a class="ch-item" href="#tasks?q=${encodeURIComponent(t.task_number)}"><b>${escapeHTML(t.title)}</b><span>${escapeHTML(t.task_number)} · ${escapeHTML(t.assignee?.full_name || '')}${t.due_date ? ' · ' + formatDate(t.due_date) : ''}</span></a>`).join('')
        : '<p class="ch-empty">Completed and approved tasks will be listed here.</p>'}</section>`;
  }

  // ---------------------------------------------------------------- Files
  assetsHTML() {
    const { assets, attachments, tasks } = this.data;
    const taskName = new Map(tasks.map(t => [t.id, t.title]));
    const rows = [
      ...assets.map(a => ({ bucket: CONFIG.STORAGE_BUCKETS.STUDIO_ASSETS, path: a.storage_path, name: a.name || a.file_name, size: a.file_size, at: a.created_at, from: a.folder || 'Library' })),
      ...attachments.map(a => ({ bucket: CONFIG.STORAGE_BUCKETS.TASK_ATTACHMENTS, path: a.storage_path, name: a.file_name, size: a.file_size, at: a.created_at, from: 'Task: ' + (taskName.get(a.task_id) || '') }))
    ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    this._files = rows;
    return `<div class="ch-row" style="margin-bottom:var(--space-2);"><span class="text-xs text-muted">${rows.length} file${rows.length === 1 ? '' : 's'} — library uploads for this client and files attached to its tasks.</span>
      <label class="btn btn-primary btn-sm" style="cursor:pointer;"><i data-lucide="upload"></i> Upload files<input id="chUpload" type="file" multiple hidden /></label></div>
      ${rows.length ? `<div class="ch-files">${rows.map((f, i) => `<button type="button" class="ch-file" data-file="${i}">
        <i data-lucide="file"></i><span class="ch-ellipsis"><b>${escapeHTML(f.name)}</b><em>${escapeHTML(f.from)} · ${sizeText(f.size || 0)} · ${formatDate(f.at)}</em></span><i data-lucide="download"></i></button>`).join('')}</div>`
      : '<div class="empty-state"><div class="empty-state-icon">📂</div><div class="empty-state-title">No files yet</div><div class="empty-state-desc">Upload briefs, logos, contracts or finished work.</div></div>'}`;
  }

  // ---------------------------------------------------------------- shared wiring
  bindTab(body) {
    body.querySelectorAll('[data-open-task]').forEach(el => el.addEventListener('click', () => { location.hash = `#tasks?q=${encodeURIComponent(el.dataset.openTask)}`; }));
    body.querySelector('#chPrev')?.addEventListener('click', () => { this.calMonth = new Date(this.calMonth.getFullYear(), this.calMonth.getMonth() - 1, 1); this.paintTab(); });
    body.querySelector('#chNext')?.addEventListener('click', () => { this.calMonth = new Date(this.calMonth.getFullYear(), this.calMonth.getMonth() + 1, 1); this.paintTab(); });
    body.querySelector('#chNow')?.addEventListener('click', () => { const n = new Date(); this.calMonth = new Date(n.getFullYear(), n.getMonth(), 1); this.paintTab(); });
    body.querySelectorAll('[data-file]').forEach(b => b.addEventListener('click', () => this.download(this._files[Number(b.dataset.file)])));
    body.querySelector('#chUpload')?.addEventListener('change', (e) => this.upload([...e.target.files]).finally(() => { e.target.value = ''; }));
  }

  async download(f) {
    const { data, error } = await this.supabase.storage.from(f.bucket).createSignedUrl(f.path, 120, { download: f.name });
    if (error || !data?.signedUrl) { Toast.error(error?.message || 'Could not open the file', 'Download failed'); return; }
    window.open(data.signedUrl, '_blank', 'noopener');
  }

  async upload(files) {
    const me = this.app.currentUser.id, bucket = CONFIG.STORAGE_BUCKETS.STUDIO_ASSETS;
    let ok = 0;
    for (const file of files) {
      const path = `${me}/${crypto.randomUUID()}-${file.name.replace(/[^\w.\-]+/g, '_').slice(-120)}`;
      const up = await this.supabase.storage.from(bucket).upload(path, file, { upsert: false, contentType: file.type || 'application/octet-stream' });
      if (up.error) { Toast.error(`${file.name}: ${up.error.message}`, 'Upload failed'); continue; }
      const row = await this.supabase.from('assets').insert({
        name: file.name, file_name: file.name, file_size: file.size, file_type: file.type || 'FILE',
        storage_path: path, uploaded_by: me, client_id: this.clientId, folder: 'Clients', visibility: 'studio'
      });
      if (row.error) { await this.supabase.storage.from(bucket).remove([path]); Toast.error(`${file.name}: ${row.error.message}`, 'Upload failed'); continue; }
      ok++;
    }
    if (ok) { Toast.success(`${ok} file${ok === 1 ? '' : 's'} added`, 'Uploaded'); if (await this.loadClient()) this.paintTab(); }
  }

  newProject() {
    const c = this.data.client;
    const d = new Date(); d.setDate(d.getDate() + 30);
    formDialog({
      title: `New project for ${clientName(c)}`,
      subtitle: 'Tasks you add to this project will appear on this client’s page.',
      fields: [
        { name: 'name', label: 'Project name', required: true, maxlength: 160, placeholder: 'e.g. Summer menu launch' },
        { name: 'code', label: 'Code', required: true, half: true, maxlength: 20, placeholder: 'e.g. TAL-01' },
        { name: 'budget', label: 'Budget (EGP)', type: 'number', half: true, min: 0, value: 0 },
        { name: 'deadline', label: 'Deadline', type: 'date', required: true, value: iso(d) },
        { name: 'description', label: 'Scope', type: 'textarea', rows: 3 }
      ],
      onSubmit: async (v) => {
        const { error } = await this.supabase.from('projects').insert({
          name: v.name, code: String(v.code).toUpperCase(), budget: v.budget ?? 0, deadline: v.deadline, description: v.description,
          client_id: c.id, status: 'active', created_by: this.app.currentUser.id
        });
        if (error) throw new Error(error.code === '23505' ? 'That project code is already used.' : error.message);
        Toast.success('Project created', 'Added');
        if (await this.loadClient()) this.paintTab();
      }
    });
  }
}
