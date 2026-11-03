/**
 * KITE SYSTEM — Calendar & Timeline
 *
 * Real data only (Row Level Security decides what each person sees):
 *   tasks (due dates), project deadlines, milestones, campaign launches,
 *   approved leave, holidays.
 * Views: Month · Agenda · Timeline (Gantt-style).
 * Actions: drag a task to another day to reschedule it; click a day to create a task.
 */

import { Realtime } from '../../services/realtime-service.js';
import { getSupabase } from '../../supabase-client.js';
import { Permissions } from '../../permissions/permission-service.js';
import { Toast } from '../../services/toast-service.js';
import { Api } from '../../services/api.js';
import { escapeHTML } from '../../utils/helpers.js';
import { formDialog, htmlDialog, closeDialog } from '../../ui/dialogs.js';

// Studio calendar conventions (Egypt): week starts Sunday, weekend is Friday + Saturday.
const WEEK_START = 0;
const WEEKENDS = [5, 6];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DONE = ['completed', 'approved', 'cancelled'];

// ---------------------------------------------------------------- date helpers (local dates, no timezone drift)
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
const monthName = (d) => d.toLocaleString('en', { month: 'long', year: 'numeric' });
const prettyDate = (s) => parse(s).toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

const KIND = {
  task:      { label: 'Tasks',      tone: 'blue'  },
  project:   { label: 'Projects',   tone: 'red'   },
  campaign:  { label: 'Campaigns',  tone: 'amber' },
  post:      { label: 'Posts',      tone: 'blue'  },
  leave:     { label: 'Leave',      tone: 'green' },
  holiday:   { label: 'Holidays',   tone: 'gray'  }
};

export class CalendarModule {
  constructor(app) {
    this.app = app;
    this.view = window.innerWidth < 760 ? 'agenda' : 'month';
    this.cursor = new Date(); this.cursor.setDate(1);
    this.kinds = new Set(Object.keys(KIND));
    this.mineOnly = false;
    this.events = [];        // normalized single-day + range events
    this.people = [];
    this.projects = [];
    // timeline window
    this.tlStart = addDays(new Date(), -7);
    this.tlDays = 42;
  }

  // ================================================================ render shell
  async render(container) {
    container.innerHTML = `
      <div class="page-container animate-fade-in">
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-4);">
          <div>
            <h1 class="font-display font-bold text-xl text-white">Calendar &amp; Timeline</h1>
            <p class="text-xs text-muted" style="margin-top: 2px;">Deadlines, launches, leave and holidays in one place. Drag a task to another day to reschedule it.</p>
          </div>
          <button type="button" class="btn btn-primary" id="calNewTask"><i data-lucide="plus"></i> New task</button>
        </div>

        <div class="glass-panel cal-toolbar">
          <div class="cal-nav">
            <button type="button" class="btn btn-secondary btn-sm" id="calPrev" aria-label="Previous"><i data-lucide="chevron-left"></i></button>
            <button type="button" class="btn btn-secondary btn-sm" id="calToday">Today</button>
            <button type="button" class="btn btn-secondary btn-sm" id="calNext" aria-label="Next"><i data-lucide="chevron-right"></i></button>
            <h2 class="cal-title font-display" id="calTitle"></h2>
          </div>
          <div class="cal-views" role="tablist">
            <button type="button" class="btn btn-ghost btn-sm" data-view="month"><i data-lucide="calendar"></i> Month</button>
            <button type="button" class="btn btn-ghost btn-sm" data-view="agenda"><i data-lucide="list"></i> Agenda</button>
            <button type="button" class="btn btn-ghost btn-sm" data-view="timeline"><i data-lucide="gantt-chart"></i> Timeline</button>
          </div>
        </div>

        <div class="cal-filters" id="calFilters"></div>
        <div id="calBody"><div class="empty-state" style="border:none; padding: 40px 0;"><div class="empty-state-icon animate-spin">⟳</div><div class="empty-state-title">Loading calendar...</div></div></div>
      </div>
    `;

    document.getElementById('calPrev').addEventListener('click', () => this.step(-1));
    document.getElementById('calNext').addEventListener('click', () => this.step(1));
    document.getElementById('calToday').addEventListener('click', () => this.goToday());
    document.getElementById('calNewTask').addEventListener('click', () => this.openNewTask(ymd(new Date())));
    container.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { this.view = b.dataset.view; this.draw(); }));

    await this.load();
    this.draw();
    Realtime.watch(['tasks', 'milestones', 'leave_requests', 'campaigns', 'projects', 'content_posts'], async () => { await this.load(); this.draw(); });
  }

  // ================================================================ data
  async load() {
    const supabase = getSupabase();
    if (!supabase) return;
    try {
      const [tasks, projects, campaigns, milestones, leave, holidays, people, posts] = await Promise.all([
        supabase.from('tasks')
          .select('id, task_number, title, status, priority, start_date, due_date, assigned_to, created_by, project_id, profiles!tasks_assigned_to_fkey(full_name)')
          .not('due_date', 'is', null).limit(3000),
        supabase.from('projects').select('id, code, name, status, start_date, deadline').limit(1000),
        supabase.from('campaigns').select('id, name, status, start_date, end_date').limit(1000),
        supabase.from('milestones').select('id, title, due_date, status, projects(name, code)').not('due_date', 'is', null).limit(2000),
        supabase.from('leave_requests')
          .select('id, start_date, end_date, status, user_id, profiles!leave_requests_user_id_fkey(full_name), leave_types(name)')
          .eq('status', 'approved').limit(2000),
        supabase.from('holidays').select('id, name, date, is_recurring').limit(500),
        supabase.from('profiles').select('id, full_name').eq('employment_status', 'active').order('full_name', { ascending: true }),
        // scheduled social posts from the content plans (feed calendars)
        supabase.from('content_posts')
          .select('id, plan_id, title, post_date, post_time, content_type, platform, status, publisher_id, content_plans(title, department_id)')
          .not('post_date', 'is', null).limit(3000)
      ]);
      this.people = people.data || [];
      this.projects = (projects.data || []);
      this.events = this.normalize({
        tasks: tasks.data || [], projects: projects.data || [], campaigns: campaigns.data || [],
        milestones: milestones.data || [], leave: leave.data || [], holidays: holidays.data || [], posts: posts.data || []
      });
    } catch (err) {
      console.error('Calendar load error:', err);
      Toast.error('Could not load the calendar', 'Load error');
    }
  }

  normalize({ tasks, projects, campaigns, milestones, leave, holidays, posts = [] }) {
    const out = [];
    const today = ymd(new Date());
    for (const t of tasks) {
      const overdue = t.due_date < today && !DONE.includes(t.status);
      out.push({
        key: `task:${t.id}`, kind: 'task', id: t.id, title: `${t.task_number} ${t.title}`, short: t.title,
        start: t.start_date || t.due_date, end: t.due_date, due: t.due_date,
        tone: DONE.includes(t.status) ? 'green' : overdue ? 'rose' : 'blue',
        status: t.status, priority: t.priority, overdue,
        who: t.profiles?.full_name || 'Unassigned', mine: t.assigned_to === this.app.currentUser.id,
        canEdit: Permissions.isAdmin() || Permissions.isManager() || t.created_by === this.app.currentUser.id || t.assigned_to === this.app.currentUser.id,
        route: '#tasks', raw: t
      });
    }
    for (const p of projects) {
      if (!p.deadline) continue;
      out.push({ key: `project:${p.id}`, kind: 'project', id: p.id, title: `${p.code} ${p.name}`, short: `Deadline: ${p.name}`,
        start: p.start_date || p.deadline, end: p.deadline, due: p.deadline, tone: 'red', status: p.status, route: '#projects', raw: p });
    }
    for (const m of milestones) {
      out.push({ key: `milestone:${m.id}`, kind: 'project', id: m.id, title: `Milestone: ${m.title}`, short: `Milestone: ${m.title}`,
        start: m.due_date, end: m.due_date, due: m.due_date, tone: 'red', status: m.status, who: m.projects?.name, route: '#projects', raw: m, milestone: true });
    }
    for (const c of campaigns) {
      if (!c.end_date) continue;
      out.push({ key: `campaign:${c.id}`, kind: 'campaign', id: c.id, title: c.name, short: `Launch: ${c.name}`,
        start: c.start_date || c.end_date, end: c.end_date, due: c.end_date, tone: 'amber', status: c.status, route: '#campaigns', raw: c });
    }
    for (const c of posts) {
      const late = c.post_date < today && c.status !== 'published';
      const icon = { reel: '🎬', carousel: '🖼️', static: '📷', story: '⏳', video: '🎥' }[c.content_type] || '📌';
      out.push({
        key: `post:${c.id}`, kind: 'post', id: c.id, title: `${c.content_plans?.title || 'Content'}: ${c.title}`,
        short: `${icon} ${c.title}`, start: c.post_date, end: c.post_date, due: c.post_date,
        tone: c.status === 'published' ? 'green' : late ? 'rose' : 'blue', status: c.status, overdue: late,
        who: c.platform || c.content_type, mine: c.publisher_id === this.app.currentUser.id,
        canEdit: Permissions.isAdmin() || Permissions.isManager() || (c.content_plans?.department_id && Permissions.departments.some(d => d.id === c.content_plans.department_id)),
        route: `#campaigns?plan=${c.plan_id}`, raw: c
      });
    }
    for (const l of leave) {
      out.push({ key: `leave:${l.id}`, kind: 'leave', id: l.id, title: `${l.profiles?.full_name || 'Team member'}: ${l.leave_types?.name || 'Leave'}`,
        short: `${l.profiles?.full_name || 'Team member'} off`, start: l.start_date, end: l.end_date, tone: 'green', spans: true,
        mine: l.user_id === this.app.currentUser.id, route: '#hr', raw: l });
    }
    const years = new Set([this.cursor.getFullYear() - 1, this.cursor.getFullYear(), this.cursor.getFullYear() + 1]);
    for (const h of holidays) {
      const base = String(h.date).slice(0, 10);
      const dates = h.is_recurring ? [...years].map(y => `${y}-${base.slice(5)}`) : [base];
      for (const d of dates) out.push({ key: `holiday:${h.id}:${d}`, kind: 'holiday', id: h.id, title: h.name, short: h.name, start: d, end: d, due: d, tone: 'gray', route: '#hr', raw: h });
    }
    return out;
  }

  visible() {
    return this.events.filter(e => this.kinds.has(e.kind) && (!this.mineOnly || e.kind === 'holiday' || e.mine || e.kind === 'project' || e.kind === 'campaign'));
  }

  /** Map of YYYY-MM-DD -> events shown on that day (single-day items on their date; leave on every day). */
  byDay(from, to) {
    const map = new Map();
    const push = (d, e) => { if (d >= from && d <= to) { if (!map.has(d)) map.set(d, []); map.get(d).push(e); } };
    for (const e of this.visible()) {
      if (e.spans) {
        let d = parse(e.start); const end = parse(e.end);
        for (let i = 0; i < 90 && d <= end; i++, d = addDays(d, 1)) push(ymd(d), e);
      } else {
        push(e.due || e.end, e);
      }
    }
    const order = { holiday: 0, project: 1, campaign: 2, task: 3, leave: 4 };
    for (const list of map.values()) list.sort((a, b) => (order[a.kind] - order[b.kind]) || String(a.title).localeCompare(b.title));
    return map;
  }

  // ================================================================ navigation
  step(dir) {
    if (this.view === 'timeline') this.tlStart = addDays(this.tlStart, dir * Math.round(this.tlDays / 2));
    else if (this.view === 'agenda') this.cursor = new Date(this.cursor.getFullYear(), this.cursor.getMonth() + dir, 1);
    else this.cursor = new Date(this.cursor.getFullYear(), this.cursor.getMonth() + dir, 1);
    this.draw();
  }

  goToday() {
    const t = new Date();
    this.cursor = new Date(t.getFullYear(), t.getMonth(), 1);
    this.tlStart = addDays(t, -7);
    this.draw();
  }

  // ================================================================ draw
  draw() {
    document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('btn-secondary', b.dataset.view === this.view));
    document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('btn-ghost', b.dataset.view !== this.view));

    const title = document.getElementById('calTitle');
    if (title) {
      title.textContent = this.view === 'timeline'
        ? `${prettyDate(ymd(this.tlStart)).replace(/^\w+, /, '')} – ${prettyDate(ymd(addDays(this.tlStart, this.tlDays - 1))).replace(/^\w+, /, '')}`
        : monthName(this.cursor);
    }

    this.drawFilters();
    const body = document.getElementById('calBody');
    if (!body) return;
    if (this.view === 'month') this.drawMonth(body);
    else if (this.view === 'agenda') this.drawAgenda(body);
    else this.drawTimeline(body);
    if (window.lucide) window.lucide.createIcons();
  }

  drawFilters() {
    const el = document.getElementById('calFilters');
    if (!el) return;
    el.innerHTML = Object.entries(KIND).map(([k, v]) => `
      <button type="button" class="cal-chip-filter tone-${v.tone} ${this.kinds.has(k) ? 'on' : ''}" data-kind="${k}">
        <span class="dot"></span>${v.label}
      </button>`).join('') + `
      <label class="cal-mine"><input type="checkbox" id="calMine" ${this.mineOnly ? 'checked' : ''} /> Only my tasks &amp; leave</label>`;
    el.querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.kind; this.kinds.has(k) ? this.kinds.delete(k) : this.kinds.add(k); this.draw();
    }));
    el.querySelector('#calMine')?.addEventListener('change', (e) => { this.mineOnly = e.target.checked; this.draw(); });
  }

  // ---------------------------------------------------------------- month view
  drawMonth(body) {
    const first = new Date(this.cursor.getFullYear(), this.cursor.getMonth(), 1);
    const offset = (first.getDay() - WEEK_START + 7) % 7;
    const gridStart = addDays(first, -offset);
    const gridEnd = addDays(gridStart, 41);
    const map = this.byDay(ymd(gridStart), ymd(gridEnd));
    const today = ymd(new Date());

    const heads = Array.from({ length: 7 }, (_, i) => WEEKDAYS[(WEEK_START + i) % 7]);
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const d = addDays(gridStart, i); const key = ymd(d);
      const list = map.get(key) || [];
      const other = d.getMonth() !== first.getMonth();
      const weekend = WEEKENDS.includes(d.getDay());
      const shown = list.slice(0, 3);
      cells += `
        <div class="cal-cell ${other ? 'other' : ''} ${weekend ? 'weekend' : ''} ${key === today ? 'today' : ''}" data-day="${key}">
          <div class="cal-cell-head">
            <span class="cal-daynum">${d.getDate()}</span>
            <button type="button" class="cal-add" data-add="${key}" title="New task on this day" aria-label="New task on ${key}">+</button>
          </div>
          <div class="cal-events">
            ${shown.map(e => this.chip(e)).join('')}
            ${list.length > 3 ? `<button type="button" class="cal-more" data-more="${key}">+${list.length - 3} more</button>` : ''}
          </div>
        </div>`;
    }

    body.innerHTML = `
      <div class="cal-grid-wrap">
        <div class="cal-grid-head">${heads.map(h => `<div>${h}</div>`).join('')}</div>
        <div class="cal-grid">${cells}</div>
      </div>`;
    this.bindMonth(body);
  }

  chip(e) {
    const draggable = (e.kind === 'task' || e.kind === 'post') && e.canEdit;
    return `<button type="button" class="cal-event tone-${e.tone} kind-${e.kind}" data-ev="${escapeHTML(e.key)}" ${draggable ? 'draggable="true"' : ''}
              title="${escapeHTML(e.title)}">${e.overdue ? '<i data-lucide="alert-circle"></i>' : ''}<span>${escapeHTML(e.short || e.title)}</span></button>`;
  }

  bindMonth(body) {
    const find = (key) => this.events.find(e => e.key === key);
    body.querySelectorAll('[data-ev]').forEach(b => b.addEventListener('click', (ev) => { ev.stopPropagation(); this.openEvent(find(b.dataset.ev)); }));
    body.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', (ev) => { ev.stopPropagation(); this.openNewTask(b.dataset.add); }));
    body.querySelectorAll('[data-more]').forEach(b => b.addEventListener('click', (ev) => { ev.stopPropagation(); this.openDay(b.dataset.more); }));
    body.querySelectorAll('.cal-cell').forEach(c => c.addEventListener('dblclick', () => this.openNewTask(c.dataset.day)));

    // drag a task onto another day = reschedule
    let dragKey = null;
    body.querySelectorAll('.cal-event[draggable="true"]').forEach(chip => {
      chip.addEventListener('dragstart', (e) => { dragKey = chip.dataset.ev; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragKey); chip.classList.add('dragging'); });
      chip.addEventListener('dragend', () => { chip.classList.remove('dragging'); body.querySelectorAll('.drag-over').forEach(x => x.classList.remove('drag-over')); dragKey = null; });
    });
    body.querySelectorAll('.cal-cell').forEach(cell => {
      cell.addEventListener('dragover', (e) => { if (!dragKey) return; e.preventDefault(); cell.classList.add('drag-over'); });
      cell.addEventListener('dragleave', (e) => { if (!cell.contains(e.relatedTarget)) cell.classList.remove('drag-over'); });
      cell.addEventListener('drop', async (e) => {
        e.preventDefault(); cell.classList.remove('drag-over');
        const key = dragKey || e.dataTransfer.getData('text/plain');
        if (key) await this.reschedule(key, cell.dataset.day);
      });
    });
  }

  async reschedule(key, day) {
    const ev = this.events.find(e => e.key === key);
    if (!ev || (ev.kind !== 'task' && ev.kind !== 'post') || ev.due === day) return;
    const prev = { due: ev.due, end: ev.end, start: ev.start, overdue: ev.overdue, tone: ev.tone };
    const today = ymd(new Date());
    // optimistic
    ev.due = ev.end = day; if (ev.start > day) ev.start = day;
    const isPost = ev.kind === 'post';
    ev.overdue = day < today && (isPost ? ev.status !== 'published' : !DONE.includes(ev.status));
    ev.tone = (isPost ? ev.status === 'published' : DONE.includes(ev.status)) ? 'green' : ev.overdue ? 'rose' : 'blue';
    this.draw();
    try {
      if (isPost) {
        const { error } = await getSupabase().from('content_posts').update({ post_date: day }).eq('id', ev.id);
        if (error) throw new Error(error.message);
        Api.contentPostChanged(ev.id).catch(() => {}); // tells the person who publishes it
      } else {
        await Api.updateTask(ev.id, { dueDate: day });
      }
      Toast.success(`Moved to ${prettyDate(day)}`, 'Rescheduled');
    } catch (err) {
      Object.assign(ev, { due: prev.due, end: prev.end, start: prev.start, overdue: prev.overdue, tone: prev.tone });
      this.draw();
      Toast.error(err.message || 'Could not reschedule this task', 'Reschedule refused');
    }
  }

  // ---------------------------------------------------------------- agenda view
  drawAgenda(body) {
    const from = ymd(new Date(this.cursor.getFullYear(), this.cursor.getMonth(), 1));
    const to = ymd(new Date(this.cursor.getFullYear(), this.cursor.getMonth() + 1, 0));
    const map = this.byDay(from, to);
    const today = ymd(new Date());

    const overdue = this.visible().filter(e => e.kind === 'task' && e.overdue).sort((a, b) => a.due.localeCompare(b.due));
    const days = [...map.keys()].sort();

    const row = (e) => `
      <button type="button" class="agenda-row tone-${e.tone}" data-ev="${escapeHTML(e.key)}">
        <span class="agenda-dot"></span>
        <span class="agenda-main"><strong>${escapeHTML(e.title)}</strong>
          <small>${KIND[e.kind].label.replace(/s$/, '')}${e.who ? ' · ' + escapeHTML(e.who) : ''}${e.priority ? ' · ' + escapeHTML(e.priority) : ''}${e.milestone ? '' : ''}</small></span>
        <span class="agenda-end">${e.overdue ? '<span class="badge badge-rose">Overdue</span>' : ''}</span>
      </button>`;

    let html = '';
    if (overdue.length) html += `<section class="agenda-day overdue"><h3>Overdue <span class="badge badge-rose">${overdue.length}</span></h3>${overdue.map(row).join('')}</section>`;
    for (const d of days) {
      html += `<section class="agenda-day ${d === today ? 'is-today' : ''}"><h3>${prettyDate(d)}${d === today ? ' <span class="badge badge-brand">Today</span>' : ''}</h3>${map.get(d).map(row).join('')}</section>`;
    }
    if (!html) html = `<div class="empty-state"><div class="empty-state-icon">📅</div><div class="empty-state-title">Nothing scheduled in ${monthName(this.cursor)}</div><div class="empty-state-desc">Tasks with deadlines, project dates, leave and holidays appear here.</div></div>`;

    body.innerHTML = `<div class="agenda">${html}</div>`;
    body.querySelectorAll('[data-ev]').forEach(b => b.addEventListener('click', () => this.openEvent(this.events.find(e => e.key === b.dataset.ev))));
  }

  // ---------------------------------------------------------------- timeline (Gantt)
  drawTimeline(body) {
    const start = ymd(this.tlStart);
    const endDate = addDays(this.tlStart, this.tlDays - 1);
    const end = ymd(endDate);
    const colW = this.tlDays <= 21 ? 56 : this.tlDays <= 45 ? 34 : 13;
    const width = this.tlDays * colW;
    const today = ymd(new Date());

    // zoom controls live above the chart
    const zoom = `
      <div class="tl-zoom">
        <span class="text-2xs text-dim">Zoom</span>
        ${[[14, '2 weeks'], [42, '6 weeks'], [120, 'Quarter']].map(([n, l]) => `<button type="button" class="btn btn-sm ${this.tlDays === n ? 'btn-secondary' : 'btn-ghost'}" data-zoom="${n}">${l}</button>`).join('')}
      </div>`;

    const inRange = (e) => e.end >= start && e.start <= end;
    const clamp = (e) => {
      const s = Math.max(0, diffDays(start, e.start)); const f = Math.min(this.tlDays - 1, diffDays(start, e.end));
      return { left: s * colW, width: Math.max(colW * 0.9, (f - s + 1) * colW - 2), clippedL: e.start < start, clippedR: e.end > end };
    };

    const vis = this.visible().filter(inRange);
    const groups = [
      ['Projects', vis.filter(e => e.kind === 'project' && !e.milestone)],
      ['Milestones', vis.filter(e => e.milestone)],
      ['Campaigns', vis.filter(e => e.kind === 'campaign')],
      ['Tasks', vis.filter(e => e.kind === 'task').sort((a, b) => a.start.localeCompare(b.start))],
      ['Leave', vis.filter(e => e.kind === 'leave')]
    ].filter(([, list]) => list.length);

    // header: months + days
    let months = '', days = '';
    for (let i = 0; i < this.tlDays; i++) {
      const d = addDays(this.tlStart, i);
      if (i === 0 || d.getDate() === 1) {
        const left = Math.min(this.tlDays - i, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate() + 1);
        months += `<div class="tl-month" style="width:${left * colW}px">${d.toLocaleString('en', { month: 'long', year: 'numeric' })}</div>`;
      }
      days += `<div class="tl-day ${WEEKENDS.includes(d.getDay()) ? 'weekend' : ''} ${ymd(d) === today ? 'today' : ''}" style="width:${colW}px">${colW >= 30 ? `<small>${WEEKDAYS[d.getDay()][0]}</small>` : ''}${colW >= 20 ? d.getDate() : ''}</div>`;
    }
    const todayOffset = diffDays(start, today);
    const todayLine = todayOffset >= 0 && todayOffset < this.tlDays ? `<div class="tl-today" style="left:${todayOffset * colW + colW / 2}px"></div>` : '';
    const weekendBands = Array.from({ length: this.tlDays }, (_, i) => WEEKENDS.includes(addDays(this.tlStart, i).getDay()) ? `<div class="tl-weekend" style="left:${i * colW}px;width:${colW}px"></div>` : '').join('');

    const rows = groups.map(([name, list]) => `
      <div class="tl-group"><div class="tl-label tl-group-label">${name} <span class="badge badge-slate">${list.length}</span></div><div class="tl-track" style="width:${width}px"></div></div>
      ${list.map(e => {
        const c = clamp(e);
        return `<div class="tl-row">
          <div class="tl-label" title="${escapeHTML(e.title)}">${escapeHTML(e.title)}</div>
          <div class="tl-track" style="width:${width}px">${weekendBands}
            <button type="button" class="tl-bar tone-${e.tone} ${c.clippedL ? 'clip-l' : ''} ${c.clippedR ? 'clip-r' : ''}" data-ev="${escapeHTML(e.key)}"
              style="left:${c.left}px;width:${c.width}px" title="${escapeHTML(e.title)} · ${prettyDate(e.start)}${e.end !== e.start ? ' → ' + prettyDate(e.end) : ''}">
              <span>${c.width > 70 ? escapeHTML(e.short || e.title) : ''}</span>
            </button>
          </div>
        </div>`;
      }).join('')}`).join('');

    body.innerHTML = `
      ${zoom}
      <div class="tl-wrap" style="--col: ${colW}px">
        <div class="tl-scroll" id="tlScroll">
          <div class="tl-head">
            <div class="tl-label tl-corner">${this.tlDays} days</div>
            <div class="tl-axis" style="width:${width}px"><div class="tl-months">${months}</div><div class="tl-days">${days}</div>${todayLine}</div>
          </div>
          <div class="tl-body" style="min-width:${width + 230}px">
            ${rows || '<div class="empty-state" style="border:none; padding: 40px 0;"><div class="empty-state-icon">🗓️</div><div class="empty-state-title">Nothing in this period</div><div class="empty-state-desc">Move the window with the arrows, or change the filters.</div></div>'}
            <div class="tl-overlay" style="left:230px;width:${width}px">${todayLine}</div>
          </div>
        </div>
      </div>`;

    body.querySelectorAll('[data-zoom]').forEach(b => b.addEventListener('click', () => { this.tlDays = Number(b.dataset.zoom); this.draw(); }));
    body.querySelectorAll('[data-ev]').forEach(b => b.addEventListener('click', () => this.openEvent(this.events.find(e => e.key === b.dataset.ev))));
  }

  // ================================================================ dialogs
  openEvent(e) {
    if (!e) return;
    const rows = [];
    const add = (k, v) => v && rows.push(`<div class="ev-row"><span>${k}</span><strong>${v}</strong></div>`);
    add('Type', escapeHTML(KIND[e.kind].label.replace(/s$/, '') + (e.milestone ? ' milestone' : '')));
    if (e.kind === 'task') {
      add('Status', escapeHTML(String(e.status).replace(/_/g, ' ')));
      add('Priority', escapeHTML(e.priority));
      add('Assigned to', escapeHTML(e.who));
      add('Due', escapeHTML(prettyDate(e.due)) + (e.overdue ? ' <span class="badge badge-rose">Overdue</span>' : ''));
    } else if (e.kind === 'post') {
      add('Date', escapeHTML(prettyDate(e.start)) + (e.overdue ? ' <span class="badge badge-rose">Not published yet</span>' : ''));
      if (e.raw.post_time) add('Time', escapeHTML(String(e.raw.post_time).slice(0, 5)));
      add('Format', escapeHTML(e.raw.content_type));
      add('Platform', e.raw.platform && escapeHTML(e.raw.platform));
      add('Status', escapeHTML(String(e.status).replace(/_/g, ' ')));
    } else if (e.kind === 'leave') {
      add('From', escapeHTML(prettyDate(e.start))); add('To', escapeHTML(prettyDate(e.end)));
    } else {
      add(e.start !== e.end ? 'Starts' : 'Date', escapeHTML(prettyDate(e.start)));
      if (e.start !== e.end) add('Ends', escapeHTML(prettyDate(e.end)));
      add('Status', e.status && escapeHTML(String(e.status).replace(/_/g, ' ')));
      add('Project', e.milestone && e.who && escapeHTML(e.who));
    }
    const d = htmlDialog({
      title: e.title,
      html: `<div class="ev-details">${rows.join('')}</div>
             <div style="margin-top: var(--space-4); display: flex; gap: var(--space-2);">
               <a class="btn btn-primary btn-sm" href="${e.route}" data-open>Open in ${escapeHTML(KIND[e.kind].label)}</a>
             </div>`
    });
    d.querySelector('[data-open]')?.addEventListener('click', () => closeDialog());
  }

  openDay(day) {
    const list = this.byDay(day, day).get(day) || [];
    const d = htmlDialog({
      title: prettyDate(day),
      html: `<div class="agenda" style="padding:0">${list.map(e => `
        <button type="button" class="agenda-row tone-${e.tone}" data-ev="${escapeHTML(e.key)}"><span class="agenda-dot"></span>
          <span class="agenda-main"><strong>${escapeHTML(e.title)}</strong><small>${KIND[e.kind].label.replace(/s$/, '')}${e.who ? ' · ' + escapeHTML(e.who) : ''}</small></span></button>`).join('')}</div>
        <div style="margin-top: var(--space-3);"><button type="button" class="btn btn-secondary btn-sm" data-new>+ New task this day</button></div>`
    });
    d.querySelectorAll('[data-ev]').forEach(b => b.addEventListener('click', () => this.openEvent(this.events.find(e => e.key === b.dataset.ev))));
    d.querySelector('[data-new]')?.addEventListener('click', () => this.openNewTask(day));
  }

  openNewTask(day) {
    formDialog({
      title: 'New task',
      subtitle: `Due ${prettyDate(day)}`,
      submitLabel: 'Create task',
      fields: [
        { name: 'title', label: 'Task name', required: true, maxlength: 200 },
        { name: 'assigneeId', label: 'Assigned to', type: 'select', half: true, required: true, value: this.app.currentUser.id,
          options: this.people.map(p => ({ value: p.id, label: p.full_name })) },
        { name: 'priority', label: 'Priority', type: 'select', half: true, value: 'medium', options: [
          { value: 'urgent', label: 'Urgent' }, { value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }] },
        { name: 'dueDate', label: 'Deadline', type: 'date', half: true, required: true, value: day },
        { name: 'projectId', label: 'Project', type: 'select', half: true, value: '', options: [
          { value: '', label: 'General studio work' }, ...this.projects.map(p => ({ value: p.id, label: `${p.name} (${p.code})` }))] },
        { name: 'description', label: 'Brief', type: 'textarea', rows: 3 }
      ],
      onSubmit: async (v) => {
        await Api.createTask({ title: v.title, assignedTo: v.assigneeId, projectId: v.projectId, priority: v.priority, dueDate: v.dueDate, description: v.description });
        Toast.success('Task created', 'Created');
        await this.load(); this.draw();
      }
    });
  }
}
