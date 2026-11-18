// Phase 7 verification: background processing and data lifecycle (migration 037), on a real PostgreSQL.
//   cd supabase/tests && npm run test:background
// A throwaway local PostgreSQL (embedded-postgres, temp dir, deleted at the end); it never touches any remote database,
// never calls an Edge Function and never sends a notification. Edge Function code is checked statically (esbuild syntax pass +
// source assertions) because no Deno runtime is available here; every rule that matters is enforced in SQL and tested there.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SB = path.resolve(HERE, '..');
let EmbeddedPostgres, pg, esbuild;
try { EmbeddedPostgres = (await import('embedded-postgres')).default; pg = (await import('pg')).default; }
catch { console.log('SKIPPED: install the optional dependencies first:  npm install --no-save embedded-postgres pg'); process.exit(0); }
try { esbuild = await import('esbuild'); } catch { esbuild = null; }
let passed = 0, failed = 0;
const ok = (c, name, d = '') => { if (c) passed++; else { failed++; console.log('FAIL', name, d); } };
const section = (s) => console.log('\n== ' + s);
const sql = (f) => fs.readFileSync(path.join(SB, f), 'utf8');
const src = (f) => fs.readFileSync(path.join(SB, f), 'utf8');
const testSrc = fs.readFileSync(path.join(HERE, 'verify-integrity.mjs'), 'utf8');
const STUBS = /const STUBS = `([\s\S]*?)`;/.exec(testSrc)[1];
const USERS = Number(process.env.USERS || 5000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-bg-'));
const PORT = 56900 + Math.floor(Math.random() * 600);
const server = new EmbeddedPostgres({ databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'pw', port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
const conns = [];
const connect = async (db = 'kite') => { const c = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'pw', database: db }); await c.connect(); c.on('error', () => {}); conns.push(c); return c; };
const uid = (g) => `00000000-0000-4000-8000-${String(g).padStart(12, '0')}`;
const err = async (c, q, p = []) => { try { await c.query(q, p); return null; } catch (e) { return e; } };
const iso = (d) => new Date(d).toISOString();

try {
  await server.initialise(); await server.start();
  const c0 = await connect('postgres'); await c0.query(`CREATE DATABASE kite ENCODING 'UTF8' TEMPLATE template0 LOCALE 'C'`);
  const db = await connect(); await db.query(STUBS);
  await db.query('ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()');
  const files = fs.readdirSync(path.join(SB, 'migrations')).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  for (const f of files.filter((x) => x < '037')) { await db.query(sql('migrations/' + f)); if (f.startsWith('005')) await db.query(sql('seed.sql')); }
  await db.query('GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role');

  // ---------------------------------------------------------------- 0. migration 037
  section('0. migration 037 applies, is idempotent, and extends integrity_report()');
  ok((await db.query('SELECT count(*)::int c FROM public.integrity_report()')).rows[0].c === 17, 'integrity_report has 17 rows before 037');
  await db.query(sql('migrations/037_background_jobs.sql'));
  const again = await err(db, sql('migrations/037_background_jobs.sql'));
  ok(again === null, '037 can be applied a second time', again?.message);
  const rep = (await db.query('SELECT * FROM public.integrity_report()')).rows;
  ok(rep.length === 19, 'integrity_report has 19 rows after 037', rep.length);
  ok(rep.some((r) => /most recent run failed/.test(r.check_name)) && rep.some((r) => /retainer invoices still in draft/.test(r.check_name)), 'the two new rows are present');
  const FUNCS = ['job_run_start(text)', 'job_run_progress(bigint,jsonb)', 'job_run_finish(bigint,text,text,jsonb)', 'job_status()', 'job_missed_runs(interval,text[])', 'job_stuck_runs(interval)',
    'due_digest_batch(date,date,uuid,integer)', 'publish_digest_batch(date,date,uuid,integer)', 'broadcast_claim(uuid,text,text,text,text,text,uuid)', 'broadcast_finish(uuid)',
    'storage_cleanup_requeue(bigint[])', 'storage_cleanup_prune_candidates(interval,integer)', 'storage_orphans(interval,integer)', 'fin_retainer_drafts_unreviewed()'];
  const CALLS = ["job_run_start('x')", 'job_run_progress(1, $${}$$::jsonb)', "job_run_finish(1,'failed')", 'job_status()', "job_missed_runs('1 day')", "job_stuck_runs('1 day')",
    "due_digest_batch(current_date,current_date)", "publish_digest_batch(current_date,current_date)", "broadcast_claim(NULL,'ab','cd',NULL,'all','x',NULL)", `broadcast_finish('${uid(1)}')`,
    'storage_cleanup_requeue()', "storage_cleanup_prune_candidates('1 day')", "storage_orphans('1 day')", 'fin_retainer_drafts_unreviewed()'];
  // service_role only: neither the browser roles nor the public may call any of them, nor read the two new tables
  for (const role of ['anon', 'authenticated']) {
    let denied = 0;
    for (const call of CALLS) { await db.query('BEGIN'); await db.query(`SET LOCAL ROLE ${role}`); const e = await err(db, `SELECT * FROM public.${call}`); await db.query('ROLLBACK'); if (e && e.code === '42501') denied++; }
    ok(denied === CALLS.length, `${role} is denied all ${CALLS.length} new functions`, `${denied}`);
    for (const t of ['job_runs', 'storage_cleanup_requeues']) { await db.query('BEGIN'); await db.query(`SET LOCAL ROLE ${role}`); const e = await err(db, `SELECT * FROM public.${t}`); await db.query('ROLLBACK'); ok(e && e.code === '42501', `${role} cannot read ${t}`); }
  }
  { await db.query('BEGIN'); await db.query('SET LOCAL ROLE service_role'); const e = await err(db, 'SELECT * FROM public.job_status()'); await db.query('ROLLBACK'); ok(e === null, 'service_role may call job_status()', e?.message); }
  ok((await db.query(`SELECT bool_and(provolatile = 's') b FROM pg_proc WHERE oid = ANY (ARRAY['public.job_status()','public.job_missed_runs(interval,text[])','public.job_stuck_runs(interval)','public.due_digest_batch(date,date,uuid,integer)','public.publish_digest_batch(date,date,uuid,integer)','public.storage_cleanup_prune_candidates(interval,integer)','public.storage_orphans(interval,integer)','public.fin_retainer_drafts_unreviewed()']::regprocedure[])`)).rows[0].b, 'every detector / report function is STABLE (cannot write)');

  // ---------------------------------------------------------------- 1. job ledger
  section('1. job ledger: start, progress, finish, crash, repeat, missed runs');
  const start = async (job) => (await db.query('SELECT public.job_run_start($1) id', [job])).rows[0].id;
  const row = async (id) => (await db.query('SELECT * FROM public.job_runs WHERE id=$1', [id])).rows[0];
  const r1 = await start('due-reminders');
  let jr = await row(r1);
  ok(jr.status === 'running' && jr.finished_at === null && jr.started_at, 'a started run is "running" with no finish time');
  await db.query('SELECT public.job_run_progress($1, $2::jsonb)', [r1, JSON.stringify({ due_digest_after: uid(5) })]);
  ok((await row(r1)).checkpoint.due_digest_after === uid(5), 'a checkpoint is stored');
  await db.query('SELECT public.job_run_finish($1,$2,NULL,$3::jsonb)', [r1, 'succeeded', JSON.stringify({ notified: 3 })]);
  jr = await row(r1);
  ok(jr.status === 'succeeded' && jr.finished_at && jr.details.notified === 3, 'finish records status, time and details');
  await db.query('SELECT public.job_run_finish($1,$2,$3,$4::jsonb)', [r1, 'failed', 'late duplicate', '{}']);
  await db.query('SELECT public.job_run_progress($1,$2::jsonb)', [r1, '{"x":1}']);
  jr = await row(r1);
  ok(jr.status === 'succeeded' && jr.error === null && jr.checkpoint.x === undefined, 'a second finish / late progress changes nothing (idempotent)');
  ok((await err(db, "SELECT public.job_run_finish($1,'bogus')", [r1]))?.message.includes('invalid status'), 'an invalid status is refused');
  const rl = await start('retainer-billing'); await db.query("SELECT public.job_run_finish($1,'failed',$2)", [rl, 'x'.repeat(900)]);
  ok((await row(rl)).error.length === 500, 'the error text is capped at 500 characters');
  let st = (await db.query('SELECT * FROM public.job_status() ORDER BY job')).rows;
  ok(st.length === 2 && st[0].job === 'due-reminders' && st[0].last_status === 'succeeded' && st[0].last_success_at && Number(st[0].running_now) === 0, 'job_status: succeeded job');
  ok(st[1].job === 'retainer-billing' && st[1].last_status === 'failed' && st[1].last_success_at === null, 'job_status: failed job has no last success');
  ok((await db.query("SELECT n FROM public.integrity_report() WHERE check_name LIKE '%most recent run failed%'")).rows[0].n == 1, 'integrity_report counts the job whose last run failed');
  // crash: a run that never finishes stays "running" and is listed as stuck; a later run does not hide it
  const crashed = await start('due-reminders');
  await db.query("UPDATE public.job_runs SET started_at = now() - interval '3 hours' WHERE id=$1", [crashed]);
  const stuck = (await db.query("SELECT * FROM public.job_stuck_runs('1 hour')")).rows;
  ok(stuck.length === 1 && Number(stuck[0].id) === Number(crashed), 'a crashed run is listed by job_stuck_runs', JSON.stringify(stuck));
  ok((await db.query("SELECT count(*)::int c FROM public.job_stuck_runs('6 hours')")).rows[0].c === 0, 'no threshold is built in: the caller decides');
  const resumed = await start('due-reminders'); await db.query("SELECT public.job_run_finish($1,'succeeded')", [resumed]);
  st = (await db.query("SELECT * FROM public.job_status() WHERE job='due-reminders'")).rows[0];
  ok(st.last_status === 'succeeded' && Number(st.running_now) === 1, 'a later successful run is recorded and the crashed one is still visible as running', JSON.stringify(st));
  // missed runs: nothing built in; the caller passes the age and the expected jobs
  await db.query("UPDATE public.job_runs SET finished_at = now() - interval '2 days' WHERE job='due-reminders' AND status='succeeded'");
  const miss = (await db.query("SELECT * FROM public.job_missed_runs('1 day', ARRAY['due-reminders','retainer-billing','never-scheduled'])")).rows;
  const names = miss.map((m) => m.job).sort().join(',');
  ok(names === 'due-reminders,never-scheduled,retainer-billing', 'missed runs: stale success, failed-only job and a job that never ran are all reported', names);
  ok(miss.find((m) => m.job === 'never-scheduled').never_ran === true && miss.find((m) => m.job === 'due-reminders').never_ran === false, 'never_ran distinguishes "not in the ledger"');
  ok((await db.query("SELECT count(*)::int c FROM public.job_missed_runs('30 days')")).rows[0].c === 1, 'a wider age only reports the job that never succeeded');
  const before = (await db.query('SELECT count(*)::int c, md5(string_agg(id::text||status, \',\' ORDER BY id)) h FROM public.job_runs')).rows[0];
  await db.query("SELECT * FROM public.job_missed_runs('1 day'); SELECT * FROM public.job_stuck_runs('1 hour'); SELECT * FROM public.job_status()");
  ok(JSON.stringify(before) === JSON.stringify((await db.query('SELECT count(*)::int c, md5(string_agg(id::text||status, \',\' ORDER BY id)) h FROM public.job_runs')).rows[0]), 'the detectors do not change the ledger');
  await db.query('DELETE FROM public.job_runs');

  // ---------------------------------------------------------------- 2. digest at scale
  section(`2. digest candidates for ${USERS} users (beyond the 1,000-row API cap), compared with an independent reference`);
  const T = (await db.query("SELECT current_date::text d, (current_date + 1)::text t, (current_date - 1)::text y")).rows[0];
  const dpt = (await db.query("INSERT INTO public.departments(name, code) VALUES ('BG','BG') RETURNING id")).rows[0].id;
  await db.query(`INSERT INTO auth.users(id,email) SELECT ('00000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid, 'u'||g||'@x.test' FROM generate_series(1,${USERS + 20}) g`);
  await db.query(`INSERT INTO public.profiles(id,full_name,email,employee_id,department_id,employment_status)
     SELECT u.id, 'User '||g, u.email, 'T-'||g, '${dpt}', CASE WHEN g % 20 = 0 OR g = ${USERS + 5} THEN 'inactive' ELSE 'active' END
     FROM generate_series(1,${USERS + 20}) g JOIN auth.users u ON u.email='u'||g||'@x.test'`);
  const mk = (title, who, status, dueExpr) => `INSERT INTO public.tasks(title,created_by,assigned_to,status,priority,due_date) VALUES (${title},'${uid(1)}',${who},'${status}','medium',${dueExpr})`;
  // 1 overdue(2 days) + 1 today + 1 tomorrow (even users) + done / backlog noise + a far task; every 5th user has 3 more overdue
  await db.query(`INSERT INTO public.tasks(title,created_by,assigned_to,status,priority,due_date)
     SELECT 'T'||g||'-'||k, '${uid(1)}', ('00000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid, s, 'medium', current_date + d
     FROM generate_series(1,${USERS}) g CROSS JOIN LATERAL (VALUES (1,'todo',-2),(2,'in_progress',0),(3,CASE WHEN g%2=0 THEN 'todo' ELSE 'completed' END,1),(4,'backlog',0),(5,'approved',-9),(6,'todo',5),
          (7,CASE WHEN g%5=0 THEN 'todo' ELSE 'cancelled' END,-1),(8,CASE WHEN g%5=0 THEN 'under_review' ELSE 'cancelled' END,-4),(9,CASE WHEN g%5=0 THEN 'todo' ELSE 'cancelled' END,-7)) v(k,s,d)
     WHERE g % 25 <> 0`);
  // special users (ids above USERS)
  const SP = (n) => uid(USERS + n);
  await db.query(mk("'sp-s6'", `'${SP(6)}'`, 'completed', 'current_date - 3'));
  await db.query(mk("'sp-s6b'", `'${SP(6)}'`, 'cancelled', 'current_date'));
  await db.query(mk("'sp-s7'", `'${SP(7)}'`, 'todo', 'current_date + 1'));
  await db.query(mk("'sp-s8'", `'${SP(8)}'`, 'todo', 'current_date + 2'));
  await db.query(`INSERT INTO public.tasks(title,created_by,assigned_to,status,priority) VALUES ('sp-s9','${uid(1)}','${SP(9)}','todo','medium')`);
  await db.query(mk("'sp-s10-tomorrow'", `'${SP(10)}'`, 'todo', 'current_date + 1'));
  await db.query(mk("'sp-s10-today'", `'${SP(10)}'`, 'todo', 'current_date'));
  await db.query(mk("'sp-s10-late-recent'", `'${SP(10)}'`, 'todo', 'current_date - 1'));
  await db.query(mk("'sp-s10-late-old'", `'${SP(10)}'`, 'todo', 'current_date - 30'));
  for (const n of [1, 2, 3, 4, 5]) await db.query(mk(`'sp-s${n}'`, `'${SP(n)}'`, 'todo', 'current_date'));
  await db.query(`INSERT INTO public.notifications(user_id,type,title,content,created_at) VALUES ('${SP(1)}','due_digest','t','c', now() - interval '5 hours')`);
  await db.query(`INSERT INTO public.notifications(user_id,type,title,content,created_at) VALUES ('${SP(2)}','due_digest','t','c', now() - interval '30 hours')`);
  await db.query(`INSERT INTO public.notifications(user_id,type,title,content,dedupe_key,created_at) VALUES ('${SP(3)}','due_digest','t','c','due_digest:${T.d}', now() - interval '30 hours')`);
  await db.query(`INSERT INTO public.notifications(user_id,type,title,content,dedupe_key,created_at) VALUES ('${SP(4)}','due_digest','t','c','due_digest:${T.y}', now() - interval '30 hours')`);
  await db.query('VACUUM ANALYZE');

  // independent reference of the previous behaviour
  const trows = (await db.query(`SELECT assigned_to u, task_number, title, due_date::text d, status FROM public.tasks WHERE assigned_to IS NOT NULL AND status NOT IN ('completed','approved','cancelled','backlog') AND due_date IS NOT NULL AND due_date <= $1::date`, [T.t])).rows;
  const prof = new Map((await db.query('SELECT id, employment_status s FROM public.profiles')).rows.map((r) => [r.id, r.s]));
  const noti = (await db.query("SELECT user_id, type, dedupe_key, created_at FROM public.notifications WHERE type='due_digest'")).rows;
  const since = Date.now() - 20 * 3600e3;
  const blocked = new Set(noti.filter((n) => +n.created_at >= since || n.dedupe_key === `due_digest:${T.d}`).map((n) => n.user_id));
  const byU = new Map();
  for (const t of trows) { const a = byU.get(t.u) ?? []; a.push(t); byU.set(t.u, a); }
  const expected = new Map();
  for (const [u, ts] of byU) {
    if (prof.get(u) !== 'active' || blocked.has(u)) continue;
    const cat = (t) => (t.d < T.d ? 0 : t.d === T.d ? 1 : 2);
    ts.sort((a, b) => cat(a) - cat(b) || (a.d < b.d ? -1 : a.d > b.d ? 1 : 0) || (a.task_number < b.task_number ? -1 : 1));
    expected.set(u, { late: ts.filter((t) => t.d < T.d).length, tod: ts.filter((t) => t.d === T.d).length, tom: ts.filter((t) => t.d > T.d).length, first: `${ts[0].task_number} ${ts[0].title}` });
  }
  ok(trows.length > 1000 && expected.size > 1000, `the dataset is beyond the 1,000-row cap (${trows.length} tasks, ${expected.size} people)`);
  const page = async (c, fn, after, limit) => (await c.query(`SELECT * FROM public.${fn}($1::date,$2::date,$3::uuid,$4)`, [T.d, T.t, after, limit])).rows;
  const all = []; let after = null, pages = 0;
  for (;;) { const r = await page(db, 'due_digest_batch', after, 200); if (!r.length) break; pages++; all.push(...r); after = r.at(-1).user_id; if (r.length < 200) break; }
  ok(all.length === expected.size, 'paged candidates = the reference set', `${all.length} vs ${expected.size}`);
  ok(pages > 20, `read in ${pages} bounded pages`);
  ok(new Set(all.map((r) => r.user_id)).size === all.length, 'no person appears twice across pages');
  ok(all.every((r, i) => i === 0 || all[i - 1].user_id < r.user_id), 'pages are in user-id (keyset) order');
  let bad = 0, firstBad = '';
  for (const r of all) { const e = expected.get(r.user_id); if (!e || e.late !== r.late_count || e.tod !== r.today_count || e.tom !== r.tomorrow_count || e.first !== r.first_label) { bad++; firstBad ||= JSON.stringify([r, e]); } }
  ok(bad === 0, 'every person has the same counts and most urgent item as the reference', firstBad);
  ok((await page(db, 'due_digest_batch', null, 5000)).length === 1000, 'the page size is capped at 1,000');
  const got = new Map(all.map((r) => [r.user_id, r]));
  ok(!got.has(SP(1)), 'eligibility: reminded 5 hours ago -> skipped');
  ok(got.has(SP(2)), 'eligibility: reminded 30 hours ago -> included');
  ok(!got.has(SP(3)), "eligibility: today's dedupe key exists (even if old) -> skipped");
  ok(got.has(SP(4)), "eligibility: yesterday's dedupe key only -> included");
  ok(!got.has(SP(5)), 'eligibility: inactive person -> skipped');
  ok(!got.has(SP(6)), 'eligibility: completed / cancelled tasks only -> skipped');
  ok(got.has(SP(7)) && got.get(SP(7)).tomorrow_count === 1 && got.get(SP(7)).late_count === 0, 'eligibility: due tomorrow -> included as "tomorrow"');
  ok(!got.has(SP(8)), 'eligibility: due in 2 days -> skipped');
  ok(!got.has(SP(9)), 'eligibility: no due date -> skipped');
  const s10 = got.get(SP(10));
  ok(s10 && s10.late_count === 2 && s10.today_count === 1 && s10.tomorrow_count === 1 && /sp-s10-late-old$/.test(s10.first_label), 'most urgent item: the oldest overdue task first', JSON.stringify(s10));
  ok(!got.has(uid(25)) && !got.has(uid(20)), 'people without eligible tasks / inactive people are not returned');

  // publish reminders
  const plan = (await db.query("INSERT INTO public.content_plans(title) VALUES ('Spring plan') RETURNING id")).rows[0].id;
  const post = (t, who, status, date, time) => db.query('INSERT INTO public.content_posts(plan_id,title,publisher_id,status,post_date,post_time) VALUES ($1,$2,$3,$4,$5,$6)', [plan, t, who, status, date, time]);
  await post('P-today', uid(1), 'planned', T.d, '14:30:00'); await post('P-late', uid(1), 'ready', T.y, null); await post('P-tomorrow', uid(1), 'approved', T.t, null);
  await post('P-published', uid(2), 'published', T.d, null); await post('P-nodate', uid(2), 'planned', null, null); await post('P-far', uid(2), 'planned', '2099-01-01', null);
  await post('P-inactive', SP(5), 'planned', T.d, null); await post('P-no-publisher', null, 'planned', T.d, null); await post('P-two', uid(3), 'planned', T.t, null);
  const pub = new Map((await page(db, 'publish_digest_batch', null, 200)).map((r) => [r.user_id, r]));
  ok(pub.size === 2 && pub.has(uid(1)) && pub.has(uid(3)), 'publish: only active people with unpublished, dated posts due by tomorrow', [...pub.keys()].join());
  const p1 = pub.get(uid(1));
  ok(p1.today_count === 1 && p1.late_count === 1 && p1.tomorrow_count === 1 && p1.first_label === 'P-today (Spring plan) 14:30', 'publish: counts and the first item (today first, with plan and time)', JSON.stringify(p1));
  await db.query(`INSERT INTO public.notifications(user_id,type,title,content,dedupe_key) VALUES ('${uid(3)}','publish_reminder','t','c','publish_reminder:${T.d}')`);
  ok(!(await page(db, 'publish_digest_batch', null, 200)).some((r) => r.user_id === uid(3)), 'publish: already reminded today -> skipped');

  // ---------------------------------------------------------------- 3. concurrent workers, crash, resume, repeat
  section('3. concurrent digest workers, crash and resume, repeated execution');
  const worker = async (maxBatches = Infinity) => {
    const c = await connect(); let inserted = 0, dup = 0, aft = null, n = 0;
    for (;;) {
      if (n++ >= maxBatches) break;
      const r = (await c.query('SELECT * FROM public.due_digest_batch($1::date,$2::date,$3::uuid,200)', [T.d, T.t, aft])).rows;
      if (!r.length) break;
      for (const x of r) {
        const e = await err(c, "INSERT INTO public.notifications(user_id,type,title,content,dedupe_key) VALUES ($1,'due_digest','Your deadlines',$2,$3)", [x.user_id, `${x.first_label}`, `due_digest:${T.d}`]);
        if (!e) inserted++; else if (e.code === '23505') dup++; else throw e;   // the same handling as notify()
        aft = x.user_id;
      }
      if (r.length < 200) break;
    }
    return { inserted, dup };
  };
  const ELIGIBLE = expected.size;
  const t0 = Date.now();
  const res = await Promise.all(Array.from({ length: 8 }, () => worker()));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const sum = res.reduce((a, r) => a + r.inserted, 0);
  const total = (await db.query(`SELECT count(*)::int c, count(DISTINCT user_id)::int u FROM public.notifications WHERE type='due_digest' AND dedupe_key='due_digest:${T.d}' AND user_id <> '${SP(3)}'`)).rows[0];
  ok(sum === ELIGIBLE && total.c === ELIGIBLE && total.u === ELIGIBLE, `8 concurrent workers: exactly one notification per eligible person (${ELIGIBLE}), in ${secs}s`, `${sum} / ${total.c} / ${total.u}`);
  ok(res.some((r) => r.dup > 0), 'the workers did collide (the database dedupe key resolved the races)', JSON.stringify(res));
  ok((await page(db, 'due_digest_batch', null, 200)).length === 0, 'afterwards nobody is a candidate any more (repeat is a no-op)');
  const rep2 = await worker();
  ok(rep2.inserted === 0, 'running the job again sends nothing');
  // crash: a worker stops after 3 batches (a timeout), the next run finishes the rest without repeating anyone
  await db.query("DELETE FROM public.notifications WHERE type='due_digest' AND dedupe_key = $1 AND user_id <> $2", [`due_digest:${T.d}`, SP(3)]);
  const partial = await worker(3);
  ok(partial.inserted === 600, 'a worker stopped by a timeout after 3 batches had notified 600 people', `${partial.inserted}`);
  const rest = await Promise.all([worker(), worker()]);
  const restSum = rest.reduce((a, r) => a + r.inserted, 0);
  const tot2 = (await db.query(`SELECT count(*)::int c, count(DISTINCT user_id)::int u FROM public.notifications WHERE type='due_digest' AND dedupe_key='due_digest:${T.d}' AND user_id <> '${SP(3)}'`)).rows[0];
  ok(restSum === ELIGIBLE - 600 && tot2.c === ELIGIBLE && tot2.u === ELIGIBLE, 'two resumed workers finish exactly the remaining people; nobody is notified twice', `${restSum} ${tot2.c} ${tot2.u}`);

  // ---------------------------------------------------------------- 4. broadcasts
  section('4. broadcasts: atomic claim, conflict, concurrent delivery, partial recovery');
  const SENDER = uid(1), OTHER = uid(2), REQ = '11111111-1111-4111-8111-111111111111';
  const claim = async (c, sender = SENDER, title = 'Holiday', msg = 'Office closed', link = null, aud = 'all', req = REQ) => (await c.query('SELECT * FROM public.broadcast_claim($1,$2,$3,$4,$5,$6,$7)', [sender, title, msg, link, aud, 'Everyone', req])).rows[0];
  const racers = await Promise.all(Array.from({ length: 8 }, async () => claim(await connect())));
  const states = racers.map((r) => r.state).sort();
  ok(states.filter((s) => s === 'new').length === 1 && states.filter((s) => s === 'resume').length === 7, '8 concurrent claims of one request id: exactly one is new, the others resume', states.join());
  ok(new Set(racers.map((r) => r.broadcast_id)).size === 1, 'they all point at the same broadcast');
  const BID = racers[0].broadcast_id, KEY = `broadcast:${BID}`;
  ok((await db.query('SELECT count(*)::int c FROM public.broadcasts WHERE request_id=$1', [REQ])).rows[0].c === 1, 'only one broadcast row exists');
  ok((await claim(db, OTHER)).state === 'conflict', 'another sender reusing the request id -> conflict');
  ok((await claim(db, SENDER, 'Different title')).state === 'conflict', 'different content with the same request id -> conflict');
  ok((await claim(db, SENDER, 'Holiday', 'Office closed', '#tasks')).state === 'conflict', 'different link with the same request id -> conflict');
  const n1 = (await claim(db, SENDER, 'Same', 'Same text', null, 'all', null)), n2 = (await claim(db, SENDER, 'Same', 'Same text', null, 'all', null));
  ok(n1.state === 'new' && n2.state === 'new' && n1.broadcast_id !== n2.broadcast_id, 'without a request id every send is its own broadcast');
  const audience = (await db.query("SELECT id FROM public.profiles WHERE employment_status='active' AND id <> $1 ORDER BY id LIMIT 1000", [SENDER])).rows.map((r) => r.id);
  const deliver = async (c, ids) => { let ins = 0, dup = 0; for (const id of ids) { const e = await err(c, "INSERT INTO public.notifications(user_id,type,title,content,dedupe_key) VALUES ($1,'announcement','Holiday','Office closed',$2)", [id, KEY]); if (!e) ins++; else if (e.code === '23505') dup++; else throw e; } return { ins, dup }; };
  ok((await deliver(db, audience.slice(0, 300))).ins === 300, 'the first 300 recipients were notified, then the function died');
  ok((await db.query('SELECT completed_at FROM public.broadcasts WHERE id=$1', [BID])).rows[0].completed_at === null, 'the broadcast is still open');
  ok((await claim(db)).state === 'resume', 'the same request again -> resume (nothing is silently dropped)');
  const parts = [0, 1, 2, 3].map((k) => audience.filter((_, i) => i % 4 === k));
  const dres = await Promise.all(parts.map(async (p) => deliver(await connect(), p)));
  const insSum = dres.reduce((a, r) => a + r.ins, 0), dupSum = dres.reduce((a, r) => a + r.dup, 0);
  ok(insSum === audience.length - 300 && dupSum === 300, '4 concurrent resumed workers delivered exactly the missing 700 and skipped the 300 already notified', `${insSum} ${dupSum}`);
  ok((await db.query('SELECT count(*)::int c, count(DISTINCT user_id)::int u FROM public.notifications WHERE dedupe_key=$1', [KEY])).rows[0].u === audience.length, 'every recipient has exactly one notification');
  const fin = (await db.query('SELECT public.broadcast_finish($1) n', [BID])).rows[0].n, fin2 = (await db.query('SELECT public.broadcast_finish($1) n', [BID])).rows[0].n;
  ok(fin === audience.length && fin2 === fin, 'broadcast_finish counts the real notifications and is repeatable');
  const bc = (await db.query('SELECT recipient_count, completed_at FROM public.broadcasts WHERE id=$1', [BID])).rows[0];
  ok(bc.recipient_count === audience.length && bc.completed_at, 'the broadcast is closed with the true recipient count');
  ok((await claim(db)).state === 'done', 'a finished broadcast answers "done" and is never sent again');
  // the source must refuse to send without a claim
  const bsrc = src('functions/broadcast/index.ts');
  ok(/throw new HttpError\(500, "The announcement could not be recorded/.test(bsrc) && !/history is not essential/.test(bsrc), 'broadcast/index.ts stops when the claim cannot be made (no unsafe fallback)');
  ok(/dedupeKey/.test(bsrc) && /broadcast_claim/.test(bsrc) && /broadcast_finish/.test(bsrc), 'broadcast/index.ts uses the claim, the per-recipient key and finish');
  // ---------------------------------------------------------------- 5. storage cleanup requeue / prune report
  section('5. storage cleanup: requeue of exhausted rows, worker claim, prune report');
  await db.query('DELETE FROM public.storage_cleanup_queue');
  await db.query(`INSERT INTO public.storage_cleanup_queue(bucket,path,source,attempts,last_error,next_attempt_at) SELECT 'studio-assets','ex/'||g,'assets',12,'storage unavailable '||g, now() + interval '5 days' FROM generate_series(1,40) g`);
  await db.query(`INSERT INTO public.storage_cleanup_queue(bucket,path,source,attempts,last_error) SELECT 'studio-assets','part/'||g,'assets',5,'e' FROM generate_series(1,5) g`);
  await db.query(`INSERT INTO public.storage_cleanup_queue(bucket,path,source,attempts,done_at) SELECT 'chat-media','done/'||g,'messages',1, now() - (g||' days')::interval FROM generate_series(1,10) g`);
  const snap = async () => (await db.query("SELECT md5(string_agg(id||':'||bucket||path||attempts||coalesce(last_error,'')||coalesce(done_at::text,''), ',' ORDER BY id)) h FROM public.storage_cleanup_queue WHERE path LIKE 'part/%' OR path LIKE 'done/%'")).rows[0].h;
  ok((await db.query('SELECT gave_up FROM public.storage_cleanup_status()')).rows[0].gave_up == 40, 'setup: 40 rows have given up');
  ok((await db.query('SELECT count(*)::int c FROM public.storage_cleanup_claim(500)')).rows[0].c === 5, 'the existing worker claim (029) never takes exhausted rows');
  await db.query("UPDATE public.storage_cleanup_queue SET next_attempt_at = now() + interval '1 hour' WHERE attempts BETWEEN 1 AND 11 AND done_at IS NULL");
  const untouched = await snap();
  const one = (await db.query('SELECT public.storage_cleanup_requeue($1::bigint[]) n', [(await db.query("SELECT array_agg(id) a FROM (SELECT id FROM public.storage_cleanup_queue WHERE attempts >= 12 ORDER BY id LIMIT 3) x")).rows[0].a])).rows[0].n;
  ok(one === 3, 'requeue of 3 chosen ids requeues exactly those 3', `${one}`);
  const results = await Promise.all(Array.from({ length: 4 }, async () => (await (await connect()).query('SELECT public.storage_cleanup_requeue() n')).rows[0].n));
  ok(results.reduce((a, b) => a + b, 0) === 37, '4 concurrent requeue calls together requeue the remaining 37 exactly once', results.join());
  const hist = (await db.query('SELECT count(*)::int c, count(DISTINCT queue_id)::int q, min(attempts_before) mn, bool_and(last_error_before LIKE \'storage unavailable%\') e FROM public.storage_cleanup_requeues')).rows[0];
  ok(hist.c === 40 && hist.q === 40 && hist.mn === 12 && hist.e, 'the history keeps the attempt count and last error of every requeued row (40 rows, once each)', JSON.stringify(hist));
  const rq = (await db.query("SELECT attempts, last_error, next_attempt_at <= now() due, done_at FROM public.storage_cleanup_queue WHERE path = 'ex/1'")).rows[0];
  ok(rq.attempts === 0 && rq.last_error === 'storage unavailable 1' && rq.due && rq.done_at === null, 'a requeued row has fresh attempts, is due now and keeps its error text', JSON.stringify(rq));
  ok(await snap() === untouched, 'rows that were not exhausted, and completed rows, are unchanged');
  ok((await db.query('SELECT public.storage_cleanup_requeue() n')).rows[0].n === 0, 'a second requeue finds nothing to do');
  const claimed = (await db.query('SELECT * FROM public.storage_cleanup_claim(500)')).rows;
  ok(claimed.length === 40, 'the existing worker now claims the requeued rows (029 functions unchanged)', `${claimed.length}`);
  ok((await db.query("SELECT gave_up FROM public.storage_cleanup_status()")).rows[0].gave_up == 0, 'storage_cleanup_status shows nobody gave up');
  await db.query("UPDATE public.storage_cleanup_queue SET attempts = 12, next_attempt_at = now() WHERE path = 'ex/1' AND done_at IS NULL");
  await db.query('SELECT public.storage_cleanup_requeue()');
  ok((await db.query("SELECT count(*)::int c FROM public.storage_cleanup_requeues WHERE path='ex/1'")).rows[0].c === 2, 'requeueing the same file again adds a second history row (history is never overwritten)');
  const total0 = (await db.query('SELECT count(*)::int c FROM public.storage_cleanup_queue')).rows[0].c;
  const pr = (await db.query("SELECT * FROM public.storage_cleanup_prune_candidates('5 days')")).rows;
  ok(pr.length === 6 && pr.every((r) => r.done_at), 'prune report lists only completed rows older than the age you pass', `${pr.length}`);
  ok((await db.query("SELECT count(*)::int c FROM public.storage_cleanup_prune_candidates('100 days')")).rows[0].c === 0, 'no period is built in');
  ok((await db.query('SELECT count(*)::int c FROM public.storage_cleanup_queue')).rows[0].c === total0, 'the prune report deletes nothing');

  // ---------------------------------------------------------------- 6. orphan detector
  section('6. orphan detector: read-only, preserves referenced, queued and recent files');
  await db.query('DELETE FROM public.storage_cleanup_queue');
  const old = "now() - interval '10 days'";
  const obj = (b, n, age = old) => db.query(`INSERT INTO storage.objects(bucket_id,name,created_at) VALUES ($1,$2,${age})`, [b, n]);
  const task = (await db.query('SELECT id FROM public.tasks LIMIT 1')).rows[0].id;
  await db.query('INSERT INTO public.task_attachments(task_id,file_name,file_size,file_type,storage_path,uploaded_by) VALUES ($1,$2,1,$3,$4,$5)', [task, 'a.png', 'image/png', `${uid(1)}/ref-att.png`, uid(1)]);
  await db.query("INSERT INTO public.assets(name,file_name,file_size,file_type,storage_path,uploaded_by) VALUES ('A','a.png',1,'image/png',$1,$2)", [`${uid(1)}/ref-asset.png`, uid(1)]);
  await db.query('INSERT INTO public.content_post_assets(plan_id,storage_path,file_name,file_type,file_size,uploaded_by) VALUES ($1,$2,$3,$4,1,$5)', [plan, `${uid(1)}/plans/${plan}/ref-plan.png`, 'p.png', 'image/png', uid(1)]);
  const conv = (await db.query("INSERT INTO public.conversations(type,name,is_public) VALUES ('group','BG chat',false) RETURNING id")).rows[0].id;
  await db.query("INSERT INTO public.messages(conversation_id,sender_id,content,metadata) VALUES ($1,$2,'',$3::jsonb)", [conv, uid(1), JSON.stringify({ path: `${conv}/ref-msg.png` })]);
  await obj('task-attachments', `${uid(1)}/ref-att.png`); await obj('studio-assets', `${uid(1)}/ref-asset.png`);
  await obj('studio-assets', `${uid(1)}/plans/${plan}/ref-plan.png`); await obj('chat-media', `${conv}/ref-msg.png`);
  await obj('task-attachments', 'orphan/att.png'); await obj('studio-assets', 'orphan/asset.png'); await obj('chat-media', `${conv}/orphan-msg.png`);
  await obj('task-attachments', 'recent/upload.png', "now() - interval '5 minutes'");
  await obj('studio-assets', 'queued/removal.png');
  await db.query("INSERT INTO public.storage_cleanup_queue(bucket,path) VALUES ('studio-assets','queued/removal.png')");
  await obj('some-other-bucket', 'foreign/file.bin');
  await obj('studio-assets', `${uid(1)}/ref-att.png`);   // same name, other bucket: a task attachment path does not protect a studio asset
  const snapAll = async () => (await db.query(`SELECT md5((SELECT string_agg(bucket_id||name||created_at::text, ',' ORDER BY bucket_id, name) FROM storage.objects) || (SELECT string_agg(id::text, ',' ORDER BY id) FROM public.task_attachments) || (SELECT string_agg(id::text, ',' ORDER BY id) FROM public.assets) || (SELECT string_agg(id::text, ',' ORDER BY id) FROM public.messages) || (SELECT coalesce(string_agg(id::text, ',' ORDER BY id), '') FROM public.storage_cleanup_queue)) h`)).rows[0].h;
  const s0 = await snapAll();
  const orph = (await db.query("SELECT * FROM public.storage_orphans('1 day') ORDER BY bucket_id, name")).rows.map((r) => `${r.bucket_id}:${r.name}`);
  const want = ['chat-media:' + conv + '/orphan-msg.png', 'studio-assets:' + uid(1) + '/ref-att.png', 'studio-assets:orphan/asset.png', 'task-attachments:orphan/att.png'].sort();
  ok(JSON.stringify(orph) === JSON.stringify(want), 'only real orphans older than the age are listed (referenced, queued, recent and other-bucket files are kept)', JSON.stringify(orph));
  ok((await db.query("SELECT count(*)::int c FROM public.storage_orphans('1 hour')")).rows[0].c === 4, 'an upload younger than the age is not listed; with a shorter age the list is unchanged except by age');
  ok((await db.query("SELECT count(*)::int c FROM public.storage_orphans('1 minute')")).rows[0].c === 5, 'with a 1-minute age the 5-minute-old upload appears (the age is the only protection, so it is a required argument)');
  ok((await db.query("SELECT count(*)::int c FROM public.storage_orphans('1 day', 2)")).rows[0].c === 2, 'the limit applies');
  ok(await snapAll() === s0, 'the detector changed no storage object, reference or queue row');
  ok((await db.query('SELECT n FROM public.integrity_report() LIMIT 1')).rows.length === 1, 'integrity_report still runs');

  // ---------------------------------------------------------------- 7. notification dedupe
  section('7. notification deduplication under retries');
  const nk = async (user, key) => err(db, "INSERT INTO public.notifications(user_id,type,title,content,dedupe_key) VALUES ($1,'t','t','c',$2)", [user, key]);
  ok(await nk(uid(1), 'leave_decision:abc') === null, 'first insert with a key succeeds');
  ok((await nk(uid(1), 'leave_decision:abc'))?.code === '23505', 'a retry with the same user and key is rejected by the database (notify() treats 23505 as "already sent")');
  ok(await nk(uid(2), 'leave_decision:abc') === null, 'the same key for another person is allowed');
  ok(await nk(uid(1), 'leave_decision:other') === null, 'another event key for the same person is allowed');
  ok(await err(db, "INSERT INTO public.notifications(user_id,type,title,content) VALUES ($1,'t','t','c'),($1,'t','t','c')", [uid(1)]) === null, 'notifications without a key are unchanged (no new restriction)');
  const wf = src('functions/workflow/index.ts');
  const wantKeys = ['expense_decision:${expenseId}:${decision}', 'leave_decision:${leaveId}', 'task_deleted:${taskId}', 'task_comment:${comment.id}', 'leave_request:${leaveId}', 'expense_request:${expenseId}'];
  for (const k of wantKeys) ok(wf.includes('`' + k + '`'), `workflow notification keyed by its event: ${k}`);
  ok(!/dedupeKey: `(task_assigned|task_status|role_changed|task_updated|task_file)/.test(wf), 'events without a stable identity (reassign, status change, edit, file, role) are not keyed, so a legitimate repeat is never suppressed');
  const auth = src('functions/_shared/auth.ts');
  ok(/dedupeKey && error\.code === "23505"/.test(auth) && !/notification_preferences/.test(auth), 'notify() and notification preferences are unchanged');
  ok(src('functions/_shared/push.ts').includes('TTL: payload.requireInteraction ? 60 : 60 * 60 * 24,'), 'push delivery and its TTL are unchanged (no new retry mechanism)');

  // ---------------------------------------------------------------- 8. storage.cleanup authorization
  section('8. workflow storage.cleanup is limited to administrators');
  if (esbuild) {
    const b = await esbuild.build({ entryPoints: [path.join(SB, 'functions/_shared/authz.ts')], bundle: true, format: 'esm', write: false, platform: 'node' });
    const mod = await import('data:text/javascript;base64,' + Buffer.from(b.outputFiles[0].text).toString('base64'));
    const allow = /export const ADMIN_ROLES = \[([^\]]*)\]/.exec(auth)[1].replace(/["\s]/g, '').split(',');
    const may = (s, r) => mod.mayRunStorageCleanup(s, r, allow);
    for (const r of allow) ok(may('active', [r]) === true, `active ${r} may run it`);
    for (const r of ['ceo', 'department_manager', 'project_manager', 'team_leader', 'hr_manager', 'finance_manager', 'accountant', 'employee', 'client', 'designer']) ok(may('active', [r]) === false, `active ${r} is refused`);
    ok(may('active', []) === false && may('active', null) === false, 'no roles -> refused');
    for (const s of ['inactive', 'suspended', 'invited', '', null, undefined]) ok(may(s, ['super_admin']) === false, `a super_admin with status ${JSON.stringify(s)} is refused`);
    ok(may('active', ['employee', 'owner']) === true, 'one admin role among others is enough');
    ok(allow.join() === 'super_admin,owner,general_manager', 'the allowed roles are exactly ADMIN_ROLES of auth.ts', allow.join());
  } else ok(false, 'esbuild is needed for the authorization test');
  const caseAt = wf.indexOf('case "storage.cleanup"');
  const guardAt = wf.indexOf('mayRunStorageCleanup(caller.status, caller.roles, ADMIN_ROLES)', caseAt);
  const drainAt = wf.indexOf('drainStorageCleanup(admin, 100)', caseAt);
  ok(caseAt > 0 && guardAt > caseAt && drainAt > guardAt && /HttpError\(403/.test(wf.slice(guardAt, drainAt)), 'the handler checks the role and answers 403 BEFORE the queue is drained');
  ok(/const caller = await getCaller\(req, admin\);\s*requireStaff\(caller\);/.test(wf), 'authentication still runs before any action');
  ok((wf.match(/drainStorageCleanup\(/g) || []).length === 2, 'the internal drain call after a task delete is unchanged (one guarded action call + one internal call)');

  // ---------------------------------------------------------------- 9. retainer alerts and drafts
  section('9. retainer drafts detector and the once-per-month alert');
  const cl = (await db.query("INSERT INTO public.clients(name,company_name) VALUES ('rc','Retainer Co') RETURNING id")).rows[0].id;
  await db.query('BEGIN'); await db.query("SET LOCAL app.migrating = 'on'");
  const inv = (n, kind, status, month) => db.query(`INSERT INTO public.invoices(invoice_number,client_id,type,status,kind,period_month,due_date,currency,amount,tax,subtotal,vat_amount,total,net_receivable,amount_paid,balance)
     VALUES ($1,$2,'receivable',$3,$4,$5,current_date,'EGP',100,0,100,0,100,100,0,100)`, [n, cl, status, kind, month]);
  await inv('R-1', 'retainer', 'draft', '2026-11-01'); await inv('R-2', 'retainer', 'draft', '2026-10-01'); await inv('R-3', 'retainer', 'sent', '2026-11-01');
  await inv('A-1', 'adhoc', 'draft', null); await inv('R-4', 'retainer', 'void', '2026-09-01');
  await db.query('COMMIT');
  let dr = (await db.query('SELECT * FROM public.fin_retainer_drafts_unreviewed()')).rows;
  ok(dr.map((r) => r.invoice_number).sort().join() === 'R-1,R-2', 'only retainer invoices still in draft are listed', dr.map((r) => r.invoice_number).join());
  await db.query("UPDATE public.invoices SET status='sent' WHERE invoice_number='R-1'");
  dr = (await db.query('SELECT * FROM public.fin_retainer_drafts_unreviewed()')).rows;
  ok(dr.length === 1 && dr[0].invoice_number === 'R-2', 'a reviewed (sent) draft leaves the list');
  ok((await db.query("SELECT n FROM public.integrity_report() WHERE check_name = 'retainer invoices still in draft'")).rows[0].n == 1, 'integrity_report shows the unreviewed drafts');
  const monthKey = 'invoice_drafts:2026-11';
  ok(await nk(uid(1), monthKey) === null && (await nk(uid(1), monthKey))?.code === '23505', 'the "drafts ready" alert is stored once per person per month (a second run of the job is blocked)');
  ok(await nk(uid(1), 'invoice_drafts:2026-12') === null, 'the next month sends a new alert');
  const rb = src('functions/retainer-billing/index.ts');
  ok(rb.includes('dedupeKey: `invoice_drafts:${month.slice(0, 7)}`') && rb.includes('fin_retainer_generate') && rb.includes('fin_mark_overdue'), 'retainer-billing keys the alert by month and still calls the same billing functions');
  ok(/fin_retainer_generate", \{ p_actor: null, p_month: month \}/.test(rb), 'billing semantics: same arguments as before');
  const fin028 = (await db.query("SELECT prosrc FROM pg_proc WHERE proname='fin_retainer_generate'")).rows[0].prosrc;
  ok(/pg_advisory_xact_lock/.test(fin028), 'fin_retainer_generate (028) is untouched and still locks per month');

  // ---------------------------------------------------------------- 10. job ledger wiring + resumable job source
  section('10. the scheduled functions use the ledger and run housekeeping before the digest');
  const dr1 = src('functions/due-reminders/index.ts');
  ok(dr1.includes('startJobRun(admin, "due-reminders")') && /run\.finish\(partial \? "partial" : "succeeded"/.test(dr1) && /run\.finish\("failed"/.test(dr1), 'due-reminders records start, success / partial and failure');
  ok(rb.includes('startJobRun(admin, "retainer-billing")') && rb.includes('run.finish("failed"'), 'retainer-billing records its runs');
  const iClean = dr1.indexOf('drainStorageCleanup('), iInv = dr1.indexOf('invitations_expire_pending'), iDig = dr1.indexOf('runDigest("due_digest_batch"');
  ok(iClean > 0 && iInv > iClean && iDig > iInv, 'storage cleanup and invitation expiry run BEFORE the digest, so a digest timeout cannot skip them');
  ok(!/\.from\("tasks"\)|\.from\("content_posts"\)|\.lte\(/.test(dr1), 'no capped PostgREST reads are left in due-reminders');
  ok(/Date\.now\(\) - startedAt > budgetMs/.test(dr1) && /partial = true/.test(dr1), 'the digest stops starting new batches when the time budget is used up and the run ends as partial');
  ok(/dedupeKey: `\$\{key\}:\$\{today\}`/.test(dr1), 'the one-digest-per-person-per-day key is kept');
  const jobs = src('functions/_shared/jobs.ts');
  ok(/never stop a job|must stop a job|Nothing here may stop a job/.test(jobs) && !/throw /.test(jobs), 'the ledger helper never throws (a missing migration cannot stop a job)');
  const srcFiles = ['functions/due-reminders/index.ts', 'functions/retainer-billing/index.ts', 'functions/broadcast/index.ts', 'functions/workflow/index.ts', 'functions/_shared/jobs.ts', 'functions/_shared/authz.ts'];
  if (esbuild) for (const f of srcFiles) { let e = null; try { await esbuild.transform(src(f), { loader: 'ts' }); } catch (x) { e = x.message.split('\n')[0]; } ok(e === null, `TypeScript parses: ${f}`, e); }

  // ---------------------------------------------------------------- 11. rollback
  section('11. rollback of 037, then apply again');
  await db.query(sql('maintenance/rollback-037.sql'));
  const gone = (await db.query(`SELECT count(*)::int c FROM unnest($1::text[]) f WHERE to_regprocedure('public.'||f) IS NOT NULL`, [FUNCS])).rows[0].c;
  ok(gone === 0, 'every function of 037 is dropped', `${gone}`);
  ok((await db.query("SELECT count(*)::int c FROM pg_class WHERE relname IN ('job_runs','storage_cleanup_requeues') AND relnamespace='public'::regnamespace")).rows[0].c === 0, 'both new tables are dropped');
  ok((await db.query('SELECT count(*)::int c FROM public.integrity_report()')).rows[0].c === 17, 'integrity_report is back to the 17 rows of 035');
  ok((await db.query("SELECT count(*)::int c FROM public.storage_cleanup_status()")).rows.length === 1 && (await db.query("SELECT count(*)::int c FROM pg_proc WHERE proname IN ('storage_cleanup_claim','storage_cleanup_report')")).rows[0].c === 2, 'the 029 functions are untouched by the rollback');
  ok((await db.query("SELECT count(*)::int c FROM public.notifications WHERE dedupe_key IS NOT NULL")).rows[0].c > 0, 'no notification data was touched by the rollback');
  ok(await err(db, sql('maintenance/rollback-037.sql')) === null, 'the rollback can run twice');
  await db.query(sql('migrations/037_background_jobs.sql'));
  ok((await db.query('SELECT count(*)::int c FROM public.integrity_report()')).rows[0].c === 19, '037 applies again after a rollback (19 rows)');
  ok((await db.query("SELECT count(*)::int c FROM public.due_digest_batch(current_date, current_date + 1)")).rows[0].c >= 0, 'the digest function works again');
} catch (e) {
  failed++; console.log('FATAL', e.stack || e.message);
} finally {
  for (const c of conns) { try { await c.end(); } catch { /* */ } }
  try { await server.stop(); } catch { /* */ }
  if (!process.env.KEEP) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
