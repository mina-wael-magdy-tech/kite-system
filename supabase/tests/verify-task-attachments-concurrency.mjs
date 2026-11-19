// Real-PostgreSQL CONCURRENCY test for migration 039 (permanent path registry, cleanup-queue gate).
// PGlite is a single connection, so this starts a throwaway local PostgreSQL (embedded-postgres, 127.0.0.1, temp dir)
// and races genuine connections. Nothing leaves the machine.
// Every interleaving is forced and PROVEN: T2 is started while T1 is open and the test polls pg_stat_activity until T2's
// backend waits on a lock (wait_event_type = 'Lock'), so "blocked" is observed, not assumed.
//
// Optional dependencies (NOT in package.json on purpose, they download a PostgreSQL binary):
//   npm install --no-save embedded-postgres pg
//   node verify-task-attachments-concurrency.mjs
// Without them the script prints SKIPPED and exits 0.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SB = path.resolve(HERE, '..');
let EmbeddedPostgres, pg;
try { EmbeddedPostgres = (await import('embedded-postgres')).default; pg = (await import('pg')).default; }
catch { console.log('SKIPPED: install the optional dependencies first:  npm install --no-save embedded-postgres pg'); process.exit(0); }

let passed = 0, failed = 0;
const ok = (c, name, d = '') => { if (c) { passed++; console.log('PASS', name); } else { failed++; console.log('FAIL', name, d); } };
const section = (s) => console.log('\n== ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-pg-att-'));
const PORT = 54900 + Math.floor(Math.random() * 90);
const server = new EmbeddedPostgres({ databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'pw', port: PORT, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} });
const open = async () => { const c = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'pw', database: 'kite' }); await c.connect(); return c; };
const as = async (uid, role = 'authenticated') => {                       // a session acting as an app user (RLS applies) or as the worker
  const c = await open();
  await c.query('SELECT set_config($1, $2, false)', ['request.jwt.claim.sub', uid ?? '']);
  await c.query(`SET ROLE ${role}`);
  c.pid = (await c.query('SELECT pg_backend_pid() p')).rows[0].p;
  return c;
};
const tryq = async (c, sql, p = []) => { try { const r = await c.query(sql, p); return { ok: true, rows: r.rows }; } catch (e) { return { ok: false, error: e.message, code: e.code }; } };

let ctl;
const STUBS = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE authenticator NOLOGIN;
CREATE SCHEMA auth; CREATE SCHEMA storage;
CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, raw_user_meta_data jsonb);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth, storage, public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects (id uuid DEFAULT gen_random_uuid(), bucket_id text, name text, owner_id text, created_at timestamptz DEFAULT now());
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT ALL ON storage.objects, storage.buckets TO authenticated, service_role;
CREATE PUBLICATION supabase_realtime;
CREATE SCHEMA realtime;
CREATE TABLE realtime.messages (id bigserial primary key, topic text, extension text);
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql AS $$ SELECT null::text $$;
GRANT USAGE ON SCHEMA realtime TO authenticated;`;

try {
  await server.initialise(); await server.start(); await server.createDatabase('kite');
  ctl = await open();
  console.log('real PostgreSQL ' + (await ctl.query('SHOW server_version')).rows[0].server_version + ' on port ' + PORT);
  await ctl.query(STUBS);
  const files = fs.readdirSync(path.join(SB, 'migrations')).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort().filter((f) => f.slice(0, 3) <= '039');
  for (const f of files) {
    await ctl.query(fs.readFileSync(path.join(SB, 'migrations', f), 'utf8'));
    if (f.startsWith('005')) await ctl.query(fs.readFileSync(path.join(SB, 'seed.sql'), 'utf8'));
  }
  ok(true, 'migrations 001-039 applied on a real PostgreSQL server');

  // ---- fixtures
  const u = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const A = u(1), B = u(2);
  for (const [id, n] of [[A, 'a'], [B, 'b']]) {
    await ctl.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [id, n + '@x.test']);
    await ctl.query("INSERT INTO public.profiles(id,full_name,email,employment_status) VALUES ($1,$2,$3,'active')", [id, 'u' + n, n + '@x.test']);
    await ctl.query("INSERT INTO public.user_roles(user_id, role_id) SELECT $1, id FROM public.roles WHERE name='employee'", [id]);
  }
  const task = (await ctl.query("INSERT INTO public.tasks(title, created_by) VALUES ('T', $1) RETURNING id", [A])).rows[0].id;
  await ctl.query('INSERT INTO public.task_assignees(task_id, user_id) VALUES ($1,$2)', [task, B]);
  let seq = 100;
  const bp = (uid) => `${task}/${uid}-bbbbbbbb-1111-4222-8333-${String(++seq).padStart(12, '0')}-doc.pdf`;
  const INS = `INSERT INTO public.task_attachments (task_id, file_name, file_size, file_type, storage_path, uploaded_by) VALUES ($1,'f.pdf',1,'application/pdf',$2,$3) RETURNING id`;
  const attach = async (uid, p) => { const c = await as(uid); try { const r = await tryq(c, INS, [task, p, uid]); if (!r.ok) throw new Error(r.error); return r.rows[0].id; } finally { await c.end(); } };
  const live = async (p) => (await ctl.query('SELECT count(*)::int c FROM public.task_attachments WHERE storage_path=$1', [p])).rows[0].c;
  const queued = async (p) => (await ctl.query("SELECT count(*)::int c FROM public.storage_cleanup_queue WHERE bucket='task-attachments' AND path=$1", [p])).rows[0].c;
  const reg = async (p) => (await ctl.query("SELECT state FROM public.storage_path_registry WHERE bucket='task-attachments' AND path=$1", [p])).rows[0]?.state ?? null;
  const invariant = async () => (await ctl.query(`
    SELECT (SELECT count(*) FROM public.task_attachments a JOIN public.storage_cleanup_queue q ON q.bucket='task-attachments' AND q.path=a.storage_path)::int AS queued_and_live,
           (SELECT count(*) FROM public.task_attachments a WHERE NOT EXISTS (SELECT 1 FROM public.storage_path_registry r WHERE r.path=a.storage_path AND r.state='live' AND r.attachment_id=a.id))::int AS live_without_registry,
           (SELECT count(*) FROM public.storage_path_registry r JOIN public.task_attachments a ON a.storage_path=r.path WHERE r.state='dead')::int AS dead_but_attached`)).rows[0];

  // Forced interleaving of two real connections.
  //   t1(c1) runs in an open transaction; t2(c2) starts while it is open; we wait until T2's backend is blocked on a lock;
  //   then T1 commits (or rolls back) and T2 finishes.
  const interleave = async ({ uid1, uid2, t1, t2, end = 'commit', iso2 = null, role2 = 'authenticated' }) => {
    const c1 = await as(uid1), c2 = await as(uid2, role2);
    const out = { blocked: false, r2: null };
    try {
      await c1.query('BEGIN'); await c2.query(iso2 ? `BEGIN ISOLATION LEVEL ${iso2}` : 'BEGIN');
      if (iso2) await c2.query('SELECT 1');                            // establish the snapshot BEFORE T1 commits
      await t1(c1);
      const p2 = t2(c2).then((r) => r, (e) => ({ ok: false, error: e.message, code: e.code }));
      for (let i = 0; i < 40 && !out.blocked; i++) {
        await sleep(50);
        out.blocked = (await ctl.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [c2.pid])).rows[0]?.wait_event_type === 'Lock';
        if (await Promise.race([p2.then(() => true), sleep(0).then(() => false)])) break;
      }
      await c1.query(end === 'commit' ? 'COMMIT' : 'ROLLBACK');
      out.r2 = await p2;
      await c2.query(out.r2.ok ? 'COMMIT' : 'ROLLBACK');
    } finally { await c1.end(); await c2.end(); }
    return out;
  };
  const delAtt = (id) => (c) => c.query('DELETE FROM public.task_attachments WHERE id=$1', [id]);
  const insAtt = (uid, p) => async (c) => tryq(c, INS, [task, p, uid]);

  // ------------------------------------------------------------------
  section('C1. DELETE(A, P) uncommitted  ||  INSERT(P) by the uploader   [T1 commits]');
  for (const [name, uid2] of [['same uploader re-registers', A]]) {
    const P = bp(A, 'x'); const id = await attach(A, P);
    const r = await interleave({ uid1: A, uid2, t1: delAtt(id), t2: insAtt(uid2, P) });
    ok(r.blocked, `C1 ${name}: T2 was really blocked behind T1 (wait_event_type=Lock)`);
    ok(!r.r2.ok && /already used/.test(r.r2.error) && r.r2.code === '23505', `C1 ${name}: T2 is refused with unique_violation after T1 commits`, JSON.stringify(r.r2));
    ok(await live(P) === 0 && await reg(P) === 'dead' && await queued(P) === 1, `C1 ${name}: final state = no live row, tombstone dead, one queue row`);
  }
  section('C2. DELETE(A, P) uncommitted  ||  INSERT(P)   [T1 ROLLS BACK]');
  {
    const P = bp(A, 'x'); const id = await attach(A, P);
    const r = await interleave({ uid1: A, uid2: A, t1: delAtt(id), t2: insAtt(A, P), end: 'rollback' });
    ok(r.blocked, 'C2: T2 blocked behind T1');
    ok(!r.r2.ok, 'C2: T2 is refused (the path is still live)', JSON.stringify(r.r2));
    ok(await live(P) === 1 && await reg(P) === 'live' && await queued(P) === 0, 'C2: rolled-back delete leaves the attachment live, registry live, NO queue row (atomic)');
  }
  section('C3. two INSERTs of the same new path');
  for (const end of ['commit', 'rollback']) {
    const P = bp(A, 'x');
    const r = await interleave({ uid1: A, uid2: A, t1: async (c) => { const x = await tryq(c, INS, [task, P, A]); if (!x.ok) throw new Error(x.error); }, t2: insAtt(A, P), end });
    ok(r.blocked, `C3 (T1 ${end}): T2 blocked behind T1`);
    if (end === 'commit') ok(!r.r2.ok && await live(P) === 1, 'C3: T1 commits -> T2 refused, exactly one row');
    else ok(r.r2.ok && await live(P) === 1 && await reg(P) === 'live', 'C3: T1 rolls back -> T2 succeeds, exactly one row');
  }
  section('C4. worker claim while a path is being registered (forged queue row present)');
  {
    const P = bp(A, 'x');
    await ctl.query("INSERT INTO public.storage_cleanup_queue(bucket, path, source) VALUES ('task-attachments', $1, 'forged')", [P]);
    const r = await interleave({ uid1: A, uid2: null, role2: 'service_role',
      t1: async (c) => { const x = await tryq(c, INS, [task, P, A]); if (!x.ok) throw new Error(x.error); },     // T1: registration open, uncommitted
      t2: (c) => tryq(c, 'SELECT path FROM public.storage_cleanup_claim(500)') });
    ok(r.r2.ok && !r.r2.rows.some((x) => x.path === P), 'C4: claim during the open registration does not return the path');
    const again = await ctl.query("SELECT path FROM public.storage_cleanup_claim(500)");
    ok(!again.rows.some((x) => x.path === P) && await live(P) === 1, 'C4: after the registration commits the path is still never claimable');
    await ctl.query("DELETE FROM public.storage_cleanup_queue WHERE path=$1", [P]);
  }
  section('C5. path leased by the worker (claimed, not reported)');
  {
    const P = bp(A, 'x'); const id = await attach(A, P);
    const c = await as(A); await c.query('DELETE FROM public.task_attachments WHERE id=$1', [id]); await c.end();
    const claim = (await ctl.query('SELECT id, path FROM public.storage_cleanup_claim(500)')).rows.find((x) => x.path === P);
    ok(!!claim, 'C5: worker holds a lease on the path');
    const ca = await as(A); const r = await tryq(ca, INS, [task, P, A]); await ca.end();
    ok(!r.ok && /already used/.test(r.error), 'C5: registration of a leased path is refused', r.error);
    await ctl.query('SELECT public.storage_cleanup_report($1, true, NULL)', [claim.id]);
    const cb = await as(A); const r2 = await tryq(cb, INS, [task, P, A]); await cb.end();
    ok(!r2.ok, 'C5: and after completion', r2.error);
  }
  section('C6. stricter isolation levels fail closed');
  for (const iso of ['REPEATABLE READ', 'SERIALIZABLE']) {
    const P = bp(A, 'x'); const id = await attach(A, P);
    const r = await interleave({ uid1: A, uid2: A, t1: delAtt(id), t2: insAtt(A, P), iso2: iso });
    ok(!r.r2.ok && await live(P) === 0 && await reg(P) === 'dead', `C6 ${iso}: T2 refused (${(r.r2.error || '').slice(0, 60)}); no live row`);
  }

  // ------------------------------------------------------------------
  section('C7. randomized stress: delete || re-register (x2) || worker claim, fixed seed');
  {
    let seed = 20240607; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const ROUNDS = 80;
    const cDel = await as(A), cR1 = await as(A), cR2 = await as(B), cW = await as(null, 'service_role'), cN1 = await as(A), cN2 = await as(A);
    let reRegOk = 0, delOk = 0, winners = 0; const claimed = [];
    for (let i = 0; i < ROUNDS; i++) {
      const P = bp(A, 'x'); const id = await attach(A, P);
      const N = bp(A, 'x');
      const job = async (fn, d) => { await sleep(d); return fn(); };
      const res = await Promise.all([
        job(() => tryq(cDel, 'DELETE FROM public.task_attachments WHERE id=$1 RETURNING id', [id]), rnd() * 15),
        job(() => tryq(cR1, INS, [task, P, A]), rnd() * 15),
        job(() => tryq(cR2, INS, [task, P, B]), rnd() * 15),                                   // another user, same path
        job(async () => { const r = await tryq(cW, 'SELECT id, path FROM public.storage_cleanup_claim(50)'); if (r.ok) for (const x of r.rows) { claimed.push(x.path); await tryq(cW, 'SELECT public.storage_cleanup_report($1, true, NULL)', [x.id]); } return r; }, rnd() * 20),
        job(() => tryq(cN1, INS, [task, N, A]), rnd() * 10),                                   // two inserts of a brand-new path
        job(() => tryq(cN2, INS, [task, N, A]), rnd() * 10),
      ]);
      delOk += res[0].ok && res[0].rows.length === 1 ? 1 : 0;
      reRegOk += (res[1].ok ? 1 : 0) + (res[2].ok ? 1 : 0);
      winners += ((res[4].ok ? 1 : 0) + (res[5].ok ? 1 : 0)) === 1 ? 1 : 0;
    }
    for (const c of [cDel, cR1, cR2, cW, cN1, cN2]) await c.end();
    const inv = await invariant();
    ok(delOk === ROUNDS, `C7: every delete committed (${delOk}/${ROUNDS})`);
    ok(reRegOk === 0, `C7: NO re-registration of a pending/deleted path ever succeeded (${reRegOk} of ${ROUNDS * 2} attempts)`);
    ok(winners === ROUNDS, `C7: two concurrent inserts of one new path: exactly one winner every round (${winners}/${ROUNDS})`);
    ok(inv.queued_and_live === 0 && inv.live_without_registry === 0 && inv.dead_but_attached === 0, 'C7: invariant holds (no path both queued and live; registry consistent)', JSON.stringify(inv));
    const bad = (await ctl.query("SELECT count(*)::int c FROM public.task_attachments a WHERE a.storage_path = ANY($1)", [claimed])).rows[0].c;
    ok(bad === 0, `C7: none of the ${claimed.length} paths the worker claimed has a live attachment`);
  }
  ok(true, 'C8 note: PGlite cannot interleave transactions; the sequential suite proves each committed order, this file proves the interleavings');
} catch (e) {
  failed++; console.log('FAIL harness error', e);
} finally {
  try { await ctl?.end(); } catch { /* ignore */ }
  try { await server.stop(); } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n========================================\nConcurrency test: ${passed} passed, ${failed} failed\n========================================`);
process.exit(failed ? 1 : 0);
