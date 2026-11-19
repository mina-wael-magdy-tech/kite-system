// Real-PostgreSQL regression + concurrency tests for Phase 3.B-3.E (migrations 029-033) on the COMPLETE migration chain
// (001 ... 033, including 026, 027 and 028). A throwaway local PostgreSQL (embedded-postgres, temp dir, deleted at the end);
// it never touches any remote database.   Run:  npm install --no-save embedded-postgres pg  &&  node verify-integrity.mjs
// Without the optional dependencies it prints SKIPPED and exits 0.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SB = path.resolve(HERE, '..');
let EmbeddedPostgres, pg;
try { EmbeddedPostgres = (await import('embedded-postgres')).default; pg = (await import('pg')).default; }
catch { console.log('SKIPPED: install the optional dependencies first:  npm install --no-save embedded-postgres pg'); process.exit(0); }

let passed = 0, failed = 0;
const ok = (c, name, d = '') => { if (c) passed++; else { failed++; console.log('FAIL', name, d); } };
const section = (s) => console.log('\n== ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (f) => fs.readFileSync(path.join(SB, f), 'utf8');
const num = (x) => Number(x);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-int-'));
const PORT = 56100 + Math.floor(Math.random() * 800);
const server = new EmbeddedPostgres({ databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'pw', port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
const conns = [];
const connect = async (db = 'kite', notices) => {
  const c = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'pw', database: db });
  await c.connect(); c.on('error', () => {}); if (notices) c.on('notice', (n) => notices.push(n.message)); conns.push(c); return c;
};
/** run a statement and return { rows } or { error } (the message of the database error) */
const tryq = async (c, q, p = []) => { try { return { rows: (await c.query(q, p)).rows }; } catch (e) { return { error: e.message, code: e.code }; } };
const expectErr = async (c, q, p, re) => { const r = await tryq(c, q, p); return !!r.error && (!re || re.test(r.error)); };

const STUBS = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE authenticator NOLOGIN;
CREATE SCHEMA auth; CREATE SCHEMA storage;
CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, raw_user_meta_data jsonb);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth, storage, public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects (id uuid DEFAULT gen_random_uuid(), bucket_id text, name text, owner_id text);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY; GRANT ALL ON storage.objects, storage.buckets TO authenticated, service_role;
CREATE PUBLICATION supabase_realtime; CREATE SCHEMA realtime;
CREATE TABLE realtime.messages(id bigserial primary key, topic text, extension text); ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql AS $$ select null::text $$;
GRANT USAGE ON SCHEMA realtime TO authenticated;`;

let seq = 0;
const uid = (n) => `00000000-0000-4000-8000-${String(n ?? ++seq + 5000).padStart(12, '0')}`;
const conversion = {};

try {
  await server.initialise(); await server.start();
  const c0 = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'pw', database: 'postgres' }); await c0.connect();
  await c0.query(`CREATE DATABASE kite ENCODING 'UTF8' TEMPLATE template0 LOCALE 'C'`); await c0.end();
  const notices = [];
  const db = await connect('kite', notices);
  console.log('real PostgreSQL ' + (await db.query('SHOW server_version')).rows[0].server_version + ' on port ' + PORT);
  await db.query(STUBS);

  // ================================================================== 0. the complete chain
  section('0. complete migration chain 001 -> 034 on real PostgreSQL (incl. 026, 027, 028), then 029-034 again (idempotent)');
  const files = fs.readdirSync(path.join(SB, 'migrations')).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  let chainOk = true;
  for (const f of files) {
    const r = await tryq(db, sql('migrations/' + f));
    if (r.error) { chainOk = false; console.log('FAIL migration', f, r.error.slice(0, 200)); failed++; }
    if (f.startsWith('005')) await db.query(sql('seed.sql'));
  }
  ok(chainOk && files.length >= 34 && files.includes('034_invitation_activation.sql'), `all ${files.length} migrations apply in order`);
  for (const f of files.filter((x) => /^0(29|30|31|32|33|34|35|36|37|38)_/.test(x))) { const r = await tryq(db, sql('migrations/' + f)); ok(!r.error, `${f} can be run twice`, r.error); }
  ok(notices.filter((m) => /NOT VALID|was NOT created/.test(m)).length === 0, 'a clean database raises no "NOT VALID / not created" notice', notices.filter((m) => /NOT VALID|NOT created/.test(m)).join(' | ').slice(0, 300));

  // fixtures ------------------------------------------------------------------------------------------------------------------
  const roleId = async (n) => (await db.query('SELECT id FROM public.roles WHERE name=$1', [n])).rows[0].id;
  const mkUser = async (key, role = 'employee', status = 'active') => {
    const id = uid(); await db.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [id, key + '@x.test']);
    await db.query("INSERT INTO public.profiles(id,full_name,email,employment_status) VALUES ($1,$2,$3,$4)", [id, key, key + '@x.test', status]);
    await db.query('INSERT INTO public.user_roles(user_id,role_id) VALUES ($1,$2)', [id, await roleId(role)]);
    return id;
  };
  /** run SQL as a signed-in user (RLS applies); the result of the LAST statement is returned */
  const asUser = async (user, q, p = []) => {
    const c = await connect('kite');
    try { await c.query('BEGIN'); await c.query('SET LOCAL ROLE authenticated'); await c.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [user]);
      const r = await tryq(c, q, p); await c.query(r.error ? 'ROLLBACK' : 'COMMIT'); return r; }
    finally { await c.end(); }
  };
  const ADMIN = await mkUser('admin', 'super_admin'), OWNER = await mkUser('owner', 'owner'), HR = await mkUser('hr', 'hr_manager'), E1 = await mkUser('e1'), E2 = await mkUser('e2');
  const count = async (q, p = []) => num((await db.query(q, p)).rows[0].c);
  const client = async (n = 'C') => (await db.query("INSERT INTO public.clients(name,company_name) VALUES ($1,$1) RETURNING id", [n + Math.random()])).rows[0].id;

  // ================================================================== 1. F-02
  section('1. F-02 an employee with history cannot be hard-deleted; one without can, and leaves a tombstone');
  {
    const probes = {
      attendance: (u) => db.query("INSERT INTO public.attendance_records(user_id,check_in,date) VALUES ($1, now(), current_date)", [u]),
      'leave requests': async (u) => { const t = (await db.query("INSERT INTO public.leave_types(name,default_days) VALUES ('T'||random(),30) RETURNING id")).rows[0].id;
        return db.query("INSERT INTO public.leave_requests(user_id,leave_type_id,start_date,end_date,total_days,reason) VALUES ($1,$2,'2030-01-01','2030-01-02',2,'r')", [u, t]); },
      'chat messages': async (u) => { const cv = (await db.query("INSERT INTO public.conversations(type,name) VALUES ('group','g') RETURNING id")).rows[0].id;
        return db.query("INSERT INTO public.messages(conversation_id,sender_id,content) VALUES ($1,$2,'hi')", [cv, u]); },
      'HR documents': (u) => db.query("INSERT INTO public.employee_documents(user_id,document_type,file_name,storage_path,uploaded_by) VALUES ($1,'cv','a.pdf','p/a.pdf',$2)", [u, ADMIN]),
      'task comments': async (u) => { const t = (await db.query("INSERT INTO public.tasks(title,created_by) VALUES ('t',$1) RETURNING id", [ADMIN])).rows[0].id;
        return db.query("INSERT INTO public.task_comments(task_id,user_id,content) VALUES ($1,$2,'c')", [t, u]); },
      'time entries': async (u) => { const t = (await db.query("INSERT INTO public.tasks(title,created_by) VALUES ('t',$1) RETURNING id", [ADMIN])).rows[0].id;
        return db.query("INSERT INTO public.task_time_entries(task_id,user_id,hours) VALUES ($1,$2,1)", [t, u]); },
      'audit records': (u) => db.query("INSERT INTO public.audit_logs(user_id,action,entity_type) VALUES ($1,'X','y')", [u]),
      'finance audit': (u) => db.query("INSERT INTO public.finance_audit_log(actor,table_name,action) VALUES ($1,'invoices','INSERT')", [u]),
    };
    for (const [source, mk] of Object.entries(probes)) {
      const u = await mkUser('h_' + source.replace(/\W/g, ''));
      await mk(u);
      const r = await tryq(db, 'DELETE FROM public.profiles WHERE id=$1', [u]);
      ok(!!r.error && /employee_has_history/.test(r.error) && r.error.includes(source), `delete refused: employee has ${source}`, r.error);
      ok(await count('SELECT count(*)::int c FROM public.profiles WHERE id=$1', [u]) === 1, `  ... the profile is still there (${source})`);
      const viaAuth = await tryq(db, 'DELETE FROM auth.users WHERE id=$1', [u]);
      ok(!!viaAuth.error || await count('SELECT count(*)::int c FROM public.profiles WHERE id=$1', [u]) === 1, `  ... and deleting the auth user (cascade) is refused too (${source})`, viaAuth.error);
    }
    const hist = await db.query("SELECT source FROM public.employee_history($1)", [(await db.query("SELECT id FROM public.profiles WHERE email='h_attendance@x.test'")).rows[0].id]);
    ok(hist.rows.map((r) => r.source).join() === 'attendance', 'employee_history() lists exactly the sources that exist');
    // a brand-new account with nothing recorded can be removed (an onboarding invitation that was never accepted)
    const fresh = await mkUser('fresh');
    const del = await tryq(db, 'DELETE FROM auth.users WHERE id=$1', [fresh]);
    ok(!del.error, 'an account with no history can be deleted', del.error);
    ok(await count('SELECT count(*)::int c FROM public.deleted_users WHERE id=$1 AND email=$2', [fresh, 'fresh@x.test']) === 1, '... and a tombstone (name, e-mail, snapshot) is written');
    // attribution survives (operator override of the guard for ONE delete: the audit foreign key then sets user_id to NULL)
    const gone = await mkUser('gone'); await db.query("INSERT INTO public.audit_logs(user_id,action,entity_type) VALUES ($1,'DID_SOMETHING','x')", [gone]);
    ok((await db.query("SELECT actor_id, actor_label FROM public.audit_logs WHERE action='DID_SOMETHING'")).rows[0].actor_label === 'gone', 'a new audit row records actor_id + actor_label');
    await db.query('ALTER TABLE public.profiles DISABLE TRIGGER profiles_a_history_guard');
    const forced = await tryq(db, 'DELETE FROM public.profiles WHERE id=$1', [gone]);
    await db.query('ALTER TABLE public.profiles ENABLE TRIGGER profiles_a_history_guard');
    const row = (await db.query("SELECT user_id, actor_id, actor_label FROM public.audit_logs WHERE action='DID_SOMETHING'")).rows[0];
    ok(!forced.error && row.user_id === null && row.actor_id === gone && row.actor_label === 'gone', 'operator-forced delete: audit user_id becomes NULL (FK) but actor_id + actor_label keep who did it', JSON.stringify([forced, row]));
    ok(await count('SELECT count(*)::int c FROM public.deleted_users WHERE id=$1', [gone]) === 1, '... and the tombstone exists');
    ok(await expectErr(db, 'DELETE FROM public.audit_logs', [], /append-only/), 'audit_logs rows cannot be deleted even by an operator statement');
  }


  await db.query('GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role');   // what Supabase grants by default

  // ================================================================== 2. F-08
  section('2. F-08 clients / projects / departments / tasks with history cannot be deleted (archive instead); the message hides finance detail');
  {
    const invoiceFor = async (clientId, extra = {}) => (await db.query(`SELECT public.fin_invoice_save($1,$2::jsonb) id`, [ADMIN, JSON.stringify({ client_id: clientId, items: [{ description_en: 'x', quantity: 1, unit_price: 100 }], ...extra })])).rows[0].id;
    const c1 = await client('HasInv'); const inv = await invoiceFor(c1);
    let r = await tryq(db, 'DELETE FROM public.clients WHERE id=$1', [c1]);
    ok(!!r.error && /record_has_history/.test(r.error) && /Inactive/.test(r.error), 'client with an invoice: delete refused with "set it Inactive"', r.error);
    ok(!/invoice|payment|EGP|\d/.test(r.error.replace(/record_has_history/, '')), '  ... and the message mentions no invoice, amount or count (finance stays executive-only)', r.error);
    ok((await db.query('SELECT public.deletion_blockers($1,$2) b', ['client', c1])).rows[0].b.join().includes('invoices: 1'), '  ... deletion_blockers() (service role) gives the detail');
    ok((await asUser(OWNER, "SELECT public.deletion_blockers('client', $1)", [c1])).error !== undefined, '  ... and deletion_blockers() is not callable by a signed-in user');
    const c2 = await client('Plan'); await db.query("INSERT INTO public.retainer_plans(client_id,name,monthly_fee,start_date) VALUES ($1,'plan',10,'2026-01-01')", [c2]);
    ok(await expectErr(db, 'DELETE FROM public.clients WHERE id=$1', [c2], /record_has_history|retainer|foreign key/), 'client with a retainer plan: delete refused');
    const c3 = await client('Clean'); const lead = (await db.query("INSERT INTO public.leads(client_id,title) VALUES ($1,'deal') RETURNING id", [c3])).rows[0].id;
    ok(!(await tryq(db, 'DELETE FROM public.clients WHERE id=$1', [c3])).error && await count('SELECT count(*)::int c FROM public.leads WHERE id=$1', [lead]) === 0, 'a client with no financial history is deleted (its deals go with it, as the dialog says)');
    // projects
    const p1 = (await db.query("INSERT INTO public.projects(code,name) VALUES ('P1','p1') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO public.expenses(title,amount,category,submitted_by,project_id,status) VALUES ('e',5,'other',$1,$2,'submitted')", [E1, p1]);
    ok(await expectErr(db, 'DELETE FROM public.projects WHERE id=$1', [p1], /record_has_history/), 'project with an expense: delete refused');
    const p2 = (await db.query("INSERT INTO public.projects(code,name) VALUES ('P2','p2') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO public.budgets(name,project_id,amount) VALUES ('b',$1,5)", [p2]);
    ok(await expectErr(db, 'DELETE FROM public.projects WHERE id=$1', [p2], /record_has_history/), 'project with a budget: delete refused');
    const p3 = (await db.query("INSERT INTO public.projects(code,name) VALUES ('P3','p3') RETURNING id")).rows[0].id;
    const t3 = (await db.query("INSERT INTO public.tasks(title,created_by,project_id) VALUES ('t',$1,$2) RETURNING id", [ADMIN, p3])).rows[0].id;
    ok(!(await tryq(db, 'DELETE FROM public.projects WHERE id=$1', [p3])).error && (await db.query('SELECT project_id FROM public.tasks WHERE id=$1', [t3])).rows[0].project_id === null, 'a project with only tasks is deleted; its tasks are kept (as the dialog says)');
    // departments
    const d1 = (await db.query("INSERT INTO public.departments(name) VALUES ('D1') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO public.budgets(name,department_id,amount) VALUES ('b',$1,5)", [d1]);
    ok(await expectErr(db, 'DELETE FROM public.departments WHERE id=$1', [d1], /record_has_history/), 'department with a budget: delete refused (it used to cascade the budget away silently)');
    ok(await count('SELECT count(*)::int c FROM public.budgets WHERE department_id=$1', [d1]) === 1, '  ... the budget is still there');
    const d2 = (await db.query("INSERT INTO public.departments(name) VALUES ('D2') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO public.retainer_plans(client_id,department_id,name,monthly_fee,start_date) VALUES ($1,$2,'plan',10,'2026-01-01')", [await client(), d2]);
    ok(await expectErr(db, 'DELETE FROM public.departments WHERE id=$1', [d2], /record_has_history/), 'department with a retainer plan: delete refused');
    const d3 = (await db.query("INSERT INTO public.departments(name) VALUES ('D3') RETURNING id")).rows[0].id;
    ok(!(await tryq(db, 'DELETE FROM public.departments WHERE id=$1', [d3])).error, 'an empty department is deleted');
    // tasks
    const tk1 = (await db.query("INSERT INTO public.tasks(title,created_by) VALUES ('billed',$1) RETURNING id", [ADMIN])).rows[0].id;
    await db.query(`UPDATE public.invoices SET task_id=$1 WHERE id=$2`, [tk1, inv]);
    ok(await expectErr(db, 'DELETE FROM public.tasks WHERE id=$1', [tk1], /record_has_history.*Cancel/), 'a task that an invoice refers to cannot be deleted (cancel it)');
    const tk2 = (await db.query("INSERT INTO public.tasks(title,created_by) VALUES ('timed',$1) RETURNING id", [ADMIN])).rows[0].id;
    await db.query("INSERT INTO public.task_time_entries(task_id,user_id,hours) VALUES ($1,$2,2)", [tk2, E1]);
    ok(await expectErr(db, 'DELETE FROM public.tasks WHERE id=$1', [tk2], /record_has_history/), 'a task with time entries cannot be deleted');
    const parent = (await db.query("INSERT INTO public.tasks(title,created_by) VALUES ('parent',$1) RETURNING id", [ADMIN])).rows[0].id;
    const child = (await db.query("INSERT INTO public.tasks(title,created_by,parent_task_id) VALUES ('child',$1,$2) RETURNING id", [ADMIN, parent])).rows[0].id;
    await db.query("INSERT INTO public.task_time_entries(task_id,user_id,hours) VALUES ($1,$2,1)", [child, E1]);
    ok(await expectErr(db, 'DELETE FROM public.tasks WHERE id=$1', [parent], /record_has_history/) && await count('SELECT count(*)::int c FROM public.tasks WHERE id=$1', [parent]) === 1, 'deleting a parent whose SUB-task has time entries is refused as a whole');
    const tk3 = (await db.query("INSERT INTO public.tasks(title,created_by) VALUES ('plain',$1) RETURNING id", [ADMIN])).rows[0].id;
    ok(!(await tryq(db, 'DELETE FROM public.tasks WHERE id=$1', [tk3])).error, 'a plain task is deleted');
    // campaigns carry no history of their own
    const cp = (await db.query("INSERT INTO public.campaigns(name) VALUES ('camp') RETURNING id")).rows[0].id;
    ok(!(await tryq(db, 'DELETE FROM public.campaigns WHERE id=$1', [cp])).error, 'a campaign is deleted (its budget figure goes with it, see section 9)');
  }

  // ================================================================== 3. F-19
  section('3. F-19 storage clean-up: queued with the row delete, never lost, retried, safe under concurrency');
  {
    const q = (where = '') => count(`SELECT count(*)::int c FROM public.storage_cleanup_queue WHERE done_at IS NULL ${where}`);
    const task = (await db.query("INSERT INTO public.tasks(title,created_by) VALUES ('att',$1) RETURNING id", [ADMIN])).rows[0].id;
    const attPath = `${task}/${ADMIN}-bbbbbbbb-1111-4222-8333-000000000001-att1.png`;   // uploader-bound path (migration 039)
    const att = (await db.query("INSERT INTO public.task_attachments(task_id,file_name,file_size,file_type,storage_path,uploaded_by) VALUES ($1,'a.png',1,'image/png',$3,$2) RETURNING id", [task, ADMIN, attPath])).rows[0].id;
    await db.query('BEGIN'); await db.query('DELETE FROM public.task_attachments WHERE id=$1', [att]); await db.query('ROLLBACK');
    ok(await q() === 0 && await count('SELECT count(*)::int c FROM public.task_attachments WHERE id=$1', [att]) === 1, 'a rolled-back delete queues nothing and keeps the row (the file is not touched)');
    await db.query('DELETE FROM public.task_attachments WHERE id=$1', [att]);
    const row = (await db.query("SELECT bucket, path, source FROM public.storage_cleanup_queue WHERE path=$1", [attPath])).rows[0];
    ok(row && row.bucket === 'task-attachments' && row.source === 'task_attachments', 'deleting the row queues its file (bucket task-attachments) in the same transaction', JSON.stringify(row));
    // cascade: plan -> assets
    const plan = (await db.query("INSERT INTO public.content_plans(title,created_by) VALUES ('pl',$1) RETURNING id", [ADMIN])).rows[0].id;
    const post = (await db.query("INSERT INTO public.content_posts(plan_id,title) VALUES ($1,'po') RETURNING id", [plan])).rows[0].id;
    for (const [i, pid] of [[1, post], [2, null]]) await db.query("INSERT INTO public.content_post_assets(plan_id,post_id,storage_path,file_name,file_type,file_size,uploaded_by) VALUES ($1,$2,$3,'f','image/png',1,$4)", [plan, pid, `${ADMIN}/plans/${plan}/f${i}.png`, ADMIN]);
    await db.query('DELETE FROM public.content_plans WHERE id=$1', [plan]);
    ok(await q("AND bucket='studio-assets' AND path LIKE '%/plans/%'") === 2, 'deleting a plan (cascade: posts -> visuals) queues EVERY visual file');
    // library asset + chat media
    await db.query("INSERT INTO public.assets(name,file_name,file_size,file_type,storage_path,uploaded_by) VALUES ('a','a',1,'x',$1,$2)", [`${ADMIN}/lib1.png`, ADMIN]);
    await db.query('DELETE FROM public.assets WHERE storage_path=$1', [`${ADMIN}/lib1.png`]);
    ok(await q("AND path = '" + ADMIN + "/lib1.png'") === 1, 'a library asset delete queues its file');
    const cv = (await db.query("INSERT INTO public.conversations(type,name) VALUES ('group','g2') RETURNING id")).rows[0].id;
    const m1 = (await db.query("INSERT INTO public.messages(conversation_id,sender_id,content,metadata) VALUES ($1,$2,'img',$3) RETURNING id", [cv, ADMIN, { path: `${cv}/x.png` }])).rows[0].id;
    const m2 = (await db.query("INSERT INTO public.messages(conversation_id,sender_id,content,metadata) VALUES ($1,$2,'evil',$3) RETURNING id", [cv, ADMIN, { path: 'someone-elses/secret.png' }])).rows[0].id;
    await db.query('DELETE FROM public.messages WHERE id = ANY($1)', [[m1, m2]]);
    ok(await q(`AND bucket='chat-media' AND path='${cv}/x.png'`) === 1 && await q("AND path='someone-elses/secret.png'") === 0, 'a deleted chat message queues its own media only (a path outside its conversation is never queued)');
    // duplicates collapse
    await db.query("INSERT INTO public.storage_cleanup_queue(bucket,path) VALUES ('studio-assets','dup.png') ON CONFLICT DO NOTHING");
    ok(await expectErr(db, "INSERT INTO public.storage_cleanup_queue(bucket,path) VALUES ('studio-assets','dup.png')", [], /duplicate/), 'one open queue row per file');
    // claim / report
    await db.query("DELETE FROM public.storage_cleanup_queue WHERE path='dup.png'");
    const total = await q();
    const c1 = (await db.query('SELECT * FROM public.storage_cleanup_claim(100)')).rows;
    ok(c1.length === total && c1.length >= 5, `claim returns the due files (${c1.length})`);
    ok((await db.query('SELECT * FROM public.storage_cleanup_claim(100)')).rows.length === 0, 'a second claim finds nothing: the first holds a lease');
    const failId = c1[0].id, okId = c1[1].id;
    await db.query('SELECT public.storage_cleanup_report($1,false,$2)', [failId, 'storage unavailable']);
    await db.query('SELECT public.storage_cleanup_report($1,true,NULL)', [okId]);
    const f = (await db.query('SELECT done_at, attempts, last_error, next_attempt_at > now() AS later FROM public.storage_cleanup_queue WHERE id=$1', [failId])).rows[0];
    ok(f.done_at === null && f.attempts === 1 && f.last_error === 'storage unavailable' && f.later, 'a failed removal stays queued with its error and a later retry time (nothing silently lost)', JSON.stringify(f));
    ok((await db.query('SELECT done_at FROM public.storage_cleanup_queue WHERE id=$1', [okId])).rows[0].done_at !== null, 'a successful removal marks the row done');
    await db.query('UPDATE public.storage_cleanup_queue SET next_attempt_at = now() WHERE id=$1', [failId]);
    const again = (await db.query('SELECT * FROM public.storage_cleanup_claim(100)')).rows;
    ok(again.length === 1 && again[0].id === failId, 'after the retry time the failed file is claimed again');
    ok((await db.query('SELECT attempts FROM public.storage_cleanup_queue WHERE id=$1', [failId])).rows[0].attempts === 2, '  ... attempts counts up (2)');
    await db.query('SELECT public.storage_cleanup_report($1,true,NULL)', [failId]);
    ok((await db.query('SELECT * FROM public.storage_cleanup_status()')).rows[0].gave_up == 0, 'storage_cleanup_status() reports nothing given up');
    await db.query("UPDATE public.storage_cleanup_queue SET attempts = 12, next_attempt_at = now() WHERE done_at IS NULL AND id = (SELECT min(id) FROM public.storage_cleanup_queue WHERE done_at IS NULL)");
    ok((await db.query('SELECT gave_up FROM public.storage_cleanup_status()')).rows[0].gave_up == 1, 'a file that failed 12 times is reported as given up (needs a person), never deleted from the queue');
    // concurrency: 40 rows, 4 workers claiming at once -> disjoint
    await db.query("DELETE FROM public.storage_cleanup_queue");
    for (let i = 0; i < 40; i++) await db.query("INSERT INTO public.storage_cleanup_queue(bucket,path) VALUES ('studio-assets',$1)", ['conc/' + i]);
    const ws = await Promise.all([1, 2, 3, 4].map(() => connect('kite')));
    const got = await Promise.all(ws.map((w) => w.query('SELECT * FROM public.storage_cleanup_claim(10)').then((r) => r.rows.map((x) => x.id))));
    const all = got.flat();
    ok(all.length === 40 && new Set(all).size === 40, 'four workers claiming at once take 40 distinct files, none twice (real PostgreSQL, SKIP LOCKED)', JSON.stringify(got.map((g) => g.length)));
    for (const w of ws) await w.end();
    ok((await asUser(OWNER, 'SELECT * FROM public.storage_cleanup_claim(1)')).error !== undefined, 'a signed-in user cannot call the clean-up functions');
  }

  // ================================================================== 4. attendance
  section('4. F-06 attendance: the clock is the server\'s; invalid sequences are refused; time-zone boundaries');
  {
    const emp = await mkUser('att1'); const emp2 = await mkUser('att2');
    // an employee tries to back-date a check-in and claim 40 hours
    let r = await asUser(emp, "INSERT INTO public.attendance_records(user_id,check_in,date,total_hours,check_out) VALUES ($1,'2020-01-01 08:00+00','2020-01-01',40,'2020-01-02 00:00+00') RETURNING check_in, date, check_out, total_hours", [emp]);
    ok(!r.error && Math.abs(new Date(r.rows[0].check_in) - Date.now()) < 120000 && r.rows[0].check_out === null && num(r.rows[0].total_hours) === 0, 'check-in: the browser\'s time, date, check-out and hours are ignored (server time, open record, 0 hours)', JSON.stringify(r));
    const studioDay = (await db.query('SELECT public.studio_today() d')).rows[0].d;
    ok(String(r.rows[0].date) === String(studioDay), '  ... date = the STUDIO date of the check-in', String(r.rows[0].date));
    r = await asUser(emp, "INSERT INTO public.attendance_records(user_id,check_in,date) VALUES ($1, now(), current_date)", [emp]);
    ok(!!r.error && /uq_user_attendance_date|duplicate/.test(r.error), 'a second check-in on the same studio day is refused', r.error);
    r = await asUser(emp, "INSERT INTO public.attendance_records(user_id,check_in,date) VALUES ($1, now(), current_date)", [emp2]);
    ok(!!r.error, 'an employee cannot check in for someone else (RLS)');
    // check-out
    await db.query("UPDATE public.attendance_records SET check_in = now() - interval '2 hours 30 minutes' WHERE user_id=$1", [emp]);   // operator fixture: a 2.5 hour day
    r = await asUser(emp, "UPDATE public.attendance_records SET check_out = '2099-01-01', total_hours = 99 WHERE user_id=$1 RETURNING check_out, total_hours", [emp]);
    ok(!r.error && Math.abs(new Date(r.rows[0].check_out) - Date.now()) < 120000 && Math.abs(num(r.rows[0].total_hours) - 2.5) < 0.05, 'check-out: server time, hours computed (~2.5), the browser\'s 2099 / 99h ignored', JSON.stringify(r));
    r = await asUser(emp, "UPDATE public.attendance_records SET check_out = now() WHERE user_id=$1", [emp]);
    ok(!!r.error && /already checked out/.test(r.error), 'a second check-out is refused', r.error);
    r = await asUser(emp, "UPDATE public.attendance_records SET check_out = NULL WHERE user_id=$1", [emp]);
    ok(!!r.error, 'a checked-out record cannot be re-opened');
    r = await asUser(emp, "UPDATE public.attendance_records SET check_in = now() - interval '9 hours', date = '2020-01-01' WHERE user_id=$1", [emp]);
    ok(!!r.error, 'the check-in time and date cannot be rewritten (no grant / guard)', r.error);
    r = await asUser(emp, "UPDATE public.attendance_records SET total_hours = 50 WHERE user_id=$1 RETURNING total_hours", [emp]);
    ok(!r.error && num(r.rows[0].total_hours) < 3, 'typing total_hours alone changes nothing (recomputed)', JSON.stringify(r));
    // HR correction
    r = await asUser(HR, "UPDATE public.attendance_records SET check_out = check_in + interval '8 hours' WHERE user_id=$1 RETURNING total_hours", [emp]);
    ok(!r.error && num(r.rows[0].total_hours) === 8, 'HR can correct a check-out explicitly; hours are recomputed (8.00)', JSON.stringify(r));
    r = await asUser(HR, "UPDATE public.attendance_records SET check_out = check_in - interval '1 minute' WHERE user_id=$1", [emp]);
    ok(!!r.error && /after check-in/.test(r.error), 'HR cannot set a check-out before the check-in', r.error);
    // stale open record
    const emp3 = await mkUser('att3');
    await db.query("INSERT INTO public.attendance_records(user_id,check_in) VALUES ($1, now() - interval '30 hours')", [emp3]);
    r = await asUser(emp3, "UPDATE public.attendance_records SET check_out = now() WHERE user_id=$1", [emp3]);
    ok(!!r.error && /older than 24 hours/.test(r.error), 'an employee cannot close a record older than 24 hours (HR must)', r.error);
    ok((await db.query('SELECT count(*)::int c FROM public.hr_open_attendance() WHERE user_id=$1', [emp3])).rows[0].c === 1, 'hr_open_attendance() lists it for HR');
    ok(!(await asUser(HR, "UPDATE public.attendance_records SET check_out = check_in + interval '30 hours' WHERE user_id=$1", [emp3])).error, 'HR closes it');
    // DB-level constraints exist and are validated on a clean database
    ok(await count("SELECT count(*)::int c FROM pg_constraint WHERE conname IN ('attendance_out_after_in','attendance_hours_nonneg','leave_end_after_start') AND convalidated") === 3, 'the three HR CHECK constraints exist and are validated');
    // time-zone boundaries (pure function, both seasons)
    const dd = async (ts, tz) => (await db.query("SELECT to_char(public.studio_date($1::timestamptz, $2), 'YYYY-MM-DD') d", [ts, tz])).rows[0].d;
    ok(await dd('2026-01-01 21:30+00', 'Africa/Cairo') === '2026-01-01' && await dd('2026-01-01 22:00+00', 'Africa/Cairo') === '2026-01-02', 'Cairo winter (UTC+2): 21:59 UTC is still the 1st, 22:00 UTC is the 2nd');
    ok(await dd('2026-07-01 20:59+00', 'Africa/Cairo') === '2026-07-01' && await dd('2026-07-01 21:00+00', 'Africa/Cairo') === '2026-07-02', 'Cairo summer (UTC+3): 20:59 UTC is the 1st, 21:00 UTC is the 2nd');
    const emp4 = await mkUser('att4');
    await db.query("INSERT INTO public.attendance_records(user_id,check_in) VALUES ($1,'2026-01-01 22:30+00')", [emp4]);
    ok((await db.query("SELECT to_char(date,'YYYY-MM-DD') d FROM public.attendance_records WHERE user_id=$1", [emp4])).rows[0].d === '2026-01-02', 'a check-in at 22:30 UTC in January is recorded on the studio\'s NEXT day (00:30 Cairo), not the server\'s date');
    await db.query("INSERT INTO public.company_settings(key,value) VALUES ('studio_timezone', '\"UTC\"')");
    ok((await db.query('SELECT public.studio_timezone() z')).rows[0].z === 'UTC' && await dd('2026-01-01 22:30+00', 'UTC') === '2026-01-01', 'the studio time zone is configurable (company_settings studio_timezone)');
    await db.query("DELETE FROM public.company_settings WHERE key='studio_timezone'");
    ok((await db.query('SELECT public.studio_timezone() z')).rows[0].z === 'Africa/Cairo', 'default Africa/Cairo');
  }

  // ================================================================== 5. leave
  section('5. F-06 leave: DB-calculated days, validation, overlap, balances (race-safe)');
  {
    const typ = async (days) => (await db.query("INSERT INTO public.leave_types(name,default_days) VALUES ('LT'||random(), $1) RETURNING id", [days])).rows[0].id;
    const ask = (user, type, s, e, extra = '') => asUser(user, `INSERT INTO public.leave_requests(user_id,leave_type_id,start_date,end_date,total_days,reason,status) VALUES ($1,$2,$3,$4,99,'r','pending') RETURNING id, total_days ${extra}`, [user, type, s, e]);
    const lv = await mkUser('lv1'); const T10 = await typ(10);
    let r = await ask(lv, T10, '2031-03-01', '2031-03-03');
    ok(!r.error && r.rows[0].total_days === 3, 'total_days is counted by the database (3), whatever the browser sent (99)', JSON.stringify(r));
    r = await ask(lv, T10, '2031-04-05', '2031-04-01');
    ok(!!r.error && /end date cannot be before/.test(r.error), 'end before start is refused', r.error);
    r = await ask(lv, T10, '2031-03-03', '2031-03-05');
    ok(!!r.error && /overlaps/.test(r.error), 'an overlapping request (sharing a day) is refused', r.error);
    r = await ask(lv, T10, '2031-03-04', '2031-03-09');   // 6 more -> 3 + 6 = 9 <= 10
    ok(!r.error, 'a non-overlapping request within the balance is accepted (3 + 6 = 9 of 10)', r.error);
    r = await ask(lv, T10, '2031-05-01', '2031-05-02');   // 9 + 2 = 11 > 10
    ok(!!r.error && /Not enough leave balance for 2031: 1 of 10 days left, 2 requested/.test(r.error), 'a request above the balance is refused with the numbers', r.error);
    ok(!(await ask(lv, T10, '2031-05-01', '2031-05-01')).error, 'the last day fits (10 of 10)');
    const bal = await asUser(lv, 'SELECT * FROM public.hr_leave_balance($1,$2,2031)', [lv, T10]);
    ok(!bal.error && bal.rows[0].entitlement === 10 && bal.rows[0].approved === 0 && bal.rows[0].pending === 10 && bal.rows[0].remaining === 0, 'hr_leave_balance: entitlement 10, pending 10 (reserved), remaining 0', JSON.stringify(bal));
    ok((await asUser(E2, 'SELECT * FROM public.hr_leave_balance($1,$2,2031)', [lv, T10])).error !== undefined, 'you cannot read another person\'s balance');
    ok(!(await asUser(HR, 'SELECT * FROM public.hr_leave_balance($1,$2,2031)', [lv, T10])).error, 'HR can');
    // rejecting releases days; approving counts them
    const pend = (await db.query("SELECT id FROM public.leave_requests WHERE user_id=$1 AND start_date='2031-03-04'", [lv])).rows[0].id;
    await db.query("UPDATE public.leave_requests SET status='rejected', reviewed_by=$2 WHERE id=$1", [pend, HR]);
    ok((await db.query('SELECT pending, remaining FROM public.hr_leave_balance($1,$2,2031)', [lv, T10])).rows[0].remaining === 6, 'a rejected request releases its days (remaining 6)');
    ok(await expectErr(db, "UPDATE public.leave_requests SET status='approved' WHERE id=$1", [pend], /cannot become/), 'a rejected request cannot be approved later (no resurrection)');
    const first = (await db.query("SELECT id FROM public.leave_requests WHERE user_id=$1 AND start_date='2031-03-01'", [lv])).rows[0].id;
    await db.query("UPDATE public.leave_requests SET status='approved', reviewed_by=$2 WHERE id=$1", [first, HR]);
    ok((await db.query('SELECT approved, pending, remaining FROM public.hr_leave_balance($1,$2,2031)', [lv, T10])).rows[0].approved === 3, 'an approved request counts as used (3)');
    // legacy pending request that exceeds the balance (written behind the guard, as old data would be): cannot be approved
    const lt5 = await typ(5); const lg = await mkUser('lv2');
    await db.query('ALTER TABLE public.leave_requests DISABLE TRIGGER hr_leave_guard');
    const big = (await db.query("INSERT INTO public.leave_requests(user_id,leave_type_id,start_date,end_date,total_days,reason) VALUES ($1,$2,'2031-06-01','2031-06-09',9,'legacy') RETURNING id", [lg, lt5])).rows[0].id;
    await db.query('ALTER TABLE public.leave_requests ENABLE TRIGGER hr_leave_guard');
    ok(await expectErr(db, "UPDATE public.leave_requests SET status='approved' WHERE id=$1", [big], /Not enough leave balance/), 'a legacy pending request above the balance cannot be approved (it is not rewritten either)');
    ok(await count("SELECT count(*)::int c FROM public.leave_requests WHERE id=$1 AND total_days=9 AND status='pending'", [big]) === 1, '  ... the legacy row is unchanged');
    // spanning two years is checked per year
    const lt3 = await typ(3); const sp = await mkUser('lv3');
    r = await ask(sp, lt3, '2031-12-30', '2032-01-03');    // 2 days in 2031, 3 days in 2032: each <= 3
    ok(!r.error && r.rows[0].total_days === 5, 'a request spanning New Year is checked per year (2 + 3, entitlement 3 each): accepted', r.error);
    r = await ask(sp, lt3, '2032-02-01', '2032-02-01');
    ok(!!r.error && /2032/.test(r.error), '... and 2032 is then full', r.error);
    // unlimited type
    const unl = await typ(0); const ul = await mkUser('lv4');
    ok(!(await ask(ul, unl, '2031-01-01', '2031-03-31')).error, 'default_days = 0 means no limit is tracked');
    // immutability (temporary grant so a signed-in user can reach the trigger)
    await db.query('GRANT UPDATE ON public.leave_requests TO authenticated'); await db.query('CREATE POLICY tmp_leave_update ON public.leave_requests FOR UPDATE TO authenticated USING (true)');   // no API update path exists today; opened here only to prove the guard
    const mine = (await db.query("SELECT id FROM public.leave_requests WHERE user_id=$1 AND start_date='2031-05-01'", [lv])).rows[0].id;
    r = await asUser(HR, "UPDATE public.leave_requests SET end_date = '2031-05-20' WHERE id=$1", [mine]);
    ok(!!r.error && /cannot be changed/.test(r.error), 'the dates of an existing request cannot be edited, even by HR through the API', r.error);
    r = await asUser(HR, "UPDATE public.leave_requests SET total_days = 7 WHERE id=$1", [mine]);
    ok(!!r.error && /cannot be changed/.test(r.error), 'total_days cannot be edited, even by HR through the API', r.error);
    await db.query('REVOKE UPDATE ON public.leave_requests FROM authenticated'); await db.query('DROP POLICY tmp_leave_update ON public.leave_requests');
    // race: two requests of 6 days for a 10-day type at the same moment -> exactly one wins
    const rc = await mkUser('lv5'); const T10b = await typ(10);
    const conc = async (user, s, e) => { const c = await connect('kite'); try { await c.query('BEGIN'); await c.query('SET LOCAL ROLE authenticated'); await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [user]);
      const x = await tryq(c, "INSERT INTO public.leave_requests(user_id,leave_type_id,start_date,end_date,total_days,reason) VALUES ($1,$2,$3,$4,1,'r')", [user, T10b, s, e]); await c.query(x.error ? 'ROLLBACK' : 'COMMIT'); return x; } finally { await c.end(); } };
    const res = await Promise.all([conc(rc, '2031-07-01', '2031-07-06'), conc(rc, '2031-08-01', '2031-08-06')]);
    ok(res.filter((x) => !x.error).length === 1 && res.filter((x) => x.error && /Not enough leave balance/.test(x.error)).length === 1, 'RACE: two simultaneous 6-day requests against 10 days: exactly one is accepted', JSON.stringify(res.map((x) => x.error ?? 'ok')));
    const res2 = await Promise.all([conc(rc, '2031-09-01', '2031-09-02'), conc(rc, '2031-09-02', '2031-09-03')]);
    ok(res2.filter((x) => !x.error).length === 1 && res2.some((x) => x.error && /overlaps/.test(x.error)), 'RACE: two simultaneous overlapping requests: exactly one is accepted', JSON.stringify(res2.map((x) => x.error ?? 'ok')));
  }


  // ================================================================== 6. content-plan approval
  section('6. F-07 content-plan approval: atomic with its evidence, invalidated when the approved content changes, plan/post integrity');
  {
    const mkPlan = async (status = 'in_review') => (await db.query("INSERT INTO public.content_plans(title,created_by,status) VALUES ('Plan',$1,$2) RETURNING id", [ADMIN, status])).rows[0].id;
    const mkPost = async (plan, title = 'Post') => (await db.query("INSERT INTO public.content_posts(plan_id,title,caption,position) VALUES ($1,$2,'cap',0) RETURNING id", [plan, title])).rows[0].id;
    const status = async (plan) => (await db.query('SELECT status, approved_at FROM public.content_plans WHERE id=$1', [plan])).rows[0];
    const fb = (plan) => count('SELECT count(*)::int c FROM public.content_feedback WHERE plan_id=$1', [plan]);
    const give = (plan, kind = 'approve_all', post = null, c = db) => c.query('SELECT public.content_plan_client_feedback($1,$2,$3,$4,$5,$6) s', [plan, kind, 'Client', 'ok', post, 1]);
    const reapprove = async (plan) => { await db.query("UPDATE public.content_plans SET status='approved' WHERE id=$1", [plan]); };

    const draft = await mkPlan('draft');
    let r = await tryq(db, 'SELECT public.content_plan_client_feedback($1,$2,$3,$4,$5,$6)', [draft, 'approve_all', 'C', 'm', null, 1]);
    ok(!!r.error && /plan_not_open/.test(r.error) && await fb(draft) === 0 && (await status(draft)).status === 'draft', 'a DRAFT plan cannot be approved by the client: no evidence row, status unchanged', r.error);
    const plan = await mkPlan(); const post = await mkPost(plan);
    const other = await mkPlan(); const otherPost = await mkPost(other, 'Elsewhere');
    r = await tryq(db, 'SELECT public.content_plan_client_feedback($1,$2,$3,$4,$5,$6)', [plan, 'note', 'C', 'm', otherPost, 1]);
    ok(!!r.error && /post_not_in_plan/.test(r.error) && await fb(plan) === 0, 'feedback about a post of ANOTHER plan is refused: nothing written', r.error);
    r = await tryq(db, 'SELECT public.content_plan_client_feedback($1,$2,$3,$4,$5,$6)', [plan, 'bogus', 'C', 'm', null, 1]);
    ok(!!r.error && await fb(plan) === 0, 'an unknown kind is refused');
    // atomicity: the status change fails AFTER the evidence row was inserted -> the evidence row is rolled back too
    await db.query(`CREATE FUNCTION public.zz_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
    await db.query(`CREATE TRIGGER zz_fail BEFORE UPDATE ON public.content_plans FOR EACH ROW WHEN (NEW.status = 'approved') EXECUTE FUNCTION public.zz_fail()`);
    r = await tryq(db, 'SELECT public.content_plan_client_feedback($1,$2,$3,$4,$5,$6)', [plan, 'approve_all', 'C', 'm', null, 1]);
    ok(!!r.error && /injected failure/.test(r.error) && await fb(plan) === 0 && (await status(plan)).status === 'in_review', 'ATOMIC: when the approval cannot be saved, the evidence row is not saved either (and vice versa)', r.error);
    await db.query('DROP TRIGGER zz_fail ON public.content_plans'); await db.query('DROP FUNCTION public.zz_fail()');
    r = await give(plan, 'approve_all');
    let st = await status(plan);
    ok(r.rows[0].s === 'approved' && st.status === 'approved' && st.approved_at !== null && await fb(plan) === 1, 'approve_all: the plan is approved, approved_at is set, ONE evidence row exists');
    r = await give(plan, 'change', post);
    ok(r.rows[0].s === 'changes_requested' && (await status(plan)).approved_at === null, 'a change request moves it to changes_requested and clears approved_at');
    // invalidation
    const audit = () => count("SELECT count(*)::int c FROM public.audit_logs WHERE action='CONTENT_PLAN_APPROVAL_INVALIDATED'");
    const extraPost = await mkPost(plan, 'Temp');
    const cases = [
      ['editing a post caption', () => db.query("UPDATE public.content_posts SET caption='changed' WHERE id=$1", [post])],
      ['changing a post date', () => db.query("UPDATE public.content_posts SET post_date='2031-01-01' WHERE id=$1", [post])],
      ['reordering a post', () => db.query("UPDATE public.content_posts SET position=5 WHERE id=$1", [post])],
      ['adding a post', () => mkPost(plan, 'New')],
      ['adding a visual', () => db.query("INSERT INTO public.content_post_assets(plan_id,post_id,storage_path,file_name,file_type,file_size,uploaded_by) VALUES ($1,$2,$3,'f','image/png',1,$4)", [plan, post, `${ADMIN}/plans/${plan}/inv1.png`, ADMIN])],
      ['removing a visual', () => db.query("DELETE FROM public.content_post_assets WHERE storage_path=$1", [`${ADMIN}/plans/${plan}/inv1.png`])],
      ['editing the plan title', () => db.query("UPDATE public.content_plans SET title='New title' WHERE id=$1", [plan])],
      ['changing the plan accent colour', () => db.query("UPDATE public.content_plans SET accent='#00ff00' WHERE id=$1", [plan])],
      ['deleting a post', () => db.query('DELETE FROM public.content_posts WHERE id=$1', [extraPost])],
    ];
    for (const [label, fn] of cases) {
      await reapprove(plan); const a0 = await audit();
      await fn(); st = await status(plan);
      ok(st.status === 'in_review' && st.approved_at === null && await audit() === a0 + 1, `approval is invalidated by ${label} (audited)`, JSON.stringify(st));
    }
    // things that must NOT invalidate
    await reapprove(plan);
    await db.query("UPDATE public.content_posts SET status='published', published_url='https://x.test/p', published_at=now(), publisher_id=$2 WHERE id=$1", [post, ADMIN]);
    await db.query("UPDATE public.content_plans SET campaign_id=NULL WHERE id=$1", [plan]);
    ok((await status(plan)).status === 'approved', 'publishing a post (status / publisher / published url) or touching non-content plan fields does NOT invalidate the approval');
    // plan <-> post integrity
    r = await tryq(db, "INSERT INTO public.content_post_assets(plan_id,post_id,storage_path,file_name,file_type,file_size,uploaded_by) VALUES ($1,$2,$3,'f','image/png',1,$4)", [plan, otherPost, `${ADMIN}/plans/${plan}/bad.png`, ADMIN]);
    ok(!!r.error && /plan_post_fk|foreign key/.test(r.error), 'a visual of plan A cannot point at a post of plan B (composite foreign key)', r.error);
    r = await tryq(db, "INSERT INTO public.content_feedback(plan_id,post_id,author_name,kind) VALUES ($1,$2,'C','note')", [plan, otherPost]);
    ok(!!r.error, 'feedback cannot point at a post of another plan');
    const fpost = await mkPost(plan, 'Fb'); await db.query("INSERT INTO public.content_feedback(plan_id,post_id,author_name,kind,message) VALUES ($1,$2,'C','note','hello')", [plan, fpost]);
    await db.query('DELETE FROM public.content_posts WHERE id=$1', [fpost]);
    const fbRow = (await db.query("SELECT plan_id, post_id FROM public.content_feedback WHERE message='hello'")).rows[0];
    ok(fbRow && fbRow.plan_id === plan && fbRow.post_id === null, 'deleting a post keeps its feedback (post_id becomes NULL, plan_id stays): history kept');
    ok(await count("SELECT count(*)::int c FROM pg_constraint WHERE conname IN ('content_post_assets_plan_post_fk','content_feedback_plan_post_fk') AND convalidated") === 2, 'both composite foreign keys are validated on a clean database');
    // concurrency
    const p2 = await mkPlan(); const cs = await Promise.all([connect('kite'), connect('kite'), connect('kite')]);
    const rs = await Promise.allSettled(cs.map((c) => give(p2, 'approve_all', null, c)));
    ok(rs.every((x) => x.status === 'fulfilled') && await fb(p2) === 3 && (await status(p2)).status === 'approved', 'three clients approving at the same moment: 3 evidence rows, plan approved, no error');
    // approve (holds the plan lock) racing a post edit: the edit waits, then invalidates -> final state in_review (the evidence row stays: it was true when given)
    const p3 = await mkPlan(); const post3 = await mkPost(p3);
    await cs[0].query('BEGIN'); await give(p3, 'approve_all', null, cs[0]);
    const edit = cs[1].query("UPDATE public.content_posts SET caption='late edit' WHERE id=$1", [post3]);
    await sleep(400); await cs[0].query('COMMIT'); await edit;
    ok((await status(p3)).status === 'in_review' && await fb(p3) === 1, 'RACE: an edit that lands right after the approval invalidates it (in_review) and the evidence row is kept', JSON.stringify([await status(p3), await fb(p3)]));
    for (const c of cs) await c.end();
  }

  // ================================================================== 7. expenses + budgets
  section('7. F-15 expenses: atomic decisions, lifecycle, currency, derived budgets');
  {
    const exp = async (extra = {}) => { const o = { title: 'e', amount: 100, category: 'other', submitted_by: E1, status: 'submitted', ...extra };
      return (await db.query(`INSERT INTO public.expenses(title,amount,category,submitted_by,status,department_id,project_id,currency,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8,'EGP'),coalesce($9::timestamptz, now())) RETURNING id`,
        [o.title, o.amount, o.category, o.submitted_by, o.status, o.department_id ?? null, o.project_id ?? null, o.currency ?? null, o.created_at ?? null])).rows[0].id; };
    const st = async (id) => (await db.query('SELECT status, paid_at, currency FROM public.expenses WHERE id=$1', [id])).rows[0];
    const appr = (id) => count('SELECT count(*)::int c FROM public.expense_approvals WHERE expense_id=$1', [id]);
    const decide = (c, actor, id, d) => c.query('SELECT public.expense_decide($1,$2,$3,$4) s', [actor, id, d, 'n']);
    const e0 = await exp();
    ok((await st(e0)).currency === 'EGP', 'the currency default is EGP (a claim entered through the EGP form is stored as EGP)');
    const dflt = (await db.query("INSERT INTO public.expenses(title,amount,category,submitted_by) VALUES ('d',1,'other',$1) RETURNING currency", [E1])).rows[0].currency;
    ok(dflt === 'EGP', 'a column default of EGP applies when no currency is given');
    ok(await expectErr(db, "INSERT INTO public.expenses(title,amount,category,submitted_by,currency) VALUES ('d',1,'other',$1,'egp')", [E1], /currency_chk/), 'a currency must be three capital letters');
    let r = await tryq(db, 'SELECT public.expense_decide($1,$2,$3,$4)', [HR, e0, 'approved', null]);
    ok(!!r.error && /expense_forbidden/.test(r.error) && (await st(e0)).status === 'submitted', 'a non-executive (HR) cannot decide, even through the SQL function (defence in depth)', r.error);
    r = await tryq(db, 'SELECT public.expense_decide($1,$2,$3,$4)', [E1, e0, 'approved', null]);
    ok(!!r.error && /expense_forbidden/.test(r.error), 'the claim\'s own author (a non-executive) cannot approve it');
    const ownerClaim = await exp({ submitted_by: OWNER });
    r = await tryq(db, 'SELECT public.expense_decide($1,$2,$3,$4)', [OWNER, ownerClaim, 'approved', null]);
    ok(!!r.error && /expense_self_decision/.test(r.error), 'an executive cannot decide on their own claim', r.error);
    // atomic: the approval record cannot be written -> the status stays submitted
    await db.query(`CREATE FUNCTION public.zz_fail2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected approval failure'; END $$`);
    await db.query('CREATE TRIGGER zz_fail2 BEFORE INSERT ON public.expense_approvals FOR EACH ROW EXECUTE FUNCTION public.zz_fail2()');
    r = await tryq(db, 'SELECT public.expense_decide($1,$2,$3,$4)', [OWNER, e0, 'approved', null]);
    ok(!!r.error && (await st(e0)).status === 'submitted' && await appr(e0) === 0, 'ATOMIC: when the approval record fails, the expense is NOT left approved', r.error);
    await db.query('DROP TRIGGER zz_fail2 ON public.expense_approvals'); await db.query('DROP FUNCTION public.zz_fail2()');
    r = await decide(db, OWNER, e0, 'approved');
    ok(r.rows[0].s === 'approved' && (await st(e0)).status === 'approved' && await appr(e0) === 1, 'an executive approves: status approved + exactly one approval record');
    r = await tryq(db, 'SELECT public.expense_decide($1,$2,$3,$4)', [ADMIN, e0, 'rejected', null]);
    ok(!!r.error && /expense_already_decided/.test(r.error) && (await st(e0)).status === 'approved', 'a second decision is refused (409-type error)', r.error);
    // race: two executives decide at once
    const e1 = await exp(); const cs = await Promise.all([connect('kite'), connect('kite')]);
    const rs = await Promise.all([tryq(cs[0], 'SELECT public.expense_decide($1,$2,$3,$4)', [OWNER, e1, 'approved', 'a']), tryq(cs[1], 'SELECT public.expense_decide($1,$2,$3,$4)', [ADMIN, e1, 'rejected', 'r'])]);
    const final = (await st(e1)).status;
    ok(rs.filter((x) => !x.error).length === 1 && rs.filter((x) => x.error && /already_decided/.test(x.error)).length === 1 && await appr(e1) === 1, 'RACE: two executives deciding at the same moment: exactly one wins, one approval record', JSON.stringify(rs.map((x) => x.error ?? 'ok')));
    ok((await db.query('SELECT action FROM public.expense_approvals WHERE expense_id=$1', [e1])).rows[0].action === final, '  ... and the record agrees with the final status');
    for (const c of cs) await c.end();
    // lifecycle trigger (every writer)
    const e2 = await exp();
    ok(await expectErr(db, "UPDATE public.expenses SET status='paid' WHERE id=$1", [e2], /cannot move from submitted to paid/), 'submitted -> paid directly is refused');
    await db.query("UPDATE public.expenses SET status='approved' WHERE id=$1", [e2]);
    ok(await expectErr(db, "UPDATE public.expenses SET status='submitted' WHERE id=$1", [e2], /cannot move from approved to submitted/), 'approved -> submitted is refused (no going back)');
    ok(await expectErr(db, "UPDATE public.expenses SET amount = 1 WHERE id=$1", [e2], /cannot be edited/), 'the amount of a submitted claim cannot be changed');
    ok(await expectErr(db, "UPDATE public.expenses SET currency = 'USD' WHERE id=$1", [e2], /cannot be edited/), 'nor its currency');
    r = await tryq(db, 'SELECT public.expense_mark_paid($1,$2) s', [HR, e2]);
    ok(!!r.error && /expense_forbidden/.test(r.error), 'only an executive marks a claim paid');
    r = await tryq(db, 'SELECT public.expense_mark_paid($1,$2) s', [OWNER, e2]);
    ok(!r.error && (await st(e2)).status === 'paid' && (await st(e2)).paid_at !== null, 'approved -> paid works and records paid_at');
    r = await tryq(db, 'SELECT public.expense_mark_paid($1,$2) s', [OWNER, e2]);
    ok(!!r.error && /already paid/.test(r.error), 'paying twice is refused');
    const e3 = await exp();
    r = await tryq(db, 'SELECT public.expense_mark_paid($1,$2) s', [OWNER, e3]);
    ok(!!r.error && /expense_not_approved/.test(r.error), 'a claim that is not approved cannot be marked paid', r.error);
    const dr = await exp({ status: 'draft' });
    r = await tryq(db, 'SELECT public.expense_submit($1,$2) s', [E2, dr]);
    ok(!!r.error && /expense_forbidden/.test(r.error), 'only the author submits a draft claim');
    r = await tryq(db, 'SELECT public.expense_submit($1,$2) s', [E1, dr]);
    ok(!r.error && (await st(dr)).status === 'submitted', 'the author submits a draft: draft -> submitted');
    ok(await expectErr(db, "INSERT INTO public.expense_approvals(expense_id,approver_id,action) VALUES ($1,$2,'approved')", [e0, OWNER], /duplicate|uq_expense_approval_once/), 'a second approval record for the same expense cannot exist (unique)');
    // budgets are derived
    const dept = (await db.query("INSERT INTO public.departments(name) VALUES ('BudgetDept') RETURNING id")).rows[0].id;
    const proj = (await db.query("INSERT INTO public.projects(code,name) VALUES ('BP','bp') RETURNING id")).rows[0].id;
    const year = num((await db.query("SELECT extract(year FROM public.studio_today())::int y")).rows[0].y);
    const bud = (await db.query("INSERT INTO public.budgets(name,department_id,amount,spent,fiscal_year) VALUES ('dept budget',$1,1000,555,$2) RETURNING id", [dept, year])).rows[0].id;
    const spent = async (id) => num((await db.query('SELECT spent FROM public.budgets WHERE id=$1', [id])).rows[0].spent);
    ok(await spent(bud) === 0, 'a budget saved with a hand-typed spent figure (555) gets the DERIVED figure (0)');
    const a1 = await exp({ department_id: dept, amount: 100 }); await decide(db, OWNER, a1, 'approved');
    ok(await spent(bud) === 100, 'an approved claim of the department is counted (100)');
    const a2 = await exp({ department_id: dept, amount: 50 }); await decide(db, OWNER, a2, 'rejected');
    ok(await spent(bud) === 100, 'a rejected claim is not counted');
    const a3 = await exp({ department_id: dept, amount: 25, currency: 'USD' }); await decide(db, OWNER, a3, 'approved');
    ok(await spent(bud) === 100, 'a claim in another currency (USD) is NOT added to an EGP budget');
    const a4 = await exp({ department_id: dept, amount: 10, created_at: '2019-06-01' }); await decide(db, OWNER, a4, 'approved');
    ok(await spent(bud) === 100, 'a claim of another fiscal year is not counted');
    await db.query("SELECT public.expense_mark_paid($1,$2)", [OWNER, a1]);
    ok(await spent(bud) === 100, 'paying an approved claim does not count it twice');
    const a5 = await exp({ department_id: dept, amount: 40 }); await decide(db, OWNER, a5, 'approved');
    ok(await spent(bud) === 140, 'the next approved claim is added (140)');
    await db.query('UPDATE public.budgets SET spent = 1 WHERE id=$1', [bud]);
    ok(await spent(bud) === 140, 'typing a spent figure by hand is overridden by the derived one');
    const pb = (await db.query("INSERT INTO public.budgets(name,project_id,amount,fiscal_year) VALUES ('project budget',$1,500,$2) RETURNING id", [proj, year])).rows[0].id;
    const pe = await exp({ project_id: proj, amount: 70, department_id: dept }); await decide(db, OWNER, pe, 'approved');
    ok(await spent(pb) === 70 && await spent(bud) === 210, 'a claim counts in every budget whose scope contains it (project 70; department 140 + 70)');
    const all = (await db.query("INSERT INTO public.budgets(name,amount,fiscal_year) VALUES ('company',9999,$1) RETURNING id", [year])).rows[0].id;
    ok(await spent(all) > 0, 'a company-wide budget (no department, no project) counts everything of the year');
    await db.query('ALTER TABLE public.budgets DISABLE TRIGGER budgets_spent_calc');
    const legacy = (await db.query("INSERT INTO public.budgets(name,department_id,amount,spent,fiscal_year) VALUES ('legacy',$1,10,777,$2) RETURNING id", [dept, year])).rows[0].id;
    await db.query('ALTER TABLE public.budgets ENABLE TRIGGER budgets_spent_calc');
    ok((await db.query('SELECT stored_spent, derived_spent FROM public.budget_reconciliation() WHERE budget_id=$1', [legacy])).rows.length === 1 && await spent(legacy) === 777, 'a legacy budget with a hand-typed figure is NOT rewritten; budget_reconciliation() reports it');
  }

  // ================================================================== 8. department links
  section('8. F-09 department links are atomic; one primary per person; client departments change in one transaction');
  {
    const dep = async (n) => (await db.query("INSERT INTO public.departments(name) VALUES ($1) RETURNING id", [n + Math.random()])).rows[0].id;
    const A = await dep('A'), B = await dep('B'), C = await dep('C');
    const u = await mkUser('dl1');
    const links = async (user) => (await db.query('SELECT department_id d, is_primary p FROM public.user_departments WHERE user_id=$1 ORDER BY d', [user])).rows;
    const prof = async (user) => (await db.query('SELECT department_id d FROM public.profiles WHERE id=$1', [user])).rows[0].d;
    await db.query('SELECT public.set_user_departments($1,$2)', [u, [A, B]]);
    let l = await links(u);
    ok(l.length === 2 && l.filter((x) => x.p).length === 1 && l.find((x) => x.p).d === A && await prof(u) === A, 'set {A,B}: both linked, A is the single primary, profile department = A');
    await db.query('SELECT public.set_user_departments($1,$2)', [u, [B, C, B]]);
    l = await links(u);
    ok(l.length === 2 && l.find((x) => x.p).d === B && !l.some((x) => x.d === A) && await prof(u) === B, 'set {B,C,B}: A removed, duplicates collapsed, B primary, profile = B');
    const bad = await tryq(db, 'SELECT public.set_user_departments($1,$2)', [u, [A, '00000000-0000-4000-8000-00000000ffff']]);
    l = await links(u);
    ok(!!bad.error && /Unknown department/.test(bad.error) && l.length === 2 && l.find((x) => x.p).d === B && await prof(u) === B, 'ATOMIC: an unknown department aborts the whole change; the previous links and primary are intact', bad.error);
    ok(await expectErr(db, "UPDATE public.user_departments SET is_primary = true WHERE user_id=$1", [u], /uq_user_primary_department|duplicate/), 'the database refuses two primary departments for one person');
    await db.query('SELECT public.set_user_departments($1,$2)', [u, []]);
    ok((await links(u)).length === 0 && await prof(u) === null, 'an empty list clears the links and the profile department');
    await db.query('SELECT public.set_user_departments($1,$2)', [u, [A, B]]);
    await db.query('SELECT public.set_primary_department($1,$2)', [u, C]);
    l = await links(u);
    ok(l.length === 2 && l.find((x) => x.p).d === C && !l.some((x) => x.d === A) && await prof(u) === C, 'set_primary_department(C): the old primary membership is replaced (the single-department form\'s behaviour), B stays');
    await db.query('SELECT public.set_primary_department($1,NULL)', [u]);
    ok(!(await links(u)).some((x) => x.p) && await prof(u) === null, 'set_primary_department(NULL) removes the primary only');
    ok(await expectErr(db, 'SELECT public.set_user_departments($1,$2)', ['00000000-0000-4000-8000-00000000aaaa', [A]], /Employee not found/), 'an unknown employee is refused');
    // race: two different full sets written at the same moment
    let consistent = 0, rounds = 20;
    const w = await Promise.all([connect('kite'), connect('kite')]);
    for (let i = 0; i < rounds; i++) {
      const [x, y] = i % 2 ? [[A, B], [C]] : [[C], [A, B]];
      await Promise.all([w[0].query('SELECT public.set_user_departments($1,$2)', [u, x]), w[1].query('SELECT public.set_user_departments($1,$2)', [u, y])]);
      const ln = await links(u); const prim = ln.filter((z) => z.p);
      const set = ln.map((z) => z.d).sort().join();
      const okSets = [[A, B].sort().join(), [C].join()];
      if (prim.length === 1 && await prof(u) === prim[0].d && okSets.includes(set)) consistent++;
    }
    ok(consistent === rounds, `RACE: ${rounds} rounds of two concurrent full updates: always exactly one set, one primary, profile = primary (${consistent}/${rounds})`);
    for (const c of w) await c.end();
    await db.query('UPDATE public.profiles SET department_id = $2 WHERE id=$1', [u, B]);
    ok(await count('SELECT count(*)::int c FROM public.department_link_drift() WHERE user_id=$1', [u]) === 1, 'department_link_drift() reports a profile whose department differs from its primary link');
    // client departments (runs as the signed-in user: RLS decides)
    const cl = await client('CD'); const GM = await mkUser('gm2', 'general_manager');
    await db.query('INSERT INTO public.client_departments(client_id,department_id) VALUES ($1,$2),($1,$3)', [cl, A, B]);
    let rr = await asUser(E1, 'SELECT public.set_client_departments($1,$2)', [cl, [C]]);
    ok(!!rr.error && await count('SELECT count(*)::int c FROM public.client_departments WHERE client_id=$1', [cl]) === 2, 'an employee (not a manager) cannot change a client\'s departments; nothing changes', rr.error);
    rr = await asUser(ADMIN, 'SELECT public.set_client_departments($1,$2)', [cl, [B, '00000000-0000-4000-8000-00000000ffff']]);
    ok(!!rr.error && (await db.query('SELECT department_id d FROM public.client_departments WHERE client_id=$1 ORDER BY 1', [cl])).rows.map((x) => x.d).sort().join() === [A, B].sort().join(), 'ATOMIC: an invalid department rolls back the DELETE too - the client keeps A and B (the old two-request code lost them)', rr.error);
    rr = await asUser(ADMIN, 'SELECT public.set_client_departments($1,$2)', [cl, [B, C]]);
    ok(!rr.error && (await db.query('SELECT department_id d FROM public.client_departments WHERE client_id=$1 ORDER BY 1', [cl])).rows.map((x) => x.d).sort().join() === [B, C].sort().join(), 'a manager replaces the set in one call: {B,C}');
  }


  // ================================================================== 9. money_figures
  section('9. F-11 money figures follow their record; a record and its figure are saved together');
  {
    const fig = (entity, id) => count('SELECT count(*)::int c FROM public.money_figures WHERE entity=$1 AND entity_id=$2', [entity, id]);
    const cl = await client('MF'); await db.query("INSERT INTO public.money_figures(entity,entity_id,amount,updated_by) VALUES ('client_monthly',$1,1500,$2)", [cl, OWNER]);
    ok(await fig('client_monthly', cl) === 1, 'a figure is stored for an existing client');
    await db.query('DELETE FROM public.clients WHERE id=$1', [cl]);
    ok(await fig('client_monthly', cl) === 0, 'deleting the client deletes its figure (no orphan)');
    ok(await expectErr(db, "INSERT INTO public.money_figures(entity,entity_id,amount) VALUES ('client_monthly',$1,5)", ['00000000-0000-4000-8000-0000000000ee'], /money_figure_orphan/), 'a figure cannot be written for a record that does not exist');
    for (const [table, entity, mk] of [
      ['projects', 'project_budget', async () => (await db.query("INSERT INTO public.projects(code,name) VALUES ('MF'||random(),'p') RETURNING id")).rows[0].id],
      ['campaigns', 'campaign_budget', async () => (await db.query("INSERT INTO public.campaigns(name) VALUES ('c') RETURNING id")).rows[0].id],
      ['departments', 'department_budget', async () => (await db.query("INSERT INTO public.departments(name) VALUES ('d'||random()) RETURNING id")).rows[0].id],
      ['leads', 'lead_value', async () => (await db.query("INSERT INTO public.leads(title) VALUES ('l') RETURNING id")).rows[0].id],
      ['opportunities', 'opportunity_value', async () => (await db.query("INSERT INTO public.opportunities(name) VALUES ('o') RETURNING id")).rows[0].id]]) {
      const id = await mk(); await db.query('INSERT INTO public.money_figures(entity,entity_id,amount) VALUES ($1,$2,9)', [entity, id]);
      await db.query(`DELETE FROM public.${table} WHERE id=$1`, [id]);
      ok(await fig(entity, id) === 0, `deleting a ${table.replace(/s$/, '')} deletes its ${entity} figure`);
    }
    // create_entity_with_figure / update_entity_with_figure
    const GM2 = await mkUser('gm3', 'general_manager');
    let r = await asUser(OWNER, `SELECT public.create_entity_with_figure('clients', $1::jsonb, 750) id`, [JSON.stringify({ name: 'Nour', company_name: 'Nour Co', status: 'active', created_by: OWNER })]);
    ok(!r.error && await fig('client_monthly', r.rows[0].id) === 1 && await count("SELECT count(*)::int c FROM public.clients WHERE id=$1", [r.rows[0].id]) === 1, 'the owner creates a client and its monthly figure in ONE call', JSON.stringify(r));
    const made = r.rows[0].id;
    r = await asUser(GM2, `SELECT public.create_entity_with_figure('leads', $1::jsonb, 750) id`, [JSON.stringify({ title: 'NoFig Lead', created_by: GM2 })]);
    ok(!!r.error && await count("SELECT count(*)::int c FROM public.leads WHERE title='NoFig Lead'") === 0, 'ATOMIC: a manager who may create leads but not money figures gets an error and NO lead is left behind (the old code left a lead without its value)', r.error);
    r = await asUser(GM2, `SELECT public.create_entity_with_figure('leads', $1::jsonb) id`, [JSON.stringify({ title: 'Plain Lead', created_by: GM2 })]);
    ok(!r.error && await count("SELECT count(*)::int c FROM public.leads WHERE title='Plain Lead'") === 1, 'without a figure the same manager creates the lead normally (RLS unchanged)', r.error);
    ok(await expectErr(db, `SELECT public.create_entity_with_figure('clients', '{"name":"x","company_name":"x","nope":1}'::jsonb, 5)`, [], /Unknown column/), 'an unknown column is refused');
    ok(await expectErr(db, `SELECT public.create_entity_with_figure('profiles', '{"full_name":"x"}'::jsonb, 5)`, [], /Unsupported table/), 'only the six business tables are accepted');
    ok(await expectErr(db, `SELECT public.create_entity_with_figure('clients', '{}'::jsonb, 5)`, [], /Nothing to insert/), 'an empty row is refused');
    r = await asUser(OWNER, `SELECT public.update_entity_with_figure('clients', $1, $2::jsonb, 900)`, [made, JSON.stringify({ name: 'Nour 2', industry: 'Media' })]);
    ok(!r.error && (await db.query('SELECT name, industry FROM public.clients WHERE id=$1', [made])).rows[0].name === 'Nour 2' && num((await db.query("SELECT amount FROM public.money_figures WHERE entity='client_monthly' AND entity_id=$1", [made])).rows[0].amount) === 900, 'update_entity_with_figure changes the record and its figure together (900)', r.error);
    r = await asUser(OWNER, `SELECT public.update_entity_with_figure('clients', $1, '{"name":"Nour 3"}'::jsonb, NULL, false)`, [made]);
    ok(!r.error && await fig('client_monthly', made) === 1, 'p_touch_figure = false leaves the figure alone');
    r = await asUser(OWNER, `SELECT public.update_entity_with_figure('clients', $1, '{}'::jsonb, 0)`, [made]);
    ok(!r.error && await fig('client_monthly', made) === 0, 'an amount of 0 / empty clears the figure (as Money.save did)');
    r = await asUser(OWNER, `SELECT public.update_entity_with_figure('clients', $1, '{"name":"x"}'::jsonb, 5)`, ['00000000-0000-4000-8000-0000000000dd']);
    ok(!!r.error && /not_found_or_not_permitted/.test(r.error), 'updating a record that does not exist (or is not yours to change) is an error, not a silent success');
    ok(await expectErr(db, `SELECT public.update_entity_with_figure('clients', $1, '{"id":"00000000-0000-4000-8000-0000000000ab"}'::jsonb, 5)`, [made], /Unknown column/), 'the id cannot be rewritten through the helper');
    // legacy orphans are reported, not deleted
    await db.query('ALTER TABLE public.money_figures DISABLE TRIGGER money_figures_entity_check');
    await db.query("INSERT INTO public.money_figures(entity,entity_id,amount) VALUES ('lead_value','00000000-0000-4000-8000-0000000000fe',3)");
    await db.query('ALTER TABLE public.money_figures ENABLE TRIGGER money_figures_entity_check');
    ok(await count("SELECT count(*)::int c FROM public.money_figure_orphans() WHERE entity_id='00000000-0000-4000-8000-0000000000fe'") === 1, 'a legacy orphan figure (written behind the guard) is reported by money_figure_orphans() and left in place');
    ok((await db.query("SELECT n FROM public.integrity_report() WHERE check_name LIKE 'money figures%'")).rows[0].n >= 1, '... and counted by integrity_report()');
  }

  // ================================================================== 10. Kite Drive intents
  section('10. F-16 Kite Drive: link creation is an intent that survives a crash, retries adopt the account, races create one');
  {
    const cl = await client('KD');
    const begin = (c, client, email = 'drive@x.test') => c.query('SELECT * FROM public.drive_link_begin($1,$2,$3)', [client, email, ADMIN]).then((r) => r.rows[0]);
    let b = await begin(db, cl);
    ok(b.state === 'new' && b.drive_user_id === null, 'first request: state new (go and create the account on Drive)');
    b = await begin(db, cl);
    ok(b.state === 'busy', 'a second request right away: busy (another request is creating it)');
    await db.query("UPDATE public.client_drive_link_intents SET created_at = now() - interval '5 minutes' WHERE client_id=$1", [cl]);
    b = await begin(db, cl);
    ok(b.state === 'stale', 'an intent older than 2 minutes with no recorded account: stale (look the account up on Drive by e-mail before creating)');
    await db.query('SELECT public.drive_link_remote_created($1,$2,$3)', [cl, 7701, 'Drive Name']);
    b = await begin(db, cl);
    ok(b.state === 'adopt' && b.drive_user_id === 7701 && b.drive_name === 'Drive Name', 'after the account exists on Drive, a retry gets state adopt + the Drive id: NO second account is created');
    await db.query("UPDATE public.client_drive_link_intents SET created_at = now() - interval '20 minutes' WHERE client_id=$1", [cl]);
    ok(await count('SELECT count(*)::int c FROM public.drive_link_orphans() WHERE client_id=$1', [cl]) === 1, 'an account created on Drive but never linked shows up in drive_link_orphans()');
    // atomic completion: the link row and the removal of the intent commit together; a clash leaves the intent for the retry
    const other = await client('KD2');
    await db.query('INSERT INTO public.client_drive_links(client_id,drive_user_id,drive_name) VALUES ($1,7701,$2)', [other, 'someone else']);
    let r = await tryq(db, 'SELECT public.drive_link_complete($1,$2,$3,$4)', [cl, 7701, 'Drive Name', ADMIN]);
    ok(!!r.error && /duplicate|unique/.test(r.error) && await count('SELECT count(*)::int c FROM public.client_drive_link_intents WHERE client_id=$1', [cl]) === 1 && await count('SELECT count(*)::int c FROM public.client_drive_links WHERE client_id=$1', [cl]) === 0, 'ATOMIC: when the Drive account is already linked to another client, nothing is linked and the intent stays', r.error);
    await db.query('DELETE FROM public.client_drive_links WHERE client_id=$1', [other]);
    await db.query('SELECT public.drive_link_complete($1,$2,$3,$4)', [cl, 7701, 'Drive Name', ADMIN]);
    ok(await count('SELECT count(*)::int c FROM public.client_drive_links WHERE client_id=$1 AND drive_user_id=7701', [cl]) === 1 && await count('SELECT count(*)::int c FROM public.client_drive_link_intents WHERE client_id=$1', [cl]) === 0, 'complete: the link exists and the intent is gone, together');
    ok(await expectErr(db, 'SELECT * FROM public.drive_link_begin($1,$2,$3)', [cl, 'x@x.test', ADMIN], /already_linked/), 'a linked client cannot start a second creation');
    await db.query('SELECT public.drive_link_complete($1,$2,$3,$4,true)', [cl, 7702, 'Replaced', ADMIN]);
    ok((await db.query('SELECT drive_user_id d FROM public.client_drive_links WHERE client_id=$1', [cl])).rows[0].d === 7702, 'p_replace = true keeps the old "link another existing account" behaviour');
    // abort only removes an intent that never produced an account
    const c3 = await client('KD3'); await begin(db, c3); await db.query('SELECT public.drive_link_abort($1)', [c3]);
    ok(await count('SELECT count(*)::int c FROM public.client_drive_link_intents WHERE client_id=$1', [c3]) === 0, 'abort removes an intent whose remote call failed');
    await begin(db, c3); await db.query('SELECT public.drive_link_remote_created($1,7703,$2)', [c3, 'n']); await db.query('SELECT public.drive_link_abort($1)', [c3]);
    ok(await count('SELECT count(*)::int c FROM public.client_drive_link_intents WHERE client_id=$1', [c3]) === 1, '... but never one that already created an account (it is kept for adoption)');
    // race
    const c4 = await client('KD4'); const ws = await Promise.all(Array.from({ length: 6 }, () => connect('kite')));
    const res = await Promise.all(ws.map((w) => begin(w, c4)));
    ok(res.filter((x) => x.state === 'new').length === 1 && res.filter((x) => x.state === 'busy').length === 5, 'RACE: six simultaneous link.create requests: exactly ONE goes to Drive, five are told it is busy');
    for (const w of ws) await w.end();
  }

  // ================================================================== 11. chat
  section('11. F-17 reactions and channel members: concurrent changes cannot corrupt or fail');
  {
    const cv = (await db.query("INSERT INTO public.conversations(type,name) VALUES ('group','chan') RETURNING id")).rows[0].id;
    const msg = (await db.query("INSERT INTO public.messages(conversation_id,sender_id,content) VALUES ($1,$2,'hi') RETURNING id", [cv, ADMIN])).rows[0].id;
    const rx = () => count("SELECT count(*)::int c FROM public.message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji='👍'", [msg, E1]);
    const ws = await Promise.all(Array.from({ length: 11 }, () => connect('kite')));
    const res = await Promise.allSettled(ws.map((w) => w.query("SELECT public.chat_reaction_toggle($1,$2,'👍') a", [E1, msg])));
    ok(res.every((x) => x.status === 'fulfilled'), 'RACE: eleven simultaneous toggles of one reaction: none fails (the old select-then-insert returned 500 on a clash)', res.filter((x) => x.status === 'rejected').map((x) => x.reason.message).join('|'));
    ok(await rx() === 1 && res.filter((x) => x.value.rows[0].a === true).length === 6, '  ... 11 toggles = ON: one row, 6 "added" and 5 "removed" answers');
    const res2 = await Promise.allSettled(ws.map((w) => w.query("SELECT public.chat_reaction_toggle($1,$2,'👍') a", [E1, msg])));
    ok(res2.every((x) => x.status === 'fulfilled') && await rx() === 0, 'eleven more toggles (22 in total) = OFF: no row, no error');
    ok((await db.query("SELECT public.chat_reaction_toggle($1,$2,'❤️') a", [E2, msg])).rows[0].a === true && await count("SELECT count(*)::int c FROM public.message_reactions WHERE message_id=$1", [msg]) === 1, 'other people / other emoji are independent');
    ok(await expectErr(db, "SELECT public.chat_reaction_toggle($1,$2,'x')", [E1, '00000000-0000-4000-8000-0000000000cc'], /message_not_found/), 'a missing message is an error');
    for (const w of ws) await w.end();
    // members
    const M = await Promise.all([1, 2, 3, 4].map((i) => mkUser('m' + i)));
    await db.query("INSERT INTO public.conversation_members(conversation_id,user_id,role) VALUES ($1,$2,'admin'),($1,$3,'member')", [cv, M[0], M[1]]);
    let r = await db.query('SELECT public.chat_set_members($1,$2) d', [cv, [M[0], M[1], M[2]]]);
    ok(r.rows[0].d.added.join() === M[2] && r.rows[0].d.removed.length === 0, 'chat_set_members reports what it added / removed');
    r = await db.query('SELECT public.chat_set_members($1,$2) d', [cv, [M[0], M[3]]]);
    ok(r.rows[0].d.added.join() === M[3] && r.rows[0].d.removed.sort().join() === [M[1], M[2]].sort().join() && (await db.query("SELECT role FROM public.conversation_members WHERE conversation_id=$1 AND user_id=$2", [cv, M[0]])).rows[0].role === 'admin', '... removes the rest and keeps an existing admin\'s role');
    let clean = 0; const cw = await Promise.all([connect('kite'), connect('kite')]);
    for (let i = 0; i < 20; i++) {
      const s1 = [M[0], M[1]], s2 = [M[0], M[2], M[3]];
      const rs = await Promise.allSettled([cw[0].query('SELECT public.chat_set_members($1,$2)', [cv, s1]), cw[1].query('SELECT public.chat_set_members($1,$2)', [cv, s2])]);
      const have = (await db.query('SELECT user_id FROM public.conversation_members WHERE conversation_id=$1', [cv])).rows.map((x) => x.user_id).sort().join();
      if (rs.every((x) => x.status === 'fulfilled') && [s1.slice().sort().join(), s2.slice().sort().join()].includes(have)) clean++;
    }
    ok(clean === 20, `RACE: 20 rounds of two concurrent member updates: no error and always exactly one of the two requested sets (${clean}/20)`);
    for (const w of cw) await w.end();
  }

  // ================================================================== 12. dedupe, broadcasts, invitations
  section('12. F-17 reminders / broadcasts / invitations: the database makes repeats impossible');
  {
    const ins = (c, user, key) => tryq(c, "INSERT INTO public.notifications(user_id,type,title,content,dedupe_key) VALUES ($1,'due_digest','t','c',$2)", [user, key]);
    const ws = await Promise.all(Array.from({ length: 8 }, () => connect('kite')));
    const res = await Promise.all(ws.map((w) => ins(w, E1, 'due_digest:2031-01-01')));
    ok(res.filter((x) => !x.error).length === 1 && res.filter((x) => /uq_notifications_dedupe|duplicate/.test(x.error ?? '')).length === 7, 'RACE: 8 reminder jobs at once for the same person and day: exactly one notification');
    ok(!(await ins(db, E1, 'due_digest:2031-01-02')).error && !(await ins(db, E2, 'due_digest:2031-01-01')).error, 'another day, or another person, is a different key');
    ok(!(await ins(db, E1, null)).error && !(await ins(db, E1, null)).error, 'notifications without a key are unrestricted (as before)');
    for (const w of ws) await w.end();
    const rq = '00000000-0000-4000-8000-0000000000b1';
    await db.query("INSERT INTO public.broadcasts(sender_id,title,message,audience_type,request_id) VALUES ($1,'Hi','hello there','all',$2)", [ADMIN, rq]);
    ok(await expectErr(db, "INSERT INTO public.broadcasts(sender_id,title,message,audience_type,request_id) VALUES ($1,'Hi','hello there','all',$2)", [ADMIN, rq], /uq_broadcasts_request|duplicate/), 'a broadcast request id can be recorded once (a repeated send is recognised)');
    const inv = (c, email) => tryq(c, "INSERT INTO public.invitations(email,full_name,role_id,invited_by,token,status) SELECT $1,'N',id,$2,gen_random_uuid()::text,'pending' FROM public.roles WHERE name='employee'", [email, ADMIN]);
    ok(!(await inv(db, 'Dup@x.test')).error, 'first pending invitation for an address');
    ok((await inv(db, 'dup@X.TEST')).error?.match(/uq_invitation_pending_email|duplicate/) !== undefined, 'a second pending invitation for the same address (any capitalisation) is refused');
    await db.query("UPDATE public.invitations SET status='revoked' WHERE lower(email)='dup@x.test'");
    ok(!(await inv(db, 'dup@x.test')).error, 'after the first is revoked a new pending one is allowed');
    const w2 = await Promise.all(Array.from({ length: 5 }, () => connect('kite')));
    const rr = await Promise.all(w2.map((w) => inv(w, 'race@x.test')));
    ok(rr.filter((x) => !x.error).length === 1, 'RACE: five simultaneous invitations for one address: exactly one is created');
    for (const w of w2) await w.end();
  }

  // ================================================================== 13. hygiene
  section('13. F-18 / F-20 / F-24 / F-12: audit immutability, TRUNCATE guards, FK indexes, operator-only migration switch, business dates');
  {
    await db.query("INSERT INTO public.audit_logs(user_id,action,entity_type) VALUES ($1,'IMMUTABLE_PROBE','x')", [ADMIN]);
    ok(await expectErr(db, "UPDATE public.audit_logs SET action='CHANGED' WHERE action='IMMUTABLE_PROBE'", [], /append-only/), 'audit_logs: UPDATE refused');
    ok(await expectErr(db, "UPDATE public.audit_logs SET user_id = NULL, action='X' WHERE action='IMMUTABLE_PROBE'", [], /append-only/), 'audit_logs: clearing user_id together with anything else is refused (only the FK\'s own SET NULL passes)');
    ok(await expectErr(db, "DELETE FROM public.audit_logs WHERE action='IMMUTABLE_PROBE'", [], /append-only/), 'audit_logs: DELETE refused');
    ok(await expectErr(db, 'TRUNCATE public.audit_logs', [], /append-only/), 'audit_logs: TRUNCATE refused');
    ok(await count("SELECT count(*)::int c FROM public.audit_logs WHERE action='IMMUTABLE_PROBE'") === 1, '  ... the row is still there');
    for (const t of ['finance_audit_log', 'invoices', 'invoice_payments', 'invoice_number_seq']) ok(await expectErr(db, `TRUNCATE public.${t}`, [], /append-only|cannot be deleted|cannot truncate a table referenced/), `${t}: TRUNCATE refused`);
    ok(await expectErr(db, 'TRUNCATE public.clients CASCADE', [], /append-only|cannot be deleted/), 'TRUNCATE ... CASCADE from a parent table cannot wipe the finance tables either');
    // foreign-key indexes
    const noIdx = await db.query(`SELECT c.conrelid::regclass::text t, c.conname FROM pg_constraint c WHERE c.contype='f' AND c.connamespace='public'::regnamespace
      AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid AND i.indisvalid AND i.indpred IS NULL AND (i.indkey::int2[])[0:cardinality(c.conkey)-1] = c.conkey)`);
    ok(noIdx.rows.length === 0, 'EVERY foreign key in the public schema has a supporting index', noIdx.rows.slice(0, 5).map((r) => r.t + '.' + r.conname).join(', '));
    ok(await count("SELECT count(*)::int c FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'idx_fk_%'") >= 40, 'migration 033 created the missing ones (idx_fk_*)');
    ok((await db.query("SELECT n FROM public.integrity_report() WHERE check_name LIKE 'foreign keys without%'")).rows[0].n == 0, 'integrity_report() agrees');
    ok(await count("SELECT count(*)::int c FROM public.integrity_report()") === 19, 'integrity_report() lists its 19 detectors (13 from 033 + 4 from 035 + 2 from 037)');
    ok((await asUser(OWNER, 'SELECT * FROM public.integrity_report()')).error !== undefined, 'integrity_report() is not callable by a signed-in user');
    // F-24: app.migrating
    const cl = await client('MIG'); const inv = (await db.query(`SELECT public.fin_invoice_save($1,$2::jsonb) id`, [ADMIN, JSON.stringify({ client_id: cl, items: [{ description_en: 'x', quantity: 1, unit_price: 100, vat_rate: 0 }] })])).rows[0].id;
    await db.query('SELECT public.fin_invoice_issue($1,$2)', [ADMIN, inv]);
    const payId = (await db.query("SELECT public.fin_payment_add($1,$2,40,public.studio_today(),'cash',NULL,NULL) id", [ADMIN, inv])).rows[0].id;
    let c = await connect('kite');
    await c.query('BEGIN'); await c.query('SET LOCAL ROLE service_role'); await c.query("SET LOCAL app.migrating = 'on'");
    let r = await tryq(c, 'UPDATE public.invoice_payments SET amount = 41 WHERE id=$1', [payId]);
    await c.query('ROLLBACK');
    ok(!!r.error && /cannot be edited/.test(r.error), 'F-24: service_role with app.migrating=on still cannot edit a payment (the switch is operator-only)', r.error);
    await c.query('BEGIN'); await c.query('SET LOCAL ROLE service_role'); await c.query("SET LOCAL app.migrating = 'on'");
    r = await tryq(c, "UPDATE public.invoices SET status='draft' WHERE id=$1", [inv]); await c.query('ROLLBACK');
    ok(!!r.error, 'F-24: ... nor move an issued invoice back to draft', r.error);
    await c.query('BEGIN'); await c.query("SET LOCAL app.migrating = 'on'");
    r = await tryq(c, 'UPDATE public.invoice_payments SET amount = amount WHERE id=$1', [payId]); await c.query('ROLLBACK');
    ok(!r.error, 'F-24: a database operator with the switch on (the 017 legacy load) still works', r.error);
    await c.end();
    ok((await db.query('SELECT public.fin_migrating() m')).rows[0].m === false, 'fin_migrating() is false by default');
    // F-12: business date in finance
    const defs = (await db.query(`SELECT p.proname, pg_get_functiondef(p.oid) d FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'fin\\_%'`)).rows;
    const cd = defs.filter((x) => /current_date/i.test(x.d)).map((x) => x.proname);
    ok(cd.length === 0, 'F-12: no finance function uses the server\'s current_date', cd.join(','));
    const raw = defs.filter((x) => /app\.migrating/.test(x.d) && x.proname !== 'fin_migrating').map((x) => x.proname);
    ok(raw.length === 0, 'F-24: no finance function reads app.migrating directly (all use fin_migrating())', raw.join(','));
    ok(!(await tryq(db, "SELECT public.fin_payment_add($1,$2,10,public.studio_today(),'cash',NULL,NULL)", [ADMIN, inv])).error, 'a payment dated today (studio date) is accepted');
    ok(await expectErr(db, "SELECT public.fin_payment_add($1,$2,10,public.studio_today() + 1,'cash',NULL,NULL)", [ADMIN, inv], /future/), 'a payment dated tomorrow (studio date) is refused');
    await db.query("INSERT INTO public.company_settings(key,value) VALUES ('studio_timezone', '\"Pacific/Kiritimati\"')");   // UTC+14: its "today" is ahead of Cairo's
    const kiri = (await db.query("SELECT public.studio_today() = public.studio_date(now(), 'Pacific/Kiritimati') AS same")).rows[0].same;
    await db.query("DELETE FROM public.company_settings WHERE key='studio_timezone'");
    ok(kiri === true, 'the finance "today" follows the configured studio time zone (company_settings), not the session or server zone');
  }

  // ================================================================== 14. re-run rule
  section('14. re-running 017 after the chain: 028 then 033 restore every protected function (documented rule)');
  {
    const names = ['fin_recalc_invoice', 'fin_payment_reverse', 'fin_payment_add', 'fin_invoice_issue', 'fin_invoice_save', 'fin_retainer_generate', 'fin_invoice_guard', 'fin_payment_guard',
      'fin_item_calc', 'fin_refresh_status', 'fin_mark_overdue', 'fin_check_paid_sum', 'fin_migrating'];
    const defs = async () => JSON.stringify((await db.query(`SELECT p.oid::regprocedure::text sig, pg_get_functiondef(p.oid) d FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname = ANY($1) ORDER BY 1`, [names])).rows);
    const nPay = () => count("SELECT count(*)::int c FROM pg_proc WHERE proname='fin_payment_add' AND pronamespace='public'::regnamespace");
    const data = async () => JSON.stringify((await db.query(`SELECT (SELECT count(*) FROM public.invoices) a, (SELECT sum(total) FROM public.invoices) b, (SELECT count(*) FROM public.invoice_payments) c, (SELECT sum(amount) FROM public.invoice_payments) d, (SELECT count(*) FROM public.invoice_items) e`)).rows[0]);
    const good = await defs(); const d0 = await data();
    ok(await nPay() === 1, 'baseline: one fin_payment_add');
    await db.query(sql('migrations/017_finance_invoicing.sql'));
    ok(await defs() !== good && await nPay() === 2, 'a re-run of 017 replaces the protected functions and brings the 7-argument fin_payment_add back');
    ok(await data() === d0, '... and changes no historical row');
    await db.query(sql('migrations/028_finance_integrity.sql'));
    const after028 = await defs();
    ok(after028 !== good && await nPay() === 1 && /current_date/.test(after028), 'after 028 ONLY: one overload again, but the 033 protections (studio date, operator-only switch) are still missing');
    await db.query(sql('migrations/033_database_hygiene.sql'));
    ok(await defs() === good, 'after 028 THEN 033: every protected function is byte-identical to the baseline');
    ok(await nPay() === 1 && await data() === d0, '... one overload, no data changed');
    const live = (await db.query('SELECT count(*)::int c FROM public.fin_reconcile_invoices()')).rows[0].c;
    ok(live === 0, '... and reconcile is clean', String(live));
    await db.query(sql('migrations/035_phase5_business_correctness.sql'));        // documented rule: 035 goes last (it re-creates integrity_report())
    ok(await count('SELECT count(*)::int c FROM public.integrity_report()') === 17 && await defs() === good, '... then 035 last restores the 17-row report and leaves the protected finance functions untouched');
    await db.query(sql('migrations/037_background_jobs.sql'));                     // documented rule: 037 goes after 035 (it re-creates integrity_report() with 19 rows)
    ok(await count('SELECT count(*)::int c FROM public.integrity_report()') === 19, '... and 037 after it brings the 19-row report back');
  }



  // ================================================================== 15. legacy data
  section('15. LEGACY database: damaged historical rows are kept byte-for-byte, reported, never block valid work; constraints validate after clean-up');
  {
    const c1 = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'pw', database: 'postgres' }); await c1.connect();
    await c1.query(`CREATE DATABASE legacy ENCODING 'UTF8' TEMPLATE template0 LOCALE 'C'`); await c1.end();
    const lnotices = [];
    const L = await connect('legacy', lnotices);
    await L.query(STUBS.replace(/CREATE ROLE[^;]*;/g, ''));
    for (const f of files.filter((x) => num(x.slice(0, 3)) <= 28)) { const r = await tryq(L, sql('migrations/' + f)); if (r.error) { failed++; console.log('FAIL legacy chain', f, r.error.slice(0, 160)); } if (f.startsWith('005')) await L.query(sql('seed.sql')); }
    const lid = (n) => `00000000-0000-4000-8000-0000000${String(n).padStart(5, '0')}`;
    const lrole = async (n) => (await L.query('SELECT id FROM public.roles WHERE name=$1', [n])).rows[0].id;
    const mk = async (n, role = 'employee') => { const id = lid(n); await L.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [id, 'l' + n + '@x.test']); await L.query("INSERT INTO public.profiles(id,full_name,email) VALUES ($1,$2,$3)", [id, 'L' + n, 'l' + n + '@x.test']); await L.query('INSERT INTO public.user_roles(user_id,role_id) VALUES ($1,$2)', [id, await lrole(role)]); return id; };
    const own = await mk(1, 'owner'), emp = await mk(2), emp2 = await mk(3);
    // ---- historical damage that earlier code allowed
    await L.query("INSERT INTO public.attendance_records(user_id,check_in,check_out,total_hours,date) VALUES ($1,'2025-03-01 09:00+00','2025-03-01 08:00+00',99,'2025-03-01')", [emp]);   // check-out before check-in, hours made up
    await L.query("INSERT INTO public.attendance_records(user_id,check_in,date) VALUES ($1,'2025-03-02 09:00+00','2025-03-02')", [emp]);                                                    // never closed
    const lt = (await L.query("INSERT INTO public.leave_types(name,default_days) VALUES ('Annual',5) RETURNING id")).rows[0].id;
    await L.query("INSERT INTO public.leave_requests(user_id,leave_type_id,start_date,end_date,total_days,reason,status) VALUES ($1,$2,'2025-05-10','2025-05-01',3,'backwards','approved')", [emp, lt]);   // end before start
    await L.query("INSERT INTO public.leave_requests(user_id,leave_type_id,start_date,end_date,total_days,reason,status) VALUES ($1,$2,'2025-06-01','2025-06-10',2,'wrong days','approved'),($1,$2,'2025-06-05','2025-06-12',8,'overlaps','pending')", [emp, lt]);
    const e1 = (await L.query("INSERT INTO public.expenses(title,amount,category,submitted_by,status,currency) VALUES ('old claim',900,'other',$1,'approved','USD') RETURNING id", [emp])).rows[0].id;                       // approved, no approval record
    const e2 = (await L.query("INSERT INTO public.expenses(title,amount,category,submitted_by,status) VALUES ('twice',50,'other',$1,'approved') RETURNING id", [emp])).rows[0].id;
    await L.query("INSERT INTO public.expense_approvals(expense_id,approver_id,action) VALUES ($1,$2,'approved'),($1,$2,'approved')", [e2, own]);                                                         // two approvals
    await L.query("INSERT INTO public.budgets(name,amount,spent) VALUES ('typed by hand',1000,999)");
    await L.query("INSERT INTO public.money_figures(entity,entity_id,amount) VALUES ('client_monthly','00000000-0000-4000-8000-0000000fffff',123)");                                                          // orphan
    const dA = (await L.query("INSERT INTO public.departments(name) VALUES ('LA') RETURNING id")).rows[0].id, dB = (await L.query("INSERT INTO public.departments(name) VALUES ('LB') RETURNING id")).rows[0].id;
    await L.query("INSERT INTO public.user_departments(user_id,department_id,is_primary) VALUES ($1,$2,true),($1,$3,true)", [emp, dA, dB]);                                                                // two primaries
    await L.query("UPDATE public.profiles SET department_id=$2 WHERE id=$1", [emp2, dA]);                                                                                                                   // profile dept without a link
    const rl = await lrole('employee');
    await L.query("INSERT INTO public.invitations(email,full_name,role_id,invited_by,token,status) VALUES ('Two@x.test','T',$1,$2,'t1','pending'),('two@x.test','T',$1,$2,'t2','pending')", [rl, own]);          // two pending
    const pA = (await L.query("INSERT INTO public.content_plans(title,created_by) VALUES ('PA',$1) RETURNING id", [own])).rows[0].id, pB = (await L.query("INSERT INTO public.content_plans(title,created_by) VALUES ('PB',$1) RETURNING id", [own])).rows[0].id;
    const postB = (await L.query("INSERT INTO public.content_posts(plan_id,title) VALUES ($1,'b') RETURNING id", [pB])).rows[0].id;
    await L.query("INSERT INTO public.content_post_assets(plan_id,post_id,storage_path,file_name,file_type,file_size,uploaded_by) VALUES ($1,$2,$3,'f','image/png',1,$4)", [pA, postB, `${own}/plans/${pA}/mismatch.png`, own]);       // plan A's visual on plan B's post
    await L.query("INSERT INTO public.audit_logs(user_id,action,entity_type) VALUES ($1,'OLD_EVENT','x')", [emp]);
    const tk = (await L.query("INSERT INTO public.tasks(title,created_by) VALUES ('old task',$1) RETURNING id", [own])).rows[0].id;
    const legacyPath = `${tk}/cccccccc-1111-4222-8333-000000000001-path.png`;   // canonical legacy format: still queued on delete
    await L.query("INSERT INTO public.task_attachments(task_id,file_name,file_size,file_type,storage_path,uploaded_by) VALUES ($1,'a',1,'x',$3,$2)", [tk, own, legacyPath]);

    const NEWCOLS = ['user_id', 'actor_id', 'actor_label', 'paid_at', 'paid_by', 'approved_at', 'dedupe_key', 'request_id', 'completed_at'];
    const TABLES = ['profiles', 'attendance_records', 'leave_requests', 'leave_types', 'expenses', 'expense_approvals', 'budgets', 'money_figures', 'user_departments', 'invitations', 'content_plans', 'content_posts', 'content_post_assets',
      'audit_logs', 'tasks', 'task_attachments', 'departments', 'user_roles'];
    const snap = async () => { const out = {}; for (const t of TABLES) out[t] = JSON.stringify((await L.query(`SELECT coalesce(json_agg(to_jsonb(x) - $1::text[] ORDER BY to_jsonb(x)::text), '[]') j FROM public.${t} x`, [NEWCOLS])).rows[0].j); return out; };
    const before = await snap();
    for (const f of files.filter((x) => num(x.slice(0, 3)) >= 29)) { const r = await tryq(L, sql('migrations/' + f)); if (r.error) { failed++; console.log('FAIL legacy apply', f, r.error.slice(0, 200)); } }
    const after = await snap();
    const diff = TABLES.filter((t) => before[t] !== after[t]);
    ok(diff.length === 0, 'applying 029-033 changed NO historical row in any of the ' + TABLES.length + ' business tables (the new annotation columns excluded)', diff.join(','));
    ok(lnotices.some((m) => /attendance_out_after_in/.test(m)) && lnotices.some((m) => /leave_end_after_start/.test(m)), 'the attendance and leave CHECKs the data cannot satisfy were reported (NOTICE)');
    ok(lnotices.some((m) => /uq_user_primary_department/.test(m)) && lnotices.some((m) => /uq_invitation_pending_email/.test(m)) && lnotices.some((m) => /uq_expense_approval_once/.test(m)), 'the three unique indexes the data cannot satisfy were skipped with a NOTICE (not forced)');
    ok(lnotices.some((m) => /content_post_assets_plan_post_fk/.test(m)), 'the plan / post foreign key stays NOT VALID because a legacy visual points at another plan\'s post');
    const cons = (await L.query("SELECT conname, convalidated FROM pg_constraint WHERE conname IN ('attendance_out_after_in','attendance_hours_nonneg','leave_end_after_start','expenses_currency_chk','content_post_assets_plan_post_fk','content_feedback_plan_post_fk')")).rows;
    const cv = Object.fromEntries(cons.map((x) => [x.conname, x.convalidated]));
    ok(cv.attendance_out_after_in === false && cv.leave_end_after_start === false && cv.content_post_assets_plan_post_fk === false && cv.attendance_hours_nonneg === true && cv.expenses_currency_chk === true && cv.content_feedback_plan_post_fk === true, 'violated constraints stay NOT VALID, the compliant ones are VALIDATED', JSON.stringify(cv));
    ok((await L.query("SELECT count(*)::int c FROM pg_indexes WHERE indexname IN ('uq_user_primary_department','uq_invitation_pending_email','uq_expense_approval_once')")).rows[0].c === 0, 'none of the three skipped indexes exists');
    // ---- the detectors see the damage
    const rep = Object.fromEntries((await L.query('SELECT check_name, n FROM public.integrity_report()')).rows.map((r) => [r.check_name, num(r.n)]));
    ok(rep['money figures of records that no longer exist'] === 1 && rep['people whose profile department differs from their primary department'] >= 1 && rep['decided expenses without an approval record'] >= 1 && rep['visuals pointing at a post of another plan'] === 1
       && rep['attendance records open for more than 24 hours'] >= 1 && rep['budgets whose stored spent differs from the derived figure'] >= 1 && rep['constraints still NOT VALID in the public schema'] >= 3, 'integrity_report() lists every kind of legacy damage', JSON.stringify(rep));
    // ---- legacy rows keep working; valid new work is unaffected
    ok(await expectErr(L, 'DELETE FROM public.profiles WHERE id=$1', [emp], /employee_has_history/), 'the legacy employee (attendance, leave, audit) can no longer be hard-deleted');
    const q = await L.query("SELECT bucket, path FROM public.storage_cleanup_queue");
    ok(q.rows.length === 0, 'the migration queued NO file (only future deletes are queued)');
    await L.query('DELETE FROM public.task_attachments WHERE task_id=$1', [tk]);
    ok((await L.query("SELECT count(*)::int c FROM public.storage_cleanup_queue WHERE path=$1", [legacyPath])).rows[0].c === 1, 'deleting a LEGACY attachment row now queues its file');
    const goodUser = await mk(9);
    ok(!(await tryq(L, "INSERT INTO public.attendance_records(user_id,check_in) VALUES ($1, now())", [goodUser])).error, 'a new check-in works on the legacy database');
    ok(!(await tryq(L, "INSERT INTO public.leave_requests(user_id,leave_type_id,start_date,end_date,total_days,reason) VALUES ($1,$2,'2032-01-01','2032-01-03',3,'ok')", [goodUser, lt])).error, 'a new valid leave request works');
    ok(!!(await tryq(L, "INSERT INTO public.leave_requests(user_id,leave_type_id,start_date,end_date,total_days,reason) VALUES ($1,$2,'2032-01-05','2032-01-01',3,'bad')", [goodUser, lt])).error, 'a new backwards leave request is refused even though a legacy one exists');
    ok(!!(await tryq(L, "INSERT INTO public.attendance_records(user_id,check_in,check_out,date) VALUES ($1,'2032-01-01 09:00+00','2032-01-01 08:00+00','2032-01-01')", [goodUser])).error, 'a new check-out-before-check-in record is refused');
    ok(await expectErr(L, "UPDATE public.leave_requests SET status='approved' WHERE reason='overlaps'", [], /Not enough leave balance|cannot become/), 'a legacy pending request above the balance cannot be approved (and is not rewritten)');
    // ---- idempotent: running everything again changes nothing
    const pre = await snap();
    for (const f of files.filter((x) => num(x.slice(0, 3)) >= 29)) await tryq(L, sql('migrations/' + f));
    const again = await snap();
    ok(TABLES.every((t) => again[t] === pre[t]), 're-running 029-033 on the legacy database changes no row (snapshot before / after the re-run)', TABLES.filter((t) => again[t] !== pre[t]).join());
    // ---- after the operator cleans the data, re-running validates everything and creates the indexes
    await L.query('ALTER TABLE public.attendance_records DISABLE TRIGGER hr_attendance_guard; ALTER TABLE public.leave_requests DISABLE TRIGGER hr_leave_guard');
    await L.query("UPDATE public.attendance_records SET check_out = check_in + interval '8 hours', total_hours = 8 WHERE check_out < check_in");
    await L.query("UPDATE public.leave_requests SET end_date = start_date + 2 WHERE end_date < start_date");
    await L.query('ALTER TABLE public.attendance_records ENABLE TRIGGER hr_attendance_guard; ALTER TABLE public.leave_requests ENABLE TRIGGER hr_leave_guard');
    await L.query("DELETE FROM public.expense_approvals WHERE id = (SELECT id FROM public.expense_approvals WHERE expense_id=$1 LIMIT 1)", [e2]);
    await L.query("UPDATE public.user_departments SET is_primary=false WHERE user_id=$1 AND department_id=$2", [emp, dB]);
    await L.query("UPDATE public.invitations SET status='revoked' WHERE token='t2'");
    await L.query('DELETE FROM public.content_post_assets WHERE storage_path LIKE $1', ['%mismatch.png']);
    for (const f of files.filter((x) => num(x.slice(0, 3)) >= 29)) { const r = await tryq(L, sql('migrations/' + f)); if (r.error) { failed++; console.log('FAIL re-apply after clean-up', f, r.error.slice(0, 160)); } }
    const cons2 = (await L.query("SELECT bool_and(convalidated) v FROM pg_constraint WHERE conname IN ('attendance_out_after_in','attendance_hours_nonneg','leave_end_after_start','expenses_currency_chk','content_post_assets_plan_post_fk','content_feedback_plan_post_fk')")).rows[0].v;
    const idx2 = (await L.query("SELECT count(*)::int c FROM pg_indexes WHERE indexname IN ('uq_user_primary_department','uq_invitation_pending_email','uq_expense_approval_once')")).rows[0].c;
    ok(cons2 === true && idx2 === 3, 'after the clean-up, re-running the migrations VALIDATES every constraint and creates all three unique indexes', JSON.stringify({ cons2, idx2 }));
  }


  // ================================================================== 16. Phase 4 ARC-03 employee activation
  section('16. ARC-03 employee activation (migration 034): atomic, single-use, bound to the account, expiring');
  {
    const roleEmp = await roleId('employee');
    let n = 0;
    const mkInv = async ({ email, user = null, status = 'pending', expires = "now() + interval '7 days'", by = HR }) => (await db.query(
      `INSERT INTO public.invitations(email, full_name, role_id, invited_by, token, status, expires_at, user_id) VALUES ($1,'Inv',$2,$3,$4,$5,${expires},$6) RETURNING id`,
      [email, roleEmp, by, 'sha256:t' + (++n) + Math.random(), status, user])).rows[0].id;
    const accept = (c, user) => c.query('SELECT public.accept_invitation($1) r', [user]).then((r) => r.rows[0].r);
    const statusOf = async (u) => (await db.query('SELECT employment_status s FROM public.profiles WHERE id=$1', [u])).rows[0].s;
    const invOf = async (id) => (await db.query('SELECT status, accepted_at FROM public.invitations WHERE id=$1', [id])).rows[0];
    const rolesOf = async (u) => (await db.query('SELECT r.name FROM public.user_roles ur JOIN public.roles r ON r.id=ur.role_id WHERE ur.user_id=$1 ORDER BY 1', [u])).rows.map((x) => x.name).join();

    const a = await mkUser('act_a', 'employee', 'onboarding'); const invA = await mkInv({ email: 'act_a@x.test', user: a });
    ok(await accept(db, a) === 'accepted' && await statusOf(a) === 'active', 'activation: the profile becomes active');
    const ia = await invOf(invA);
    ok(ia.status === 'accepted' && ia.accepted_at !== null, 'activation: the invitation is marked accepted with a time, in the same transaction');
    ok(await rolesOf(a) === 'employee', 'activation never touches the role');
    ok(await accept(db, a) === 'not_onboarding', 'replay: a second activation of the same account is refused');
    ok((await invOf(invA)).status === 'accepted', 'replay leaves the accepted invitation as it was');

    const b = await mkUser('act_b', 'employee', 'onboarding'); const invB = await mkInv({ email: 'act_b@x.test', user: b, expires: "now() - interval '1 minute'" });
    ok(await accept(db, b) === 'expired' && await statusOf(b) === 'onboarding', 'an expired invitation does not activate the account');
    ok((await invOf(invB)).status === 'expired', '... and the expiry is RECORDED (not rolled back with a raised error)');
    ok(await accept(db, b) === 'no_invitation', 'once expired, a retry finds no pending invitation');

    const c = await mkUser('act_c', 'employee', 'onboarding');
    ok(await accept(db, c) === 'no_invitation' && await statusOf(c) === 'onboarding', 'no invitation: nothing is activated');

    const d = await mkUser('act_d', 'employee', 'onboarding'); const other = await mkUser('act_d_other', 'employee', 'onboarding');
    const invBound = await mkInv({ email: 'act_d@x.test', user: other });   // bound to ANOTHER account but carrying d's address
    ok(await accept(db, d) === 'no_invitation' && (await invOf(invBound)).status === 'pending', 'an invitation bound to one account is never matched to another by e-mail');
    ok(await accept(db, other) === 'accepted', '... it activates only the account it was issued for');

    const legacy = await mkUser('act_leg', 'employee', 'onboarding'); const invLeg = await mkInv({ email: 'ACT_LEG@x.test' });   // no user_id: a row from before 034
    ok(await accept(db, legacy) === 'accepted' && (await invOf(invLeg)).status === 'accepted', 'legacy invitation without user_id still works (matched by e-mail, case-insensitive)');

    for (const st of ['active', 'inactive', 'suspended']) {
      const u = await mkUser('act_' + st, 'employee', st); const i = await mkInv({ email: `act_${st}@x.test`, user: u });
      ok(await accept(db, u) === 'not_onboarding' && await statusOf(u) === st && (await invOf(i)).status === 'pending', `a ${st} account cannot be "activated" and its invitation is untouched`);
    }

    const s = await mkUser('act_sup', 'employee', 'onboarding');
    const oldI = await mkInv({ email: 'act_sup_old@x.test', user: s }); await new Promise((r) => setTimeout(r, 15));
    const newI = await mkInv({ email: 'act_sup@x.test', user: s });
    ok(await accept(db, s) === 'accepted' && (await invOf(newI)).status === 'accepted' && (await invOf(oldI)).status === 'revoked', 'the newest invitation is used; an older pending one of the same account is superseded (revoked)');

    // concurrency: ten devices activate the same account at once
    const race = await mkUser('act_race', 'employee', 'onboarding'); const invRace = await mkInv({ email: 'act_race@x.test', user: race });
    const cs = await Promise.all(Array.from({ length: 10 }, () => connect('kite')));
    const out = await Promise.all(cs.map((cx) => accept(cx, race)));
    await Promise.all(cs.map((cx) => cx.end()));
    ok(out.filter((x) => x === 'accepted').length === 1 && out.filter((x) => x === 'not_onboarding').length === 9, 'CONCURRENCY: 10 simultaneous activations give exactly one "accepted"', out.join());
    ok(await statusOf(race) === 'active' && (await invOf(invRace)).status === 'accepted' && await count("SELECT count(*)::int c FROM public.invitations WHERE user_id=$1 AND status='accepted'", [race]) === 1, '... one active profile, one accepted invitation');

    // expiry and activation racing: the invitation expires between two requests
    const exp = await mkUser('act_exp', 'employee', 'onboarding'); const invExp = await mkInv({ email: 'act_exp@x.test', user: exp, expires: "now() + interval '1 second'" });
    await new Promise((r) => setTimeout(r, 1300));
    ok(await accept(db, exp) === 'expired', 'an invitation that expired a moment ago is refused');

    // who may call it
    const self = await mkUser('act_self', 'employee', 'onboarding'); await mkInv({ email: 'act_self@x.test', user: self });
    const viaUser = await asUser(self, 'SELECT public.accept_invitation($1)', [self]);
    ok(!!viaUser.error && /permission denied/.test(viaUser.error) && await statusOf(self) === 'onboarding', 'a signed-in user cannot call accept_invitation themselves (only the Edge Function can)', viaUser.error);
    const viaSweep = await asUser(HR, 'SELECT public.invitations_expire_pending()');
    ok(!!viaSweep.error && /permission denied/.test(viaSweep.error), 'a signed-in user cannot run the expiry sweep');

    // expiry sweep
    const sw1 = await mkUser('act_sw1', 'employee', 'onboarding'); const sw2 = await mkUser('act_sw2', 'employee', 'onboarding');
    const i1 = await mkInv({ email: 'act_sw1@x.test', user: sw1, expires: "now() - interval '2 days'" }); const i2 = await mkInv({ email: 'act_sw2@x.test', user: sw2 });
    const swept = (await db.query('SELECT public.invitations_expire_pending() n')).rows[0].n;
    ok(swept >= 1 && (await invOf(i1)).status === 'expired' && (await invOf(i2)).status === 'pending', 'the sweep marks past-due invitations expired and leaves current ones pending', String(swept));
    ok((await db.query('SELECT public.invitations_expire_pending() n')).rows[0].n === 0, 'the sweep is idempotent');

    // the stored token: not readable by signed-in users
    const tokRead = await asUser(HR, 'SELECT token FROM public.invitations LIMIT 1');
    ok(!!tokRead.error && /permission denied/.test(tokRead.error), 'HR / admins cannot read invitations.token (column privilege)', tokRead.error);
    const starRead = await asUser(HR, 'SELECT * FROM public.invitations LIMIT 1');
    ok(!!starRead.error && /permission denied/.test(starRead.error), 'SELECT * on invitations is refused too (the browser never uses it)', starRead.error);
    const listRead = await asUser(HR, 'SELECT id, email, status, expires_at, user_id FROM public.invitations');
    ok(!listRead.error && listRead.rows.length > 0, 'HR can still list the non-secret invitation columns (RLS unchanged)', listRead.error);
    const empRead = await asUser(E1, 'SELECT id FROM public.invitations');
    ok(!empRead.error && empRead.rows.length === 0, 'an ordinary employee still sees no invitation rows (RLS unchanged)');
    const unique = await tryq(db, "SELECT count(*)::int c FROM public.invitations GROUP BY lower(email) HAVING count(*) FILTER (WHERE status='pending') > 1");
    ok(!unique.error && unique.rows.length === 0, 'still at most one pending invitation per e-mail (migration 032 index intact)');
  }


  // ================================================================== 17. Phase 5 (migration 035)
  section('17. Phase 5 (migration 035): studio-month KPIs, invoice link consistency, lead history, read-only detectors');
  {
    const asRole = async (role, q, p = []) => {      // a role with no user (anon): nothing is committed
      const c = await connect('kite');
      try { await c.query('BEGIN'); await c.query(`SET LOCAL ROLE ${role}`); const r = await tryq(c, q, p); await c.query('ROLLBACK'); return r; }
      finally { await c.end(); }
    };
    const one = async (q, p = []) => (await db.query(q, p)).rows[0];
    const save = (actor, o) => db.query('SELECT public.fin_invoice_save($1,$2::jsonb) id', [actor, JSON.stringify(o)]).then((r) => r.rows[0].id);
    const saveE = (actor, o) => tryq(db, 'SELECT public.fin_invoice_save($1,$2::jsonb) id', [actor, JSON.stringify(o)]);
    const item = (price = 100) => [{ description_en: 'Work', quantity: 1, unit_price: price, vat_rate: 0 }];
    const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
    const sm = async (add) => iso((await one("SELECT ((public.studio_today() - (extract(day FROM public.studio_today())::int - 1)) + ($1 || ' month')::interval)::date::text d", [String(add)])).d);
    const snapshot = async () => JSON.stringify(await one(`SELECT (SELECT count(*) FROM public.invoices) a, (SELECT count(*) FROM public.leads) b, (SELECT count(*) FROM public.retainer_plans) c,
      (SELECT coalesce(sum(total),0) FROM public.invoices) d, (SELECT count(*) FROM public.invoice_payments) e, (SELECT count(*) FROM public.money_figures) f`));

    // ---- P5-02 invoice links ------------------------------------------------------------------------------------------------
    const cA = await client('LA'), cB = await client('LB');
    const proj = async (code, cl) => (await db.query('INSERT INTO public.projects(code,name,client_id) VALUES ($1,$1,$2) RETURNING id', [code + Math.random().toString(36).slice(2, 7), cl])).rows[0].id;
    const pA = await proj('PA', cA), pB = await proj('PB', cB), pN = await proj('PN', null);
    const task = async (pr) => (await db.query("INSERT INTO public.tasks(title,created_by,project_id) VALUES ('t',$1,$2) RETURNING id", [ADMIN, pr])).rows[0].id;
    const tA = await task(pA), tB = await task(pB), tN = await task(null);
    const dep = async (n) => (await db.query('INSERT INTO public.departments(name) VALUES ($1) RETURNING id', [n + Math.random()])).rows[0].id;
    const d1 = await dep('D1'), d2 = await dep('D2');
    await db.query('INSERT INTO public.client_departments(client_id,department_id) VALUES ($1,$2)', [cA, d1]);
    const base = (o) => ({ client_id: cA, kind: 'project', items: item(), ...o });
    let r = await saveE(OWNER, base({ project_id: pB }));
    ok(!!r.error && /project belongs to a different client/.test(r.error), 'P5-02: a project of another client is refused', r.error);
    ok(!(await saveE(OWNER, base({ project_id: pA }))).error, 'P5-02: the client\'s own project is accepted');
    ok(!(await saveE(OWNER, base({ project_id: pN }))).error, 'P5-02: a project with no client cannot be verified and is allowed');
    r = await saveE(OWNER, base({ task_id: tB }));
    ok(!!r.error && /different client/.test(r.error), 'P5-02: a task of another client\'s project is refused', r.error);
    ok(!(await saveE(OWNER, base({ task_id: tA }))).error, 'P5-02: a task of the client\'s own project is accepted');
    ok(!(await saveE(OWNER, base({ task_id: tN }))).error, 'P5-02: a task with no project is allowed');
    r = await saveE(OWNER, base({ project_id: pA, task_id: await task(pN) }));
    ok(!!r.error && /different project/.test(r.error), 'P5-02: a task of another project than the invoice\'s project is refused', r.error);
    r = await saveE(OWNER, base({ department_id: d2 }));
    ok(!!r.error && /department does not serve/.test(r.error), 'P5-02: a department that does not serve the client is refused', r.error);
    ok(!(await saveE(OWNER, base({ department_id: d1 }))).error, 'P5-02: a department that serves the client is accepted');
    ok(!(await saveE(OWNER, { client_id: cB, kind: 'project', items: item(), department_id: d2 })).error, 'P5-02: a client with no department list cannot be verified and is allowed');
    ok(!(await saveE(OWNER, base({ kind: 'retainer', department_id: d2 }))).error, 'P5-02: a retainer invoice is exempt from the department rule (the department comes from the plan)');
    const edit = await save(OWNER, base({ project_id: pA }));
    r = await saveE(OWNER, { ...base({ project_id: pB }), id: edit });
    ok(!!r.error && (await one('SELECT project_id p FROM public.invoices WHERE id=$1', [edit])).p === pA, 'P5-02: editing a draft cannot move it onto another client\'s project (nothing changed)', r.error);
    r = await tryq(db, "INSERT INTO public.invoices(invoice_number,client_id,project_id,type,status,due_date) VALUES ('DRAFT-zz1',$1,$2,'receivable','draft',current_date)", [cA, pB]);
    ok(!!r.error && /different client/.test(r.error), 'P5-02: a raw INSERT is refused too (the rule lives in the database, not in the Edge Function)', r.error);
    // a legacy row that breaks the rule must never block payments, issue, status refresh
    const leg = await save(OWNER, base({ project_id: pA }));
    await db.query('ALTER TABLE public.invoices DISABLE TRIGGER fin_invoice_links_guard');
    await db.query('UPDATE public.invoices SET project_id=$1 WHERE id=$2', [pB, leg]);
    await db.query('ALTER TABLE public.invoices ENABLE TRIGGER fin_invoice_links_guard');
    ok((await db.query('SELECT invoice_id FROM public.fin_invoice_link_drift() WHERE invoice_id=$1', [leg])).rows.length === 1, 'P5-02: fin_invoice_link_drift() lists the legacy row');
    const legNo = await tryq(db, 'SELECT public.fin_invoice_issue($1,$2) n', [OWNER, leg]);
    const legPay = await tryq(db, "SELECT public.fin_payment_add($1,$2,10,current_date,'cash',NULL,NULL,gen_random_uuid()) p", [OWNER, leg]);
    ok(!legNo.error && !legPay.error, 'P5-02: a legacy row can still be issued and paid (only a change of its links is checked)', legNo.error || legPay.error);
    ok(!(await tryq(db, "UPDATE public.invoices SET notes='n' WHERE id=$1", [leg])).error, '... and its other columns can still change');

    // ---- P5-01 KPIs ------------------------------------------------------------------------------------------------------------
    const cK = await client('LK');
    const jpy = async (price, o = {}) => { const id = await save(OWNER, { client_id: cK, kind: 'adhoc', items: item(price), ...o }); await db.query("UPDATE public.invoices SET currency='JPY' WHERE id=$1", [id]); await db.query('SELECT public.fin_invoice_issue($1,$2)', [OWNER, id]); return id; };
    const pay = (inv, amt, on) => db.query('SELECT public.fin_payment_add($1,$2,$3,$4::date,$5,NULL,NULL,gen_random_uuid()) p', [OWNER, inv, amt, on, 'cash']).then((x) => x.rows[0].p);
    const today = iso((await one('SELECT public.studio_today()::text d')).d);
    const prevEnd = iso((await one('SELECT ((public.studio_today() - (extract(day FROM public.studio_today())::int - 1)) - 1)::text d')).d);   // last day of the previous studio month
    const invA = await jpy(1000); await pay(invA, 300, today); await pay(invA, 100, prevEnd); const rev = await pay(invA, 50, today);
    await db.query('SELECT public.fin_payment_reverse($1,$2,$3)', [OWNER, rev, 'test']);
    const invO = await jpy(400, { issue_date: '2020-01-01', due_date: '2020-02-01' });
    ok((await one('SELECT status s FROM public.invoices WHERE id=$1', [invO])).s === 'overdue', 'KPI fixture: the old invoice is overdue');
    const kp = async (user) => (await asUser(user, 'SELECT metric, currency, amount::text a FROM public.fin_kpis()'));
    const kv = (res, m, c) => { const x = (res.rows || []).find((y) => y.metric === m && y.currency === c); return x ? Number(x.a) : null; };
    let k = await kp(OWNER);
    ok(!k.error, 'P5-01: an executive (owner) can call fin_kpis()', k.error);
    ok(kv(k, 'outstanding', 'JPY') === 1000 && kv(k, 'overdue', 'JPY') === 400, 'P5-01: outstanding / overdue are summed per currency in the database', JSON.stringify(k.rows));
    ok(kv(k, 'collected', 'JPY') === 300, 'P5-01: "collected" = payments of the STUDIO month only; last month\'s payment and the reversed one are excluded', JSON.stringify(k.rows));
    const oracle = (await db.query(`SELECT i.currency, sum(i.balance)::text s FROM public.invoices i WHERE i.status IN ('sent','partially_paid','overdue') GROUP BY 1`)).rows;
    ok(oracle.every((o) => kv(k, 'outstanding', o.currency) === Number(o.s)), 'P5-01: outstanding agrees with the invoices for every currency');
    ok(kv((await kp(ADMIN)), 'outstanding', 'JPY') === 1000, 'P5-01: a super administrator is an executive too');
    for (const [who, label] of [[E1, 'an employee'], [HR, 'an HR manager']]) {
      const x = await kp(who); ok(!!x.error && /Finance access is limited/.test(x.error), `P5-01: ${label} is refused by fin_kpis()`, x.error);
      const y = await asUser(who, 'SELECT * FROM public.fin_client_balances()'); ok(!!y.error && /Finance access is limited/.test(y.error), `P5-01: ${label} is refused by fin_client_balances()`, y.error);
    }
    for (const fn of ['fin_kpis()', 'fin_client_balances()']) {
      const x = await asRole('anon', `SELECT * FROM public.${fn}`); ok(!!x.error && /permission denied/.test(x.error), `P5-01: anon cannot execute ${fn}`, x.error);
    }
    const meta = (await db.query("SELECT proname, prosecdef FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('fin_kpis','fin_client_balances')")).rows;
    ok(meta.length === 2 && meta.every((m) => m.prosecdef === false), 'P5-01: both are SECURITY INVOKER (row-level security still applies, nothing is bypassed)');
    ok(!((await db.query("SELECT has_function_privilege('public','public.fin_kpis()','EXECUTE') a, has_function_privilege('anon','public.fin_client_balances()','EXECUTE') b")).rows[0].a)
       && !((await db.query("SELECT has_function_privilege('anon','public.fin_client_balances()','EXECUTE') b")).rows[0].b), 'P5-01: PUBLIC and anon hold no EXECUTE privilege');
    // more than 1000 open invoices: the database sums them all
    await db.query('BEGIN'); await db.query("SET LOCAL app.migrating = 'on'");
    await db.query(`INSERT INTO public.invoices(invoice_number,client_id,type,status,due_date,currency,amount,tax,subtotal,vat_amount,total,net_receivable,balance)
      SELECT 'LIM-' || g, $1, 'receivable', 'sent', current_date + 30, 'KRW', 1, 0, 1, 0, 1, 1, 1 FROM generate_series(1, 1200) g`, [cK]);
    await db.query('COMMIT');
    k = await kp(OWNER);
    ok(kv(k, 'outstanding', 'KRW') === 1200, 'P5-01: 1200 open invoices are all counted (no 1000-row limit)', JSON.stringify(kv(k, 'outstanding', 'KRW')));
    const cb = await asUser(OWNER, 'SELECT client_id, currency, balance::text b FROM public.fin_client_balances()');
    const cbv = (c, cur) => { const x = (cb.rows || []).find((y) => y.client_id === c && y.currency === cur); return x ? Number(x.b) : null; };
    ok(cbv(cK, 'JPY') === 1000 && cbv(cK, 'KRW') === 1200, 'P5-09: a client\'s open balance comes back per currency, never mixed', JSON.stringify(cb.rows?.filter((y) => y.client_id === cK)));
    ok(!(cb.rows || []).some((y) => Number(y.b) <= 0), 'P5-09: only open balances are listed');
    // the browser helpers
    const ct = await import(pathToFileURL(path.join(SB, '..', 'js', 'modules', 'finance', 'currency-totals.mjs')).href);
    ok(ct.formatTotals(new Map()) === 'EGP 0.00', 'P5-09: no balance shows EGP 0.00');
    ok(ct.formatTotals(ct.totalsByCurrency([{ currency: 'USD', amount: 50 }, { currency: 'EGP', amount: 1000 }, { currency: 'EGP', amount: 0.5 }])) === 'EGP 1,000.50 · USD 50.00', 'P5-09: currencies are listed separately and never added together');
    ok(ct.kpiTexts([{ metric: 'outstanding', currency: 'EGP', amount: '12.5' }]).overdue === 'EGP 0.00' && ct.kpiTexts([{ metric: 'collected', currency: 'JPY', amount: '3' }]).collected === 'JPY 3.00', 'P5-01: the KPI texts are built from the database rows');
    const bb = ct.balancesByClient([{ client_id: 'x', currency: 'EGP', balance: '5' }, { client_id: 'x', currency: 'USD', balance: '2' }, { client_id: 'y', currency: null, balance: '1' }]);
    ok(bb.get('x').size === 2 && bb.get('y').get('EGP') === 1, 'P5-09: balances are grouped per client and currency');
    // P5-08: pending claims = submitted only
    const fin = fs.readFileSync(path.join(SB, '..', 'js', 'modules', 'finance', 'finance.js'), 'utf8');
    ok(/\.eq\('status', 'submitted'\)/.test(fin) && !/in\('status', \['submitted', 'draft'\]\)/.test(fin), 'P5-08: the pending-approvals count no longer includes drafts');
    ok(/rpc\('fin_kpis'\)/.test(fin) && !/toISOString\(\)\.slice\(0, 7\)/.test(fin), 'P5-01: the KPIs use the database function, not the browser (UTC) month');

    // ---- P5-04 lead stage history -------------------------------------------------------------------------------------------------
    const hist = (id) => db.query('SELECT event, from_stage, to_stage, actor_id, actor_label FROM public.lead_stage_history WHERE lead_id=$1 ORDER BY changed_at, id', [id]).then((x) => x.rows);
    const mk = await asUser(ADMIN, "INSERT INTO public.leads(title,stage,created_by) VALUES ('Deal',  'new', $1) RETURNING id", [ADMIN]);
    const L1 = mk.rows?.[0]?.id;
    ok(!!L1, 'P5-04: a manager creates a lead as before', mk.error);
    let h = await hist(L1);
    ok(h.length === 1 && h[0].event === 'created' && h[0].to_stage === 'new' && h[0].from_stage === null && h[0].actor_id === ADMIN && h[0].actor_label === 'admin', 'P5-04: creation is recorded with the person and their name', JSON.stringify(h));
    ok(!(await asUser(ADMIN, "UPDATE public.leads SET stage='won' WHERE id=$1", [L1])).error, 'P5-04: no stage rule was added: new -> won is still allowed');
    ok(!(await asUser(ADMIN, "UPDATE public.leads SET stage='new' WHERE id=$1", [L1])).error, 'P5-04: ... and won -> new is still allowed (rules are a business decision)');
    await asUser(ADMIN, "UPDATE public.leads SET title='Deal 2', notes='x' WHERE id=$1", [L1]);
    await asUser(ADMIN, "UPDATE public.leads SET stage='new' WHERE id=$1", [L1]);
    h = await hist(L1);
    ok(h.length === 3 && h[1].event === 'stage_changed' && h[1].from_stage === 'new' && h[1].to_stage === 'won' && h[2].from_stage === 'won' && h[2].to_stage === 'new', 'P5-04: every real stage change is recorded in order; edits that keep the stage, and a stage set to itself, are not', JSON.stringify(h));
    await db.query("UPDATE public.leads SET stage='lost' WHERE id=$1", [L1]);
    h = await hist(L1);
    ok(h[3].actor_id === null && h[3].actor_label === null, 'P5-04: a change made without a signed-in person has no actor (never invented)');
    const L2 = (await db.query("INSERT INTO public.leads(title,stage,assigned_to) VALUES ('Mine','new',$1) RETURNING id", [E2])).rows[0].id;
    const vis = async (u, id) => (await asUser(u, 'SELECT count(*)::int n FROM public.lead_stage_history WHERE lead_id=$1', [id])).rows?.[0]?.n;
    ok(await vis(E2, L2) === 1 && await vis(E1, L2) === 0 && await vis(E1, L1) === 0, 'P5-04 RLS: the history is visible to whoever can see the lead and to nobody else');
    ok(await vis(ADMIN, L2) === 1 && await vis(ADMIN, L1) === 4, 'P5-04 RLS: an administrator sees it all');
    ok(!!(await asRole('anon', 'SELECT * FROM public.lead_stage_history')).error, 'P5-04 RLS: anon cannot read it');
    for (const [who, q, nm] of [[ADMIN, "INSERT INTO public.lead_stage_history(lead_id,event) VALUES (gen_random_uuid(),'created')", 'insert'], [ADMIN, "UPDATE public.lead_stage_history SET to_stage='x'", 'update'], [ADMIN, 'DELETE FROM public.lead_stage_history', 'delete'], [E2, "INSERT INTO public.lead_stage_history(lead_id,event) VALUES (gen_random_uuid(),'created')", 'insert (employee)']]) {
      const x = await asUser(who, q); ok(!!x.error && /permission denied/.test(x.error), `P5-04: a signed-in user cannot ${nm} history rows`, x.error);
    }
    for (const [q, nm] of [["UPDATE public.lead_stage_history SET to_stage='x'", 'UPDATE'], ['DELETE FROM public.lead_stage_history', 'DELETE'], ['TRUNCATE public.lead_stage_history', 'TRUNCATE']]) {
      const x = await tryq(db, q); ok(!!x.error && /append-only/.test(x.error), `P5-04: ${nm} is refused even for the database owner`, x.error);
    }
    const hadH = await count('SELECT count(*)::int c FROM public.lead_stage_history');
    await asUser(ADMIN, 'DELETE FROM public.leads WHERE id=$1', [L1]);
    h = await hist(L1);
    ok(h.length === 5 && h[4].event === 'deleted' && h[4].from_stage === 'lost' && h[4].actor_id === ADMIN, 'P5-04: deleting a lead is recorded and the history of the deleted lead survives', JSON.stringify(h[4]));
    ok(await count('SELECT count(*)::int c FROM public.lead_stage_history') === hadH + 1, '... nothing else was removed');
    ok(await vis(E2, L1) === 0 && await vis(ADMIN, L1) === 5, 'P5-04 RLS: only an administrator still reads the history of a deleted lead');
    ok(!(await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='lead_stage_history'")).rows.some((c) => /value|amount/.test(c.column_name)), 'P5-04: the history never stores the (owner-only) deal value');

    // ---- P5-05 retainer gaps (read-only) -----------------------------------------------------------------------------------------
    const cR = await client('LR');
    const plan = async (name, start, extra = '') => { const id = (await db.query('INSERT INTO public.retainer_plans(client_id,name,monthly_fee,start_date) VALUES ($1,$2,500,$3) RETURNING id', [cR, name + Math.random(), start])).rows[0].id;
      await db.query("UPDATE public.retainer_plans SET created_at = $2::date + 3 WHERE id=$1", [id, start]); if (extra) await db.query(extra, [id]); return id; };
    const m3 = await sm(-3), m2 = await sm(-2), m1 = await sm(-1), m0 = await sm(0);
    const P = await plan('Gap', m3);
    const gaps = async (id) => (await db.query('SELECT month::text m FROM public.fin_retainer_gaps() WHERE plan_id=$1 ORDER BY month', [id])).rows.map((x) => x.m);
    ok(JSON.stringify(await gaps(P)) === JSON.stringify([m3, m2, m1]), 'P5-05: three past months without an invoice are reported; the current month is not a gap yet', JSON.stringify(await gaps(P)));
    await db.query('SELECT public.fin_retainer_generate($1,$2::date)', [OWNER, m2]);
    ok(JSON.stringify(await gaps(P)) === JSON.stringify([m3, m1]), 'P5-05: a billed month is no longer a gap');
    const inv2 = (await db.query('SELECT id FROM public.invoices WHERE retainer_plan_id=$1 AND period_month=$2::date', [P, m2])).rows[0].id;
    await db.query('SELECT public.fin_invoice_void($1,$2,$3)', [OWNER, inv2, 'test']);
    ok((await gaps(P)).includes(m2), 'P5-05: a voided invoice does not count as billing');
    const Pend = await plan('Ended', m3, `UPDATE public.retainer_plans SET end_date = '${m2}'::date + 20 WHERE id=$1`);
    ok(JSON.stringify(await gaps(Pend)) === JSON.stringify([m3, m2]), 'P5-05: months after the plan\'s end date are not gaps', JSON.stringify(await gaps(Pend)));
    const Pin = await plan('Off', m3, 'UPDATE public.retainer_plans SET is_active=false WHERE id=$1');
    ok((await gaps(Pin)).length === 0, 'P5-05: an inactive plan reports nothing');
    const Pnew = await plan('New', m0);
    ok((await gaps(Pnew)).length === 0, 'P5-05: a plan that starts this month has no past month to miss');
    // created later than it started: months before the plan existed are not "missed"
    const Plate = (await db.query('INSERT INTO public.retainer_plans(client_id,name,monthly_fee,start_date) VALUES ($1,$2,500,$3) RETURNING id', [cR, 'Late' + Math.random(), m3])).rows[0].id;
    ok((await gaps(Plate)).length === 0, 'P5-05: a plan that starts in the past but was created today has no missed month (it is only reported from the month it was created)');

    // ---- P5-06 detectors: read-only, service role only ---------------------------------------------------------------------------
    await db.query("INSERT INTO public.leads(title,stage,client_id) VALUES ('Won-no-client','won',NULL), ('Won-with-client','won',$1)", [cA]);
    ok((await db.query("SELECT title FROM public.crm_won_leads_without_client() WHERE title LIKE 'Won-%'")).rows.map((x) => x.title).join() === 'Won-no-client', 'P5-06: only a won lead WITHOUT a client is listed');
    const cP = await client('LP'); const pBud = await proj('PBUD', cP);
    await db.query("INSERT INTO public.money_figures(entity,entity_id,amount) VALUES ('project_budget',$1,100)", [pBud]);
    const invP = await save(OWNER, { client_id: cP, kind: 'project', project_id: pBud, items: item(150) });
    const inBud = () => db.query('SELECT budget::text b, invoiced::text i FROM public.fin_project_invoicing_vs_budget() WHERE project_id=$1', [pBud]).then((x) => x.rows);
    ok((await inBud()).length === 0, 'P5-06: a DRAFT invoice does not count against the project budget');
    await db.query('SELECT public.fin_invoice_issue($1,$2)', [OWNER, invP]);
    ok(JSON.stringify(await inBud()) === JSON.stringify([{ b: '100.00', i: '150.00' }]), 'P5-06: issued invoices above the budget figure are listed (before VAT)', JSON.stringify(await inBud()));
    await db.query("UPDATE public.money_figures SET amount=150 WHERE entity='project_budget' AND entity_id=$1", [pBud]);
    ok((await inBud()).length === 0, 'P5-06: invoicing equal to the budget is not listed');
    const rep = Object.fromEntries((await db.query('SELECT check_name, n FROM public.integrity_report()')).rows.map((x) => [x.check_name, num(x.n)]));
    ok(Object.keys(rep).length === 19, 'P5-06 / P7: integrity_report() lists 19 detectors (13 + 4 from Phase 5 + 2 from Phase 7)', String(Object.keys(rep).length));
    ok(rep['won leads without a client'] >= 1 && rep['past retainer months without an invoice (active plans)'] >= 3 && rep['invoices linked to a project / task / department of another client'] >= 1, 'P5-06: the new rows count what the detectors find', JSON.stringify(rep));
    for (const fn of ['fin_retainer_gaps()', 'crm_won_leads_without_client()', 'fin_project_invoicing_vs_budget()', 'fin_invoice_link_drift()', 'integrity_report()']) {
      const a = await asUser(OWNER, `SELECT * FROM public.${fn}`); const b = await asRole('anon', `SELECT * FROM public.${fn}`);
      ok(!!a.error && /permission denied/.test(a.error) && !!b.error, `P5-06: ${fn} is callable only by the service role`, a.error);
    }
    const s0 = await snapshot();
    for (const fn of ['fin_retainer_gaps', 'crm_won_leads_without_client', 'fin_project_invoicing_vs_budget', 'fin_invoice_link_drift', 'integrity_report']) await db.query(`SELECT * FROM public.${fn}()`);
    ok(await snapshot() === s0, 'P5-06: running every detector changes no invoice, payment, lead, plan or figure');
    const ro = (await db.query("SELECT proname, provolatile FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('fin_retainer_gaps','crm_won_leads_without_client','fin_project_invoicing_vs_budget','fin_invoice_link_drift','integrity_report','fin_kpis','fin_client_balances')")).rows;
    ok(ro.length === 7 && ro.every((x) => x.provolatile === 's'), 'every new read function is declared STABLE (the database refuses writes inside it)');

    // ---- re-run rule + idempotency ------------------------------------------------------------------------------------------------
    const before = await snapshot();
    ok(!(await tryq(db, sql('migrations/035_phase5_business_correctness.sql'))).error, '035 can be run twice');
    ok(await snapshot() === before && await count('SELECT count(*)::int c FROM public.integrity_report()') === 17, '... changes no data and keeps 17 detectors');
    await db.query(sql('migrations/017_finance_invoicing.sql')); await db.query(sql('migrations/028_finance_integrity.sql')); await db.query(sql('migrations/033_database_hygiene.sql'));
    ok(await count('SELECT count(*)::int c FROM public.integrity_report()') === 13, 'documented rule: re-running 033 restores the 13-row report ...');
    await db.query(sql('migrations/035_phase5_business_correctness.sql'));
    ok(await count('SELECT count(*)::int c FROM public.integrity_report()') === 17 && (await saveE(OWNER, base({ project_id: pB }))).error !== undefined, '... and re-applying 035 last brings back 17 detectors; the link guard was never removed by 017');
    await db.query(sql('migrations/037_background_jobs.sql'));
    ok(await count('SELECT count(*)::int c FROM public.integrity_report()') === 19, '... and 037 after 035 brings the report to 19 rows (Phase 7)');
  }
  console.log(`\n${passed} passed, ${failed} failed`);
} catch (e) { failed++; console.log('SCRIPT ERROR', e); }
finally {
  for (const c of conns) { try { await c.end(); } catch { /* closed */ } }
  try { await server.stop(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(failed ? 1 : 0);
