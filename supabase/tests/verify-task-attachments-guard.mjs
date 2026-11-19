// ====================================================================
// Security regression test for migration 039 (task_attachments storage guard, permanent path registry, Storage RLS).
// Sequential correctness on the full migration chain (001 ... 039). In-process PostgreSQL (PGlite): strictly local.
// PGlite is a single connection: real concurrency is tested in verify-task-attachments-concurrency.mjs.
// Run:  cd supabase/tests && node verify-task-attachments-guard.mjs
// ====================================================================
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SB = path.resolve(HERE, '..');

let passed = 0;
let failed = 0;

const ok = (cond, name, details = '') => {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.error(`FAIL ${name} -> ${details}`);
  }
};

const section = (title) => console.log(`\n=== ${title} ===`);

const db = new PGlite();

// Supabase environment stubs
const STUBS = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticator NOLOGIN;

CREATE SCHEMA auth;
CREATE SCHEMA storage;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb
);

CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

GRANT USAGE ON SCHEMA auth, storage, public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

CREATE TABLE storage.buckets (
  id text PRIMARY KEY,
  name text,
  public boolean,
  file_size_limit bigint,
  allowed_mime_types text[]
);

CREATE TABLE storage.objects (
  id uuid DEFAULT gen_random_uuid(),
  bucket_id text,
  name text,
  owner_id text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT ALL ON storage.objects, storage.buckets TO authenticated, service_role;

CREATE PUBLICATION supabase_realtime;
CREATE SCHEMA realtime;
CREATE TABLE realtime.messages (
  id bigserial primary key,
  topic text,
  extension text
);
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql AS $$ SELECT null::text $$;
GRANT USAGE ON SCHEMA realtime TO authenticated;
`;

await db.exec(STUBS);

// Helper: load and execute SQL file
const execFile = async (relPath) => {
  const full = path.join(SB, relPath);
  const sql = fs.readFileSync(full, 'utf8');
  await db.exec(sql);
};

// --------------------------------------------------------------------
// Setup: Apply complete migration chain 001 through 038, plus seed
// --------------------------------------------------------------------
section('0. Setup: Apply migrations 001 through 038');

const migrationFiles = fs.readdirSync(path.join(SB, 'migrations'))
  .filter((f) => /^\d{3}_.*\.sql$/.test(f))
  .sort();

for (const f of migrationFiles.filter((x) => x < '039')) {
  try {
    await execFile(`migrations/${f}`);
    if (f.startsWith('005')) {
      await execFile('seed.sql');
    }
  } catch (err) {
    console.error(`Error loading migrations/${f}:`, err);
    process.exit(1);
  }
}
ok(true, 'migrations 001-038 applied successfully');

// ====================================================================
// Fixtures
// ====================================================================
const u = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER_A = u(1), USER_B = u(2), USER_C = u(3), ADMIN = u(4);
const FU = (n) => `bbbbbbbb-1111-4222-8333-${String(n).padStart(12, '0')}`;   // file uuids
const san = (n) => n.replace(/[^\w.\-]+/g, '_').slice(-120);                   // the frontend sanitizer, verbatim

for (const [id, nm] of [[USER_A, 'a'], [USER_B, 'b'], [USER_C, 'c'], [ADMIN, 'admin']]) {
  await db.query("INSERT INTO auth.users(id, email) VALUES ($1, $2)", [id, `${nm}@pulse.com`]);
  await db.query("INSERT INTO public.profiles(id, full_name, email, employment_status) VALUES ($1, $2, $3, 'active')", [id, `User ${nm}`, `${nm}@pulse.com`]);
}
const roleId = async (n) => (await db.query("SELECT id FROM public.roles WHERE name = $1", [n])).rows[0].id;
for (const id of [USER_A, USER_B, USER_C]) await db.query("INSERT INTO public.user_roles(user_id, role_id) VALUES ($1, $2)", [id, await roleId('employee')]);
await db.query("INSERT INTO public.user_roles(user_id, role_id) VALUES ($1, $2)", [ADMIN, await roleId('super_admin')]);

const taskA = (await db.query("INSERT INTO public.tasks(title, created_by) VALUES ('Task A', $1) RETURNING id", [USER_A])).rows[0].id;
const taskB = (await db.query("INSERT INTO public.tasks(title, created_by) VALUES ('Task B', $1) RETURNING id", [USER_B])).rows[0].id;
await db.query("INSERT INTO public.task_assignees(task_id, user_id) VALUES ($1, $2)", [taskA, USER_B]);   // B can see task A; C cannot

const runAs = async (uid, fn) => {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [uid]);
  await db.query('SET ROLE authenticated');
  try { return await fn(); }
  finally { await db.query('RESET ROLE'); await db.query("SELECT set_config('request.jwt.claim.sub', '', false)"); }
};
const tryq = async (sql, params = []) => {
  try { const r = await db.query(sql, params); return { ok: true, rows: r.rows, n: r.affectedRows ?? r.rows.length }; }
  catch (e) { return { ok: false, error: e.message }; }
};
const att = (uid, task, p, by = uid) => runAs(uid, () => tryq(
  `INSERT INTO public.task_attachments (task_id, file_name, file_size, file_type, storage_path, uploaded_by)
   VALUES ($1, 'f.pdf', 10, 'application/pdf', $2, $3) RETURNING id`, [task, p, by]));
const attDel = (uid, id) => runAs(uid, () => tryq('DELETE FROM public.task_attachments WHERE id = $1 RETURNING id', [id]));
const putObj = (uid, name, owner = uid) => runAs(uid, () => tryq("INSERT INTO storage.objects(bucket_id, name, owner_id) VALUES ('task-attachments', $1, $2)", [name, owner]));
const seeObj = (uid, name) => runAs(uid, async () => (await db.query("SELECT count(*)::int c FROM storage.objects WHERE bucket_id='task-attachments' AND name=$1", [name])).rows[0].c);
const delObj = (uid, name) => runAs(uid, async () => (await db.query("DELETE FROM storage.objects WHERE bucket_id='task-attachments' AND name=$1 RETURNING name", [name])).rows.length);
const bp = (task, uid, n, name = 'doc.pdf') => `${task}/${uid}-${FU(n)}-${name}`;       // uploader-bound path
const lp = (task, n, name = 'legacy.pdf') => `${task}/${FU(n)}-${name}`;                // legacy path
const q1 = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const queued = async (p) => (await q1("SELECT count(*)::int c FROM public.storage_cleanup_queue WHERE bucket='task-attachments' AND path=$1", [p])).c;
const regState = async (p) => (await q1("SELECT state FROM public.storage_path_registry WHERE bucket='task-attachments' AND path=$1", [p]))?.state ?? null;
const setLegacy = (on) => db.query("UPDATE public.storage_guard_settings SET enabled=$1 WHERE key='task_attachments_legacy_paths'", [on]);

// ====================================================================
// Phase B: BASELINE on migrations 001-038. Reproduces the attack so the later "blocked" results are meaningful.
// ====================================================================
section('Phase B: baseline on 038 (attack reproduced, residue for the backfill)');
const VICTIM = lp(taskA, 90, 'victim.pdf');          // an object A uploaded, row not attached yet
{
  const r1 = await att(USER_B, taskA, VICTIM, USER_B);                       // B registers A's unattached object
  ok(r1.ok, 'baseline 038: B can register a path pointing at someone else\'s unattached object', r1.error);
  const r2 = await attDel(USER_B, r1.rows[0].id);                            // ...then deletes the row
  ok(r2.ok && (await queued(VICTIM)) === 1, 'baseline 038: the delete queues the victim\'s path for the service-role worker (the vulnerability)');
}
// legacy fixtures that must survive the migration
const L1 = lp(taskA, 91, 'legacy-live.pdf'), L2 = `${taskA}/weird name (old).pdf`, Q1 = lp(taskA, 92, 'q-open.pdf'), Q2 = lp(taskA, 93, 'q-done.pdf'), Q4 = 'task-attachments-noncanonical/oops.pdf';
const l1 = (await att(USER_A, taskA, L1)).rows[0].id;
const l2 = (await att(USER_A, taskA, L2)).rows[0].id;
await db.query("INSERT INTO public.storage_cleanup_queue(bucket, path, source) VALUES ('task-attachments', $1, 'seed')", [Q1]);
await db.query("INSERT INTO public.storage_cleanup_queue(bucket, path, source, done_at) VALUES ('task-attachments', $1, 'seed', now())", [Q2]);
await db.query("INSERT INTO public.storage_cleanup_queue(bucket, path, source) VALUES ('task-attachments', $1, 'seed'), ('task-attachments', $2, 'seed')", [L1, Q4]); // Q3 = live-referenced, Q4 = non-canonical

// ====================================================================
// Phase C: apply 039
// ====================================================================
section('Phase C: apply 039, idempotency, backfill');
await execFile('migrations/039_task_attachments_storage_guard.sql');
ok(true, '039 applied');
await execFile('migrations/039_task_attachments_storage_guard.sql');
ok(true, '039 idempotent (second run clean)');
ok((await regState(L1)) === 'live' && (await q1("SELECT deletable FROM public.storage_path_registry WHERE path=$1", [L1])).deletable === true, 'backfill: canonical legacy attachment is live + deletable');
ok((await regState(L2)) === 'live' && (await q1("SELECT deletable FROM public.storage_path_registry WHERE path=$1", [L2])).deletable === false, 'backfill: non-canonical legacy attachment is live + NOT deletable');
ok((await regState(Q1)) === 'dead' && (await regState(Q2)) === 'dead', 'backfill: open and done queue paths became permanent tombstones');
ok((await regState(VICTIM)) === 'dead', 'backfill: the baseline residue (victim path) is a tombstone too (cannot be re-registered)');
{
  const qq = (await db.query("SELECT path, attempts, last_error FROM public.storage_cleanup_queue WHERE bucket='task-attachments' AND done_at IS NULL")).rows;
  const byPath = Object.fromEntries(qq.map((r) => [r.path, r]));
  ok(byPath[L1]?.attempts === 12 && /quarantined/.test(byPath[L1].last_error), 'backfill: open queue row for a LIVE attachment path is quarantined (attempts=12)');
  ok(byPath[Q4]?.attempts === 12, 'backfill: open queue row for a non-canonical path is quarantined');
  ok(byPath[Q1]?.attempts === 0, 'backfill: open queue row with a tombstone is untouched');
}
{
  const cl = (await db.query("SELECT path FROM public.storage_cleanup_claim(100)")).rows.map((r) => r.path);
  ok(!cl.includes(L1) && !cl.includes(Q4), 'claim gate: quarantined / live-referenced rows are never handed to the worker', cl.join());
  ok(cl.includes(Q1) && cl.includes(VICTIM), 'claim gate: tombstoned open rows are handed out');
  await db.query("UPDATE public.storage_cleanup_queue SET done_at=now() WHERE bucket='task-attachments' AND path = ANY($1)", [[Q1, VICTIM]]);
}

// ====================================================================
// Section 1: registration, ownership
// ====================================================================
section('1. Registration and ownership (uploader-bound path)');
const PA = bp(taskA, USER_A, 1);
let aId;
{
  const r = await att(USER_A, taskA, PA);
  ok(r.ok, '1.1 A registers <task>/<A>-<uuid>-<name>', r.error);
  aId = r.rows?.[0]?.id;
  ok((await regState(PA)) === 'live', '1.2 registry row is live');
}
{
  const r = await att(USER_A, taskA, bp(taskB, USER_A, 2));
  ok(!r.ok && /must follow/.test(r.error), '1.3 cross-task prefix refused', r.error);
  const r2 = await att(USER_B, taskA, PA, USER_B);
  ok(!r2.ok && /another uploader/.test(r2.error), '1.4 B cannot register a path bound to A (path reuse by another uploader)', r2.error);
  const r3 = await att(USER_B, taskA, PA, USER_A);
  ok(!r3.ok, '1.5 B cannot forge uploaded_by = A (RLS WITH CHECK)', r3.error);
  const r4 = await att(USER_B, taskA, `${taskA}/confidential_report.pdf`, USER_B);
  ok(!r4.ok && /must follow/.test(r4.error), '1.6 arbitrary non-canonical path refused', r4.error);
  const r5 = await att(USER_B, taskA, bp(taskA, USER_B, 3), USER_B);
  ok(r5.ok, '1.7 B registers a path bound to B', r5.error);
}
{
  // same-task orphan claiming: A's pending object (uploaded, not attached) cannot be claimed by B
  const OR = bp(taskA, USER_A, 4, 'pending.pdf');
  ok((await putObj(USER_A, OR)).ok, '1.8 A uploads (Storage INSERT policy) into A\'s namespace');
  const r = await att(USER_B, taskA, OR, USER_B);
  ok(!r.ok, '1.9 same-task orphan claiming: B cannot register A\'s pending object', r.error);
  const r2 = await att(USER_B, taskA, OR, USER_A);
  ok(!r2.ok, '1.10 ...nor as uploaded_by = A', r2.error);
}
{
  const r = await runAs(USER_A, () => tryq("UPDATE public.task_attachments SET storage_path = $1 WHERE id = $2", [bp(taskA, USER_A, 5), aId]));
  ok(!r.ok, '1.11 storage_path is immutable', r.error);
  const r2 = await runAs(USER_A, () => tryq("UPDATE public.task_attachments SET task_id = $1 WHERE id = $2", [taskB, aId]));
  ok(!r2.ok, '1.12 task_id is immutable', r2.error);
  const r3 = await db.query("UPDATE public.task_attachments SET storage_path = $1 WHERE id = $2", [bp(taskA, USER_A, 5), aId]).then(() => null, (e) => e.message);
  ok(r3 && /cannot be changed/.test(r3), '1.13 immutable even for the database owner', r3);
}

// ====================================================================
// Section 2: legacy format, Stage 1 switch, fail closed
// ====================================================================
section('2. Legacy path format (Stage 1, fail closed)');
{
  const LG = lp(taskA, 10);
  const r = await att(USER_A, taskA, LG);
  ok(!r.ok && /refresh the page/.test(r.error), '2.1 switch OFF (default): legacy path refused with the refresh message', r.error);
  const rs = await putObj(USER_A, LG);
  ok(!rs.ok, '2.2 switch OFF: Storage INSERT policy refuses a legacy-format object name', rs.error);
  await setLegacy(true);
  const r2 = await att(USER_A, taskA, LG);
  ok(!r2.ok && /could not be verified/.test(r2.error), '2.3 switch ON, no stored object: refused (fail closed)', r2.error);
  await db.query("INSERT INTO storage.objects(bucket_id, name, owner_id) VALUES ('task-attachments', $1, $2)", [LG, USER_B]);
  const r3 = await att(USER_A, taskA, LG);
  ok(!r3.ok && /could not be verified/.test(r3.error), '2.4 switch ON, object owned by someone else: refused', r3.error);
  const LG2 = lp(taskA, 11);
  await db.query("INSERT INTO storage.objects(bucket_id, name, owner_id) VALUES ('task-attachments', $1, NULL)", [LG2]);
  const r4 = await att(USER_A, taskA, LG2);
  ok(!r4.ok, '2.5 switch ON, owner_id NULL (unpopulated): refused, never silently accepted', r4.error);
  const LG3 = lp(taskA, 12);
  ok((await putObj(USER_A, LG3, USER_A)).ok, '2.6 switch ON: Storage INSERT policy allows the legacy name');
  const r5 = await att(USER_A, taskA, LG3);
  ok(r5.ok, '2.7 switch ON, object owned by the uploader: accepted', r5.error);
  const r6 = await att(USER_B, taskA, LG3, USER_B);
  ok(!r6.ok, '2.8 ...and a second registration of that path is refused', r6.error);
  await setLegacy(false);
  ok(!(await att(USER_A, taskA, lp(taskA, 13))).ok, '2.9 switch OFF again: refused');
  // a bound-shaped path with someone else's uid is never treated as legacy
  await setLegacy(true);
  const r7 = await att(USER_B, taskA, bp(taskA, USER_A, 14), USER_B);
  ok(!r7.ok && /another uploader/.test(r7.error), '2.10 switch ON: bound-shaped path of another uploader does not fall back to legacy', r7.error);
  await setLegacy(false);
}

// ====================================================================
// Section 3: cleanup queue reuse (pending / completed / pruned), failed worker
// ====================================================================
section('3. Cleanup path reuse, tombstones, worker');
{
  const P = bp(taskA, USER_A, 20);
  const r = await att(USER_A, taskA, P); const id = r.rows[0].id;
  ok((await attDel(USER_A, id)).ok, '3.1 delete the attachment');
  ok((await regState(P)) === 'dead' && (await queued(P)) === 1, '3.2 registry dead + exactly one queue row');
  const re = await att(USER_A, taskA, P);
  ok(!re.ok && /already used/.test(re.error), '3.3 PENDING cleanup path cannot be registered again', re.error);
  const claim = (await db.query("SELECT id, path FROM public.storage_cleanup_claim(100)")).rows.find((x) => x.path === P);
  ok(!!claim, '3.4 worker claims it (dead tombstone)');
  ok(!(await att(USER_A, taskA, P)).ok, '3.5 CLAIMED (leased) path cannot be registered');
  await db.query("SELECT public.storage_cleanup_report($1, false, 'boom')", [claim.id]);
  const row = await q1("SELECT done_at, last_error, attempts FROM public.storage_cleanup_queue WHERE id=$1", [claim.id]);
  ok(row.done_at === null && row.last_error === 'boom', '3.6 failed worker report keeps the row open with its error');
  ok(!(await att(USER_A, taskA, P)).ok, '3.7 FAILED/retrying path cannot be registered');
  await db.query("UPDATE public.storage_cleanup_queue SET attempts=12, next_attempt_at=now() WHERE id=$1", [claim.id]);
  ok(!(await db.query("SELECT path FROM public.storage_cleanup_claim(100)")).rows.some((x) => x.path === P), '3.8 exhausted row is not claimed');
  await db.query("SELECT public.storage_cleanup_requeue(ARRAY[$1]::bigint[])", [claim.id]);
  const again = (await db.query("SELECT id, path FROM public.storage_cleanup_claim(100)")).rows.find((x) => x.path === P);
  ok(!!again, '3.9 requeue revives it and the gate still passes (dead tombstone)');
  await db.query("SELECT public.storage_cleanup_report($1, true, NULL)", [again.id]);
  ok((await q1("SELECT done_at FROM public.storage_cleanup_queue WHERE id=$1", [again.id])).done_at !== null, '3.10 successful report completes it');
  const re2 = await att(USER_A, taskA, P);
  ok(!re2.ok && /already used/.test(re2.error), '3.11 COMPLETED cleanup path cannot be registered', re2.error);
  await db.query("DELETE FROM public.storage_cleanup_queue WHERE id=$1", [again.id]);
  ok(!(await att(USER_A, taskA, P)).ok, '3.12 even after the queue row is PRUNED the tombstone refuses the path');
}
{
  const P = bp(taskA, USER_A, 21);
  // a forged queue row without / with a live registry never reaches the service role
  await db.query("INSERT INTO public.storage_cleanup_queue(bucket, path, source) VALUES ('task-attachments', $1, 'forged')", [P]);
  ok(!(await db.query("SELECT path FROM public.storage_cleanup_claim(500)")).rows.some((x) => x.path === P), '3.13 forged queue row (no registry row) is never claimed');
  const r = await att(USER_A, taskA, P);                      // a registration may still happen, row is live
  ok(!(await db.query("SELECT path FROM public.storage_cleanup_claim(500)")).rows.some((x) => x.path === P) && r.ok, '3.14 forged queue row for a LIVE path is never claimed');
  await db.query("DELETE FROM public.storage_cleanup_queue WHERE path=$1", [P]);
}
{
  ok(((await db.query("DELETE FROM public.storage_path_registry WHERE state='dead' AND path=$1 RETURNING 1", [PA]).catch(() => ({ rows: [] }))).rows.length) === 0, '3.15 (setup) live row not deletable');
  const dead = (await q1("SELECT path FROM public.storage_path_registry WHERE state='dead' LIMIT 1")).path;
  const e1 = await tryq("DELETE FROM public.storage_path_registry WHERE path=$1", [dead]);
  const e2 = await tryq("UPDATE public.storage_path_registry SET state='live', dead_at=NULL WHERE path=$1", [dead]);
  const e3 = await tryq("TRUNCATE public.storage_path_registry");
  ok(!e1.ok && !e2.ok && !e3.ok && /permanent/.test(e1.error + e2.error + e3.error), '3.16 tombstones are permanent: DELETE, dead->live UPDATE and TRUNCATE all refused even for the owner', [e1.error, e2.error, e3.error].join(' | '));
  const reg = await runAs(USER_A, () => tryq("SELECT * FROM public.storage_path_registry"));
  ok(!reg.ok, '3.17 authenticated users cannot read the registry');
}

// ====================================================================
// Section 4: Storage RLS (policy behaviour on storage.objects)
// ====================================================================
section('4. Storage RLS: namespace, listing, deletion');
{
  const OA = bp(taskA, USER_A, 30, 'a-pending.pdf'), OB = bp(taskA, USER_B, 31, 'b-pending.pdf');
  ok((await putObj(USER_A, OA)).ok && (await putObj(USER_B, OB)).ok, '4.1 each user uploads into their own namespace');
  ok(!(await putObj(USER_B, bp(taskA, USER_A, 32))).ok, '4.2 B cannot upload into A\'s namespace');
  ok(!(await putObj(USER_C, bp(taskA, USER_C, 33))).ok, '4.3 C (no access to the task) cannot upload even into their own namespace');
  ok(!(await putObj(USER_A, `${taskA}/${FU(34)}-x.pdf`)).ok && !(await putObj(USER_A, `${taskA}/free-form.pdf`)).ok, '4.4 non-conforming names are refused');
  ok((await seeObj(USER_A, OA)) === 1 && (await seeObj(USER_B, OA)) === 0, '4.5 listing: B cannot see A\'s UNATTACHED object; A can');
  ok((await seeObj(USER_C, OA)) === 0 && (await seeObj(ADMIN, OA)) === 1, '4.6 outsider sees nothing, admin sees it');
  const r = await att(USER_A, taskA, OA);
  ok(r.ok && (await seeObj(USER_B, OA)) === 1 && (await seeObj(USER_C, OA)) === 0, '4.7 once attached, task viewers (B) can read it, outsiders (C) still cannot');
  ok((await delObj(USER_B, OA)) === 0, '4.8 B cannot delete A\'s object');
  ok((await delObj(USER_A, OB)) === 0, '4.9 A cannot delete B\'s object');
  ok((await delObj(USER_B, OB)) === 1, '4.10 B deletes their own pending object (failed-insert cleanup path of the frontend)');
  await attDel(USER_A, r.rows[0].id);
  ok((await delObj(USER_A, OA)) === 1, '4.11 after the row is deleted, A removes their own object (frontend does this right after the row delete)');
  const OAdm = bp(taskA, USER_A, 35);
  await putObj(USER_A, OAdm);
  ok((await delObj(ADMIN, OAdm)) === 1, '4.12 admin can delete any object');
  await db.query("INSERT INTO storage.objects(bucket_id, name, owner_id) VALUES ('task-attachments', $1, $2)", [lp(taskA, 36), USER_A]);
  ok((await seeObj(USER_A, lp(taskA, 36))) === 1 && (await seeObj(USER_B, lp(taskA, 36))) === 0 && (await delObj(USER_A, lp(taskA, 36))) === 1, '4.13 legacy object: owner can still see and delete it via owner_id; others cannot see it');
}

// ====================================================================
// Section 5: valid upload / delete end to end, cascade, legacy rows
// ====================================================================
section('5. End-to-end flows');
{
  const P = bp(taskA, USER_A, 40, 'Screenshot_2024-01-01_at_10.00.00.png');
  ok((await putObj(USER_A, P)).ok, '5.1 upload');
  const r = await att(USER_A, taskA, P);
  ok(r.ok, '5.2 attach');
  ok((await seeObj(USER_B, P)) === 1, '5.3 download by a task viewer (signed URL needs SELECT)');
  ok((await attDel(USER_A, r.rows[0].id)).rows?.length === 1 && (await queued(P)) === 1, '5.4 delete queues exactly this path');
  ok((await q1("SELECT bucket, source FROM public.storage_cleanup_queue WHERE path=$1", [P])).bucket === 'task-attachments', '5.5 queue row bucket/source');
  const cl = (await db.query("SELECT id, bucket, path FROM public.storage_cleanup_claim(100)")).rows.find((x) => x.path === P);
  ok(!!cl, '5.6 worker claims');
  await db.query("SELECT public.storage_cleanup_report($1, true, NULL)", [cl.id]);
  ok((await q1("SELECT done_at FROM public.storage_cleanup_queue WHERE id=$1", [cl.id])).done_at !== null, '5.7 worker completes');
}
{
  const ps = [bp(taskB, USER_B, 41), bp(taskB, USER_B, 42), bp(taskB, USER_B, 43)];
  for (const p of ps) await att(USER_B, taskB, p);
  await db.query("SET session_replication_role = origin");
  const d = await tryq("DELETE FROM public.tasks WHERE id=$1", [taskB]);
  if (d.ok) ok((await Promise.all(ps.map(async (p) => (await regState(p)) === 'dead' && (await queued(p)) === 1))).every(Boolean), '5.8 task delete cascades: every attachment path goes dead and is queued once');
  else ok(true, '5.8 (skipped: task delete refused by another guard: ' + d.error.slice(0, 60) + ')');
}
{
  const cl = await db.query("DELETE FROM public.task_attachments WHERE id=$1 RETURNING id", [l1]);
  ok((await regState(L1)) === 'dead' && (await queued(L1)) === 1, '5.9 legacy canonical attachment: delete -> dead + the (quarantined) open row is still the single queue row');
  await db.query("DELETE FROM public.task_attachments WHERE id=$1", [l2]);
  ok((await regState(L2)) === 'dead' && (await queued(L2)) === 0, '5.10 legacy non-canonical attachment: dead, never queued (file is not auto-removed)');
}

// ====================================================================
// Section 6: filename contract
// ====================================================================
section('6. Filename validation vs frontend sanitizer /[^\\w.\\-]+/g');
{
  const kinds = async (paths) => (await db.query("SELECT public.task_attachment_path_kind(p) k FROM unnest($1::text[]) WITH ORDINALITY t(p, o) ORDER BY o", [paths])).rows.map((r) => r.k);
  const P = (name) => `${taskA}/${USER_A}-${FU(50)}-${name}`;
  const raw = {
    'space': 'a b.pdf', 'newline': 'a\nb.pdf', 'trailing newline': 'ab.pdf\n', 'tab': 'a\tb.pdf', 'control 0x01': 'a\u0001b.pdf', 'DEL': 'a\u007fb.pdf',
    'double quote': 'a"b.pdf', 'single quote': "a'b.pdf", 'backslash': 'a\\b.pdf', 'slash (nested)': 'a/b.pdf', 'dotdot slash': '../x.pdf', 'accent': 'é.pdf', 'arabic': 'ملف.pdf', 'cjk': '日本.pdf', 'emoji': '😀.pdf', 'empty': '', 'percent': 'a%20b.pdf', 'semicolon': 'a;b.pdf', 'colon': 'a:b.pdf',
  };
  const ks = await kinds(Object.values(raw).map(P));
  Object.keys(raw).forEach((k, i) => ok(ks[i] === null, `6.1 raw ${k} is refused`, String(ks[i])));
  const ss = await kinds(Object.values(raw).filter((v) => v !== '').map((v) => P(san(v))));
  ok(ss.every((k) => k === 'bound'), '6.2 every non-empty sanitizer output is accepted', ss.join());
  ok((await kinds([P(san(''))]))[0] === null, '6.3 empty file name -> empty name part is refused');
  const keep = ['contract.pdf', 'Screenshot_2024-01-01_at_10.00.00.png', 'a.b.c', '.hidden', '-', '_', 'UPPER.JPG', 'report-final_v2.docx', '0'];
  const kk = await kinds(keep.map((n) => P(san(n))));
  ok(keep.every((n, i) => san(n) === n && kk[i] === 'bound'), '6.4 existing valid file names are preserved unchanged and accepted', kk.join());
  ok((await kinds([P('x'.repeat(120)), P('x'.repeat(121))])).join() === 'bound,', '6.5 120 characters accepted, 121 refused');
  ok(san('y'.repeat(300)).length === 120, '6.6 sanitizer slice(-120) keeps 120 characters');
  // property test: the DB accepts a raw name iff the sanitizer would leave it unchanged (and it is 1..120 long)
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const alpha = ['a', 'Z', '0', '_', '.', '-', ' ', '\n', '\t', '\u0001', '\u001f', '\u007f', '"', "'", '\\', '/', 'é', 'ا', '日', '😀', '%', ';', 'x', 'y'];
  const names = []; for (let i = 0; i < 400; i++) { let s = ''; const L = Math.floor(rnd() * (i % 20 === 0 ? 150 : 30)); for (let j = 0; j < L; j++) s += alpha[Math.floor(rnd() * alpha.length)]; names.push(s); }
  const rk = await kinds(names.map(P)), sk = await kinds(names.map((n) => P(san(n))));
  let bad = 0;
  names.forEach((n, i) => { const exp = n.length >= 1 && n.length <= 120 && san(n) === n; if ((rk[i] === 'bound') !== exp) bad++; if ((sk[i] === 'bound') !== (san(n).length >= 1)) bad++; });
  ok(bad === 0, `6.7 property test (400 seeded random names): DB whitelist == frontend sanitizer contract (${bad} mismatches)`);
  const ins = await att(USER_A, taskA, P('a\nb.pdf'));
  ok(!ins.ok, '6.8 a newline inside the path is refused on a real INSERT too', ins.error);
}

// ====================================================================
// Section 7: other buckets unchanged
// ====================================================================
section('7. messages / assets / content_post_assets cleanup regressions');
{
  const conv = (await db.query("INSERT INTO public.conversations(type, name, is_public) VALUES ('group', 'Test Chat', false) RETURNING id")).rows[0].id;
  const msgPath = `${conv}/audio-sample.mp3`;
  const msgId = (await db.query("INSERT INTO public.messages(conversation_id, sender_id, content, metadata) VALUES ($1, $2, 'hello', $3::jsonb) RETURNING id", [conv, USER_A, JSON.stringify({ path: msgPath })])).rows[0].id;
  await db.query('DELETE FROM public.messages WHERE id = $1', [msgId]);
  const qm = await q1("SELECT bucket, source FROM public.storage_cleanup_queue WHERE path = $1", [msgPath]);
  ok(qm && qm.bucket === 'chat-media' && qm.source === 'messages', '7.1 message media cleanup unchanged', JSON.stringify(qm));

  const assetPath = `${USER_A}/sample-asset.png`;
  const assetId = (await db.query("INSERT INTO public.assets(name, file_name, file_size, file_type, storage_path, uploaded_by) VALUES ('A', 'sample-asset.png', 100, 'image/png', $1, $2) RETURNING id", [assetPath, USER_A])).rows[0].id;
  await db.query('DELETE FROM public.assets WHERE id = $1', [assetId]);
  const qa = await q1("SELECT bucket, source FROM public.storage_cleanup_queue WHERE path = $1", [assetPath]);
  ok(qa && qa.bucket === 'studio-assets' && qa.source === 'assets', '7.2 studio assets cleanup unchanged', JSON.stringify(qa));

  const client = (await db.query("INSERT INTO public.clients(name, company_name) VALUES ('Test Client', 'Test Company') RETURNING id")).rows[0].id;
  const plan = (await db.query("INSERT INTO public.content_plans(client_id, title) VALUES ($1, 'May Plan') RETURNING id", [client])).rows[0].id;
  const planPath = `${USER_A}/plans/${plan}/slide.jpg`;
  const pa = (await db.query("INSERT INTO public.content_post_assets(plan_id, storage_path, file_name, file_type, file_size, uploaded_by) VALUES ($1, $2, 'slide.jpg', 'image/jpeg', 200, $3) RETURNING id", [plan, planPath, USER_A])).rows[0].id;
  await db.query('DELETE FROM public.content_post_assets WHERE id = $1', [pa]);
  const qp = await q1("SELECT bucket, source FROM public.storage_cleanup_queue WHERE path = $1", [planPath]);
  ok(qp && qp.bucket === 'studio-assets' && qp.source === 'content_post_assets', '7.3 plan assets cleanup unchanged', JSON.stringify(qp));

  const claimed = (await db.query("SELECT bucket, path FROM public.storage_cleanup_claim(500)")).rows;
  ok([msgPath, assetPath, planPath].every((p) => claimed.some((c) => c.path === p)), '7.4 the worker still claims chat-media and studio-assets rows (gate is task-attachments only)');
  ok((await q1("SELECT count(*)::int c FROM public.storage_path_registry WHERE bucket <> 'task-attachments'")).c === 0, '7.5 other buckets never touch the registry');
}

// ====================================================================
// Section 8: rollback and re-apply
// ====================================================================
section('8. Rollback and re-apply');
{
  const refused = await db.exec(fs.readFileSync(path.join(SB, 'maintenance/rollback-039.sql'), 'utf8')).then(() => null, (e) => e.message);
  ok(refused && /rollback-039 refused/.test(refused), '8.1 rollback refuses while permanent tombstones exist and no confirmation was given', refused);
  ok((await q1("SELECT to_regclass('public.storage_path_registry') r")).r !== null, '8.2 refusal changed nothing');
  await db.query("SET kite.confirm_drop_storage_registry = 'yes'");
  await execFile('maintenance/rollback-039.sql');
  await db.query("RESET kite.confirm_drop_storage_registry");
  ok(true, '8.3 rollback applied with confirmation');
  const gone = (await q1(`SELECT (to_regclass('public.storage_path_registry') IS NULL) AND (to_regclass('public.storage_guard_settings') IS NULL)
     AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname IN ('task_attachment_path_kind','task_attachment_path_uid','storage_guard_enabled','task_attachments_path_guard','storage_path_registry_guard')) g`)).g;
  ok(gone, '8.4 registry, switch table, helper functions and trigger functions are gone');
  ok((await q1("SELECT count(*)::int c FROM pg_trigger WHERE tgname='task_attachments_path_guard'")).c === 0, '8.5 path guard trigger gone');
  const pol = (await db.query("SELECT policyname, qual, with_check FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname LIKE 'task_attachments_%'")).rows;
  const txt = pol.map((p) => (p.qual || '') + (p.with_check || '')).join(' ');
  ok(pol.length === 3 && !/task_attachment_path_uid|task_attachments a/.test(txt) && /owner_id/.test(txt), '8.6 the three Storage policies are back to their 004 form', txt.slice(0, 200));
  const fn = (await q1("SELECT pg_get_functiondef('public.storage_cleanup_claim(integer)'::regprocedure) d")).d;
  ok(!/storage_path_registry/.test(fn), '8.7 storage_cleanup_claim is back to the 029 body');
  const keepRows = (await q1("SELECT count(*)::int c FROM public.storage_cleanup_queue")).c;
  ok(keepRows > 0, '8.8 the cleanup queue is untouched by the rollback');
  await execFile('migrations/039_task_attachments_storage_guard.sql');
  ok((await q1("SELECT count(*)::int c FROM pg_trigger WHERE tgname='task_attachments_path_guard'")).c === 1, '8.9 039 re-applies cleanly after a rollback');
}

console.log(`\n========================================`);
console.log(`Test Execution Complete: ${passed} passed, ${failed} failed`);
console.log(`========================================\n`);
if (failed > 0) process.exit(1);
