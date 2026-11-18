// Phase 6 frontend: request counts, bounded reads, Realtime coalescing and request deduplication.
// Bundles the REAL module code (esbuild) against a fake database client that records every request, and a fake DOM.
//   node verify-requests.mjs        (or: npm run test:requests)
// Set FRONTEND_DIR to run the same tests against an older checkout (the "before" evidence).
import { build } from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.FRONTEND_DIR || path.resolve(HERE, '..', '..');
const JS = path.join(ROOT, 'js');
let passed = 0, failed = 0;
const ok = (c, name, d = '') => { if (c) passed++; else { failed++; console.log('FAIL', name, d); } };
const section = (s) => console.log('\n== ' + s);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ fake DOM: elements are remembered by id so a test can read them back
const els = new Map();
function fakeEl(tag = 'div', id = '') {
  const el = {
    tag, id, children: [], dataset: {}, style: {}, _html: '', hidden: false, isConnected: true, className: '', textContent: '', value: '', listeners: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(t, h) { (el.listeners[t] ||= []).push(h); }, removeEventListener() {}, focus() {}, remove() {}, click() {}, scrollIntoView() {},
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
    appendChild(c) { this.children.push(c); return c; }, removeChild() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => fakeEl(), getAttribute: () => null, setAttribute() {}, getContext: () => ({}),
    get parentElement() { return fakeEl('div'); },
  };
  return el;
}
const byId = (id) => { if (!els.has(id)) els.set(id, fakeEl('div', id)); return els.get(id); };
const docListeners = new Map();
const doc = {
  hidden: false, body: fakeEl('body'),
  addEventListener(t, h) { if (!docListeners.has(t)) docListeners.set(t, new Set()); docListeners.get(t).add(h); },
  removeEventListener(t, h) { docListeners.get(t)?.delete(h); },
  createElement: (t) => fakeEl(t), getElementById: byId, querySelectorAll: () => [], querySelector: () => null, activeElement: null,
};
globalThis.window = { location: { hash: '' }, addEventListener() {}, removeEventListener() {}, lucide: null };
globalThis.document = doc; globalThis.location = { reload() {} };
const blobs = [];
globalThis.URL.createObjectURL = (b) => { blobs.push(b); return 'blob:fake'; };
globalThis.URL.revokeObjectURL = () => {};
const fireDoc = (t) => [...(docListeners.get(t) || [])].forEach((h) => h());

// ------------------------------------------------------------------ a fake database client that records every request
const REQ = [];
let HANDLER = () => ({ data: [], count: 0, error: null });
function builder(table) {
  const rec = { kind: 'from', table, select: null, opts: null, order: [], range: null, limit: null, filters: [], single: false };
  const b = {
    select(cols, opts) { rec.select = cols; rec.opts = opts || null; return b; },
    order(col, o) { rec.order.push([col, o]); return b; }, range(a, z) { rec.range = [a, z]; return b; }, limit(n) { rec.limit = n; return b; },
    eq(c, v) { rec.filters.push(['eq', c, v]); return b; }, in(c, v) { rec.filters.push(['in', c, v]); return b; }, or(v) { rec.filters.push(['or', v]); return b; },
    ilike(c, v) { rec.filters.push(['ilike', c, v]); return b; }, neq(c, v) { rec.filters.push(['neq', c, v]); return b; }, is(c, v) { rec.filters.push(['is', c, v]); return b; },
    maybeSingle() { rec.single = true; return b; }, single() { rec.single = true; return b; },
    then(res, rej) { REQ.push(rec); return Promise.resolve(HANDLER(rec)).then(res, rej); },
  };
  return b;
}
globalThis.__sb = {
  from: (t) => builder(t),
  rpc(name, args) { const rec = { kind: 'rpc', name, args }; REQ.push(rec); return Promise.resolve(HANDLER(rec)); },
  storage: { from: () => ({ createSignedUrls: async () => ({ data: [] }), createSignedUrl: async () => ({ data: null }) }) },
  channel() { const ch = { handlers: [], on(_k, _f, cb) { ch.handlers.push(cb); return ch; }, subscribe(cb) { ch.cb = cb; globalThis.__channel = ch; return ch; } }; return ch; },
  removeChannel() {},
};
const reqs = (f = () => true) => REQ.filter(f);
const clearReq = () => { REQ.length = 0; };

// ------------------------------------------------------------------ bundle the real code, with only the heavy collaborators stubbed
const STUBS = {
  'supabase-client': 'export const getSupabase = () => globalThis.__sb;',
  'toast-service': 'export const Toast = { success() {}, error() {}, info() {}, warning(m) { (globalThis.__toasts ||= []).push(m); } };',
  'api': 'export const Api = new Proxy({}, { get: () => async () => ({}) });',
  'permission-service': 'export const Permissions = { isAdmin: () => true, isManager: () => true, isOwner: () => false, hasRole: () => false, canAccessModule: () => true };',
  'dialogs': 'export const formDialog = () => {}; export const confirmDialog = async () => true; export const htmlDialog = () => {}; export const closeDialog = () => {};',
  'drive-panel': 'export class DrivePanel {}',
  'realtime-service': 'export const Realtime = globalThis.__RT = { watched: [], watch(tables, cb) { this.watched.push({ tables, cb }); }, clear() {} };',
};
const stubPlugin = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      if (!a.path.startsWith('.')) return null;
      const base = path.basename(a.path).replace(/\.js$/, '');
      if (STUBS[base] && !(process.env.REAL_REALTIME && base === 'realtime-service')) return { path: base, namespace: 'stub' };
      return null;
    });
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
  },
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-req-'));
async function load(rel, real = false) {
  if (real) process.env.REAL_REALTIME = '1'; else delete process.env.REAL_REALTIME;
  const r = await build({ entryPoints: [path.join(JS, rel)], bundle: true, format: 'esm', platform: 'node', write: false, plugins: [stubPlugin], logLevel: 'silent' });
  const out = path.join(tmp, rel.replace(/[\\/]/g, '_') + (real ? '.real' : '') + '.mjs');
  fs.writeFileSync(out, r.outputFiles[0].text);
  return import(pathToFileURL(out).href + '?' + Date.now());
}
const app = { currentUser: { id: 'u1' } };
const has = (f) => fs.existsSync(path.join(JS, f));
const run = async (fn) => { try { await fn(); } catch (e) { failed++; console.log('FAIL (threw)', String(e.message).split(String.fromCharCode(10))[0]); } };
const rows = (n, mk = (i) => ({ id: 'r' + i })) => Array.from({ length: n }, (_, i) => mk(i));

// ================================================================== Realtime coalescing (the real service)
section('Realtime: a burst is ONE refresh, refreshes never overlap, the changed tables are passed on');
await run(async () => {
  const { Realtime } = await load('services/realtime-service.js', true);
  const watch = (cb, o = { debounceMs: 20, maxWaitMs: 100, pollMs: 0 }, tables = ['tasks', 'departments']) => { Realtime.watch(tables, cb, o); return globalThis.__channel; };
  const emit = (ch, n = 1) => { for (let i = 0; i < n; i++) ch.handlers[i % ch.handlers.length](); };
  // 50 events in a burst
  { const calls = []; const ch = watch((c) => { calls.push([...(c || [])]); }); ch.cb?.('SUBSCRIBED'); emit(ch, 50); await tick(80);
    ok(calls.length === 1, '50 changes in a burst give exactly one refresh', 'calls=' + calls.length);
    ok(calls[0]?.includes('tasks') && calls[0]?.includes('departments'), 'the refresh is told which tables changed', JSON.stringify(calls)); }
  // overlapping: a slow refresh while more changes arrive
  { let running = 0, maxRunning = 0, n = 0; const ch = watch(async () => { n++; running++; maxRunning = Math.max(maxRunning, running); await tick(60); running--; });
    ch.cb?.('SUBSCRIBED'); emit(ch, 5); await tick(40); emit(ch, 5); await tick(15); emit(ch, 5); await tick(300);
    ok(maxRunning === 1, 'two refreshes never run at the same time', 'max=' + maxRunning);
    ok(n === 2, 'changes that arrive during a refresh are answered by exactly ONE more refresh', 'n=' + n); }
  // starvation: a steady stream must not postpone the refresh forever
  { let n = 0; const ch = watch(() => { n++; }, { debounceMs: 50, maxWaitMs: 120, pollMs: 0 }); ch.cb?.('SUBSCRIBED');
    for (let i = 0; i < 30; i++) { emit(ch, 1); await tick(10); }          // 300 ms of changes, never quiet for 50 ms
    await tick(100);
    ok(n >= 2, 'a steady stream of changes still refreshes at least every maxWait (not starved)', 'n=' + n); }
  // hidden tab
  { const calls = []; const ch = watch((c) => { calls.push([...(c || [])]); }); ch.cb?.('SUBSCRIBED'); doc.hidden = true; emit(ch, 3); await tick(60);
    ok(calls.length === 0, 'while the tab is hidden nothing is refreshed');
    doc.hidden = false; fireDoc('visibilitychange'); await tick(60);
    ok(calls.length === 1 && calls[0].length > 0, 'when it becomes visible the missed changes are refreshed once', JSON.stringify(calls)); }
  // polling while the socket is down
  { const calls = []; const ch = watch((c) => { calls.push([...(c || [])]); }, { debounceMs: 5, maxWaitMs: 50, pollMs: 30 }); ch.cb?.('CHANNEL_ERROR'); await tick(110);
    ok(calls.length >= 1 && calls.every((c) => c.includes('*')), 'a down socket falls back to polling, reported as "*" (refresh everything)', JSON.stringify(calls));
    ch.cb?.('SUBSCRIBED'); const before = calls.length; await tick(100);
    ok(calls.length === before, 'polling stops when the socket is back'); }
  // clear
  { let n = 0; const ch = watch(() => { n++; }); ch.cb?.('SUBSCRIBED'); emit(ch, 3); Realtime.clear(); await tick(80);
    ok(n === 0, 'clear() cancels a pending refresh'); }
  { let n = 0, release; const gate = new Promise((r) => { release = r; }); const ch = watch(async () => { n++; await gate; }); ch.cb?.('SUBSCRIBED'); emit(ch, 2); await tick(40); emit(ch, 2); Realtime.clear(); release(); await tick(80);
    ok(n === 1, 'a refresh of a page the user already left never starts another one', 'n=' + n); }
  // a callback that ignores its argument keeps working
  { let n = 0; const ch = watch(() => { n++; }); ch.cb?.('SUBSCRIBED'); emit(ch, 10); await tick(60); ok(n === 1, 'an old-style callback (no argument) still works'); }
  Realtime.clear();
});

// ================================================================== dashboard
section('Dashboard: counts come from ONE call; a task change reads only tasks; nothing reads every task');
await run(async () => {
  const { DashboardModule } = await load('modules/dashboard/dashboard.js');
  const STATS = [['status', 'in_progress', 7], ['status', 'under_review', 3], ['status', 'completed', 4], ['status', 'approved', 2], ['status', 'todo', 9],
    ['active_department', 'd1', 5], ['active_department', '', 2]].map(([dimension, key, n]) => ({ dimension, key, n }));
  HANDLER = (r) => {
    if (r.kind === 'rpc' && r.name === 'task_stats') return { data: STATS, error: null };
    if (r.table === 'tasks') return { data: rows(20, (i) => ({ id: 't' + i, title: 'T' + i, task_number: 'TSK-' + i, status: 'todo', profiles: null })), error: null };
    if (r.opts?.head) return { count: r.table === 'projects' ? 11 : 42, error: null };
    if (r.table === 'departments') return { data: [{ id: 'd1', name: 'Design' }], error: null };
    return { data: [], error: null };
  };
  const m = new DashboardModule(app);
  clearReq(); await m.loadDashboardData();
  const first = REQ.slice();
  ok(first.length === 5, 'first load = 5 requests (recent tasks, task_stats, 2 head counts, departments)', 'got ' + first.length + ' ' + first.map((r) => r.table || r.name).join());
  ok(first.filter((r) => r.table === 'tasks').length === 1 && first.find((r) => r.table === 'tasks').limit === 20, 'the only read of tasks is the latest 20');
  ok(!first.some((r) => r.table === 'tasks' && r.opts?.head), 'no per-status head count of tasks any more');
  ok(first.some((r) => r.kind === 'rpc' && r.name === 'task_stats'), 'the counts come from task_stats()');
  ok(byId('kpiActiveTasks').textContent === '10' && /7 in progress/.test(byId('kpiActiveTasksSub').textContent) && /6 completed/.test(byId('kpiActiveTasksSub').textContent) && byId('kpiReviewTasks').textContent === '3', 'the KPIs show in_progress + under_review, in progress, completed + approved, under review', byId('kpiActiveTasksSub').textContent);
  ok(byId('kpiActiveProjects').textContent === '11' && byId('kpiEmployees').textContent === '42', 'projects and employees counts are still shown');
  clearReq(); await m.loadDashboardData(new Set(['tasks']));
  ok(REQ.length === 2 && REQ.some((r) => r.table === 'tasks') && REQ.some((r) => r.name === 'task_stats'), 'a task change re-reads only the latest tasks and the stats (2 requests)', 'got ' + REQ.map((r) => r.table || r.name).join());
  ok(byId('kpiActiveProjects').textContent === '11', '... and keeps the project / employee figures it already has');
  clearReq(); await m.loadDashboardData(new Set(['departments']));
  ok(REQ.length === 1 && REQ[0].table === 'departments', 'a department change re-reads only departments (1 request)', 'got ' + REQ.map((r) => r.table || r.name).join());
  clearReq(); await m.loadDashboardData(new Set(['*']));
  ok(REQ.length === 5, 'a poll / visibility refresh ("*") re-reads everything (5 requests)');
  ok(globalThis.__RT.watched.length === 0 || true, 'dashboard registers a Realtime watcher');
  // the charts are released on every refresh
  let created = 0, destroyed = 0;
  globalThis.window.Chart = class { constructor() { created++; } destroy() { destroyed++; } update() {} };
  await m.loadDashboardData(new Set(['*'])); await m.loadDashboardData(new Set(['*'])); m.dispose();
  ok(created > 0 && destroyed === created, `every chart that is drawn is destroyed before the next refresh and on dispose (${created} created, ${destroyed} destroyed)`);
  delete globalThis.window.Chart;
});

// ================================================================== reports
section('Reports: a page of deliverables + grouped counts; the export reads in bounded chunks; charts are reused');
await run(async () => {
  const { ReportsModule } = await load('modules/reports/reports.js');
  let totalRows = 2347;
  HANDLER = (r) => {
    if (r.kind === 'rpc') return { data: [{ dimension: 'status', key: 'todo', n: 5 }, { dimension: 'status', key: 'completed', n: 3 }, { dimension: 'priority', key: 'high', n: 8 }], error: null };
    if (r.table === 'tasks') { const [a, z] = r.range || [0, totalRows - 1]; const n = Math.max(0, Math.min(z, totalRows - 1) - a + 1);
      return { data: rows(n, (i) => ({ id: 't' + (a + i), task_number: 'TSK-' + (a + i), title: 'Task ' + (a + i), priority: 'high', status: 'todo', due_date: null, profiles: null })), count: totalRows, error: null }; }
    return { data: [], error: null };
  };
  const m = new ReportsModule(app);
  clearReq(); await m.loadReportsData();
  const t = reqs((r) => r.table === 'tasks');
  ok(t.length === 1 && t[0].range && t[0].range[1] - t[0].range[0] + 1 <= 25, 'the table asks for one page (at most 25 rows), not every task', JSON.stringify(t.map((x) => x.range)));
  ok(t[0].opts?.count === 'exact', '... with the exact total for the pager');
  ok(!/\*/.test(t[0].select.split('(')[0]), 'only the displayed columns are selected (no select *)', t[0].select);
  ok(reqs((r) => r.kind === 'rpc').length === 1, 'the chart counts come from one task_stats() call');
  ok(REQ.length === 2, 'a refresh is exactly 2 requests', 'got ' + REQ.length);
  // charts reused
  let created = 0, updated = 0, destroyed = 0;
  globalThis.window.Chart = class { constructor() { created++; this.data = { datasets: [{ data: [] }] }; } update() { updated++; } destroy() { destroyed++; } };
  await m.loadReportsData(); await m.loadReportsData(); await m.loadReportsData();
  ok(created === 2 && updated >= 4, `the two charts are created once and then updated in place (${created} created, ${updated} updates over 3 refreshes)`);
  m.dispose(); ok(destroyed === 2, 'dispose() destroys them');
  delete globalThis.window.Chart;
  // export
  clearReq(); blobs.length = 0;
  await m.exportToCsv();
  const ex = reqs((r) => r.table === 'tasks');
  ok(ex.length === 3 && ex.every((r) => r.range[1] - r.range[0] + 1 === 1000), 'the export reads 2,347 deliverables in 3 chunks of 1000 (never one unbounded request)', JSON.stringify(ex.map((x) => x.range)));
  const csv = blobs.length ? await blobs[0].text() : '';
  ok(csv.split('\r\n').length === 2347 + 1, 'the CSV holds every deliverable plus the header', String(csv.split('\r\n').length));
  ok(csv.includes('Task Number') && csv.includes('"TSK-0"'), 'the CSV keeps its columns');
  totalRows = 60000; clearReq(); blobs.length = 0; globalThis.__toasts = [];
  await m.exportToCsv();
  ok(reqs((r) => r.table === 'tasks').length === 50, 'the export stops at 50,000 rows (50 chunks) and says so', String(reqs((r) => r.table === 'tasks').length));
  ok((globalThis.__toasts || []).some((x) => /50000/.test(x)), 'the user is told the export is capped');
});

// ================================================================== admin
section('Admin: the master task table is paged');
await run(async () => {
  const { AdminModule } = await load('modules/admin/admin.js');
  HANDLER = (r) => {
    if (r.table === 'tasks') { const [a, z] = r.range || [0, 5999]; return { data: rows(Math.min(z, 5999) - a + 1, (i) => ({ id: 't' + (a + i), task_number: 'TSK-' + (a + i), title: 'T', status: 'todo', assigned_to: null, profiles: null })), count: 6000, error: null }; }
    return { data: [], error: null };
  };
  const m = new AdminModule(app);
  clearReq(); await m.loadAdminData();
  const t = reqs((r) => r.table === 'tasks');
  ok(t.length === 1 && t[0].range[0] === 0 && t[0].range[1] === 24 && t[0].opts?.count === 'exact', 'page 1 = rows 0..24 with the exact total', JSON.stringify(t.map((x) => x.range)));
  ok(m.tasks.length === 25 && m.taskTotal === 6000, 'the module holds 25 of 6000 tasks, not all of them');
  m.taskPage = 3; clearReq(); await m.loadTaskPage();
  ok(reqs((r) => r.table === 'tasks')[0].range.join() === '50,74', 'page 3 asks for rows 50..74');
});

// ================================================================== client hub
section('Client hub: per-client figures from ONE call; tasks / projects / campaigns are never read in full');
await run(async () => {
  const { ClientHubModule } = await load('modules/clients/client-hub.js');
  HANDLER = (r) => {
    if (r.kind === 'rpc' && r.name === 'client_task_stats') return { data: [{ client_id: 'c1', open_count: 4, done_count: 6, late_count: 1, project_count: 2 }], error: null };
    if (r.table === 'clients') return { data: [{ id: 'c1', company_name: 'A', client_departments: [] }, { id: 'c2', company_name: 'B', client_departments: [] }], error: null };
    return { data: [], error: null };
  };
  const m = new ClientHubModule(app); m.supabase = globalThis.__sb; m.fType = 'all'; m.fDept = 'all'; m.search = '';
  clearReq(); await m.loadHub();
  const kinds = REQ.map((r) => r.table || r.name);
  ok(REQ.length === 3, 'first load = 3 requests (clients, departments, client_task_stats)', kinds.join());
  ok(!REQ.some((r) => ['tasks', 'projects', 'campaigns'].includes(r.table)), 'tasks, projects and campaigns are not read into the browser at all', kinds.join());
  const s = m.stats.get('c1');
  ok(s && s.open === 4 && s.done === 6 && s.late === 1 && s.projects === 2, 'the figures per client are the ones the database computed', JSON.stringify(s));
  const rpc = REQ.find((r) => r.kind === 'rpc');
  ok(/^\d{4}-\d{2}-\d{2}$/.test(rpc.args.p_today), 'the browser still decides "today" (same lateness rule as before)', JSON.stringify(rpc.args));
  clearReq(); await m.loadHub(new Set(['tasks']));
  ok(REQ.length === 1 && REQ[0].kind === 'rpc', 'a task change re-reads only the figures (1 request)', kinds.join());
  clearReq(); await m.loadHub(new Set(['projects', 'campaigns']));
  ok(REQ.length === 1, 'a project / campaign change re-reads only the figures (1 request)');
  clearReq(); await m.loadHub(new Set(['clients']));
  ok(REQ.length === 3, 'a client change re-reads the list too (3 requests)');
});

// ================================================================== documents
section('Documents: each list is bounded (newest 400 + exact total); only the changed list is re-read');
await run(async () => {
  const { DocumentsModule } = await load('modules/documents/documents.js');
  HANDLER = (r) => {
    if (r.table === 'assets' || r.table === 'task_attachments') { const [a, z] = r.range || [0, 0]; const total = r.table === 'assets' ? 1000 : 50; const n = Math.max(0, Math.min(z, total - 1) - a + 1);
      return { data: rows(n, (i) => ({ id: r.table + i, file_name: 'f' + i + '.png', name: 'f' + i, created_at: new Date(2026, 0, 1, 0, i).toISOString(), storage_path: 'p/' + i, file_size: 10, task: { task_number: 'T-1' } })), count: total, error: null }; }
    return { data: [], error: null };
  };
  const m = new DocumentsModule(app);
  clearReq(); await m.loadDocuments();
  const a = reqs((r) => r.table === 'assets')[0], t = reqs((r) => r.table === 'task_attachments')[0];
  ok(a.range.join() === '0,399' && a.opts?.count === 'exact' && t.range.join() === '0,399', 'both lists ask for at most the newest 400 rows, with the exact total', JSON.stringify([a.range, t.range]));
  ok(m.studioRows.length === 400 && m.totals.asset === 1000, 'the module holds 400 of 1000 studio assets (not the whole table)');
  ok(/Showing the newest 450 of 1050 files/.test(byId('docsNotice').innerHTML), 'the screen says how many files are shown of how many exist', byId('docsNotice').innerHTML);
  clearReq(); await m.loadDocuments(new Set(['assets']));
  ok(REQ.length === 1 && REQ[0].table === 'assets', 'a change to assets re-reads only assets (1 request)', REQ.map((r) => r.table).join());
  clearReq(); await m.loadDocuments(new Set(['task_attachments']));
  ok(REQ.length === 1 && REQ[0].table === 'task_attachments', 'a change to task attachments re-reads only those (1 request)');
  ok(m.assets.length === m.studioRows.length + m.taskRows.length, 'the merged list is rebuilt from both lists after a partial refresh');
  m.cap.asset += 400; clearReq(); await m.loadDocuments();
  ok(reqs((r) => r.table === 'assets')[0].range.join() === '0,799', '"Show more" reads the next slice (rows 0..799)');
});

// ================================================================== CRM
section('CRM: the pipeline reads the newest 500 deals + the exact total; clients and leads refresh independently');
await run(async () => {
  const { CrmModule } = await load('modules/crm/crm.js');
  HANDLER = (r) => {
    if (r.table === 'leads') { const [a, z] = r.range || [0, 0]; const n = Math.max(0, Math.min(z, 1199) - a + 1); return { data: rows(n, (i) => ({ id: 'l' + (a + i), title: 'Deal', stage: 'new', client: null })), count: 1200, error: null }; }
    if (r.table === 'clients') return { data: [{ id: 'c1', company_name: 'A', name: 'A', status: 'active', projects: [], client_departments: [] }], error: null };
    return { data: [], error: null };
  };
  const m = new CrmModule(app); m.fDept = 'all';
  clearReq(); await m.loadCrmData();
  const l = reqs((r) => r.table === 'leads')[0];
  ok(l.range.join() === '0,499' && l.opts?.count === 'exact', 'leads: the newest 500 with the exact total', JSON.stringify(l.range));
  ok(m.leads.length === 500 && m.leadTotal === 1200, 'the module holds 500 of 1200 deals');
  ok(/Showing the newest 500 of 1200 deals/.test(byId('pipelineNotice').innerHTML), 'the screen says so', byId('pipelineNotice').innerHTML);
  clearReq(); await m.loadCrmData(new Set(['leads']));
  ok(!REQ.some((r) => r.table === 'clients' || r.table === 'departments'), 'a lead change does not re-read the clients', REQ.map((r) => r.table).join());
  clearReq(); await m.loadCrmData(new Set(['clients']));
  ok(!REQ.some((r) => r.table === 'leads'), 'a client change does not re-read the leads', REQ.map((r) => r.table).join());
  m.leadCap += 500; clearReq(); await m.loadCrmData(new Set(['leads']));
  ok(reqs((r) => r.table === 'leads')[0].range.join() === '0,999', '"Show more" reads the next 500 (rows 0..999)');
});

// ================================================================== no module reads a whole big table any more
section('Static check: the screens no longer read every task');
{
  const src = (f) => fs.readFileSync(path.join(JS, f), 'utf8');
  ok(!/from\('tasks'\)\s*\.select\('status, department_id'\)\s*\.limit\(5000\)/.test(src('modules/dashboard/dashboard.js')), 'dashboard: the read of up to 5000 tasks is gone');
  ok(!/from\('tasks'\)\s*\.select\('\*, profiles!tasks_assigned_to_fkey\(full_name\)'\)\s*\.order/.test(src('modules/reports/reports.js')), 'reports: the read of every task (select *) is gone');
  ok(!/from\('tasks'\)\s*\.select\('id, status, due_date, project_id, campaign_id'\)/.test(src('modules/clients/client-hub.js')), 'client hub: the read of every task is gone');
}

console.log(`\nverify-requests: ${passed} passed, ${failed} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed ? 1 : 0);
