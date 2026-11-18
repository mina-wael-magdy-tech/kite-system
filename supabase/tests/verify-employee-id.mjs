// Employee ID hotfix (migration 038), on a real local PostgreSQL.   cd supabase/tests && npm run test:employee-id
// Throwaway embedded-postgres in a temp dir; never touches any remote database.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SB = path.resolve(HERE, '..');
const ROOT = path.resolve(SB, '..');
let EmbeddedPostgres, pg;
try { EmbeddedPostgres = (await import('embedded-postgres')).default; pg = (await import('pg')).default; }
catch { console.log('SKIPPED: install the optional dependencies first:  npm install --no-save embedded-postgres pg'); process.exit(0); }
let passed = 0, failed = 0;
const ok = (c, name, d = '') => { if (c) passed++; else { failed++; console.log('FAIL', name, d); } };
const section = (s) => console.log('\n== ' + s);
const sql = (f) => fs.readFileSync(path.join(SB, f), 'utf8');
const STUBS = /const STUBS = `([\s\S]*?)`;/.exec(fs.readFileSync(path.join(HERE, 'verify-integrity.mjs'), 'utf8'))[1];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-emp-'));
const PORT = 57600 + Math.floor(Math.random() * 300);
const server = new EmbeddedPostgres({ databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'pw', port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
const conns = [];
const connect = async (db = 'kite') => { const c = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'pw', database: db }); await c.connect(); c.on('error', () => {}); conns.push(c); return c; };
const err = async (c, q, p = []) => { try { await c.query(q, p); return null; } catch (e) { return e; } };
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const newUser = async (c) => { const id = uuid(); await c.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [id, `u${n}@x.test`]); return id; };
const newProfile = async (c) => { const id = await newUser(c); await c.query('INSERT INTO public.profiles(id,full_name,email) VALUES ($1,$2,$3)', [id, `User ${n}`, `u${n}@x.test`]); return (await c.query('SELECT employee_id FROM public.profiles WHERE id=$1', [id])).rows[0].employee_id; };
const setSeq = (c, v) => c.query("SELECT setval('public.employee_id_seq', $1, true)", [v]);

try {
  await server.initialise(); await server.start();
  const c0 = await connect('postgres'); await c0.query(`CREATE DATABASE kite ENCODING 'UTF8' TEMPLATE template0 LOCALE 'C'`);
  const db = await connect(); await db.query(STUBS);
  const files = fs.readdirSync(path.join(SB, 'migrations')).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  for (const f of files.filter((x) => x < '038')) { await db.query(sql('migrations/' + f)); if (f.startsWith('005')) await db.query(sql('seed.sql')); }
  await db.query('GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role');

  section('0. before 038: the defect, on real PostgreSQL');
  const seqBefore = (await db.query("SELECT column_default d FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='employee_id'")).rows[0].d;
  ok(/lpad/i.test(seqBefore) && /3/.test(seqBefore), 'the column default is the LPAD(..., 3) expression', seqBefore);
  const legacy = [];
  for (let i = 0; i < 5; i++) legacy.push(await newProfile(db));
  ok(legacy.join() === 'EMP-001,EMP-002,EMP-003,EMP-004,EMP-005', 'existing format for small numbers', legacy.join());
  await setSeq(db, 997);
  const a = await newProfile(db), b = await newProfile(db), c1 = await newProfile(db);
  ok(a === 'EMP-998' && b === 'EMP-999', 'IDs 998 and 999 are fine', `${a} ${b}`);
  ok(c1 === 'EMP-100', 'the 1000th ID is truncated to EMP-100 (the bug)', c1);
  const dup = await err(db, 'INSERT INTO public.profiles(id,full_name,email) VALUES ($1,$2,$3)', [await newUser(db), 'Dup', 'dup@x.test']);
  ok(dup && dup.code === '23505', 'the next insert collides with the truncated ID (unique violation): employee creation fails', dup?.message);
  // the failed insert consumed a sequence value; remember the state to prove nothing existing changes
  const snap = async () => (await db.query("SELECT md5(string_agg(id::text || ':' || employee_id, ',' ORDER BY id)) h, count(*)::int c FROM public.profiles")).rows[0];
  const before = await snap();

  section('1. apply 038 (twice): existing IDs are untouched');
  await db.query(sql('migrations/038_employee_id_format.sql'));
  ok(await err(db, sql('migrations/038_employee_id_format.sql')) === null, '038 can be applied a second time');
  const after = await snap();
  ok(before.h === after.h && before.c === after.c, 'every existing employee_id is byte-for-byte unchanged (including the truncated EMP-100)');
  ok((await db.query("SELECT count(*)::int c FROM public.profiles WHERE employee_id = 'EMP-100'")).rows[0].c === 1, 'the legacy EMP-100 is still there, not rewritten');
  const col = (await db.query("SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='employee_id'")).rows[0];
  ok(col.data_type === 'text' && col.is_nullable === 'YES', 'column type and nullability unchanged (text, nullable)');
  ok((await db.query("SELECT count(*)::int c FROM pg_constraint WHERE conrelid='public.profiles'::regclass AND contype='u' AND pg_get_constraintdef(oid) LIKE '%employee_id%'")).rows[0].c === 1, 'the UNIQUE constraint on employee_id is still in place');
  ok(!(await db.query("SELECT column_default d FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='employee_id'")).rows[0].d.match(/lpad/i), 'the LPAD default is gone');

  section('2. the formatter: boundaries, no truncation');
  const fmt = async (v) => (await db.query('SELECT public.format_employee_id($1::bigint) f', [v])).rows[0].f;
  const cases = [[1, 'EMP-001'], [9, 'EMP-009'], [10, 'EMP-010'], [99, 'EMP-099'], [100, 'EMP-100'], [998, 'EMP-998'], [999, 'EMP-999'], [1000, 'EMP-1000'], [1001, 'EMP-1001'], [9999, 'EMP-9999'], [10000, 'EMP-10000'], [123456789, 'EMP-123456789']];
  for (const [v, want] of cases) ok(await fmt(v) === want, `format_employee_id(${v}) = ${want}`, await fmt(v));
  ok((await db.query('SELECT public.format_employee_id(NULL) f')).rows[0].f === null, 'NULL in, NULL out');
  ok((await db.query("SELECT provolatile, proisstrict FROM pg_proc WHERE oid='public.format_employee_id(bigint)'::regprocedure")).rows[0].provolatile === 'i', 'the formatter is IMMUTABLE and writes nothing');

  section('3. generation across the 998 / 999 / 1000 / 1001 boundary (the real default)');
  await setSeq(db, 5000);
  const gen = [];
  for (let i = 0; i < 3; i++) gen.push(await newProfile(db));
  ok(gen.join() === 'EMP-5001,EMP-5002,EMP-5003', 'generated IDs continue past 999 without truncation', gen.join());
  // exact boundary on a fresh database state: use a second database with an empty profiles table
  await c0.query(`CREATE DATABASE kite2 ENCODING 'UTF8' TEMPLATE template0 LOCALE 'C'`);
  const d2 = await connect('kite2'); await d2.query(STUBS.replace(/CREATE ROLE [^;]*;/g, ''));
  for (const f of files.filter((x) => x < '038')) { await d2.query(sql('migrations/' + f)); if (f.startsWith('005')) await d2.query(sql('seed.sql')); }
  await d2.query(sql('migrations/038_employee_id_format.sql'));
  await setSeq(d2, 996);
  const edge = [];
  for (let i = 0; i < 6; i++) edge.push(await newProfile(d2));
  ok(edge.join() === 'EMP-997,EMP-998,EMP-999,EMP-1000,EMP-1001,EMP-1002', 'EMP-997 ... EMP-1002: three digits up to 999, then four digits', edge.join());
  ok((await d2.query('SELECT count(DISTINCT employee_id)::int c, count(*)::int t FROM public.profiles')).rows[0].c === 6, 'no collisions across the boundary');
  await setSeq(d2, 9998);
  const e2 = [await newProfile(d2), await newProfile(d2)];
  ok(e2.join() === 'EMP-9999,EMP-10000', 'EMP-9999 then EMP-10000', e2.join());

  section('4. concurrent employee creation around the boundary');
  await c0.query(`CREATE DATABASE kite3 ENCODING 'UTF8' TEMPLATE template0 LOCALE 'C'`);
  const d3 = await connect('kite3'); await d3.query(STUBS.replace(/CREATE ROLE [^;]*;/g, ''));
  for (const f of files.filter((x) => x < '038')) { await d3.query(sql('migrations/' + f)); if (f.startsWith('005')) await d3.query(sql('seed.sql')); }
  await d3.query(sql('migrations/038_employee_id_format.sql'));
  await setSeq(d3, 990);
  const W = 12, PER = 60;
  const workers = await Promise.all(Array.from({ length: W }, async () => { const c = await connect('kite3'); return c; }));
  // pre-create users sequentially (their ids), then insert profiles in parallel: the default (sequence) must not collide
  const plan = [];
  for (let w = 0; w < W; w++) { const ids = []; for (let i = 0; i < PER; i++) { const id = `10000000-0000-4000-8000-${String(w * 1000 + i).padStart(12, '0')}`; ids.push(id); } plan.push(ids); }
  await d3.query(`INSERT INTO auth.users(id,email) SELECT ('10000000-0000-4000-8000-'||lpad((w*1000+i)::text,12,'0'))::uuid, 'c'||w||'_'||i||'@x.test' FROM generate_series(0,${W - 1}) w, generate_series(0,${PER - 1}) i`);
  const errors = [];
  await Promise.all(workers.map(async (c, w) => { for (let i = 0; i < PER; i++) { const e = await err(c, 'INSERT INTO public.profiles(id,full_name,email) VALUES ($1,$2,$3)', [plan[w][i], `C${w}-${i}`, `c${w}_${i}@x.test`]); if (e) errors.push(e.message); } }));
  ok(errors.length === 0, `${W} concurrent sessions x ${PER} inserts: no error`, errors[0]);
  const gen2 = (await d3.query("SELECT employee_id FROM public.profiles WHERE email LIKE 'c%\\_%@x.test' ESCAPE '\\'")).rows.map((r) => r.employee_id);
  ok(gen2.length === W * PER && new Set(gen2).size === gen2.length, `${gen2.length} concurrent employees, all IDs distinct`);
  const nums = gen2.map((s) => Number(s.slice(4))).sort((x, y) => x - y);
  ok(nums[0] === 991 && nums.at(-1) === 990 + W * PER && nums.every((v, i) => v === 991 + i), 'the numbers are exactly 991..1710, contiguous: nothing skipped, nothing repeated', `${nums[0]}..${nums.at(-1)}`);
  ok(gen2.every((s) => /^EMP-\d{3,}$/.test(s)) && gen2.filter((s) => s.length === 8).length === gen2.filter((s) => Number(s.slice(4)) >= 1000).length && gen2.some((s) => s === 'EMP-999') && gen2.some((s) => s === 'EMP-1000'), 'IDs below 1000 keep three digits, from 1000 on four or more, across the boundary');

  section('5. the sequence never hands out a number that already exists');
  await d2.query("INSERT INTO auth.users(id,email) VALUES ('20000000-0000-4000-8000-000000000001','m@x.test')");
  await d2.query("INSERT INTO public.profiles(id,full_name,email,employee_id) VALUES ('20000000-0000-4000-8000-000000000001','Manual','m@x.test','EMP-90000')");
  await d2.query(sql('migrations/038_employee_id_format.sql'));
  const afterManual = await newProfile(d2);
  ok(afterManual === 'EMP-90001', 'a hand-typed higher ID moves the sequence forward when 038 is (re)applied', afterManual);
  await setSeq(d2, 95000);
  await d2.query(sql('migrations/038_employee_id_format.sql'));
  ok((await d2.query('SELECT last_value FROM public.employee_id_seq')).rows[0].last_value == 95000, 'the sequence is never moved backwards');
  ok(await newProfile(d2) === 'EMP-95001', 'and keeps counting from where it was');
  // an explicit value is still accepted, and a duplicate is still refused
  const dupExplicit = await err(d2, "INSERT INTO public.profiles(id,full_name,email,employee_id) VALUES ($1,'X',$2,'EMP-90000')", [await newUser(d2), 'x2@x.test']);
  ok(dupExplicit?.code === '23505', 'an explicit duplicate is still refused by UNIQUE');

  section('6. rollback: refused when it would be unsafe, allowed when it is not');
  const mkdb = async (name) => {
    await c0.query(`CREATE DATABASE ${name} ENCODING 'UTF8' TEMPLATE template0 LOCALE 'C'`);
    const c = await connect(name); await c.query(STUBS.replace(/CREATE ROLE [^;]*;/g, ''));
    for (const f of files.filter((x) => x < '038')) { await c.query(sql('migrations/' + f)); if (f.startsWith('005')) await c.query(sql('seed.sql')); }
    await c.query(sql('migrations/038_employee_id_format.sql'));
    return c;
  };
  const state = async (c) => ({
    def: (await c.query("SELECT column_default d FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='employee_id'")).rows[0].d,
    fn: (await c.query("SELECT to_regprocedure('public.format_employee_id(bigint)')::text f")).rows[0].f,
    seq: JSON.stringify((await c.query('SELECT last_value, is_called FROM public.employee_id_seq')).rows[0]),
    ids: (await c.query("SELECT md5(coalesce(string_agg(id::text||employee_id, ',' ORDER BY id), '')) h FROM public.profiles")).rows[0].h,
  });
  const same = (x, y) => x.def === y.def && x.fn === y.fn && x.seq === y.seq && x.ids === y.ids;
  // node-pg sends the file as one query: after the exception the session sits in the aborted transaction (psql ends it at COMMIT); end it here
  const rollback = async (c) => { const e = await err(c, sql('maintenance/rollback-038.sql')); if (e) await c.query('ROLLBACK'); return e; };

  // A. an ID above 999 exists (the main database of this test has EMP-1000 ... and a sequence far past 999)
  const sA = await state(d2);
  const eA = await rollback(d2);
  ok(eA && /rollback-038 refused/.test(eA.message) && /above 999/.test(eA.message) && /Keep migration 038/.test(eA.message), 'IDs above 999 exist: the rollback is refused with a clear message', eA?.message);
  ok(/EMP-95\d{3}|EMP-9\d{4}/.test(eA?.message ?? ''), 'the message names the highest offending ID', eA?.message);
  ok(same(sA, await state(d2)), 'the refused rollback left the default, formatter, sequence and every employee ID unchanged');
  ok(!/lpad/i.test((await state(d2)).def) && (await state(d2)).fn !== null, 'so the 038 default and the formatter are still active');

  // B. all IDs <= 999 and the sequence is low: the rollback succeeds
  const d4 = await mkdb('kite4');
  const made = []; for (let i = 0; i < 5; i++) made.push(await newProfile(d4));
  ok(made.join() === 'EMP-001,EMP-002,EMP-003,EMP-004,EMP-005', 'setup: five employees with IDs below 1000');
  const sB = await state(d4);
  ok(await rollback(d4) === null, 'IDs all <= 999 and sequence low: the rollback succeeds');
  const sB2 = await state(d4);
  ok(/lpad/i.test(sB2.def) && sB2.fn === null, 'the original default is restored and the formatter is dropped');
  ok(sB2.ids === sB.ids && sB2.seq === sB.seq, 'no employee ID was modified and the sequence was not reset or rewound');
  ok(await rollback(d4) === null, 'the rollback can be run again (nothing left to undo)');
  await d4.query(sql('migrations/038_employee_id_format.sql'));
  ok(!/lpad/i.test((await state(d4)).def) && (await state(d4)).fn !== null, 'applying 038 again after the rollback restores the formatter and default');
  ok(await newProfile(d4) === 'EMP-006', 'and the next employee continues at EMP-006');

  // C. one hand-typed EMP-1000 with a low sequence: refused (the ID check alone is enough)
  await d4.query("INSERT INTO auth.users(id,email) VALUES ('30000000-0000-4000-8000-000000000001','big@x.test')");
  await d4.query("INSERT INTO public.profiles(id,full_name,email,employee_id) VALUES ('30000000-0000-4000-8000-000000000001','Big','big@x.test','EMP-1000')");
  const sC = await state(d4);
  const eC = await rollback(d4);
  ok(eC && /EMP-1000/.test(eC.message) && /1 employee ID/.test(eC.message), 'a single EMP-1000 blocks the rollback and is named', eC?.message);
  ok(same(sC, await state(d4)), '... leaving everything unchanged');
  const eLead = await (async () => { await d4.query("UPDATE public.profiles SET employee_id='EMP-01000' WHERE id='30000000-0000-4000-8000-000000000001'"); const e = await rollback(d4); await d4.query("UPDATE public.profiles SET employee_id='EMP-1000' WHERE id='30000000-0000-4000-8000-000000000001'"); return e; })();
  ok(eLead && /refused/.test(eLead.message), 'a zero-padded EMP-01000 is still a number above 999 and blocks the rollback');

  // D. no ID above 999, but the sequence is already past 998: refused (the next insert would truncate and collide)
  const d5 = await mkdb('kite5');
  await newProfile(d5);
  await setSeq(d5, 999);
  const sD = await state(d5);
  const eD = await rollback(d5);
  ok(eD && /next employee ID number would be 1000/.test(eD.message), 'sequence at 999: the next ID would be 1000, so the rollback is refused', eD?.message);
  ok(same(sD, await state(d5)), '... leaving everything unchanged');
  await setSeq(d5, 998);
  ok(await rollback(d5) === null, 'sequence at 998 (next ID is 999): the rollback is allowed');
  ok(await newProfile(d5) === 'EMP-999', 'and the restored default still produces EMP-999 correctly');
  ok((await d5.query('SELECT last_value FROM public.employee_id_seq')).rows[0].last_value == 999, 'the sequence is exactly where it was');
  await d5.query(sql('migrations/038_employee_id_format.sql'));
  ok(await newProfile(d5) === 'EMP-1000', 'after re-applying 038 the next employee is EMP-1000');

  section('7. the application: nothing assumes three digits');
  const jsFiles = []; const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(js|mjs|html)$/.test(f.name)) jsFiles.push(p); } };
  walk(path.join(ROOT, 'js'));
  const refs = jsFiles.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').map((l, i) => ({ f: path.relative(ROOT, f), i: i + 1, l })).filter((x) => /employee_id|EMP-/.test(x.l)));
  ok(refs.length >= 3, `employee_id is referenced in the frontend (${refs.length} places)`);
  const risky = refs.filter((x) => /(slice|substr|substring|padStart|padEnd|\.length|match\(|test\(|\\d\{3\}|maxlength|width)/.test(x.l.replace(/PROFILE_COLUMNS/g, '')));
  ok(risky.length === 0, 'no frontend line slices, pads, measures or pattern-matches an employee ID', risky.map((x) => `${x.f}:${x.i}`).join(' '));
  const emp = fs.readFileSync(path.join(ROOT, 'js/modules/employees/employees.js'), 'utf8');
  const badge = /<span class="badge badge-slate font-mono">\$\{emp\.employee_id \|\| 'EMP'\}<\/span>/.test(emp);
  ok(badge, 'the employee card prints the ID as it is (no formatting)');
  const render = (emp_) => `<span class="badge badge-slate font-mono">${emp_.employee_id || 'EMP'}</span>`;
  ok(render({ employee_id: 'EMP-1000' }).includes('EMP-1000') && render({ employee_id: 'EMP-10000' }).includes('EMP-10000') && render({ employee_id: 'EMP-001' }).includes('EMP-001'), 'four- and five-digit IDs display in full');
  const css = fs.readFileSync(path.join(ROOT, 'css/components.css'), 'utf8');
  const badgeRule = /\.badge\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
  ok(badgeRule && !/(?<![-a-z])(width|max-width)\s*:/.test(badgeRule), 'the badge style has no fixed width that could cut a longer ID', badgeRule.replace(/\s+/g, ' '));
  const others = ['supabase/functions', 'integrations'].flatMap((d) => { const out = []; const w = (p) => { for (const f of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, f.name); if (f.isDirectory()) { if (f.name !== 'node_modules' && f.name !== 'vendor') w(q); } else if (/\.(ts|php)$/.test(f.name) && /employee_id/.test(fs.readFileSync(q, 'utf8'))) out.push(q); } }; w(path.join(ROOT, d)); return out; });
  ok(others.length === 0, 'no Edge Function or Kite Drive code reads or writes employee_id', others.join());
  ok(!/employee_id/.test(sql('migrations/002_rls_policies.sql').replace(/GRANT SELECT \(id, employee_id,/, '')), 'RLS and column grants only list the column; they do not constrain its format');
} catch (e) {
  failed++; console.log('FATAL', e.stack || e.message);
} finally {
  for (const c of conns) { try { await c.end(); } catch { /* */ } }
  try { await server.stop(); } catch { /* */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
