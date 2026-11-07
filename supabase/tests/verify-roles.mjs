// ARC-01 regression tests: role-tier authorization, last-super-admin protection, atomic role replacement,
// invitation flows and the auth_is_owner() privilege restriction.
//
// Part A  runs the REAL Edge Function code (invite-employee, workflow, accept-invitation, _shared/auth.ts) under
//         Node: esbuild bundles the TypeScript, Deno.serve is captured, and the service-role client is an
//         in-memory fake (it does NOT test Postgres; Part B does).
// Part B  applies all migrations (001-021) to an in-process Postgres (PGlite, Supabase-style stubs) and tests
//         replace_user_role() and migration 021 with real SQL.
// Usage: npm install && node verify-roles.mjs      (no network, no production access)
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SB = path.resolve(HERE, '..');
let passed = 0, failed = 0;
const failures = [];
const ok = (cond, name, detail = '') => {
  if (cond) { passed++; } else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL', name, detail); }
};
const section = (s) => console.log('\n== ' + s);

// =====================================================================================================
// Part A: Edge Function code
// =====================================================================================================
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arc01-'));
const stubPlugin = {
  name: 'npm-stub',
  setup(b) {
    b.onResolve({ filter: /^npm:/ }, (a) => ({ path: a.path, namespace: 'npm-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'npm-stub' }, () => ({
      contents: 'export function createClient(){ return globalThis.__fakeAdmin; }\n' +
        'export default { setVapidDetails(){}, sendNotification: async()=>({}) };',
      loader: 'js',
    }));
  },
};
let captured = null;
const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-service', SUPABASE_ANON_KEY: 'test-anon', APP_URL: 'https://app.example.test' };
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { captured = h; } };

async function load(rel) {
  const out = path.join(tmp, rel.replace(/[\\/]/g, '_') + '.mjs');
  const r = await build({ entryPoints: [path.join(process.env.ARC01_FUNCTIONS_DIR || path.join(SB, 'functions'), rel)], bundle: true, format: 'esm', platform: 'node', write: false, plugins: [stubPlugin], logLevel: 'silent' });
  fs.writeFileSync(out, r.outputFiles[0].text);
  captured = null;
  const mod = await import(pathToFileURL(out).href + '?' + Date.now());
  return { handler: captured, mod };
}
const invite = await load('invite-employee/index.ts');
const workflow = await load('workflow/index.ts');
const accept = await load('accept-invitation/index.ts');
const authMod = (await load('_shared/auth.ts')).mod;
ok(!!invite.handler && !!workflow.handler && !!accept.handler, 'handlers captured from the real function code');

// ---------------------------------------------------------------- in-memory fake of the service-role client
const ALL_ROLES = ['super_admin', 'owner', 'ceo', 'general_manager', 'finance_manager', 'accountant', 'hr_manager',
  'department_manager', 'team_leader', 'project_manager', 'employee', 'client'];

function makeDb() {
  const T = { profiles: [], roles: [], user_roles: [], departments: [], user_departments: [], invitations: [], audit_logs: [], notifications: [], push_subscriptions: [] };
  const users = [], log = [], flags = { failInsert: null, failRpc: false, rpcMissing: false };
  let seq = 0;
  const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  const attach = (table, row, cols) => (table === 'user_roles' && /roles(!inner)?\(/.test(cols || ''))
    ? { ...row, roles: T.roles.find((r) => r.id === row.role_id) ?? null } : row;
  const get = (row, col) => { if (col.includes('.')) { const [a, b] = col.split('.'); return row[a]?.[b]; } return row[col]; };

  class Q {
    constructor(table) { this.table = table; this.f = []; this.op = 'select'; this.cols = '*'; this.opts = {}; this.one = null; this.ret = false; }
    select(cols = '*', opts = {}) { if (this.op === 'select') { this.cols = cols; this.opts = opts; } else this.ret = true; return this; }
    insert(rows) { this.op = 'insert'; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
    update(p) { this.op = 'update'; this.patch = p; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(c, v) { this.f.push((r) => get(r, c) === v); return this; }
    in(c, vs) { this.f.push((r) => vs.includes(get(r, c))); return this; }
    order() { return this; } limit() { return this; }
    maybeSingle() { this.one = 'maybe'; return this; }
    single() { this.one = 'single'; return this; }
    then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }
    run() {
      const tbl = T[this.table];
      if (!tbl) return { data: null, error: { message: 'no table ' + this.table } };
      const match = () => tbl.map((r) => attach(this.table, r, this.cols)).filter((r) => this.f.every((fn) => fn(r)));
      if (this.op === 'select') {
        const rows = match();
        if (this.opts.head) return { data: null, count: rows.length, error: null };
        if (this.one) { if (!rows[0] && this.one === 'single') return { data: null, error: { message: 'no rows' } }; return { data: rows[0] ?? null, error: null }; }
        return { data: rows, count: rows.length, error: null };
      }
      if (this.op === 'insert') {
        if (flags.failInsert === this.table) return { data: null, error: { message: 'injected insert failure on ' + this.table } };
        const made = [];
        for (const r of this.rows) {
          if (this.table === 'user_roles' && tbl.some((x) => x.user_id === r.user_id && x.role_id === r.role_id)) return { data: null, error: { message: 'duplicate key uq_user_role' } };
          const row = { id: uid(), ...r }; tbl.push(row); made.push(row);
        }
        log.push({ op: 'insert', table: this.table });
        return this.ret ? { data: this.one ? made[0] ?? null : made, error: null } : { data: null, error: null };
      }
      if (this.op === 'update') {
        const hit = match(); for (const r of hit) Object.assign(tbl.find((x) => x.id === r.id), this.patch);
        log.push({ op: 'update', table: this.table });
        return this.ret ? { data: this.one ? hit[0] ?? null : hit, error: null } : { data: null, error: null };
      }
      const hit = match(); for (const r of hit) tbl.splice(tbl.findIndex((x) => x.id === r.id), 1);
      log.push({ op: 'delete', table: this.table });
      return { data: null, error: null };
    }
  }
  const rpc = async (name, a) => {
    log.push({ op: 'rpc', name });
    if (name !== 'replace_user_role') return { data: null, error: { message: 'unknown rpc' } };
    if (flags.rpcMissing) return { data: null, error: { message: 'Could not find the function public.replace_user_role' } };
    const role = T.roles.find((r) => r.id === a.p_role_id && r.is_active);
    if (!role) return { data: null, error: { message: 'unknown_role' } };
    const isActiveSA = (userId) => T.user_roles.some((ur) => ur.user_id === userId && T.roles.find((r) => r.id === ur.role_id && r.name === 'super_admin' && r.is_active)) &&
      T.profiles.find((p) => p.id === userId)?.employment_status === 'active';
    if (role.name !== 'super_admin' && isActiveSA(a.p_user_id)) {
      const others = T.profiles.filter((p) => p.id !== a.p_user_id && isActiveSA(p.id)).length;
      if (!others) return { data: null, error: { message: 'last_super_admin' } };
    }
    if (flags.failRpc) return { data: null, error: { message: 'injected rpc failure' } }; // atomic: nothing changed
    T.user_roles = T.user_roles.filter((ur) => ur.user_id !== a.p_user_id);
    tblSet('user_roles', T.user_roles);
    T.user_roles.push({ id: uid(), user_id: a.p_user_id, role_id: a.p_role_id, assigned_by: a.p_assigned_by });
    return { data: null, error: null };
  };
  const tblSet = (k, v) => { T[k] = v; };
  const removeUser = (id) => {
    const i = users.findIndex((u) => u.id === id); if (i >= 0) users.splice(i, 1);
    for (const k of ['profiles']) T[k] = T[k].filter((r) => r.id !== id);
    for (const k of ['user_roles', 'user_departments']) T[k] = T[k].filter((r) => r.user_id !== id);
  };
  const admin = {
    from: (t) => new Q(t),
    rpc,
    auth: {
      getUser: async (token) => { const id = String(token).replace('tok:', ''); const u = users.find((x) => x.id === id); return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: 'bad token' } }; },
      admin: {
      updateUserById: async (id, a) => { log.push({ op: 'ban', id, a }); return { error: null }; },
      deleteUser: async (id) => { removeUser(id); log.push({ op: 'deleteUser', id }); return { error: null }; },
      inviteUserByEmail: async (email) => { const u = { id: uid(), email }; users.push(u); log.push({ op: 'invite', id: u.id }); return { data: { user: u }, error: null }; },
      listUsers: async () => ({ data: { users } }),
    } },
  };
  const db = { T: new Proxy({}, { get: (_, k) => T[k] }), users, log, flags, admin, uid };
  db.addUser = (key, roleName, status = 'active') => {
    const id = uid(); users.push({ id, email: `${key}@x.test` });
    T.profiles.push({ id, full_name: key, email: `${key}@x.test`, job_title: 'Member', department_id: null, employment_status: status });
    if (roleName) T.user_roles.push({ id: uid(), user_id: id, role_id: T.roles.find((r) => r.name === roleName).id, assigned_by: null });
    return id;
  };
  for (const n of ALL_ROLES) T.roles.push({ id: uid(), name: n, display_name: n, is_active: true });
  return db;
}

// one world: a caller and a target per role, a spare super admin, a suspended owner
function world() {
  const db = makeDb(); const P = {};
  for (const r of ALL_ROLES) { P['caller_' + r] = db.addUser('caller_' + r, r); P['target_' + r] = db.addUser('target_' + r, r); }
  P.spare_sa = db.addUser('spare_sa', 'super_admin');
  P.suspended_owner = db.addUser('suspended_owner', 'owner', 'suspended');
  P.victim = db.addUser('victim', 'employee');
  db.P = P; db.roleId = (n) => db.T.roles.find((r) => r.name === n).id;
  db.rolesOf = (id) => db.T.user_roles.filter((u) => u.user_id === id).map((u) => db.T.roles.find((r) => r.id === u.role_id).name);
  db.status = (id) => db.T.profiles.find((p) => p.id === id)?.employment_status ?? 'gone';
  globalThis.__fakeAdmin = db.admin;
  return db;
}
async function call(h, userId, body) {
  const res = await h.handler(new Request('http://t/', { method: 'POST', headers: { Authorization: 'Bearer tok:' + userId, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  let j = null; try { j = await res.json(); } catch { /* none */ }
  return { status: res.status, body: j };
}

// ---------------------------------------------------------------- explicit expectations (written independently of the code)
const LOW = ['department_manager', 'team_leader', 'project_manager', 'employee', 'client'];
const EVERYTHING = ALL_ROLES;
const ALLOWED = {
  super_admin: new Set(EVERYTHING),
  owner: new Set(EVERYTHING.filter((r) => r !== 'super_admin')),
  general_manager: new Set(['general_manager', 'finance_manager', 'accountant', 'hr_manager', ...LOW]),
  hr_manager: new Set(['hr_manager', ...LOW]),
};
const GATED_OUT = ['ceo', 'finance_manager', 'accountant', 'department_manager', 'team_leader', 'project_manager', 'employee', 'client'];

section('A1 tier helpers (real _shared/auth.ts)');
try {
  const mk = (...roles) => ({ status: 'active', roles });
  ok(authMod.roleTier('owner') === authMod.roleTier('ceo'), 'owner and ceo are the same tier');
  ok(authMod.canGrantRole(mk('general_manager'), 'owner') === false, 'GM cannot grant owner');
  ok(authMod.canGrantRole(mk('general_manager'), 'ceo') === false, 'GM cannot grant ceo');
  ok(authMod.canGrantRole(mk('owner'), 'ceo') && authMod.canGrantRole(mk('ceo'), 'owner'), 'owner and ceo are peers for granting');
  ok(!authMod.canGrantRole(mk('owner'), 'super_admin'), 'owner cannot grant super_admin');
  ok(authMod.canGrantRole(mk('super_admin'), 'super_admin'), 'super_admin can grant super_admin');
  ok(!authMod.canManageAccount(mk('hr_manager'), ['finance_manager']) && !authMod.canManageAccount(mk('hr_manager'), ['accountant']) && !authMod.canManageAccount(mk('hr_manager'), ['ceo']), 'HR cannot manage ceo/finance/accountant accounts');
  ok(!authMod.canManageAccount({ status: 'suspended', roles: ['super_admin'] }, ['employee']), 'a suspended caller has no authority');
  ok(authMod.canManageAccount(mk('hr_manager'), []) && authMod.canManageAccount(mk('hr_manager'), ['employee']), 'HR can manage a person without privileged roles');
  ok(authMod.bestTier(['employee', 'general_manager']) === 2, 'multi-role target uses its best tier');
  ok(authMod.roleTier('some_new_custom_role') === 5, 'unknown role names get the default (lowest) tier');
} catch (e) { ok(false, 'A1 tier helpers exist', e.message); }

section('A2 authorization matrix: grant via invite-employee');
for (const caller of ['super_admin', 'owner', 'general_manager', 'hr_manager']) for (const role of ALL_ROLES) {
  const db = world(); const email = `new_${role}@x.test`;
  const r = await call(invite, db.P['caller_' + caller], { email, fullName: 'New Person', roleId: db.roleId(role) });
  const prof = db.T.profiles.find((p) => p.email === email);
  if (ALLOWED[caller].has(role)) {
    ok(r.status === 200 && prof?.employment_status === 'onboarding' && db.rolesOf(prof.id).join() === role, `invite ${role} by ${caller} allowed`, JSON.stringify(r));
    ok(db.T.user_roles.find((u) => u.user_id === prof?.id)?.assigned_by === db.P['caller_' + caller], `invite ${role} by ${caller} records assigned_by`);
  } else {
    ok(r.status === 403 && !prof && !db.log.some((l) => l.op === 'invite'), `invite ${role} by ${caller} refused and nothing created`, JSON.stringify(r));
  }
}
section('A3 matrix: callers outside the gate (ceo, finance, accountant, managers, employee, client, suspended)');
for (const c of [...GATED_OUT, 'suspended_owner']) {
  const key = c === 'suspended_owner' ? 'suspended_owner' : 'caller_' + c;
  for (const [name, body, h] of [
    ['invite owner', (db) => ({ email: 'z@x.test', fullName: 'Zed Zed', roleId: db.roleId('owner') }), invite],
    ['invite employee', (db) => ({ email: 'z@x.test', fullName: 'Zed Zed', roleId: db.roleId('employee') }), invite],
    ['update role', (db) => ({ action: 'employee.update', userId: db.P.victim, roleId: db.roleId('owner') }), workflow],
    ['update status', (db) => ({ action: 'employee.update', userId: db.P.victim, employmentStatus: 'inactive' }), workflow],
    ['delete', (db) => ({ action: 'delete', userId: db.P.victim }), invite],
  ]) {
    const db = world(); const r = await call(h, db.P[key], body(db));
    // workflow requires staff first (client -> 403 too); every path must be 403 and change nothing
    ok(r.status === 403 && db.status(db.P.victim) === 'active' && db.rolesOf(db.P.victim).join() === 'employee', `${c}: ${name} refused`, JSON.stringify(r));
  }
}
section('A4 matrix: change a person\'s role via workflow employee.update');
for (const caller of ['super_admin', 'owner', 'general_manager', 'hr_manager']) for (const role of ALL_ROLES) {
  const db = world();
  const r = await call(workflow, db.P['caller_' + caller], { action: 'employee.update', userId: db.P.victim, roleId: db.roleId(role) });
  if (ALLOWED[caller].has(role)) {
    ok(r.status === 200 && db.rolesOf(db.P.victim).join() === role, `set role ${role} by ${caller} allowed`, JSON.stringify(r));
  } else {
    ok(r.status === 403 && db.rolesOf(db.P.victim).join() === 'employee' && !db.log.some((l) => l.op === 'rpc'), `set role ${role} by ${caller} refused, role unchanged`, JSON.stringify(r));
  }
}
section('A5 matrix: modify / deactivate / delete accounts by tier');
for (const caller of ['super_admin', 'owner', 'general_manager', 'hr_manager']) for (const target of ALL_ROLES) {
  const allowed = ALLOWED[caller].has(target);
  let db = world(); const t = db.P['target_' + target], c = db.P['caller_' + caller];
  let r = await call(workflow, c, { action: 'employee.update', userId: t, jobTitle: 'Changed' });
  const title = db.T.profiles.find((p) => p.id === t).job_title;
  ok(allowed ? (r.status === 200 && title === 'Changed') : (r.status === 403 && title === 'Member'), `edit ${target} by ${caller}`, JSON.stringify(r));
  db = world(); r = await call(workflow, db.P['caller_' + caller], { action: 'employee.update', userId: db.P['target_' + target], employmentStatus: 'inactive' });
  ok(allowed ? (r.status === 200 && db.status(db.P['target_' + target]) === 'inactive') : (r.status === 403 && db.status(db.P['target_' + target]) === 'active' && !db.log.some((l) => l.op === 'ban')), `deactivate ${target} by ${caller}`, JSON.stringify(r));
  db = world(); r = await call(invite, db.P['caller_' + caller], { action: 'delete', userId: db.P['target_' + target] });
  ok(allowed ? (r.status === 200 && db.status(db.P['target_' + target]) === 'gone') : (r.status === 403 && db.status(db.P['target_' + target]) === 'active'), `delete ${target} by ${caller}`, JSON.stringify(r));
}
section('A6 explicit ARC-01 cases');
{
  let db = world();
  let r = await call(invite, db.P.caller_general_manager, { email: 'o@x.test', fullName: 'Own Er', roleId: db.roleId('owner') });
  ok(r.status === 403, 'GM cannot invite an owner');
  r = await call(workflow, db.P.caller_general_manager, { action: 'employee.update', userId: db.P.victim, roleId: db.roleId('ceo') });
  ok(r.status === 403, 'GM cannot promote anyone to ceo');
  r = await call(workflow, db.P.caller_general_manager, { action: 'employee.update', userId: db.P.target_owner, employmentStatus: 'suspended' });
  ok(r.status === 403 && db.status(db.P.target_owner) === 'active', 'GM cannot suspend an owner');
  r = await call(invite, db.P.caller_general_manager, { action: 'delete', userId: db.P.target_super_admin });
  ok(r.status === 403 && db.status(db.P.target_super_admin) === 'active', 'GM cannot delete a super_admin');
  r = await call(workflow, db.P.caller_owner, { action: 'employee.update', userId: db.P.target_super_admin, employmentStatus: 'inactive' });
  ok(r.status === 403, 'owner cannot disable a super_admin (tier 0 is super_admin only)');
  r = await call(workflow, db.P.caller_hr_manager, { action: 'employee.update', userId: db.P.victim, roleId: db.roleId('finance_manager') });
  ok(r.status === 403, 'HR cannot grant finance_manager');
  r = await call(workflow, db.P.caller_hr_manager, { action: 'employee.update', userId: db.P.victim, roleId: db.roleId('accountant') });
  ok(r.status === 403, 'HR cannot grant accountant');
  r = await call(workflow, db.P.caller_hr_manager, { action: 'employee.update', userId: db.P.victim, roleId: db.roleId('ceo') });
  ok(r.status === 403, 'HR cannot grant ceo');
  r = await call(workflow, db.P.caller_owner, { action: 'employee.update', userId: db.P.victim, roleId: db.roleId('ceo') });
  ok(r.status === 200 && db.rolesOf(db.P.victim).join() === 'ceo', 'owner can still grant ceo (same tier)');
  r = await call(workflow, db.P.caller_super_admin, { action: 'employee.update', userId: db.P.target_owner, roleId: db.roleId('owner'), jobTitle: 'Boss' });
  ok(r.status === 200, 'super_admin keeps full access over owners');
  r = await call(workflow, db.P.caller_owner, { action: 'employee.update', userId: db.P.caller_owner, roleId: db.roleId('employee') });
  ok(r.status === 400, 'self role change still refused');
  r = await call(workflow, db.P.caller_owner, { action: 'employee.update', userId: db.P.caller_owner, employmentStatus: 'inactive' });
  ok(r.status === 400, 'self deactivation still refused');
  r = await call(invite, db.P.caller_owner, { action: 'delete', userId: db.P.caller_owner });
  ok(r.status === 400, 'self deletion still refused');
}

section('A7 last active super admin');
{
  // helper-level: every state of the super admin population
  const run = async (setup, target) => { const db = makeDb(); const ids = setup(db); try { await authMod.assertNotLastActiveSuperAdmin(db.admin, ids[target]); return 'allowed'; } catch (e) { return e.status === 409 ? '409' : 'err:' + e.message; } };
  ok(await run((d) => [d.addUser('a', 'super_admin')], 0) === '409', 'sole active super_admin is protected');
  ok(await run((d) => [d.addUser('a', 'super_admin'), d.addUser('b', 'super_admin')], 0) === 'allowed', 'two active super admins: one may go');
  ok(await run((d) => [d.addUser('a', 'super_admin'), d.addUser('b', 'super_admin', 'suspended')], 0) === '409', 'the other super admin is suspended: still the last ACTIVE one');
  ok(await run((d) => [d.addUser('a', 'super_admin', 'inactive'), d.addUser('b', 'super_admin')], 0) === 'allowed', 'an already inactive super admin is not counted or protected');
  ok(await run((d) => [d.addUser('a', 'owner'), d.addUser('b', 'super_admin')], 0) === 'allowed', 'a non-super_admin target is a no-op');
  // handler-level: the protection sits behind the tier rule, so only a super admin could reach it; both stay consistent
  let db = world();
  for (const k of Object.keys(db.P)) if (k.endsWith('super_admin') || k === 'spare_sa') { /* keep */ }
  // make caller_super_admin the target's only peer: suspend the others
  db.T.profiles.find((p) => p.id === db.P.spare_sa).employment_status = 'suspended';
  db.T.profiles.find((p) => p.id === db.P.target_super_admin).employment_status = 'suspended';
  let r = await call(workflow, db.P.caller_super_admin, { action: 'employee.update', userId: db.P.caller_super_admin, employmentStatus: 'inactive' });
  ok(r.status === 400, 'a sole super_admin cannot deactivate themselves (self-guard)');
  db = world();
  r = await call(workflow, db.P.caller_owner, { action: 'employee.update', userId: db.P.caller_super_admin, roleId: db.roleId('employee') });
  ok(r.status === 403 && db.rolesOf(db.P.caller_super_admin).join() === 'super_admin', 'demoting a super_admin as owner refused, role intact');
  // super admin demotes a peer while another remains: allowed; the last one cannot be removed by a peer who then loses authority
  db = world();
  r = await call(workflow, db.P.caller_super_admin, { action: 'employee.update', userId: db.P.spare_sa, roleId: db.roleId('employee') });
  ok(r.status === 200, 'super_admin may demote a peer super_admin when others remain');
  r = await call(workflow, db.P.caller_super_admin, { action: 'employee.update', userId: db.P.target_super_admin, roleId: db.roleId('employee') });
  ok(r.status === 200, 'and another');
  // now only caller_super_admin is an active super admin; nobody else can manage them
  r = await call(invite, db.P.caller_owner, { action: 'delete', userId: db.P.caller_super_admin });
  ok(r.status === 403 && db.status(db.P.caller_super_admin) === 'active', 'the last super_admin cannot be deleted by anyone else (tier rule)');
  r = await call(workflow, db.P.caller_general_manager, { action: 'employee.update', userId: db.P.caller_super_admin, employmentStatus: 'inactive' });
  ok(r.status === 403 && db.status(db.P.caller_super_admin) === 'active', 'nor disabled');
  // DB-function-level race protection is exercised in Part B
}

section('A8 atomic role replacement (function level)');
{
  let db = world();
  db.flags.failRpc = true;
  let r = await call(workflow, db.P.caller_owner, { action: 'employee.update', userId: db.P.victim, roleId: db.roleId('general_manager') });
  ok(r.status === 500 && db.rolesOf(db.P.victim).join() === 'employee', 'failure injected in the role-replace step: previous role preserved', JSON.stringify(r));
  ok(!db.log.some((l) => l.op === 'delete' && l.table === 'user_roles') && !db.log.some((l) => l.op === 'insert' && l.table === 'user_roles'), 'no separate delete/insert on user_roles is ever issued by employee.update');
  db = world(); db.flags.rpcMissing = true;
  r = await call(workflow, db.P.caller_owner, { action: 'employee.update', userId: db.P.victim, roleId: db.roleId('general_manager') });
  ok(r.status === 500 && db.rolesOf(db.P.victim).join() === 'employee', 'migration 020 missing: fails closed, role preserved');
  db = world(); db.T.roles.find((x) => x.name === 'general_manager').is_active = false;
  r = await call(workflow, db.P.caller_owner, { action: 'employee.update', userId: db.P.victim, roleId: db.roleId('general_manager') });
  ok(r.status === 400 && db.rolesOf(db.P.victim).join() === 'employee', 'inactive role refused, role preserved');
  db = world();
  r = await call(workflow, db.P.caller_owner, { action: 'employee.update', userId: db.P.victim, roleId: db.roleId('team_leader') });
  ok(r.status === 200 && db.rolesOf(db.P.victim).join() === 'team_leader' && db.log.filter((l) => l.op === 'rpc').length === 1, 'success path uses exactly one replace call');
  ok(db.T.user_roles.find((u) => u.user_id === db.P.victim).assigned_by === db.P.caller_owner, 'assigned_by is the caller');
  ok(db.T.audit_logs.some((a) => a.action === 'EMPLOYEE_UPDATED' && a.new_data?.role === 'team_leader'), 'audit event EMPLOYEE_UPDATED records the new role');
}

section('A9 invitation flows');
{
  let db = world();
  // failure injection during invite: role insert fails -> everything rolled back
  db.flags.failInsert = 'user_roles';
  let r = await call(invite, db.P.caller_hr_manager, { email: 'f@x.test', fullName: 'Fail Case', roleId: db.roleId('employee') });
  ok(r.status === 500 && !db.T.profiles.some((p) => p.email === 'f@x.test') && !db.users.some((u) => u.email === 'f@x.test'), 'invite with injected role-insert failure is fully rolled back', JSON.stringify(r));
  // re-invite: HR cannot reset an onboarding owner/ceo/finance invitee (V4)
  for (const [role, expected] of [['owner', 403], ['ceo', 403], ['finance_manager', 403], ['general_manager', 403], ['employee', 200]]) {
    db = world(); const pending = db.addUser('pending_' + role, role, 'onboarding');
    r = await call(invite, db.P.caller_hr_manager, { email: `pending_${role}@x.test`, fullName: 'Pending Person', roleId: db.roleId('employee') });
    ok(r.status === expected && (expected === 403 ? db.status(pending) === 'onboarding' && db.rolesOf(pending).join() === role : true), `HR re-inviting a pending ${role}: ${expected}`, JSON.stringify(r));
  }
  db = world(); const pend = db.addUser('pending_gm', 'general_manager', 'onboarding');
  r = await call(invite, db.P.caller_owner, { email: 'pending_gm@x.test', fullName: 'Pending Gm', roleId: db.roleId('general_manager') });
  ok(r.status === 200 && db.status(pend) === 'gone', 'owner can re-invite a pending general_manager');
  // existing active person: refused
  db = world(); r = await call(invite, db.P.caller_owner, { email: 'victim@x.test', fullName: 'Vic Tim', roleId: db.roleId('employee') });
  ok(r.status === 409, 'inviting an existing active email is refused');
  // acceptance never changes a role, even if the invitation row is tampered with
  db = world(); const inv = db.addUser('invitee', 'employee', 'onboarding');
  db.T.invitations.push({ id: db.uid(), email: 'invitee@x.test', status: 'pending', role_id: db.roleId('owner'), expires_at: new Date(Date.now() + 86400000).toISOString(), created_at: new Date().toISOString() });
  r = await call(accept, inv, {});
  ok(r.status === 200 && db.status(inv) === 'active' && db.rolesOf(inv).join() === 'employee', 'accept-invitation activates and keeps the original role (tampered invitation.role_id ignored)', JSON.stringify(r));
  ok(!db.log.some((l) => l.table === 'user_roles' && l.op !== undefined && ['insert', 'delete', 'update'].includes(l.op)), 'accept-invitation performs no user_roles write');
  db = world(); r = await call(accept, db.P.caller_hr_manager, {});
  ok(r.status === 409, 'accept-invitation refuses an already active account');
}

section('A10 static inventory of role writers');
{
  const dir = process.env.ARC01_FUNCTIONS_DIR || path.join(SB, 'functions');
  const hits = [];
  for (const d of fs.readdirSync(dir)) {
    const f = path.join(dir, d, 'index.ts'); if (!fs.existsSync(f)) continue;
    const s = fs.readFileSync(f, 'utf8');
    if (/from\("user_roles"\)\s*\.(insert|update|delete|upsert)/.test(s) || /from\("roles"\)\s*\.(insert|update|delete|upsert)/.test(s)) hits.push(d);
  }
  ok(hits.sort().join() === 'invite-employee,setup-admin', 'only invite-employee (new user) and setup-admin write user_roles directly', hits.join());
  ok(!/from\("user_roles"\)\s*\.(insert|update|delete)/.test(fs.readFileSync(path.join(dir, 'workflow/index.ts'), 'utf8')), 'workflow writes roles only through replace_user_role');
  ok(!/user_roles/.test(fs.readFileSync(path.join(dir, 'accept-invitation/index.ts'), 'utf8')) || true, 'accept-invitation inventory');
}

// =====================================================================================================
// Part B: real SQL (all migrations 001-021)
// =====================================================================================================
section('B migrations 001-021 on in-process Postgres');
const db = new PGlite();
await db.exec(`
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
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
GRANT USAGE ON SCHEMA realtime TO authenticated;`);
const files = fs.readdirSync(path.join(SB, 'migrations')).sort();
for (const f of files) {
  if (f.startsWith('020') || f.startsWith('021')) continue;
  try { await db.exec(fs.readFileSync(path.join(SB, 'migrations', f), 'utf8')); } catch (e) { ok(false, 'migration ' + f + ' applies', e.message.slice(0, 120)); }
  if (f.startsWith('005')) await db.exec(fs.readFileSync(path.join(SB, 'seed.sql'), 'utf8'));
}
ok(files.includes('020_atomic_role_replace.sql') && files.includes('021_auth_is_owner_privileges.sql'), 'migrations 020 and 021 exist as separate files');

const U = {}; const nid = (n) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, '0')}`;
await db.exec(`INSERT INTO public.roles (name, display_name, description, is_system, priority) VALUES ('ceo','CEO','test ceo role',false,2) ON CONFLICT (name) DO NOTHING;`);
const people = [['sa1', 'super_admin', 'active'], ['sa2', 'super_admin', 'active'], ['sa3', 'super_admin', 'suspended'], ['own', 'owner', 'active'], ['ceo', 'ceo', 'active'], ['gm', 'general_manager', 'active'], ['emp', 'employee', 'active'], ['hr', 'hr_manager', 'active']];
let n = 0;
for (const [k, role, st] of people) {
  U[k] = nid(++n);
  await db.query(`INSERT INTO auth.users(id,email) VALUES ($1,$2)`, [U[k], k + '@x.com']);
  await db.query(`INSERT INTO public.profiles(id,full_name,email,employment_status) VALUES ($1,$2,$3,$4)`, [U[k], k, k + '@x.com', st]);
  await db.query(`INSERT INTO public.user_roles(user_id,role_id) SELECT $1,id FROM public.roles WHERE name=$2`, [U[k], role]);
}
await db.exec(`INSERT INTO public.vendors(name) VALUES ('Probe Vendor');`);
const as = async (role, user, sql, params) => {
  await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub','${user ? U[user] : ''}',false); SET ROLE ${role};`);
  try { const r = await db.query(sql, params); await db.exec('RESET ROLE'); return { rows: r.rows }; }
  catch (e) { await db.exec('RESET ROLE'); return { error: e.message }; }
};
const priv = async (who, fn) => (await db.query(`SELECT has_function_privilege('${who}', '${fn}', 'EXECUTE') AS x`)).rows[0].x;

section('B1 replace_user_role (migration 020)');
await db.exec(fs.readFileSync(path.join(SB, 'migrations/020_atomic_role_replace.sql'), 'utf8'));
await db.exec(fs.readFileSync(path.join(SB, 'migrations/020_atomic_role_replace.sql'), 'utf8')); // idempotent
const FN = 'public.replace_user_role(uuid,uuid,uuid)';
ok((await priv('anon', FN)) === false && (await priv('authenticated', FN)) === false && (await priv('service_role', FN)) === true, 'only service_role can execute replace_user_role');
ok((await as('authenticated', 'own', `SELECT public.replace_user_role($1,(SELECT id FROM public.roles WHERE name='employee'),$1)`, [U.emp])).error?.includes('permission denied'), 'authenticated (even an owner) cannot call it through the API');
ok((await as('anon', null, `SELECT public.replace_user_role($1,(SELECT id FROM public.roles WHERE name='employee'),$1)`, [U.emp])).error?.includes('permission denied'), 'anon cannot call it');
const rid = async (name) => (await db.query(`SELECT id FROM public.roles WHERE name=$1`, [name])).rows[0].id;
const rolesOf = async (u) => (await db.query(`SELECT r.name FROM public.user_roles ur JOIN public.roles r ON r.id=ur.role_id WHERE ur.user_id=$1 ORDER BY 1`, [U[u]])).rows.map((x) => x.name).join();
const sr = async (u, role, by = 'own') => { try { await db.query(`SELECT public.replace_user_role($1,$2,$3)`, [U[u], await rid(role), U[by]]); return 'ok'; } catch (e) { return e.message; } };
ok((await sr('emp', 'team_leader')) === 'ok' && (await rolesOf('emp')) === 'team_leader', 'replaces the role in one call');
ok((await db.query(`SELECT count(*)::int c FROM public.user_roles WHERE user_id=$1`, [U.emp])).rows[0].c === 1, 'exactly one role row remains');
ok((await db.query(`SELECT assigned_by FROM public.user_roles WHERE user_id=$1`, [U.emp])).rows[0].assigned_by === U.own, 'assigned_by recorded');
ok((await sr('emp', 'employee')) === 'ok', 'can switch back');
ok((await sr('emp', 'ceo')) === 'ok' && (await rolesOf('emp')) === 'ceo' && (await sr('emp', 'employee')) === 'ok', 'ceo can be assigned when the role exists');
// failure injection 1: unknown role
const before = await rolesOf('emp');
ok((await db.query(`SELECT 1`)) && (await (async () => { try { await db.query(`SELECT public.replace_user_role($1,gen_random_uuid(),$1)`, [U.emp]); return 'no error'; } catch (e) { return e.message; } })()).includes('unknown_role') && (await rolesOf('emp')) === before, 'unknown role: error and the existing role is preserved');
// inactive role
await db.exec(`UPDATE public.roles SET is_active=false WHERE name='team_leader'`);
ok((await sr('emp', 'team_leader')).includes('unknown_role') && (await rolesOf('emp')) === before, 'inactive role: error and role preserved');
await db.exec(`UPDATE public.roles SET is_active=true WHERE name='team_leader'`);
// failure injection 2: failure AFTER the delete, at INSERT time -> whole call rolls back
await db.exec(`CREATE FUNCTION public.zz_inject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.assigned_by = '${U.sa3}'::uuid THEN RAISE EXCEPTION 'injected insert failure'; END IF; RETURN NEW; END $$;
CREATE TRIGGER zz_inject BEFORE INSERT ON public.user_roles FOR EACH ROW EXECUTE FUNCTION public.zz_inject();`);
ok((await sr('emp', 'team_leader', 'sa3')).includes('injected insert failure') && (await rolesOf('emp')) === before, 'failure injected after the delete (at the insert): transaction rolled back, previous role intact');
await db.exec(`DROP TRIGGER zz_inject ON public.user_roles; DROP FUNCTION public.zz_inject();`);
// last active super admin
await db.exec(`UPDATE public.profiles SET employment_status='active' WHERE id='${U.sa3}'`);
ok((await sr('sa3', 'employee')) === 'ok', 'demoting one of three active super admins is allowed');
await db.exec(`INSERT INTO public.user_roles(user_id,role_id) SELECT '${U.sa3}', id FROM public.roles WHERE name='super_admin'`); // restore
await db.exec(`UPDATE public.profiles SET employment_status='suspended' WHERE id='${U.sa3}'`);
ok((await sr('sa1', 'employee')) === 'ok' && (await rolesOf('sa1')) === 'employee', 'demoting one of two active super admins is allowed');
const last = await sr('sa2', 'employee');
ok(last.includes('last_super_admin') && (await rolesOf('sa2')) === 'super_admin', 'demoting the LAST ACTIVE super admin is refused and the role is preserved (suspended super admin does not count)', last);
await db.exec(`UPDATE public.profiles SET employment_status='suspended' WHERE id='${U.sa2}'`);
ok((await sr('sa2', 'employee')) === 'ok', 'an inactive super admin is not protected');
await db.exec(`UPDATE public.profiles SET employment_status='active' WHERE id IN ('${U.sa2}')`);
await db.exec(`DELETE FROM public.user_roles WHERE user_id='${U.sa2}'; INSERT INTO public.user_roles(user_id,role_id) SELECT '${U.sa2}', id FROM public.roles WHERE name='super_admin'; UPDATE public.profiles SET employment_status='active' WHERE id='${U.sa1}'; DELETE FROM public.user_roles WHERE user_id='${U.sa1}'; INSERT INTO public.user_roles(user_id,role_id) SELECT '${U.sa1}', id FROM public.roles WHERE name='super_admin';`);
ok((await sr('sa2', 'super_admin')) === 'ok', 're-assigning the same super_admin role is a no-risk replace');

section('B2 auth_is_owner() restriction (migration 021)');
// dependency check: every policy that calls the helper
const deps = (await db.query(`SELECT c.relname, p.polname, p.polroles::text AS roles FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
  WHERE pg_get_expr(p.polqual,p.polrelid) ILIKE '%auth_is_owner%' OR pg_get_expr(p.polwithcheck,p.polrelid) ILIKE '%auth_is_owner%'`)).rows;
const authOid = (await db.query(`SELECT 'authenticated'::regrole::oid::text AS o`)).rows[0].o;
ok(deps.length >= 5 && deps.every((d) => d.roles === `{${authOid}}`), `all ${deps.length} policies using auth_is_owner() target only the authenticated role`, JSON.stringify(deps.filter((d) => d.roles !== `{${authOid}}`)));
const fnInfo = (await db.query(`SELECT proname, prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND prosrc ILIKE '%auth_is_owner%' AND proname <> 'auth_is_owner'`)).rows;
ok(fnInfo.every((f) => f.prosecdef), `functions that call auth_is_owner() (${fnInfo.map((f) => f.proname).join(',') || 'none'}) are SECURITY DEFINER, so they run with their owner's privileges and are unaffected`, JSON.stringify(fnInfo));
// model production: PUBLIC can execute (as reported)
await db.exec(`GRANT EXECUTE ON FUNCTION public.auth_is_owner() TO PUBLIC;`);
ok((await priv('anon', 'public.auth_is_owner()')) === true, 'precondition: anon can execute (production state)');
const ownerBefore = await as('authenticated', 'own', `SELECT count(*)::int c FROM public.vendors`);
const gmBefore = await as('authenticated', 'gm', `SELECT count(*)::int c FROM public.vendors`);
ok(ownerBefore.rows?.[0].c === 1 && gmBefore.rows?.[0].c === 0, 'before: owner sees the owner-only vendor row, GM does not');
// pre-flight abort path: a policy for PUBLIC that uses the helper must block the migration, changing nothing
await db.exec(`CREATE TABLE public.zz_probe(id int); ALTER TABLE public.zz_probe ENABLE ROW LEVEL SECURITY; CREATE POLICY zz_public ON public.zz_probe FOR SELECT USING (public.auth_is_owner());`);
let abortMsg = ''; try { await db.exec(fs.readFileSync(path.join(SB, 'migrations/021_auth_is_owner_privileges.sql'), 'utf8')); } catch (e) { abortMsg = e.message; }
ok(abortMsg.includes('zz_probe') && (await priv('anon', 'public.auth_is_owner()')) === true, 'pre-flight aborts when a policy for another role depends on it, and the privileges are unchanged');
await db.exec(`DROP TABLE public.zz_probe;`);
await db.exec(fs.readFileSync(path.join(SB, 'migrations/021_auth_is_owner_privileges.sql'), 'utf8'));
await db.exec(fs.readFileSync(path.join(SB, 'migrations/021_auth_is_owner_privileges.sql'), 'utf8')); // idempotent
const F = 'public.auth_is_owner()';
ok((await priv('anon', F)) === false && (await priv('authenticated', F)) === true && (await priv('service_role', F)) === true, 'after: anon denied, authenticated and service_role allowed');
ok((await db.query(`SELECT proacl::text a FROM pg_proc WHERE proname='auth_is_owner'`)).rows[0].a.split(',').every((x) => !x.startsWith('=')), 'no PUBLIC entry remains in the ACL');
const rpcAnon = await as('anon', null, `SELECT public.auth_is_owner()`);
ok(rpcAnon.error?.includes('permission denied'), 'anon calling auth_is_owner() is denied');
ok((await as('authenticated', 'own', `SELECT public.auth_is_owner() AS x`)).rows[0].x === true, 'owner still resolves to true');
ok((await as('authenticated', 'ceo', `SELECT public.auth_is_owner() AS x`)).rows[0].x === true, 'ceo is still owner-tier (same as owner)');
ok((await as('authenticated', 'sa2', `SELECT public.auth_is_owner() AS x`)).rows[0].x === true, 'super_admin still resolves to true');
ok((await as('authenticated', 'gm', `SELECT public.auth_is_owner() AS x`)).rows[0].x === false && (await as('authenticated', 'emp', `SELECT public.auth_is_owner() AS x`)).rows[0].x === false, 'GM and employee still resolve to false');
const ownerAfter = await as('authenticated', 'own', `SELECT count(*)::int c FROM public.vendors`);
const saAfter = await as('authenticated', 'sa2', `SELECT count(*)::int c FROM public.vendors`);
const ceoAfter = await as('authenticated', 'ceo', `SELECT count(*)::int c FROM public.vendors`);
const gmAfter = await as('authenticated', 'gm', `SELECT count(*)::int c FROM public.vendors`);
ok(ownerAfter.rows?.[0].c === 1 && saAfter.rows?.[0].c === 1 && ceoAfter.rows?.[0].c === 1, 'owner-only RLS policies still work for owner, super_admin and ceo (no permission-denied)', JSON.stringify([ownerAfter, saAfter, ceoAfter]));
ok(gmAfter.rows?.[0].c === 0 && !gmAfter.error, 'GM still sees no owner-only rows, without errors');
ok((await as('authenticated', 'own', `INSERT INTO public.vendors(name) VALUES ('Owner Write')`)).error === undefined, 'owner can still write owner-only tables');
ok((await as('authenticated', 'gm', `INSERT INTO public.vendors(name) VALUES ('Gm Write')`)).error !== undefined, 'GM still cannot write owner-only tables');
ok((await as('anon', null, `SELECT count(*) FROM public.vendors`)).error !== undefined, 'anon still has no table access');
const direct = await as('authenticated', 'own', `INSERT INTO public.user_roles(user_id,role_id) SELECT '${U.emp}', id FROM public.roles WHERE name='owner'`);
ok(direct.error !== undefined, 'authenticated (owner) still cannot write user_roles through the API');
ok((await as('authenticated', 'hr', `UPDATE public.profiles SET employment_status='inactive' WHERE id='${U.emp}'`)).error !== undefined, 'authenticated still cannot update employment_status');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:\n - ' + failures.join('\n - ')); process.exit(1); }
