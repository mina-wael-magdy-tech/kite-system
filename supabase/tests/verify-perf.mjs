// Phase 6 (migration 036) on REAL PostgreSQL: row-for-row RLS equivalence, before/after EXPLAIN (ANALYZE, BUFFERS) evidence,
// pagination on a large dataset, aggregate functions, concurrent requests.
//   npm run test:perf                 default dataset (SCALE=0.1: 6,000 tasks)
//   SCALE=1 npm run test:perf         the dataset of the Phase 6 audit (60,000 tasks, 300,000 messages, ...)
//   BENCH_JSON=path.json              also writes every measurement to that file
// A throwaway local PostgreSQL (embedded-postgres, temp dir, deleted at the end); it never touches any remote database.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SB = path.resolve(HERE, '..');
let EmbeddedPostgres, pg;
try { EmbeddedPostgres = (await import('embedded-postgres')).default; pg = (await import('pg')).default; }
catch { console.log('SKIPPED: install the optional dependencies first:  npm install --no-save embedded-postgres pg'); process.exit(0); }
const { rewrite } = await import(pathToFileURL(path.join(HERE, 'tools', 'gen-036-policies.mjs')).href);
let passed = 0, failed = 0;
const ok = (c, name, d = '') => { if (c) passed++; else { failed++; console.log('FAIL', name, d); } };
const section = (s) => console.log('\n== ' + s);
const sql = (f) => fs.readFileSync(path.join(SB, f), 'utf8');
const testSrc = fs.readFileSync(path.join(HERE, 'verify-integrity.mjs'), 'utf8');
const STUBS = /const STUBS = `([\s\S]*?)`;/.exec(testSrc)[1];
const SCALE = Number(process.env.SCALE || 0.1);
const SKIP = process.env.BENCH_ONLY === '1';     // measurements only (for SCALE=1): the equivalence snapshots are quadratic and run at the default scale
const N = { users: 100, tasks: Math.round(60000 * SCALE), assignees: Math.round(30000 * SCALE), msgs: Math.round(300000 * SCALE), notes: Math.round(100000 * SCALE),
  comments: Math.round(150000 * SCALE), atts: Math.round(20000 * SCALE), invoices: Math.round(5000 * SCALE) };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-perf-'));
const PORT = 56100 + Math.floor(Math.random() * 700);
const server = new EmbeddedPostgres({ databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'pw', port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
const conns = [];
const connect = async (db = 'kite') => { const c = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'pw', database: db }); await c.connect(); c.on('error', () => {}); conns.push(c); return c; };
const tryq = async (c, q, p = []) => { try { return { rows: (await c.query(q, p)).rows, rowCount: 0 }; } catch (e) { return { error: e.message, code: e.code }; } };
const uid = (g) => `00000000-0000-4000-8000-${String(g).padStart(12, '0')}`;
const U = { ADMIN: uid(1), OWNER: uid(2), DEPTMGR: uid(3), PM: uid(4), GM: uid(6), TL: uid(7), PM2: uid(8), HR: uid(9), FIN: uid(11), CLIENT: uid(12), INACTIVE: uid(13), NOROLE: uid(14), ASSIGNEE: uid(15), DEPTMGR2: uid(16), EMP: uid(20), EMP2: uid(21), EMP3: uid(40) };
const ROLE_OF = { ADMIN: 'super_admin', OWNER: 'owner', DEPTMGR: 'department_manager', PM: 'project_manager', GM: 'general_manager', TL: 'team_leader', PM2: 'project_manager', HR: 'hr_manager',
  FIN: 'finance_manager', CLIENT: 'client', INACTIVE: 'employee', ASSIGNEE: 'employee', DEPTMGR2: 'department_manager', EMP: 'employee', EMP2: 'employee', EMP3: 'employee' };
const out = { scale: SCALE, dataset: N };
try {
  await server.initialise(); await server.start();
  const c0 = await connect('postgres'); await c0.query(`CREATE DATABASE kite ENCODING 'UTF8' TEMPLATE template0 LOCALE 'C'`);
  const db = await connect(); await db.query(STUBS);
  const files = fs.readdirSync(path.join(SB, 'migrations')).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  const before036 = files.filter((f) => f < '036');
  for (const f of before036) { await db.query(sql('migrations/' + f)); if (f.startsWith('005')) await db.query(sql('seed.sql')); }
  const role = async (n) => (await db.query('SELECT id FROM public.roles WHERE name=$1', [n])).rows[0].id;
  // ---------------------------------------------------------------- dataset
  section(`0. dataset on real PostgreSQL (${N.tasks} tasks, ${N.msgs} messages, ${N.notes} notifications, ${N.comments} comments, ${N.atts} attachments, ${N.invoices} invoices)`);
  const t0 = Date.now();
  await db.query(`INSERT INTO public.departments(name, code) SELECT 'Dept'||g, 'D'||g FROM generate_series(1,6) g`);
  await db.query(`CREATE TEMP TABLE dnum AS SELECT (row_number() OVER (ORDER BY name)-1)::int n, id FROM public.departments`);
  await db.query(`INSERT INTO auth.users(id,email) SELECT ('00000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid, 'u'||g||'@x.test' FROM generate_series(1,${N.users}) g`);
  await db.query(`INSERT INTO public.profiles(id,full_name,email,department_id,employment_status) SELECT u.id, 'User '||g, u.email, d.id, CASE WHEN g=13 THEN 'inactive' ELSE 'active' END
     FROM generate_series(1,${N.users}) g JOIN auth.users u ON u.email='u'||g||'@x.test' JOIN dnum d ON d.n = g % 6`);
  const eid = await role('employee');
  await db.query(`INSERT INTO public.user_roles(user_id,role_id) SELECT p.id, $1 FROM public.profiles p WHERE p.id <> ALL($2::uuid[])`, [eid, [U.NOROLE]]);
  for (const [k, r] of Object.entries(ROLE_OF)) if (r !== 'employee') await db.query('UPDATE public.user_roles SET role_id=$1 WHERE user_id=$2', [await role(r), U[k]]);
  await db.query(`UPDATE public.departments SET manager_id=$1 WHERE name='Dept1'`, [U.DEPTMGR]);
  await db.query(`UPDATE public.departments SET manager_id=$1 WHERE name='Dept2'`, [U.DEPTMGR2]);
  await db.query(`INSERT INTO public.clients(name,company_name) SELECT 'c'||g,'Client '||g FROM generate_series(1,300) g`);
  await db.query(`CREATE TEMP TABLE cnum AS SELECT (row_number() OVER (ORDER BY company_name)-1)::int n, id FROM public.clients`);
  await db.query(`INSERT INTO public.client_departments(client_id,department_id) SELECT c.id, d.id FROM cnum c JOIN dnum d ON d.n = c.n % 6 WHERE c.n % 5 <> 0`);
  await db.query(`INSERT INTO public.projects(code,name,client_id,project_manager_id) SELECT 'P'||g,'Project '||g, c.id,
     CASE WHEN g % 10 = 0 THEN '${U.PM}'::uuid WHEN g % 10 = 1 THEN '${U.PM2}'::uuid ELSE ('00000000-0000-4000-8000-'||lpad((30 + g % 60)::text,12,'0'))::uuid END
     FROM generate_series(1,600) g JOIN cnum c ON c.n = g % 300`);
  await db.query(`CREATE TEMP TABLE pnum AS SELECT (row_number() OVER (ORDER BY code)-1)::int n, id FROM public.projects`);
  await db.query(`INSERT INTO public.tasks(title,created_by,project_id,department_id,assigned_to,status,priority,due_date,created_at)
     SELECT 'Task '||g, ('00000000-0000-4000-8000-'||lpad((20 + g % 50)::text,12,'0'))::uuid, CASE WHEN g % 9 = 0 THEN NULL ELSE p.id END, CASE WHEN g % 11 = 0 THEN NULL ELSE d.id END,
            CASE WHEN g % 7 = 0 THEN NULL ELSE ('00000000-0000-4000-8000-'||lpad((10 + g % 90)::text,12,'0'))::uuid END,
            (ARRAY['backlog','todo','in_progress','under_review','completed','approved','cancelled'])[1 + g % 7], (ARRAY['low','medium','high','urgent'])[1 + g % 4],
            current_date + (g % 40) - 20, now() - (g || ' minutes')::interval FROM generate_series(1,${N.tasks}) g JOIN pnum p ON p.n = g % 600 JOIN dnum d ON d.n = g % 6`);
  await db.query(`CREATE TEMP TABLE tnum AS SELECT (row_number() OVER (ORDER BY created_at)-1)::int n, id FROM public.tasks`);
  await db.query(`INSERT INTO public.task_assignees(task_id,user_id) SELECT t.id, ('00000000-0000-4000-8000-'||lpad((10 + t.n % 90)::text,12,'0'))::uuid FROM tnum t WHERE t.n < ${N.assignees} ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO public.task_assignees(task_id,user_id) SELECT t.id, '${U.ASSIGNEE}'::uuid FROM tnum t WHERE t.n % 40 = 3 ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO public.conversations(type,name,is_public) SELECT CASE WHEN g<=5 THEN 'department' ELSE 'group' END, 'Chat '||g, g<=5 FROM generate_series(1,40) g`);
  await db.query(`CREATE TEMP TABLE vnum AS SELECT (row_number() OVER (ORDER BY name)-1)::int n, id FROM public.conversations`);
  await db.query(`INSERT INTO public.conversation_members(conversation_id,user_id) SELECT c.id, p.id FROM public.conversations c JOIN public.profiles p ON (abs(hashtext(c.id::text||p.id::text)) % 5)=0 ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO public.messages(conversation_id,sender_id,content,created_at) SELECT v.id, ('00000000-0000-4000-8000-'||lpad((1 + g % 100)::text,12,'0'))::uuid, 'message '||g, now() - (g || ' seconds')::interval
     FROM generate_series(1,${N.msgs}) g JOIN vnum v ON v.n = g % 40`);
  await db.query(`INSERT INTO public.notifications(user_id,type,title,content,is_read,created_at) SELECT ('00000000-0000-4000-8000-'||lpad((1 + g % 100)::text,12,'0'))::uuid, 'task','T'||g,'c',(g % 5) <> 0, now() - (g || ' seconds')::interval FROM generate_series(1,${N.notes}) g`);
  await db.query(`INSERT INTO public.task_comments(task_id,user_id,content) SELECT t.id, '${U.EMP}'::uuid, 'c'||g FROM generate_series(1,${N.comments}) g JOIN tnum t ON t.n = g % ${Math.max(1, Math.min(N.tasks, 50000))}`);
  await db.query(`INSERT INTO public.task_attachments(task_id,file_name,file_size,file_type,storage_path,uploaded_by) SELECT t.id,'f'||g||'.png',1000,'image/png','p/'||g,'${U.EMP}'::uuid
     FROM generate_series(1,${N.atts}) g JOIN tnum t ON t.n = g % ${Math.max(1, Math.min(N.tasks, 50000))}`);
  await db.query(`INSERT INTO public.task_links(task_id,title,url,added_by) SELECT t.id,'L','https://x.test/'||t.n,'${U.EMP}'::uuid FROM tnum t WHERE t.n % 20 = 0`);
  await db.query(`INSERT INTO public.leads(title,stage,client_id,assigned_to,created_by) SELECT 'Lead '||g, (ARRAY['new','contacted','qualified','proposal_sent','negotiation','won','lost'])[1+g%7], c.id,
     ('00000000-0000-4000-8000-'||lpad((10 + g % 90)::text,12,'0'))::uuid, '${U.OWNER}'::uuid FROM generate_series(1,${Math.max(200, Math.round(2000 * SCALE))}) g JOIN cnum c ON c.n = g % 300`);
  await db.query(`INSERT INTO public.expenses(title,amount,currency,category,department_id,submitted_by,status) SELECT 'E'||g, 10+g, 'EGP', 'software', d.id, ('00000000-0000-4000-8000-'||lpad((20 + g % 50)::text,12,'0'))::uuid,
     (ARRAY['draft','submitted','approved','rejected','paid'])[1+g%5] FROM generate_series(1,${Math.max(200, Math.round(1000 * SCALE))}) g JOIN dnum d ON d.n = g % 6`);
  await db.query(`INSERT INTO public.vendors(name) SELECT 'V'||g FROM generate_series(1,20) g`);
  await db.query(`INSERT INTO public.budgets(name,department_id,amount) SELECT 'B'||d.n, d.id, 1000 FROM dnum d`);
  await db.query('BEGIN'); await db.query("SET LOCAL app.migrating = 'on'");
  await db.query(`INSERT INTO public.invoices(invoice_number,client_id,type,status,due_date,currency,amount,tax,subtotal,vat_amount,total,net_receivable,amount_paid,balance,created_at)
     SELECT 'B-'||g, c.id, 'receivable', (ARRAY['sent','paid','overdue','partially_paid'])[1+g%4], current_date + (g%60) - 30, 'EGP', 100,0,100,0,100,100,(CASE g%4 WHEN 1 THEN 100 WHEN 3 THEN 50 ELSE 0 END),(CASE g%4 WHEN 1 THEN 0 WHEN 3 THEN 50 ELSE 100 END), now() - (g||' minutes')::interval
     FROM generate_series(1,${N.invoices}) g JOIN cnum c ON c.n = g % 300`);
  await db.query('COMMIT');
  await db.query('VACUUM ANALYZE');
  out.loadSeconds = +((Date.now() - t0) / 1000).toFixed(1);
  console.log(`   loaded in ${out.loadSeconds}s`);

  // ---------------------------------------------------------------- helpers
  const asUser = async (user, fn, { role = 'authenticated', timeout = '300s' } = {}) => {
    const c = await connect('kite');
    try { await c.query('BEGIN'); await c.query(`SET LOCAL ROLE ${role}`); await c.query(`SET LOCAL statement_timeout='${timeout}'`); if (user) await c.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [user]);
      const r = await fn(c); await c.query('ROLLBACK'); return r; }
    catch (e) { try { await c.query('ROLLBACK'); } catch { /* */ } return { error: e.message, code: e.code }; }
    finally { await c.end(); }
  };
  const explain = async (user, q, { warm = true } = {}) => asUser(user, async (c) => {
    if (warm) await c.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${q}`);
    const r = await c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q}`); const p = r.rows[0]['QUERY PLAN'][0];
    const nodes = []; const walk = (n) => { nodes.push(n['Node Type'] + (n['Index Name'] ? `(${n['Index Name']})` : n['Relation Name'] ? `(${n['Relation Name']})` : '')); (n.Plans || []).forEach(walk); }; walk(p.Plan);
    return { ms: +p['Execution Time'].toFixed(1), hit: p.Plan['Shared Hit Blocks'], read: p.Plan['Shared Read Blocks'], rows: p.Plan['Actual Rows'], nodes };
  });
  const policies = async () => (await db.query(`SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename, policyname`)).rows;
  const polBefore = await policies();
  const changed = polBefore.filter((p) => rewrite(p.qual, p.tablename) !== p.qual || rewrite(p.with_check, p.tablename) !== p.with_check);
  const tables = [...new Set(changed.map((p) => p.tablename))].sort();

  // ---------------------------------------------------------------- snapshots: what every user can see / do
  const SNAP_USERS = Object.entries(U);
  const visibleSnapshot = async () => {
    const snap = {};
    for (const [name, id] of [...SNAP_USERS, ['ANON', null]]) {
      snap[name] = await asUser(id, async (c) => {
        const o = {};
        for (const t of tables) {
          const r = await tryq(c, `SAVEPOINT s`).then(() => tryq(c, `SELECT count(*)::int n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) h FROM public.${t} x`));
          if (r.error) { o[t] = 'denied:' + r.code; await c.query('ROLLBACK TO SAVEPOINT s'); } else { o[t] = r.rows[0].n + ':' + r.rows[0].h; await c.query('RELEASE SAVEPOINT s'); }
        }
        return o;
      }, { role: id ? 'authenticated' : 'anon' });
    }
    return snap;
  };
  const one = async (q, p = []) => (await db.query(q, p)).rows[0];
  const T = {
    own: (await one(`SELECT id FROM public.tasks WHERE assigned_to=$1 ORDER BY created_at LIMIT 1`, [U.EMP])).id,
    made: (await one(`SELECT id FROM public.tasks WHERE created_by=$1 AND assigned_to IS DISTINCT FROM $1 ORDER BY created_at LIMIT 1`, [U.EMP2])).id,
    viaAssignee: (await one(`SELECT task_id id FROM public.task_assignees WHERE user_id=$1 LIMIT 1`, [U.ASSIGNEE])).id,
    dept1: (await one(`SELECT t.id FROM public.tasks t JOIN public.departments d ON d.id=t.department_id WHERE d.name='Dept1' ORDER BY t.created_at LIMIT 1`)).id,
    pmProj: (await one(`SELECT t.id FROM public.tasks t JOIN public.projects p ON p.id=t.project_id WHERE p.project_manager_id=$1 ORDER BY t.created_at LIMIT 1`, [U.PM])).id,
    nobody: (await one(`SELECT id FROM public.tasks WHERE department_id IS NULL AND project_id IS NULL AND assigned_to IS NULL ORDER BY created_at LIMIT 1`).catch(() => ({})))?.id,
  };
  const L1 = (await one(`SELECT id FROM public.leads WHERE assigned_to=$1 LIMIT 1`, [U.EMP])).id;
  const C1 = (await one(`SELECT id FROM public.clients ORDER BY company_name LIMIT 1`)).id;
  const P1 = (await one(`SELECT id FROM public.projects WHERE project_manager_id=$1 LIMIT 1`, [U.PM])).id;
  const D1 = (await one(`SELECT id FROM public.departments WHERE name='Dept1'`)).id;
  const EX1 = (await one(`SELECT id FROM public.expenses WHERE submitted_by=$1 AND status='draft' LIMIT 1`, [U.EMP])).id;
  const NT1 = (await one(`SELECT id FROM public.notifications WHERE user_id=$1 LIMIT 1`, [U.EMP])).id;
  const taskIds = Object.values(T).filter(Boolean);
  const probes = [];
  for (const [tn, tid] of Object.entries(T)) if (tid) probes.push(
    [`INSERT task_comment on ${tn}`, `INSERT INTO public.task_comments(task_id,user_id,content) VALUES ('${tid}', current_setting('request.jwt.claim.sub')::uuid, 'x')`],
    [`INSERT task_link on ${tn}`, `INSERT INTO public.task_links(task_id,title,url,added_by) VALUES ('${tid}','t','https://x.test', current_setting('request.jwt.claim.sub')::uuid)`],
    [`INSERT task_attachment on ${tn}`, `INSERT INTO public.task_attachments(task_id,file_name,file_size,file_type,storage_path,uploaded_by) VALUES ('${tid}','a.png',1,'image/png','p', current_setting('request.jwt.claim.sub')::uuid)`],
    [`DELETE task_comment of ${tn}`, `DELETE FROM public.task_comments WHERE task_id='${tid}'`],
    [`UPDATE task_comment of ${tn}`, `UPDATE public.task_comments SET content='y' WHERE task_id='${tid}'`],
    [`UPDATE task ${tn}`, `UPDATE public.tasks SET title='z' WHERE id='${tid}'`],
    [`DELETE task ${tn}`, `DELETE FROM public.tasks WHERE id='${tid}'`],
    [`INSERT task_assignee on ${tn}`, `INSERT INTO public.task_assignees(task_id,user_id) VALUES ('${tid}', current_setting('request.jwt.claim.sub')::uuid) ON CONFLICT DO NOTHING`]);
  probes.push(
    ['INSERT task', `INSERT INTO public.tasks(title,created_by) VALUES ('n', current_setting('request.jwt.claim.sub')::uuid)`],
    ['UPDATE lead', `UPDATE public.leads SET notes='n' WHERE id='${L1}'`], ['DELETE lead', `DELETE FROM public.leads WHERE id='${L1}'`],
    ['INSERT lead (own)', `INSERT INTO public.leads(title,created_by) VALUES ('n', current_setting('request.jwt.claim.sub')::uuid)`],
    ['INSERT lead (other creator)', `INSERT INTO public.leads(title,created_by) VALUES ('n','${U.OWNER}')`],
    ['INSERT client', `INSERT INTO public.clients(name,company_name) VALUES ('n','n')`], ['UPDATE client', `UPDATE public.clients SET notes='n' WHERE id='${C1}'`], ['DELETE client', `DELETE FROM public.clients WHERE id='${C1}'`],
    ['INSERT project', `INSERT INTO public.projects(code,name) VALUES ('ZZ'||floor(random()*1e9)::text,'n')`], ['UPDATE project', `UPDATE public.projects SET description='n' WHERE id='${P1}'`], ['DELETE project', `DELETE FROM public.projects WHERE id='${P1}'`],
    ['INSERT project_member', `INSERT INTO public.project_members(project_id,user_id) VALUES ('${P1}', current_setting('request.jwt.claim.sub')::uuid)`],
    ['INSERT department', `INSERT INTO public.departments(name) VALUES ('zz'||floor(random()*1e9)::text)`], ['UPDATE department', `UPDATE public.departments SET description='n' WHERE id='${D1}'`],
    ['INSERT expense draft (own)', `INSERT INTO public.expenses(title,amount,category,submitted_by,status) VALUES ('n',5,'software', current_setting('request.jwt.claim.sub')::uuid,'draft')`],
    ['INSERT expense approved (own)', `INSERT INTO public.expenses(title,amount,category,submitted_by,status) VALUES ('n',5,'software', current_setting('request.jwt.claim.sub')::uuid,'approved')`],
    ['INSERT expense (other)', `INSERT INTO public.expenses(title,amount,category,submitted_by,status) VALUES ('n',5,'software','${U.EMP}','draft')`],
    ['UPDATE expense', `UPDATE public.expenses SET description='n' WHERE id='${EX1}'`],
    ['INSERT vendor', `INSERT INTO public.vendors(name) VALUES ('n')`], ['INSERT budget', `INSERT INTO public.budgets(name,amount) VALUES ('n',1)`],
    ['UPDATE invoice', `UPDATE public.invoices SET notes='n' WHERE invoice_number='B-1'`], ['INSERT invoice', `INSERT INTO public.invoices(invoice_number,type,status,due_date) VALUES ('Z-'||floor(random()*1e9)::text,'receivable','draft',current_date)`],
    ['DELETE invoice', `DELETE FROM public.invoices WHERE invoice_number='B-1'`],
    ['UPDATE finance_settings', `UPDATE public.finance_settings SET phone='1'`], ['UPDATE company_settings', `UPDATE public.company_settings SET value=value`],
    ['UPSERT money_figure', `INSERT INTO public.money_figures(entity,entity_id,amount) VALUES ('lead_value','${L1}',5) ON CONFLICT (entity,entity_id) DO UPDATE SET amount=5`],
    ['UPDATE notification (own)', `UPDATE public.notifications SET is_read=true WHERE id='${NT1}'`], ['UPDATE notification (any)', `UPDATE public.notifications SET is_read=true`],
    ['INSERT message', `INSERT INTO public.messages(conversation_id,sender_id,content) SELECT id, current_setting('request.jwt.claim.sub')::uuid, 'x' FROM public.conversations WHERE is_public LIMIT 1`],
    ['INSERT leave_request', `INSERT INTO public.leave_requests(user_id,leave_type_id,start_date,end_date,total_days,reason) SELECT current_setting('request.jwt.claim.sub')::uuid, id, '2031-01-01','2031-01-02',2,'r' FROM public.leave_types LIMIT 1`]);
  const writeSnapshot = async () => {
    const snap = {};
    for (const [name, id] of SNAP_USERS) {
      snap[name] = await asUser(id, async (c) => {
        const o = {};
        for (const [pn, q] of probes) {
          await c.query('SAVEPOINT p'); const r = await c.query(q).then((x) => 'ok:' + x.rowCount, (e) => 'err:' + e.code);
          o[pn] = r; await c.query('ROLLBACK TO SAVEPOINT p');
        }
        return o;
      });
    }
    return snap;
  };

  section('1. BEFORE migration 036: baseline of what every user can see and do');
  const visBefore = SKIP ? {} : await visibleSnapshot();
  const wrBefore = SKIP ? {} : await writeSnapshot();
  console.log(`   ${tables.length} tables with a rewritten policy x ${SNAP_USERS.length + 1} principals; ${probes.length} write probes x ${SNAP_USERS.length} users`);
  const Q = {
    'tasks page 1 (20 rows, created_at desc)': ['SELECT * FROM public.tasks ORDER BY created_at DESC, id LIMIT 20', ['EMP', 'DEPTMGR', 'ADMIN']],
    'tasks count(exact) for the pager': ['SELECT count(*) FROM public.tasks', ['EMP', 'DEPTMGR', 'ADMIN']],
    'dashboard: ALL tasks (status, department)': ['SELECT status, department_id FROM public.tasks', ['EMP', 'ADMIN']],
    'tasks in_progress count (dashboard)': ["SELECT count(*) FROM public.tasks WHERE status='in_progress'", ['EMP', 'ADMIN']],
    'documents: ALL task_attachments joined to tasks': ['SELECT a.*, t.title FROM public.task_attachments a JOIN public.tasks t ON t.id=a.task_id ORDER BY a.created_at DESC', ['EMP', 'ADMIN']],
    'task comments of one task': [`SELECT * FROM public.task_comments WHERE task_id='${T.own}'`, ['EMP', 'ADMIN']],
    'finance: fin_kpis()': ['SELECT * FROM public.fin_kpis()', ['OWNER']],
    'finance: invoices page 1 (20) with client': ['SELECT i.*, c.company_name FROM public.invoices i LEFT JOIN public.clients c ON c.id=i.client_id ORDER BY i.created_at DESC LIMIT 20', ['OWNER']],
    'chat: last 50 messages of a private conversation': [`SELECT * FROM public.messages WHERE conversation_id=(SELECT m.conversation_id FROM public.conversation_members m JOIN public.conversations c ON c.id=m.conversation_id WHERE m.user_id='${U.EMP}' AND NOT c.is_public LIMIT 1) ORDER BY created_at DESC LIMIT 50`, ['EMP']],
    'notifications: unread count': ['SELECT count(*) FROM public.notifications WHERE is_read=false', ['EMP']],
  };
  const measure = async () => {
    const res = {};
    for (const [name, [q, users]] of Object.entries(Q)) { res[name] = {}; for (const u of users) res[name][u] = await explain(U[u], q); }
    return res;
  };
  const mBefore = await measure();
  out.before = mBefore;
  for (const [n, v] of Object.entries(mBefore)) for (const [u, r] of Object.entries(v)) console.log(`   BEFORE ${n} [${u}]: ${r.error ? r.error : `${r.ms} ms, ${r.hit} buffer hits, ${r.rows} rows`}`);

  // concurrent requests BEFORE (same clients, same queries)
  const CONC_USERS = [U.EMP, U.EMP2, U.EMP3, U.ASSIGNEE, U.DEPTMGR, U.DEPTMGR2, U.PM, U.ADMIN];
  const concurrent = async (users) => {
    const t = process.hrtime.bigint();
    const results = await Promise.all(users.map(async (u) => {
      const s = process.hrtime.bigint();
      const r = await asUser(u, async (c) => {
        const page = (await c.query('SELECT id FROM public.tasks ORDER BY created_at DESC, id LIMIT 20')).rows.length;
        const total = Number((await c.query('SELECT count(*) n FROM public.tasks')).rows[0].n);
        const stats = (await c.query("SELECT count(*) n FROM public.tasks WHERE status='in_progress'")).rows[0].n;
        return { page, total, stats: Number(stats) };
      });
      return { u, ms: Number(process.hrtime.bigint() - s) / 1e6, r };
    }));
    const wall = Number(process.hrtime.bigint() - t) / 1e6;
    const ms = results.map((x) => x.ms).sort((a, b) => a - b);
    return { wall: +wall.toFixed(0), p50: +ms[Math.floor(ms.length / 2)].toFixed(0), p95: +ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))].toFixed(0), results };
  };
  const cBefore = await concurrent(CONC_USERS);
  out.concurrentBefore = { wall: cBefore.wall, p50: cBefore.p50, p95: cBefore.p95 };
  console.log(`   BEFORE ${CONC_USERS.length} concurrent users (page+count+stats each): wall ${cBefore.wall} ms, p50 ${cBefore.p50} ms, p95 ${cBefore.p95} ms`);

  // reference results for the aggregate / pagination tests (computed with the OLD policies)
  const refTasks = {};
  for (const [n, id] of [['EMP', U.EMP], ['DEPTMGR', U.DEPTMGR], ['ADMIN', U.ADMIN], ['ASSIGNEE', U.ASSIGNEE]])
    refTasks[n] = await asUser(id, async (c) => (await c.query('SELECT id, status, priority, department_id, project_id, campaign_id, due_date FROM public.tasks ORDER BY created_at DESC, id')).rows);

  const rolesBefore = (await db.query(`SELECT roles FROM pg_policies WHERE schemaname='public' ORDER BY tablename, policyname`)).rows.map((r) => String(r.roles));
  // ---------------------------------------------------------------- apply 036
  section('2. apply migration 036 (and again: idempotent)');
  const r1 = await tryq(db, sql('migrations/036_performance.sql'));
  ok(!r1.error, '036 applies on the complete chain', r1.error);
  const r2 = await tryq(db, sql('migrations/036_performance.sql'));
  ok(!r2.error, '036 can be run twice', r2.error);
  await db.query('VACUUM ANALYZE');
  const polAfter = await policies();
  ok(polAfter.length === polBefore.length, `no policy was added or removed (${polAfter.length})`);
  ok(JSON.stringify(polAfter.map((p) => [p.tablename, p.policyname, p.cmd])) === JSON.stringify(polBefore.map((p) => [p.tablename, p.policyname, p.cmd])), 'every policy keeps its name, table and command');
  ok(changed.length >= 100, `${changed.length} policies were rewritten`, String(changed.length));
  const rolesAfter = (await db.query(`SELECT roles FROM pg_policies WHERE schemaname='public' ORDER BY tablename, policyname`)).rows.map((r) => String(r.roles));
  ok(JSON.stringify(rolesAfter) === JSON.stringify(rolesBefore), 'the roles every policy applies to are unchanged');
  for (const f of ['auth_can_view_task(uuid)', 'auth_is_admin()', 'auth_is_staff()', 'auth_is_finance()', 'auth_can_view_conversation(uuid)', 'auth_is_dept_manager(uuid)']) {
    ok((await one(`SELECT to_regprocedure('public.${f}') p`)).p !== null, `the old helper ${f} is still there`);
  }

  // ---------------------------------------------------------------- equivalence
  section('3. RLS equivalence: every user sees exactly the same rows and every write has exactly the same outcome');
  if (!SKIP) {
  const visAfter = await visibleSnapshot();
  let cmp = 0, diffs = [];
  for (const [u, byTable] of Object.entries(visBefore)) for (const [t, v] of Object.entries(byTable)) { cmp++; if (visAfter[u][t] !== v) diffs.push(`${u}/${t}: ${v} -> ${visAfter[u][t]}`); }
  ok(diffs.length === 0, `SELECT: ${cmp} (principal x table) visible-row sets are identical (same rows, byte for byte)`, diffs.slice(0, 5).join(' | '));
  const wrAfter = await writeSnapshot();
  let wcmp = 0, wdiffs = [];
  for (const [u, byProbe] of Object.entries(wrBefore)) for (const [p, v] of Object.entries(byProbe)) { wcmp++; if (wrAfter[u][p] !== v) wdiffs.push(`${u}/${p}: ${v} -> ${wrAfter[u][p]}`); }
  ok(wdiffs.length === 0, `INSERT / UPDATE / DELETE: ${wcmp} (user x statement) outcomes are identical (allowed, denied, same row count)`, wdiffs.slice(0, 5).join(' | '));
  const allowed = Object.values(wrAfter).flatMap((o) => Object.values(o)).filter((x) => x.startsWith('ok:') && x !== 'ok:0').length;
  const denied = Object.values(wrAfter).flatMap((o) => Object.values(o)).filter((x) => x.startsWith('err:')).length;
  ok(allowed > 50 && denied > 50, `the probes exercise both allowed (${allowed}) and denied (${denied}) cases`);
  // the user-visible facts, stated explicitly (negative cases included)
  const seen = (u, t) => visAfter[u][t].split(':')[0];
  const nTasks = Number((await one('SELECT count(*) n FROM public.tasks')).n);
  ok(seen('ADMIN', 'tasks') == nTasks && seen('OWNER', 'tasks') == nTasks && seen('GM', 'tasks') == nTasks, 'admin roles see every task');
  ok(Number(seen('EMP', 'tasks')) > 0 && Number(seen('EMP', 'tasks')) < nTasks / 5, `an employee sees only their own / assigned tasks (${seen('EMP', 'tasks')} of ${nTasks})`);
  ok(Number(seen('DEPTMGR', 'tasks')) > Number(seen('EMP', 'tasks')) && Number(seen('DEPTMGR', 'tasks')) < nTasks, 'a department manager sees their department but not every task');
  {   // department and project isolation, stated explicitly (the snapshot above already proves they did not change)
    const vis = async (u, id) => (await asUser(u, async (c) => (await c.query('SELECT count(*)::int n FROM public.tasks WHERE id=$1', [id])).rows[0].n));
    const dept2 = (await one(`SELECT t.id FROM public.tasks t WHERE t.department_id=(SELECT id FROM public.departments WHERE name='Dept2') AND t.assigned_to IS DISTINCT FROM $1 AND t.created_by <> $1
      AND NOT EXISTS (SELECT 1 FROM public.task_assignees a WHERE a.task_id=t.id AND a.user_id=$1) AND NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id=t.project_id AND p.project_manager_id=$1) LIMIT 1`, [U.DEPTMGR])).id;
    ok(await vis(U.DEPTMGR, dept2) === 0 && await vis(U.DEPTMGR2, dept2) === 1, 'department isolation: the Dept1 manager cannot see an unrelated Dept2 task; the Dept2 manager can');
    const proj = (await one(`SELECT t.id FROM public.tasks t JOIN public.projects p ON p.id=t.project_id WHERE p.project_manager_id=$1 AND t.assigned_to IS DISTINCT FROM $2 AND t.created_by <> $2
      AND NOT EXISTS (SELECT 1 FROM public.task_assignees a WHERE a.task_id=t.id AND a.user_id=$2) AND (t.department_id IS NULL OR t.department_id NOT IN (SELECT id FROM public.departments WHERE manager_id=$2)) LIMIT 1`, [U.PM, U.PM2])).id;
    ok(await vis(U.PM, proj) === 1 && await vis(U.PM2, proj) === 0, 'project isolation: a project manager sees tasks of their own projects, not of another manager project');
    ok(await vis(U.EMP2, T.own) === 0 && await vis(U.EMP, T.own) === 1, 'an unrelated employee cannot see a task that is assigned to someone else');
  }
  ok(seen('CLIENT', 'tasks') === '0' && seen('NOROLE', 'tasks') === '0' && seen('INACTIVE', 'tasks') === '0', 'client-role, role-less and inactive users see NO task (isolation)');
  ok(visAfter.ANON.tasks.startsWith('denied') && visAfter.ANON.invoices.startsWith('denied'), 'anon is denied tasks and invoices');
  ok(seen('EMP', 'invoices') === '0' && seen('FIN', 'invoices') === '0' && seen('HR', 'invoices') === '0' && seen('PM', 'invoices') === '0', 'finance isolation: employee, finance_manager, HR and PM see no invoice (executive-only)');
  ok(seen('OWNER', 'invoices') == N.invoices && seen('ADMIN', 'invoices') == N.invoices, 'finance isolation: owner and super_admin see every invoice');
  ok(seen('EMP', 'expenses') === '0' && seen('OWNER', 'expenses') !== '0', 'expense claims stay executive-only');
  ok(wrAfter.EMP['INSERT task'].startsWith('err:') && wrAfter.ADMIN['INSERT task'].startsWith('err:'), 'tasks still cannot be written through the API at all (Edge Function only)');
  ok(wrAfter.EMP['UPDATE invoice'].startsWith('err:') || wrAfter.EMP['UPDATE invoice'] === 'ok:0', 'finance isolation: an employee cannot update an invoice');
  ok(wrAfter.OWNER['UPDATE invoice'] === 'ok:0' || wrAfter.OWNER['UPDATE invoice'].startsWith('err:'), 'finance isolation: even the owner cannot write an invoice directly (fin_* functions only)');
  ok(wrAfter.EMP3['INSERT task_comment on own'] !== undefined && wrAfter.CLIENT['INSERT task_comment on own'].startsWith('err:'), 'a client-role user cannot comment on a task');
  ok(wrAfter.EMP2['INSERT task_comment on own'].startsWith('err:') && wrAfter.EMP['INSERT task_comment on own'].startsWith('ok:'), 'only people who can see a task can comment on it');
  ok(wrAfter.ASSIGNEE['INSERT task_comment on viaAssignee'].startsWith('ok:') && wrAfter.EMP2['INSERT task_comment on viaAssignee'].startsWith('err:'), 'a collaborator (task_assignees) can comment; an unrelated employee cannot');
  ok(wrAfter.PM['INSERT task_comment on pmProj'].startsWith('ok:') && wrAfter.DEPTMGR['INSERT task_comment on dept1'].startsWith('ok:'), 'a project manager (their project) and a department manager (their department) can comment');
  // structural proof for the mechanical part: undo the rewrite on the deparsed text and compare with the original
  const norm = (s) => String(s || '').replace(/\(\s*SELECT\s+([^()]*(?:\([^()]*\))?)\s+AS\s+\w+\)/gi, '$1')
    .replace(/\(?\s*EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+(?:public\.)?tasks\s+t_vis\s+WHERE\s+\(?t_vis\.id\s*=\s*\w+\.(\w+)\)?\s*\)\s*\)?/gi, 'auth_can_view_task($1)')
    .replace(/public\./g, '').replace(/[\s()]/g, '');
  let structural = 0, structBad = [];
  for (let i = 0; i < polBefore.length; i++) {
    const a = polBefore[i], b = polAfter[i];
    if (a.tablename === 'tasks' && a.policyname === 'tasks_select') continue;
    structural++;
    if (norm(a.qual) !== norm(b.qual) || norm(a.with_check) !== norm(b.with_check)) structBad.push(`${a.tablename}.${a.policyname}`);
  }
  ok(structBad.length === 0, `structural proof: undoing the rewrite on all ${structural} other policies gives the original text`, structBad.slice(0, 6).join(', '));
  ok(!/auth_can_view_task/.test(polAfter.filter((p) => p.tablename === 'tasks').map((p) => p.qual).join('')), 'tasks_select no longer calls auth_can_view_task per row');

  // self-test of the harness: a deliberately BROKEN tasks policy must be detected (and is rolled back)
  {
    const c = await connect();
    try { await c.query('BEGIN'); await c.query('ALTER POLICY tasks_select ON public.tasks USING (assigned_to = (SELECT auth.uid()))'); await c.query('SET LOCAL ROLE authenticated');
      await c.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [U.DEPTMGR]);
      const r = await c.query(`SELECT count(*)::int n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) h FROM public.tasks x`); await c.query('ROLLBACK');
      ok(r.rows[0].n + ':' + r.rows[0].h !== visBefore.DEPTMGR.tasks, 'self-test: the snapshot comparison DOES detect a policy that hides a department manager tasks'); }
    finally { await c.end(); }
  }
  }
  // ---------------------------------------------------------------- before / after
  section('4. BEFORE / AFTER: EXPLAIN (ANALYZE, BUFFERS) on the same dataset, users and queries');
  const mAfter = await measure();
  out.after = mAfter;
  const rows = [];
  for (const [n, v] of Object.entries(mBefore)) for (const [u, b] of Object.entries(v)) {
    const a = mAfter[n][u];
    rows.push({ q: n, user: u, beforeMs: b.ms, afterMs: a.ms, beforeHit: b.hit, afterHit: a.hit, rows: a.rows, plan: a.nodes.slice(0, 3).join(' > ') });
    console.log(`   ${n} [${u}]: ${b.ms} ms -> ${a.ms} ms   |  buffer hits ${b.hit} -> ${a.hit}  (${(b.hit / Math.max(1, a.hit)).toFixed(0)}x fewer)`);
    ok(a.rows === b.rows, `same row count before and after: ${n} [${u}]`, `${b.rows} vs ${a.rows}`);
  }
  out.table = rows;
  const get = (n, u) => ({ b: mBefore[n][u], a: mAfter[n][u] });
  const MIN = SCALE >= 0.1 ? 20 : 5;
  for (const u of ['EMP', 'DEPTMGR', 'ADMIN']) {
    const x = get('tasks page 1 (20 rows, created_at desc)', u);
    ok(x.b.hit / Math.max(1, x.a.hit) >= MIN, `tasks page 1 [${u}] reads at least ${MIN}x fewer buffers (${x.b.hit} -> ${x.a.hit})`);
    const y = get('tasks count(exact) for the pager', u);
    ok(y.b.hit / Math.max(1, y.a.hit) >= MIN, `tasks count [${u}] reads at least ${MIN}x fewer buffers (${y.b.hit} -> ${y.a.hit})`);
  }
  ok(get('tasks page 1 (20 rows, created_at desc)', 'ADMIN').a.nodes.some((n) => /idx_tasks_created_desc/.test(n)), 'the admin page 1 plan walks idx_tasks_created_desc (stops after 20 rows)');
  ok(get('finance: invoices page 1 (20) with client', 'OWNER').a.nodes.some((n) => /idx_invoices_created_desc/.test(n)), 'the invoices page plan walks idx_invoices_created_desc');
  ok(get('finance: fin_kpis()', 'OWNER').b.hit / Math.max(1, get('finance: fin_kpis()', 'OWNER').a.hit) >= 3, 'fin_kpis() reads at least 3x fewer buffers');
  ok(get('documents: ALL task_attachments joined to tasks', 'EMP').b.hit > get('documents: ALL task_attachments joined to tasks', 'EMP').a.hit * 3, 'the attachments join no longer evaluates the task policy per row');
  const chat = get('chat: last 50 messages of a private conversation', 'EMP');
  ok(chat.a.hit <= chat.b.hit * 2 + 200, `chat messages are not made slower (${chat.b.hit} -> ${chat.a.hit} buffer hits)`);
  const nots = get('notifications: unread count', 'EMP');
  ok(nots.a.hit <= nots.b.hit + 5, 'notifications are not made slower');
  for (const [t, col] of [['tasks', 'idx_tasks_created_desc'], ['invoices', 'idx_invoices_created_desc'], ['expenses', 'idx_expenses_created_desc'], ['task_attachments', 'idx_task_attachments_created_desc'], ['assets', 'idx_assets_created_desc'], ['leads', 'idx_leads_created_desc']])
    ok((await one(`SELECT count(*)::int n FROM pg_indexes WHERE schemaname='public' AND tablename=$1 AND indexname=$2`, [t, col])).n === 1, `index ${col} exists`);
  const idxAll = (await one(`SELECT count(*)::int n FROM pg_indexes WHERE schemaname='public'`)).n;
  ok(idxAll >= 258 + 6, `no existing index was removed (${idxAll} indexes now)`, String(idxAll));

  // ---------------------------------------------------------------- aggregates
  section('5. aggregates: the database counts exactly what the browser used to count');
  const stat = async (u) => (await asUser(U[u], async (c) => (await c.query('SELECT dimension, key, n::int n FROM public.task_stats()')).rows));
  for (const u of ['EMP', 'DEPTMGR', 'ADMIN', 'ASSIGNEE']) {
    const rowsU = refTasks[u]; const s = await stat(u);
    const by = (dim) => Object.fromEntries(s.filter((x) => x.dimension === dim).map((x) => [x.key, x.n]));
    const cnt = (f) => { const m = {}; rowsU.forEach((r) => { const k = f(r); if (k !== undefined) m[k] = (m[k] || 0) + 1; }); return m; };
    ok(JSON.stringify(by('status')) === JSON.stringify(cnt((r) => r.status)) || sameObj(by('status'), cnt((r) => r.status)), `task_stats() status counts equal the rows [${u}]`);
    ok(sameObj(by('priority'), cnt((r) => r.priority)), `task_stats() priority counts equal the rows [${u}]`);
    ok(sameObj(by('active_department'), cnt((r) => (['completed', 'approved', 'cancelled'].includes(r.status) ? undefined : (r.department_id || '')))), `task_stats() active-department counts equal the rows [${u}]`);
    ok(s.reduce((a, x) => a + (x.dimension === 'status' ? x.n : 0), 0) === rowsU.length, `the status counts add up to every visible task [${u}] (${rowsU.length})`);
  }
  function sameObj(a, b) { const ka = Object.keys(a).sort(), kb = Object.keys(b).sort(); return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]); }
  const today = new Date().toISOString().slice(0, 10);
  const DONE = new Set(['completed', 'approved']);
  for (const [u, id] of [['EMP', U.EMP], ['DEPTMGR', U.DEPTMGR], ['ADMIN', U.ADMIN], ['PM', U.PM]]) {
    // the OLD browser logic of the client hub, on the rows that user may read
    const ref = await asUser(id, async (c) => {
      const pr = (await c.query('SELECT id, client_id, status FROM public.projects')).rows;
      const ca = (await c.query('SELECT id, client_id FROM public.campaigns')).rows;
      const tk = (await c.query('SELECT id, status, due_date::text due_date, project_id, campaign_id FROM public.tasks')).rows;
      return { pr, ca, tk };
    });
    const projClient = new Map(ref.pr.map((p) => [p.id, p.client_id])), campClient = new Map(ref.ca.map((c) => [c.id, c.client_id]));
    const st = new Map(); const get2 = (k) => { if (!st.has(k)) st.set(k, { open: 0, done: 0, projects: 0, late: 0 }); return st.get(k); };
    ref.pr.forEach((p) => { if (p.client_id && !['completed', 'cancelled'].includes(p.status)) get2(p.client_id).projects++; });
    ref.tk.forEach((t) => { const cid = projClient.get(t.project_id) || campClient.get(t.campaign_id); if (!cid) return; const s = get2(cid);
      if (DONE.has(t.status)) s.done++; else if (t.status !== 'cancelled') { s.open++; if (t.due_date && t.due_date.slice(0, 10) < today) s.late++; } });
    const got = await asUser(id, async (c) => (await c.query('SELECT client_id, open_count::int o, done_count::int d, late_count::int l, project_count::int p FROM public.client_task_stats($1::date)', [today])).rows);
    const gm = new Map(got.map((r) => [r.client_id, { open: r.o, done: r.d, late: r.l, projects: r.p }]));
    const same = st.size === [...gm.entries()].filter(([, v]) => v.open + v.done + v.projects > 0).length && [...st.entries()].every(([k, v]) => { const g = gm.get(k); return g && g.open === v.open && g.done === v.done && g.late === v.late && g.projects === v.projects; });
    ok(same, `client_task_stats() equals the old client-hub computation for ${st.size} clients [${u}]`);
  }
  const anonStats = await asUser(null, (c) => tryq(c, 'SELECT * FROM public.task_stats()'), { role: 'anon' });
  ok(!!anonStats.error && /permission denied/.test(anonStats.error), 'anon cannot call task_stats()');
  const clientStats = await stat('CLIENT'); const noStats = await stat('NOROLE');
  ok(clientStats.every((x) => x.n === 0) || clientStats.length === 0, 'a client-role user counts nothing through task_stats()');
  ok(noStats.length === 0, 'a role-less user counts nothing through task_stats()');
  ok((await one(`SELECT bool_and(prosecdef = false) b FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('task_stats','client_task_stats')`)).b === true, 'both aggregates are SECURITY INVOKER (RLS applies)');

  // ---------------------------------------------------------------- pagination on the large dataset
  section(`6. pagination on ${N.tasks} tasks: pages are complete, disjoint, ordered; deep pages stay cheap`);
  const SIZE = 25;
  for (const [u, id] of [['ADMIN', U.ADMIN], ['DEPTMGR', U.DEPTMGR], ['EMP', U.EMP]]) {
    const total = refTasks[u].length; const pages = Math.ceil(total / SIZE); const seenIds = new Set(); let order = true, prev = null;
    const times = [];
    const res = await asUser(id, async (c) => {
      const tt = Number((await c.query('SELECT count(*) n FROM public.tasks')).rows[0].n);
      const sample = pages > 40 ? [...new Set([1, 2, 3, Math.floor(pages / 2), pages - 1, pages])] : Array.from({ length: pages }, (_, i) => i + 1);
      const pageRows = {};
      for (const p of sample) { const s = process.hrtime.bigint(); pageRows[p] = (await c.query('SELECT id, created_at FROM public.tasks ORDER BY created_at DESC, id LIMIT $1 OFFSET $2', [SIZE, (p - 1) * SIZE])).rows; times.push(Number(process.hrtime.bigint() - s) / 1e6); }
      return { tt, pageRows };
    });
    ok(res.tt === total, `[${u}] the pager total equals the number of visible tasks (${total})`);
    for (const [p, rws] of Object.entries(res.pageRows)) {
      const expect = Number(p) < pages ? SIZE : total - (pages - 1) * SIZE;
      ok(rws.length === expect, `[${u}] page ${p} has ${expect} rows`, String(rws.length));
      rws.forEach((r) => { if (seenIds.has(r.id)) order = false; seenIds.add(r.id); if (prev && new Date(r.created_at) > prev && Number(p) === 1) order = false; prev = new Date(r.created_at); });
    }
    ok(order, `[${u}] sampled pages never repeat a task and are ordered newest first`);
    const exp = refTasks[u];
    const firstPage = res.pageRows[1].map((r) => r.id).join();
    ok(firstPage === exp.slice(0, SIZE).map((r) => r.id).join(), `[${u}] page 1 is the same 25 tasks as before the migration`);
    const lastP = res.pageRows[pages];
    ok(lastP.map((r) => r.id).join() === exp.slice((pages - 1) * SIZE).map((r) => r.id).join(), `[${u}] the last page is the same tasks as before the migration`);
    console.log(`   [${u}] ${pages} pages; sampled page times (ms): ${times.map((x) => x.toFixed(0)).join(', ')}`);
    ok(Math.max(...times) < 5000, `[${u}] every sampled page, including the last, answers within 5 s`, String(Math.max(...times)));
  }
  const search = await asUser(U.ADMIN, async (c) => (await c.query(`SELECT id FROM public.tasks WHERE title ILIKE '%Task 5%' ORDER BY created_at DESC, id LIMIT 25`)).rows.length);
  ok(search === 25, 'a title search still returns a full first page');
  // the bounded reads the screens now use
  const bounded = await asUser(U.ADMIN, async (c) => {
    const a = await c.query('SELECT id, task_number, title, status, assigned_to FROM public.tasks ORDER BY created_at DESC, id LIMIT 25');
    const d = await c.query("SELECT id FROM public.tasks WHERE title ILIKE '%Task 1%' ORDER BY created_at DESC, id LIMIT 500");
    return [a.rows.length, d.rows.length];
  });
  ok(bounded[0] === 25 && bounded[1] <= 500, 'a bounded read never returns more than its limit');

  // ---------------------------------------------------------------- concurrency
  section('7. concurrent requests: the same clients, queries and dataset');
  const cAfter = await concurrent(CONC_USERS);
  out.concurrentAfter = { wall: cAfter.wall, p50: cAfter.p50, p95: cAfter.p95 };
  console.log(`   AFTER  ${CONC_USERS.length} concurrent users: wall ${cAfter.wall} ms, p50 ${cAfter.p50} ms, p95 ${cAfter.p95} ms   (before: wall ${cBefore.wall}, p50 ${cBefore.p50}, p95 ${cBefore.p95})`);
  ok(cAfter.results.every((x) => !x.r.error), 'every concurrent request succeeded');
  const sameAnswers = cAfter.results.every((x, i) => JSON.stringify(x.r) === JSON.stringify(cBefore.results[i].r));
  ok(sameAnswers, 'every concurrent user got exactly the same page size, total and counts as before the migration');
  ok(cAfter.wall * (SCALE >= 0.1 ? 5 : 1.5) < cBefore.wall, `the concurrent batch finishes ${SCALE >= 0.1 ? 5 : 1.5}x faster (${cBefore.wall} -> ${cAfter.wall} ms)`);
  const MANY = [...CONC_USERS, ...CONC_USERS, ...CONC_USERS, ...CONC_USERS];       // 32 simultaneous requests
  const big = await concurrent(MANY);
  out.concurrent32 = { wall: big.wall, p50: big.p50, p95: big.p95 };
  console.log(`   AFTER  ${MANY.length} concurrent users: wall ${big.wall} ms, p50 ${big.p50} ms, p95 ${big.p95} ms`);
  ok(big.results.every((x) => !x.r.error) && big.p95 < 15000, `${MANY.length} simultaneous users: all succeed, p95 under 15 s`);

  // ---------------------------------------------------------------- rollback
  section('8. rollback: supabase/maintenance/rollback-036.sql restores every original policy and removes what 036 added; 036 can be applied again');
  {
    const rb = await tryq(db, sql('maintenance/rollback-036.sql'));
    ok(!rb.error, 'the rollback script runs', rb.error);
    const polRb = await policies();
    ok(polRb.length === polBefore.length && polRb.every((p, i) => p.qual === polBefore[i].qual && p.with_check === polBefore[i].with_check && p.policyname === polBefore[i].policyname),
      `all ${polBefore.length} policies are back to their exact original text`);
    ok((await one(`SELECT count(*)::int n FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('task_stats','client_task_stats','auth_managed_department_ids','auth_assigned_task_ids','auth_managed_project_ids')`)).n === 0, 'the helpers and aggregates are gone');
    ok((await one(`SELECT count(*)::int n FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'idx\_%\_created\_desc'`)).n === 0, 'the six new indexes are gone');
    ok((await one(`SELECT to_regprocedure('public.auth_can_view_task(uuid)') p`)).p !== null, 'the old helpers were never touched');
    const seeRb = await asUser(U.EMP, async (c) => Number((await c.query('SELECT count(*) n FROM public.tasks')).rows[0].n));
    ok(seeRb === refTasks.EMP.length, 'after the rollback an employee sees exactly the same tasks as before the migration');
    const again = await tryq(db, sql('migrations/036_performance.sql'));
    ok(!again.error, '036 applies again after a rollback', again.error);
    const polAgain = await policies();
    ok(polAgain.every((p, i) => p.qual === polAfter[i].qual && p.with_check === polAfter[i].with_check), 'and gives back exactly the same policies');
  }

  if (process.env.BENCH_JSON) fs.writeFileSync(process.env.BENCH_JSON, JSON.stringify(out, null, 1));
  console.log(`\n${passed} passed, ${failed} failed`);
} catch (e) { failed++; console.log('SCRIPT ERROR', e); }
finally {
  for (const c of conns) { try { await c.end(); } catch { /* closed */ } }
  try { await server.stop(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(failed ? 1 : 0);
