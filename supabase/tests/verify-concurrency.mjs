// Real-PostgreSQL concurrency test for the "last active super_admin" invariant (migrations 020 + 023).
// PGlite (used by verify-rls.mjs / verify-roles.mjs) is a single connection and cannot test concurrency, so this
// script starts a throwaway real PostgreSQL server (embedded-postgres, local port, temp directory, no network after
// the one-time binary download) and races two genuine connections.
//
// Optional dependencies (NOT in package.json on purpose, they download a PostgreSQL binary):
//   npm install --no-save embedded-postgres pg
//   node verify-concurrency.mjs
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

let passed = 0, failed = 0; const failures = [];
const ok = (c, name, d = '') => { if (c) passed++; else { failed++; failures.push(name + (d ? ' :: ' + d : '')); console.log('FAIL', name, d); } };
const section = (s) => console.log('\n== ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-pg-'));
const PORT = 54000 + Math.floor(Math.random() * 900);
const server = new EmbeddedPostgres({ databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'pw', port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
const connect = async (db = 'kite') => { const c = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'pw', database: db }); await c.connect(); return c; };
let ctl;
try {
  await server.initialise(); await server.start(); await server.createDatabase('kite');
  ctl = await connect();
  const ver = (await ctl.query('SHOW server_version')).rows[0].server_version;
  console.log('real PostgreSQL ' + ver + ' on port ' + PORT);

  await ctl.query(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, raw_user_meta_data jsonb);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`);
  const sql = (f) => fs.readFileSync(path.join(SB, f), 'utf8');
  await ctl.query(sql('migrations/001_initial_schema.sql'));
  await ctl.query(sql('seed.sql'));
  await ctl.query(sql('migrations/020_atomic_role_replace.sql'));
  const roleId = async (n) => (await ctl.query('SELECT id FROM public.roles WHERE name=$1', [n])).rows[0].id;
  const SA = await roleId('super_admin'), EMP = await roleId('employee');

  let seq = 0;
  const mkUser = async (active = true, role = SA) => {
    const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
    await ctl.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [id, id + '@x.test']);
    await ctl.query('INSERT INTO public.profiles(id,full_name,email,employment_status) VALUES ($1,$2,$3,$4)', [id, 'u' + seq, id + '@x.test', active ? 'active' : 'suspended']);
    await ctl.query('INSERT INTO public.user_roles(user_id,role_id) VALUES ($1,$2)', [id, role]);
    return id;
  };
  // fixtures are reset with triggers off (session_replication_role), as an operator would
  const reset = async () => {
    await ctl.query(`SET session_replication_role = replica; DELETE FROM public.user_roles; DELETE FROM public.profiles; DELETE FROM auth.users; SET session_replication_role = origin;`);
  };
  const activeSuperAdmins = async () => (await ctl.query(`SELECT count(*)::int c FROM public.user_roles ur JOIN public.roles r ON r.id=ur.role_id AND r.name='super_admin' AND r.is_active JOIN public.profiles p ON p.id=ur.user_id AND p.employment_status='active'`)).rows[0].c;

  const OPS = {
    suspend: (c, id) => c.query(`UPDATE public.profiles SET employment_status='suspended' WHERE id=$1`, [id]),
    delete_profile: (c, id) => c.query(`DELETE FROM public.profiles WHERE id=$1`, [id]),
    delete_auth_user: (c, id) => c.query(`DELETE FROM auth.users WHERE id=$1`, [id]),   // what GoTrue's deleteUser does; cascades to profiles and user_roles
    demote: (c, id) => c.query(`SELECT public.replace_user_role($1,$2,$1)`, [id, EMP]),
    delete_role_row: (c, id) => c.query(`DELETE FROM public.user_roles WHERE user_id=$1`, [id]),
  };
  // the Edge Functions' own pre-check ("is another active super_admin there?"), as a plain query
  const othersActive = async (c, id) => (await c.query(`SELECT count(*)::int c FROM public.user_roles ur JOIN public.roles r ON r.id=ur.role_id AND r.name='super_admin' JOIN public.profiles p ON p.id=ur.user_id AND p.employment_status='active' WHERE ur.user_id<>$1`, [id])).rows[0].c;

  // Deterministic interleaving of two real connections:
  //   T1: BEGIN, pre-check, change A (not yet committed)      T2: BEGIN, pre-check, change B
  //   T2's change is started while T1 is still open; T1 then commits; T2 finishes.
  const race = async (op1, op2) => {
    await reset();
    const a = await mkUser(), b = await mkUser();
    const c1 = await connect(), c2 = await connect();
    const out = { t1: 'ok', t2: 'ok', blocked: false };
    try {
      await c1.query('BEGIN'); await c2.query('BEGIN');
      const p1 = await othersActive(c1, a), p2 = await othersActive(c2, b);   // both see "one other active"
      if (!(p1 === 1 && p2 === 1)) throw new Error('precondition: both pre-checks should pass');
      await OPS[op1](c1, a);                       // T1 changes A, uncommitted
      const t2 = OPS[op2](c2, b).then(() => 'ok', (e) => e.message);   // T2 changes B concurrently
      // is T2 waiting behind T1?
      for (let i = 0; i < 30 && !out.blocked; i++) {
        await sleep(100);
        out.blocked = (await ctl.query(`SELECT count(*)::int c FROM pg_locks WHERE locktype='advisory' AND NOT granted`)).rows[0].c > 0;
        if (await Promise.race([t2.then(() => true), sleep(0).then(() => false)])) break;
      }
      await c1.query('COMMIT');
      out.t2 = await t2;
      if (out.t2 === 'ok') await c2.query('COMMIT'); else await c2.query('ROLLBACK');
    } finally { await c1.end(); await c2.end(); }
    out.active = await activeSuperAdmins();
    return out;
  };

  section('1. WITHOUT migration 023: the race is real (two checks pass, both changes commit)');
  for (const [o1, o2] of [['suspend', 'suspend'], ['suspend', 'delete_profile'], ['delete_profile', 'delete_profile'], ['delete_auth_user', 'suspend']]) {
    const r = await race(o1, o2);
    ok(r.active === 0 && r.t2 === 'ok', `before 023: ${o1} || ${o2} leaves ${r.active} active super_admins (expected 0 = bug reproduced)`, JSON.stringify(r));
  }
  {
    // migration 020's role-replace function already serialized two concurrent demotions with a row lock
    const r = await race('demote', 'demote');
    ok(r.active === 1, 'before 023: demote || demote was already safe thanks to the row lock in replace_user_role (020)', JSON.stringify(r));
  }

  await ctl.query(sql('migrations/023_last_super_admin_guard.sql'));
  await ctl.query(sql('migrations/023_last_super_admin_guard.sql')); // idempotent

  section('2. WITH migration 023: every pair of concurrent removals keeps one active super_admin');
  for (const o1 of Object.keys(OPS)) for (const o2 of Object.keys(OPS)) {
    const r = await race(o1, o2);
    ok(r.active === 1, `${o1} || ${o2}: exactly one active super_admin remains`, JSON.stringify(r));
    ok(/last_super_admin/.test(r.t2), `${o1} || ${o2}: the second request is refused with last_super_admin`, JSON.stringify(r));
    ok(r.blocked, `${o1} || ${o2}: the second request really waited for the first (serialized)`, JSON.stringify(r));
  }

  section('3. WITH 023: no over-blocking');
  {
    await reset();
    const a = await mkUser(), b = await mkUser(), c = await mkUser();
    const c1 = await connect(), c2 = await connect();
    await c1.query('BEGIN'); await c2.query('BEGIN');
    await OPS.suspend(c1, a);
    const t2 = OPS.suspend(c2, b).then(() => 'ok', (e) => e.message);
    await sleep(300); await c1.query('COMMIT'); const r2 = await t2; await c2.query(r2 === 'ok' ? 'COMMIT' : 'ROLLBACK');
    await c1.end(); await c2.end();
    ok(r2 === 'ok' && (await activeSuperAdmins()) === 1, 'with three active super_admins, two concurrent removals both succeed and one remains', r2);
    const last = await connect();
    let e = ''; try { await OPS.suspend(last, c); } catch (x) { e = x.message; } await last.end();
    ok(/last_super_admin/.test(e) && (await activeSuperAdmins()) === 1, 'the remaining one then cannot be removed');
  }
  {
    await reset(); const a = await mkUser(), b = await mkUser(false);
    const cx = await connect(); let e = '';
    try { await OPS.suspend(cx, a); } catch (x) { e = x.message; } await cx.end();
    ok(/last_super_admin/.test(e), 'a suspended second super_admin does not count: the only ACTIVE one is protected');
    await reset(); const i = await mkUser(false), o = await mkUser();
    const cy = await connect(); let e2 = 'ok';
    try { await OPS.delete_profile(cy, i); } catch (x) { e2 = x.message; } await cy.end();
    ok(e2 === 'ok', 'removing an already-inactive super_admin is allowed');
  }

  section('4. WITH 023: non-super_admin operations are untouched; replace_user_role keeps the same row');
  {
    await reset(); const sa = await mkUser(), emp = await mkUser(true, EMP);
    await ctl.query(`UPDATE public.profiles SET employment_status='suspended' WHERE id=$1`, [emp]);
    await ctl.query(`DELETE FROM public.profiles WHERE id=$1`, [emp]);
    ok((await activeSuperAdmins()) === 1, 'suspending and deleting an ordinary employee works');
    const before = (await ctl.query(`SELECT id FROM public.user_roles WHERE user_id=$1`, [sa])).rows[0].id;
    await ctl.query(`SELECT public.replace_user_role($1,$2,$1)`, [sa, SA]);
    const after = (await ctl.query(`SELECT id FROM public.user_roles WHERE user_id=$1`, [sa])).rows[0].id;
    ok(before === after && (await activeSuperAdmins()) === 1, 're-assigning super_admin to the sole super_admin keeps the row (no delete, no refusal)');
    let e = ''; try { await ctl.query(`SELECT public.replace_user_role($1,$2,$1)`, [sa, EMP]); } catch (x) { e = x.message; }
    ok(/last_super_admin/.test(e) && (await activeSuperAdmins()) === 1, 'demoting the sole super_admin through replace_user_role is refused');
    let e2 = ''; try { await ctl.query(`UPDATE public.roles SET is_active=false WHERE name='super_admin'`); } catch (x) { e2 = x.message; }
    ok(/last_super_admin/.test(e2), 'deactivating the super_admin role itself is refused while one is active');
    let e3 = ''; try { await ctl.query(`DELETE FROM public.roles WHERE name='super_admin'`); } catch (x) { e3 = x.message; }
    ok(e3 !== '' && (await activeSuperAdmins()) === 1, 'deleting the super_admin role is refused');
    await ctl.query(`UPDATE public.roles SET description='x' WHERE name='super_admin'`);
    await ctl.query(`UPDATE public.user_roles SET assigned_by=NULL WHERE user_id=$1`, [sa]);
    ok(true, 'harmless updates (description, assigned_by) are not blocked');
  }

  section('5. WITH 023: randomized stress (real connections, no artificial barrier)');
  {
    let violations = 0, refused = 0, rounds = 40;
    const names = ['suspend', 'delete_profile', 'demote', 'delete_role_row'];
    for (let i = 0; i < rounds; i++) {
      await reset(); const ids = [await mkUser(), await mkUser(), await mkUser()];
      const conns = await Promise.all(ids.map(() => connect()));
      const results = await Promise.all(ids.map(async (id, k) => {
        const op = names[Math.floor(Math.random() * names.length)];
        await sleep(Math.floor(Math.random() * 15));
        try { await conns[k].query('BEGIN'); await OPS[op](conns[k], id); await sleep(Math.floor(Math.random() * 20)); await conns[k].query('COMMIT'); return 'ok'; }
        catch (e) { await conns[k].query('ROLLBACK').catch(() => {}); return e.message; }
      }));
      await Promise.all(conns.map((c) => c.end()));
      refused += results.filter((r) => /last_super_admin/.test(r)).length;
      if ((await activeSuperAdmins()) < 1) violations++;
    }
    ok(violations === 0, `${rounds} rounds of 3 concurrent removals among 3 super_admins: never fewer than one active (${refused} requests correctly refused)`, 'violations=' + violations);
  }
} catch (e) {
  ok(false, 'test run completed', e.stack?.split('\n').slice(0, 3).join(' | '));
} finally {
  try { await ctl?.end(); } catch { /* */ }
  try { await server.stop(); } catch { /* */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:\n - ' + failures.join('\n - ')); process.exit(1); }
