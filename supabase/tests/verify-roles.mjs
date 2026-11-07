// ARC-01 regression tests: role-tier authorization, executive-only Finance access, last-super-admin protection,
// atomic role replacement, invitation flows and the auth_is_owner() privilege restriction.
//
// Part A  runs the REAL Edge Function code (invite-employee, workflow, accept-invitation, _shared/auth.ts) under
//         Node: esbuild bundles the TypeScript, Deno.serve is captured, and the service-role client is an
//         in-memory fake (it does NOT test Postgres; Part B does).
// Part B  applies all migrations (001-025) to an in-process Postgres (PGlite, Supabase-style stubs) and tests
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
const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-service', SUPABASE_ANON_KEY: 'test-anon', APP_URL: 'https://app.example.test', CRON_SECRET: 'c'.repeat(40) };
const RPC_RESULTS = { fin_retainer_generate: 3, fin_mark_overdue: 0 };
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
const chat = await load('chat/index.ts');
const authMod = (await load('_shared/auth.ts')).mod;
const httpMod = (await load('_shared/http.ts')).mod;
ok(!!invite.handler && !!workflow.handler && !!accept.handler && !!chat.handler, 'handlers captured from the real function code');

// ---------------------------------------------------------------- in-memory fake of the service-role client
const ALL_ROLES = ['super_admin', 'owner', 'ceo', 'general_manager', 'finance_manager', 'accountant', 'hr_manager',
  'department_manager', 'team_leader', 'project_manager', 'employee', 'client'];

function makeDb() {
  const T = { profiles: [], roles: [], user_roles: [], departments: [], user_departments: [], invitations: [], audit_logs: [], notifications: [], push_subscriptions: [], expenses: [], messages: [], conversations: [], message_reactions: [] };
  const users = [], log = [], flags = { failInsert: null, failRpc: false, rpcMissing: false, profileUpdateError: null, rpcError: null, onDeleteUser: null };
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
        if (flags.profileUpdateError && this.table === 'profiles') return { data: null, error: { message: flags.profileUpdateError } };
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
    if (name !== 'replace_user_role') return { data: RPC_RESULTS[name] ?? null, error: null };
    if (flags.rpcError) return { data: null, error: { message: flags.rpcError } };
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
      deleteUser: async (id) => { if (flags.onDeleteUser) { flags.onDeleteUser(id); return { error: { message: 'Database error deleting user' } }; } removeUser(id); log.push({ op: 'deleteUser', id }); return { error: null }; },
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
  P.expense = db.uid();
  db.T.expenses.push({ id: P.expense, title: 'Camera rental', amount: 500, currency: 'EGP', submitted_by: P.caller_employee, status: 'submitted', created_at: new Date().toISOString() });
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
const EXEC = ['super_admin', 'owner', 'ceo'];
const GRANT = {            // roles each caller may grant (executive tier: everything)
  super_admin: new Set(EVERYTHING), owner: new Set(EVERYTHING), ceo: new Set(EVERYTHING),
  general_manager: new Set(['general_manager', 'hr_manager', ...LOW]),
  hr_manager: new Set(['hr_manager', ...LOW]),
};
const MANAGE = {           // accounts (by their role) each caller may edit, deactivate or delete
  super_admin: new Set(EVERYTHING), owner: new Set(EVERYTHING), ceo: new Set(EVERYTHING),
  general_manager: new Set(['general_manager', 'finance_manager', 'accountant', 'hr_manager', ...LOW]),
  hr_manager: new Set(['hr_manager', ...LOW]),
};
const GATE_CALLERS = ['super_admin', 'owner', 'ceo', 'general_manager', 'hr_manager'];
const GATED_OUT = ['finance_manager', 'accountant', 'department_manager', 'team_leader', 'project_manager', 'employee', 'client'];

section('A1 tier helpers (real _shared/auth.ts)');
try {
  const mk = (...roles) => ({ status: 'active', roles });
  const T = authMod;
  ok(T.roleTier('super_admin') === T.roleTier('owner') && T.roleTier('owner') === T.roleTier('ceo'), 'super_admin, owner and ceo are ONE tier');
  ok(JSON.stringify([...T.EXECUTIVE_ROLES]) === JSON.stringify(['super_admin', 'owner', 'ceo']), 'EXECUTIVE_ROLES is exactly super_admin, owner, ceo');
  for (const a of EXEC) for (const b of [...EXEC, 'finance_manager', 'accountant', 'general_manager', 'hr_manager', 'employee']) {
    ok(T.canGrantRole(mk(a), b) && T.canManageAccount(mk(a), [b]), `${a} may grant and manage ${b} (equal executive tier)`);
  }
  for (const r of ['finance_manager', 'accountant']) {
    ok(!T.canGrantRole(mk('general_manager'), r) && !T.canGrantRole(mk('hr_manager'), r), `GM and HR cannot grant ${r}`);
    ok(T.canManageAccount(mk('general_manager'), [r]) && !T.canManageAccount(mk('hr_manager'), [r]), `GM may still manage a ${r} account, HR may not`);
    ok(!T.isExecutive(mk(r)) && !T.canManageEmployees(mk(r)), `${r} is neither executive nor allowed in employee management`);
  }
  ok(!T.canGrantRole(mk('general_manager'), 'owner') && !T.canGrantRole(mk('general_manager'), 'ceo') && !T.canGrantRole(mk('general_manager'), 'super_admin'), 'GM cannot grant any executive role');
  ok(!T.canManageAccount(mk('general_manager'), ['owner']) && !T.canManageAccount(mk('hr_manager'), ['ceo']), 'GM cannot manage an owner; HR cannot manage a ceo');
  ok(T.canManageEmployees(mk('ceo')) && T.canManageEmployees(mk('hr_manager')) && !T.canManageEmployees(mk('employee')), 'ceo now passes the employee-management gate');
  ok(!T.canManageAccount({ status: 'suspended', roles: ['super_admin'] }, ['employee']) && !T.isExecutive({ status: 'suspended', roles: ['owner'] }), 'a suspended executive has no authority');
  ok(T.canManageAccount(mk('hr_manager'), []) && T.canManageAccount(mk('hr_manager'), ['employee']), 'HR can manage a person without privileged roles');
  ok(T.bestTier(['employee', 'general_manager']) === 2, 'multi-role target uses its best tier');
  ok(T.roleTier('some_new_custom_role') === 5, 'unknown role names get the default (lowest) tier');
} catch (e) { ok(false, 'A1 tier helpers exist', e.message); }

section('A2 authorization matrix: grant via invite-employee');
for (const caller of GATE_CALLERS) for (const role of ALL_ROLES) {
  const db = world(); const email = `new_${role}@x.test`;
  const r = await call(invite, db.P['caller_' + caller], { email, fullName: 'New Person', roleId: db.roleId(role) });
  const prof = db.T.profiles.find((p) => p.email === email);
  if (GRANT[caller].has(role)) {
    ok(r.status === 200 && prof?.employment_status === 'onboarding' && db.rolesOf(prof.id).join() === role, `invite ${role} by ${caller} allowed`, JSON.stringify(r));
    ok(db.T.user_roles.find((u) => u.user_id === prof?.id)?.assigned_by === db.P['caller_' + caller], `invite ${role} by ${caller} records assigned_by`);
  } else {
    ok(r.status === 403 && !prof && !db.log.some((l) => l.op === 'invite'), `invite ${role} by ${caller} refused and nothing created`, JSON.stringify(r));
  }
}
section('A3 matrix: callers outside the gate (finance_manager, accountant, managers, employee, client, suspended)');
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
for (const caller of GATE_CALLERS) for (const role of ALL_ROLES) {
  const db = world();
  const r = await call(workflow, db.P['caller_' + caller], { action: 'employee.update', userId: db.P.victim, roleId: db.roleId(role) });
  if (GRANT[caller].has(role)) {
    ok(r.status === 200 && db.rolesOf(db.P.victim).join() === role, `set role ${role} by ${caller} allowed`, JSON.stringify(r));
  } else {
    ok(r.status === 403 && db.rolesOf(db.P.victim).join() === 'employee' && !db.log.some((l) => l.op === 'rpc'), `set role ${role} by ${caller} refused, role unchanged`, JSON.stringify(r));
  }
}
section('A5 matrix: modify / deactivate / delete accounts by tier');
for (const caller of GATE_CALLERS) for (const target of ALL_ROLES) {
  const allowed = MANAGE[caller].has(target);
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
  for (const role of ['finance_manager', 'accountant']) {
    r = await call(workflow, db.P.caller_general_manager, { action: 'employee.update', userId: db.P.victim, roleId: db.roleId(role) });
    ok(r.status === 403 && db.rolesOf(db.P.victim).join() === 'employee', `GM cannot grant ${role}`);
    r = await call(workflow, db.P.caller_hr_manager, { action: 'employee.update', userId: db.P.victim, roleId: db.roleId(role) });
    ok(r.status === 403, `HR cannot grant ${role}`);
  }
  r = await call(workflow, db.P.caller_general_manager, { action: 'employee.update', userId: db.P.target_owner, employmentStatus: 'suspended' });
  ok(r.status === 403 && db.status(db.P.target_owner) === 'active', 'GM cannot suspend an owner');
  r = await call(invite, db.P.caller_general_manager, { action: 'delete', userId: db.P.target_super_admin });
  ok(r.status === 403 && db.status(db.P.target_super_admin) === 'active', 'GM cannot delete a super_admin');
  r = await call(workflow, db.P.caller_hr_manager, { action: 'employee.update', userId: db.P.victim, roleId: db.roleId('ceo') });
  ok(r.status === 403, 'HR cannot grant ceo');
  // finance roles can be granted by each of the three executives
  for (const ex of EXEC) for (const role of ['finance_manager', 'accountant']) {
    db = world();
    r = await call(workflow, db.P['caller_' + ex], { action: 'employee.update', userId: db.P.victim, roleId: db.roleId(role) });
    ok(r.status === 200 && db.rolesOf(db.P.victim).join() === role, `${ex} may grant ${role}`, JSON.stringify(r));
    db = world();
    r = await call(invite, db.P['caller_' + ex], { email: `fin_${role}@x.test`, fullName: 'Fin Person', roleId: db.roleId(role) });
    ok(r.status === 200, `${ex} may invite a ${role}`, JSON.stringify(r));
  }
  db = world();
  r = await call(workflow, db.P.caller_super_admin, { action: 'employee.update', userId: db.P.target_owner, roleId: db.roleId('owner'), jobTitle: 'Boss' });
  ok(r.status === 200, 'super_admin keeps full access over owners');
  r = await call(workflow, db.P.caller_owner, { action: 'employee.update', userId: db.P.caller_owner, roleId: db.roleId('employee') });
  ok(r.status === 400, 'self role change still refused');
  r = await call(workflow, db.P.caller_owner, { action: 'employee.update', userId: db.P.caller_owner, employmentStatus: 'inactive' });
  ok(r.status === 400, 'self deactivation still refused');
  r = await call(invite, db.P.caller_owner, { action: 'delete', userId: db.P.caller_owner });
  ok(r.status === 400, 'self deletion still refused');
}

section('A6b mutual management inside the executive tier (all 9 ordered pairs of super_admin, owner, ceo)');
for (const actor of EXEC) for (const target of EXEC) {
  let db = world();
  let r = await call(workflow, db.P['caller_' + actor], { action: 'employee.update', userId: db.P['target_' + target], jobTitle: 'Edited' });
  ok(r.status === 200 && db.T.profiles.find((p) => p.id === db.P['target_' + target]).job_title === 'Edited', `${actor} edits ${target}`, JSON.stringify(r));
  db = world();
  r = await call(workflow, db.P['caller_' + actor], { action: 'employee.update', userId: db.P['target_' + target], employmentStatus: 'inactive' });
  ok(r.status === 200 && db.status(db.P['target_' + target]) === 'inactive', `${actor} deactivates ${target}`, JSON.stringify(r));
  db = world();
  r = await call(workflow, db.P['caller_' + actor], { action: 'employee.update', userId: db.P['target_' + target], roleId: db.roleId('employee') });
  ok(r.status === 200 && db.rolesOf(db.P['target_' + target]).join() === 'employee', `${actor} demotes ${target}`, JSON.stringify(r));
  db = world();
  r = await call(invite, db.P['caller_' + actor], { action: 'delete', userId: db.P['target_' + target] });
  ok(r.status === 200 && db.status(db.P['target_' + target]) === 'gone', `${actor} deletes ${target}`, JSON.stringify(r));
  for (const role of EXEC) {
    db = world();
    r = await call(workflow, db.P['caller_' + actor], { action: 'employee.update', userId: db.P.victim, roleId: db.roleId(role) });
    ok(r.status === 200 && db.rolesOf(db.P.victim).join() === role, `${actor} grants ${role}`, JSON.stringify(r));
  }
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
  ok(await run((d) => [d.addUser('a', 'ceo')], 0) === 'allowed', 'a ceo or owner is not subject to the super_admin special rule');

  // handler-level: executives are equal, so the protection is reachable and must hold for every caller
  const lastWorld = () => {
    const db = world();
    for (const k of ['target_super_admin', 'spare_sa']) db.T.profiles.find((p) => p.id === db.P[k]).employment_status = 'suspended';
    return db; // caller_super_admin is now the ONLY active super_admin
  };
  for (const actor of ['owner', 'ceo', 'general_manager', 'hr_manager']) {
    let db = lastWorld(); const sa = db.P.caller_super_admin;
    let r = await call(workflow, db.P['caller_' + actor], { action: 'employee.update', userId: sa, roleId: db.roleId('employee') });
    ok(r.status !== 200 && db.rolesOf(sa).join() === 'super_admin', `${actor}: demoting the last active super_admin refused`, JSON.stringify(r));
    r = await call(workflow, db.P['caller_' + actor], { action: 'employee.update', userId: sa, employmentStatus: 'inactive' });
    ok(r.status !== 200 && db.status(sa) === 'active', `${actor}: deactivating the last active super_admin refused`, JSON.stringify(r));
    r = await call(workflow, db.P['caller_' + actor], { action: 'employee.update', userId: sa, employmentStatus: 'suspended' });
    ok(r.status !== 200 && db.status(sa) === 'active', `${actor}: suspending the last active super_admin refused`, JSON.stringify(r));
    r = await call(invite, db.P['caller_' + actor], { action: 'delete', userId: sa });
    ok(r.status !== 200 && db.status(sa) === 'active', `${actor}: deleting the last active super_admin refused`, JSON.stringify(r));
    if (actor === 'owner' || actor === 'ceo') {
      db = lastWorld();
      r = await call(workflow, db.P['caller_' + actor], { action: 'employee.update', userId: db.P.caller_super_admin, roleId: db.roleId('employee') });
      ok(r.status === 409, `${actor} gets 409 (not a generic error) for the last-super_admin rule`, JSON.stringify(r));
    }
  }
  // with a second ACTIVE super admin the same operations are allowed for an executive
  let db = world();
  let r = await call(workflow, db.P.caller_owner, { action: 'employee.update', userId: db.P.caller_super_admin, roleId: db.roleId('employee') });
  ok(r.status === 200, 'owner may demote a super_admin while others stay active');
  r = await call(workflow, db.P.caller_ceo, { action: 'employee.update', userId: db.P.target_super_admin, employmentStatus: 'inactive' });
  ok(r.status === 200, 'ceo may deactivate a super_admin while another stays active');
  r = await call(invite, db.P.caller_owner, { action: 'delete', userId: db.P.spare_sa });
  ok(r.status === 409 && db.status(db.P.spare_sa) === 'active', 'but the last remaining one is then protected from deletion');
  // sole super_admin acting on themselves stays blocked by the self-guards
  r = await call(workflow, db.P.spare_sa, { action: 'employee.update', userId: db.P.spare_sa, employmentStatus: 'inactive' });
  ok(r.status === 400, 'a sole super_admin cannot deactivate themselves (self-guard)');
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
}

// ---------------------------------------------------------------- Finance (executive only)
const finance = await load('finance/index.ts');
const retainer = await load('retainer-billing/index.ts');
const FIN_ACTIONS = ['settings.update', 'billing.save', 'plan.save', 'invoice.save', 'invoice.issue', 'invoice.void', 'payment.add', 'payment.reverse', 'retainer.run'];
const FIN_DENIED = ['general_manager', 'finance_manager', 'accountant', 'hr_manager', 'department_manager', 'team_leader', 'project_manager', 'employee', 'client', 'suspended_owner'];

section('A11 Finance Edge Function: every action, every role');
for (const role of EXEC) for (const action of FIN_ACTIONS) {
  const db = world(); const r = await call(finance, db.P['caller_' + role], { action });
  ok(r.status !== 403 && r.status !== 401 && r.status !== 500, `finance ${action} reaches the handler for ${role}`, JSON.stringify(r));
}
{
  const db = world(); const r = await call(finance, db.P.caller_ceo, { action: 'retainer.run', month: '2026-01-01' });
  ok(r.status === 200 && db.log.some((l) => l.op === 'rpc' && l.name === 'fin_retainer_generate'), 'ceo can run a retainer batch end to end (equal to owner)', JSON.stringify(r));
}
for (const role of FIN_DENIED) for (const action of FIN_ACTIONS) {
  const db = world(); const key = role === 'suspended_owner' ? role : 'caller_' + role;
  const r = await call(finance, db.P[key], { action });
  ok(r.status === 403 && !db.log.some((l) => l.op === 'rpc'), `finance ${action} refused for ${role} and no SQL function called`, JSON.stringify(r));
}

section('A12 expense claims: deciding and notifications are executive-only');
for (const role of EXEC) {
  const db = world(); const r = await call(workflow, db.P['caller_' + role], { action: 'expense.decide', expenseId: db.P.expense, decision: 'approved' });
  ok(r.status === 200 && db.T.expenses[0].status === 'approved', `${role} can decide an expense claim`, JSON.stringify(r));
}
for (const role of FIN_DENIED) {
  const db = world(); const key = role === 'suspended_owner' ? role : 'caller_' + role;
  const r = await call(workflow, db.P[key], { action: 'expense.decide', expenseId: db.P.expense, decision: 'approved' });
  ok(r.status === 403 && db.T.expenses[0].status === 'submitted', `${role} cannot decide an expense claim`, JSON.stringify(r));
}
{
  const db = world(); const r = await call(workflow, db.P.caller_employee, { action: 'expense.submitted', expenseId: db.P.expense });
  const execIds = new Set(EXEC.flatMap((x) => [db.P['caller_' + x], db.P['target_' + x]]).concat([db.P.spare_sa]));
  const got = db.T.notifications.filter((n) => n.type === 'expense_request').map((n) => n.user_id);
  ok(r.status === 200 && got.length === execIds.size && got.every((id) => execIds.has(id)), 'the claim (it contains an amount) is announced to executives only', JSON.stringify({ r, n: got.length }));
  const leaked = db.T.notifications.filter((n) => /EGP\s*500/.test(n.content ?? '') && !execIds.has(n.user_id));
  ok(leaked.length === 0, 'no amount reaches general_manager, finance_manager, accountant, HR or anyone outside the executive tier');
}

section('A13 retainer-billing (cron): recipients');
{
  const db = world();
  const res = await retainer.handler(new Request('http://t/', { method: 'POST', headers: { 'x-cron-secret': ENV.CRON_SECRET, 'content-type': 'application/json' }, body: '{}' }));
  const execIds = new Set(EXEC.flatMap((x) => [db.P['caller_' + x], db.P['target_' + x]]).concat([db.P.spare_sa]));
  const got = db.T.notifications.filter((n) => n.type === 'invoice_drafts').map((n) => n.user_id);
  ok(res.status === 200 && got.length > 0 && got.every((id) => execIds.has(id)), 'retainer batch notifies executives only (not finance_manager, accountant, GM)', String(res.status));
  const bad = await retainer.handler(new Request('http://t/', { method: 'POST', headers: { 'x-cron-secret': 'wrong', 'content-type': 'application/json' }, body: '{}' }));
  ok(bad.status === 403, 'retainer-billing still requires the cron secret');
}

section('A14 consistency: database, Edge Functions and UI use the same executive set');
{
  const read = (...p) => fs.readFileSync(path.join(SB, '..', ...p), 'utf8');
  const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const money = read('js/services/money.js');
  const owner = [...money.match(/OWNER_ROLES = \[([^\]]*)\]/)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  ok(sameSet(owner, EXEC), 'js/services/money.js OWNER_ROLES = executive set');
  ok(/FINANCE_ROLES = \[\.\.\.OWNER_ROLES\]/.test(money) && /FINANCE_SENIOR_ROLES = \[\.\.\.OWNER_ROLES\]/.test(money), 'UI FINANCE_ROLES and FINANCE_SENIOR_ROLES are the executive set (no finance_manager, accountant)');
  const perm = read('js/permissions/permission-service.js');
  ok(sameSet([...perm.match(/isOwner\(\) \{[\s\S]*?\[([^\]]*)\]/)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), EXEC), 'Permissions.isOwner() = executive set');
  ok(sameSet(authMod.EXECUTIVE_ROLES ?? [], EXEC), 'Edge EXECUTIVE_ROLES = executive set');
  const sql = fs.readFileSync(path.join(SB, 'migrations/022_finance_executive_only.sql'), 'utf8');
  const fn = sql.match(/auth_is_finance\(\)[\s\S]*?r\.name IN \(([^)]*)\)/)[1];
  ok(sameSet([...fn.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), EXEC), 'SQL auth_is_finance() (migration 022) = executive set');
  const fin = fs.readFileSync(path.join(SB, 'functions/finance/index.ts'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  ok(!/finance_manager|accountant/.test(fin) && /isExecutive/.test(fin), 'finance Edge Function code names no finance role: executive only');
  const wf = fs.readFileSync(path.join(SB, 'functions/workflow/index.ts'), 'utf8');
  ok(/if \(!isExecutive\(caller\)\) \{\s*throw new HttpError\(403, "Finance privilege required"\)/.test(wf), 'expense.decide is gated by isExecutive');
}


section('A15 race losers are reported as 409 (database guard from migration 023)');
{
  let db = world(); db.flags.profileUpdateError = 'last_super_admin';
  let r = await call(workflow, db.P.caller_owner, { action: 'employee.update', userId: db.P.target_super_admin, employmentStatus: 'inactive' });
  ok(r.status === 409 && /last active super administrator/.test(r.body?.error ?? '') && db.status(db.P.target_super_admin) === 'active', 'status change refused by the database guard -> 409 with the right message', JSON.stringify(r));
  db = world(); db.flags.rpcError = 'last_super_admin';
  r = await call(workflow, db.P.caller_owner, { action: 'employee.update', userId: db.P.target_super_admin, roleId: db.roleId('employee') });
  ok(r.status === 409 && db.rolesOf(db.P.target_super_admin).join() === 'super_admin', 'role replace refused by the database guard -> 409, role intact', JSON.stringify(r));
  db = world();
  db.flags.onDeleteUser = () => { for (const k of ['caller_super_admin', 'spare_sa']) db.T.profiles.find((p) => p.id === db.P[k]).employment_status = 'suspended'; }; // the other super admins vanish mid-request
  r = await call(invite, db.P.caller_owner, { action: 'delete', userId: db.P.target_super_admin });
  ok(r.status === 409 && /last active super administrator/.test(r.body?.error ?? '') && db.status(db.P.target_super_admin) === 'active', 'delete refused by the database guard -> 409 with the right message (not the generic linked-records text)', JSON.stringify(r));
  db = world(); db.flags.onDeleteUser = () => {};
  r = await call(invite, db.P.caller_owner, { action: 'delete', userId: db.P.victim });
  ok(r.status === 409 && /linked records/.test(r.body?.error ?? ''), 'an ordinary delete failure keeps the original linked-records message', JSON.stringify(r));
}

// The scanner is a function so that the SAME code runs on the real Edge Functions and on planted fixtures.
const ROLE_NAMES = ['super_admin', 'owner', 'ceo', 'general_manager', 'finance_manager', 'accountant', 'hr_manager', 'department_manager', 'team_leader', 'project_manager', 'employee', 'client'];
const ROLE_ALT = ROLE_NAMES.join('|');
const ROLE_LIT = new RegExp('["\'`](' + ROLE_ALT + ')["\'`]', 'g');
const ROLE_KEY = new RegExp('(?:^|[,{\\s])["\']?(' + ROLE_ALT + ')["\']?\\s*:\\s*([^,\\n}]+)', 'g');
const EXEC_NAMES = ['super_admin', 'owner', 'ceo'];
/** Finds hard-coded role AUTHORIZATION structures in TypeScript source:
 *   array   : [...] holding two or more distinct role names (single- or multi-line)
 *   chain   : one statement joining two or more distinct role names with ||
 *   map     : { role: <non-string value>, role: ... } with two or more role keys (display-label maps whose values are all
 *             plain strings are data, not authorization, and are ignored)
 * Comments are removed first. A single role name (caller.has("hr_manager"), .eq("name","super_admin")) is never flagged. */
function scanRoleAuthorization(source) {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\"'`])\/\/[^\n]*/g, '$1 ');
  const distinct = (t) => [...new Set([...t.matchAll(ROLE_LIT)].map((m) => m[1]))];
  const found = [];
  for (const m of src.matchAll(/\[([^\[\]]*)\]/g)) { const r = distinct(m[1]); if (r.length >= 2) found.push({ kind: 'array', roles: r }); }
  for (const stmt of src.split(/[;{}]/)) { if (stmt.includes('||')) { const r = distinct(stmt); if (r.length >= 2) found.push({ kind: 'chain', roles: r }); } }
  for (const m of src.matchAll(/\{([^{}]*)\}/g)) {
    const keys = [...m[1].matchAll(ROLE_KEY)];
    const names = new Set(keys.map((k) => k[1]));
    const nonString = keys.some((k) => !/^\s*(["'`])[^"'`]*\1\s*$/.test(k[2]));
    if (names.size >= 2 && nonString) found.push({ kind: 'map', roles: [...names] });
  }
  return found;
}
/** Scans every .ts file under a functions directory. `_shared/auth.ts` holds the canonical definitions and is skipped.
 *  Documented exception: broadcast/index.ts may hold ONE array that is exactly the executive set. */
function scanFunctionsDir(dir) {
  const violations = [];
  const walk = (d) => {
    for (const item of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, item.name);
      if (item.isDirectory()) { walk(p); continue; }
      if (!item.name.endsWith('.ts')) continue;
      const rel = path.relative(dir, p).replace(/\\/g, '/');
      if (rel === '_shared/auth.ts') continue;
      for (const f of scanRoleAuthorization(fs.readFileSync(p, 'utf8'))) {
        const isExecOnly = f.kind === 'array' && f.roles.length === EXEC_NAMES.length && EXEC_NAMES.every((r) => f.roles.includes(r));
        if (rel === 'broadcast/index.ts' && isExecOnly) continue;
        violations.push(`${rel}: ${f.kind} [${f.roles.join(', ')}]`);
      }
    }
  };
  walk(dir);
  return violations;
}

section('A16 role consistency guard: no undeclared role authorization lists in Edge Functions (P2-01)');
{
  const functionsDir = process.env.ARC01_FUNCTIONS_DIR || path.join(SB, 'functions');
  const violations = scanFunctionsDir(functionsDir);
  ok(violations.length === 0, 'no undeclared hard-coded role authorization structures in the real Edge Functions', violations.join('; '));
  ok(fs.readdirSync(functionsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(functionsDir, d.name, 'index.ts'))).length >= 12, 'the scan covers every function directory (12+ found)');

  // the scanner itself, on planted fixtures (the same function that scans the real code)
  const must = {
    'single-line role array': ['const ALLOWED = ["super_admin", "finance_manager"];', 'array'],
    'multi-line role array': ['const ALLOWED = [\n  "owner",\n  "ceo",\n  "general_manager",\n];', 'array'],
    'multi-line array with single quotes': ["const R = [\n 'hr_manager',\n 'accountant'\n];", 'array'],
    'authorization || chain': ['if (caller.has("finance_manager") || caller.has("accountant")) { run(); }', 'chain'],
    'chain across lines': ['const ok = c.roles.includes("owner")\n  || c.roles.includes("ceo");', 'chain'],
    'object map with boolean values': ['const CAN = { super_admin: true, owner: true, employee: false };', 'map'],
    'object map with quoted keys and array values': ['const SCOPES = { "owner": ["a"], "hr_manager": ["b"] };', 'map'],
    'tier map with numbers': ['const T = {\n  super_admin: 0,\n  owner: 1,\n};', 'map'],
  };
  for (const [name, [code, kind]] of Object.entries(must)) {
    const r = scanRoleAuthorization(code);
    ok(r.some((f) => f.kind === kind), `scanner detects: ${name}`, JSON.stringify(r));
  }
  const benign = {
    'single role check': 'if (caller.has("hr_manager")) { go(); }',
    'single role in a query': 'admin.from("roles").select("id").eq("name", "super_admin")',
    'one role repeated with &&': 'if (a.includes("super_admin") && role.name !== "super_admin") { x(); }',
    'display-label map (all values are plain strings)': 'const LABELS = { super_admin: "Super Admin", owner: "Owner / CEO", employee: "Employee" };',
    'display labels, quoted keys': 'const L = { "hr_manager": "HR Manager", "finance_manager": "Finance Manager" };',
    'business data row with one role field': 'const row = { role: "employee", name: "Sam", status: "active" };',
    'sentence mentioning roles': 'throw new HttpError(403, "Only a super_admin or owner may do this");',
    'role names in a comment': '// ["owner", "ceo"] are the executives\n/* owner || ceo */\nconst x = 1;',
    'spread plus one literal': 'userIdsWithRoles(admin, [...ADMIN_ROLES, "hr_manager"]);',
    'capitalised display array': 'const labels = ["Owner", "CEO", "Super Admin"];',
    '|| default value': 'const r = body.role || "employee";',
  };
  for (const [name, code] of Object.entries(benign)) {
    const r = scanRoleAuthorization(code);
    ok(r.length === 0, `scanner ignores: ${name}`, JSON.stringify(r));
  }

  // the directory walker on a planted tree: catches new lists, honours the one documented exception, skips auth.ts
  const plant = fs.mkdtempSync(path.join(os.tmpdir(), 'rolescan-'));
  const put = (rel, text) => { const f = path.join(plant, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put('_shared/auth.ts', 'export const ROLE_TIER = { super_admin: 0, owner: 0, ceo: 0 }; export const E = ["super_admin", "owner", "ceo"];');
  put('broadcast/index.ts', 'const SENDER_ROLES = ["owner", "ceo", "super_admin"];');
  put('good/index.ts', 'const labels = { owner: "Owner", ceo: "CEO" };');
  ok(scanFunctionsDir(plant).length === 0, 'walker: auth.ts is skipped, the documented broadcast executive array is allowed, display labels are ignored');
  put('broadcast/index.ts', 'const SENDER_ROLES = ["owner", "ceo", "super_admin", "general_manager"];');
  ok(scanFunctionsDir(plant).some((v) => v.startsWith('broadcast/index.ts')), 'walker: the broadcast exception does NOT cover a list with an extra role');
  put('broadcast/index.ts', 'const SENDER_ROLES = ["owner", "ceo", "super_admin"];');
  put('newfn/index.ts', 'const MAY = [\n "finance_manager",\n "accountant",\n];');
  ok(scanFunctionsDir(plant).some((v) => v.startsWith('newfn/index.ts')), 'walker: a new function with a multi-line role list is reported');
  put('newfn/index.ts', 'if (c.has("hr_manager") || c.has("finance_manager")) { go(); }');
  ok(scanFunctionsDir(plant).some((v) => v.includes('chain')), 'walker: a new authorization || chain is reported');
  fs.rmSync(plant, { recursive: true, force: true });
}

section('A17 request body hardening & payload streaming limits (P2-10, P2-11)');
{
  const { readJson } = httpMod;

  // 1. Content-Length header check (immediate 413)
  {
    const req = new Request('http://t/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '2000' },
      body: JSON.stringify({ a: 1 })
    });
    let err = null;
    try { await readJson(req, 1000); } catch (e) { err = e; }
    ok(err?.status === 413, 'Content-Length > maxBytes returns HTTP 413 immediately', String(err?.status));
  }

  // 2. Hard streaming byte limit before buffering
  {
    const enc = new TextEncoder();
    const chunk1 = enc.encode('{"part1":"' + 'x'.repeat(400) + '",');
    const chunk2 = enc.encode('"part2":"' + 'y'.repeat(400) + '"}');
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk1);
        controller.enqueue(chunk2);
        controller.close();
      }
    });
    const req = new Request('http://t/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half'
    });
    let err = null;
    try { await readJson(req, 500); } catch (e) { err = e; }
    ok(err?.status === 413, 'streaming byte limit exceeded returns HTTP 413', String(err?.status));
  }

  // 3. Early stream termination on infinite/oversized stream
  {
    let canceled = false;
    let chunksSent = 0;
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      pull(controller) {
        chunksSent++;
        controller.enqueue(enc.encode('x'.repeat(1024)));
      },
      cancel() {
        canceled = true;
      }
    });
    const req = new Request('http://t/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half'
    });
    let err = null;
    try { await readJson(req, 2048); } catch (e) { err = e; }
    ok(err?.status === 413 && canceled && chunksSent <= 4, 'oversized stream is cancelled early and returns 413 without draining', `chunks=${chunksSent}, canceled=${canceled}`);
  }

  // 4. Valid JSON within limit
  {
    const req = new Request('http://t/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', count: 42 })
    });
    const parsed = await readJson(req, 1024);
    ok(parsed.message === 'hello' && parsed.count === 42, 'valid JSON within limit parsed successfully');
  }

  // 5. JSON nesting depth bound (max 20)
  {
    let deep = { val: 1 };
    for (let i = 0; i < 21; i++) deep = { nested: deep };
    const req = new Request('http://t/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(deep)
    });
    let err = null;
    try { await readJson(req, 32768); } catch (e) { err = e; }
    ok(err?.status === 400 && /depth/.test(err.message), 'nesting depth > 20 rejected with 400', err?.message);

    // exactly 20 levels deep: accepted
    let exact20 = { val: 1 };
    for (let i = 0; i < 18; i++) exact20 = { nested: exact20 };
    const req20 = new Request('http://t/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(exact20)
    });
    let err20 = null;
    try { await readJson(req20, 32768); } catch (e) { err20 = e; }
    ok(err20 === null, 'nesting depth <= 20 accepted');
  }

  // 6. JSON node count bound (max 5000)
  {
    const manyNodes = { list: Array.from({ length: 5001 }, (_, i) => i) };
    const req = new Request('http://t/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(manyNodes)
    });
    let err = null;
    try { await readJson(req, 200000); } catch (e) { err = e; }
    ok(err?.status === 400 && /node count/.test(err.message), 'node count > 5000 rejected with 400', err?.message);

    // exactly 5000 nodes total: accepted
    const okNodes = { list: Array.from({ length: 4998 }, (_, i) => i) };
    const reqOk = new Request('http://t/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(okNodes)
    });
    let errOk = null;
    try { await readJson(reqOk, 200000); } catch (e) { errOk = e; }
    ok(errOk === null, 'node count <= 5000 accepted');
  }

  // 7. Endpoint-specific limits preserved: Finance 200 KB
  {
    const payload150k = { items: Array.from({ length: 90 }, (_, i) => ({ desc: 'Line item description text padding with extra content '.repeat(25) + i, qty: 1, price: 100 })) };
    const bodyStr = JSON.stringify(payload150k);
    ok(bodyStr.length > 32768 && bodyStr.length < 200000, 'test payload is between 32 KB and 200 KB');

    // Rejected with standard 32 KB limit:
    const reqDefault = new Request('http://t/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: bodyStr });
    let errDef = null;
    try { await readJson(reqDefault, 32768); } catch (e) { errDef = e; }
    ok(errDef?.status === 413, 'payload > 32 KB rejected by default limit');

    // Accepted with finance 200 KB limit:
    const reqFinance = new Request('http://t/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: bodyStr });
    const parsedFin = await readJson(reqFinance, 200000);
    ok(parsedFin.items.length === 90, 'payload accepted under finance 200 KB limit');
  }

  // 8. Department IDs array cap at 50 in invite-employee and workflow
  {
    const db = world();
    const depts51 = Array.from({ length: 51 }, () => db.uid());
    const rInvite51 = await call(invite, db.P.caller_owner, {
      email: 'toomany@x.test', fullName: 'Too Many', roleId: db.roleId('employee'), departmentIds: depts51
    });
    ok(rInvite51.status === 400 && /maximum 50/.test(rInvite51.body?.error ?? ''), 'invite-employee rejects > 50 departmentIds with 400', JSON.stringify(rInvite51));

    const depts50 = Array.from({ length: 50 }, () => db.uid());
    depts50.forEach((id) => db.T.departments.push({ id, name: 'D-' + id }));
    const rInvite50 = await call(invite, db.P.caller_owner, {
      email: 'okdepts@x.test', fullName: 'OK Depts', roleId: db.roleId('employee'), departmentIds: depts50
    });
    ok(rInvite50.status === 200, 'invite-employee accepts <= 50 departmentIds', JSON.stringify(rInvite50));

    const rWorkflow51 = await call(workflow, db.P.caller_owner, {
      action: 'employee.update', userId: db.P.victim, departmentIds: depts51
    });
    ok(rWorkflow51.status === 400 && /maximum 50/.test(rWorkflow51.body?.error ?? ''), 'workflow employee.update rejects > 50 departmentIds with 400', JSON.stringify(rWorkflow51));

    const rWorkflow50 = await call(workflow, db.P.caller_owner, {
      action: 'employee.update', userId: db.P.victim, departmentIds: depts50
    });
    ok(rWorkflow50.status === 200, 'workflow employee.update accepts <= 50 departmentIds', JSON.stringify(rWorkflow50));
  }
}

section('A18 chat reaction XSS: reject markup server-side & escape client-side (P2-13)');
{
  const db = world();
  const convId = db.uid();
  const msgId = db.uid();
  db.T.conversations.push({ id: convId, type: 'channel', is_archived: false });
  db.T.messages.push({ id: msgId, conversation_id: convId, content: 'Test message', sender_id: db.P.caller_owner });

  // 1. Server-side rejection of malicious characters
  const badEmojis = [
    '"><',
    '<script>',
    '\' onfocus=\'',
    '" onfocus="',
    '`',
    '\\',
    '&',
    '<',
    '>',
    'hi world',
    '\x00',
    '\x1B'
  ];
  for (const bad of badEmojis) {
    const r = await call(chat, db.P.caller_owner, { action: 'reaction.toggle', messageId: msgId, emoji: bad });
    ok(r.status === 400 && /Invalid emoji/.test(r.body?.error ?? ''), `reaction.toggle rejects malicious emoji "${bad}" with 400`, JSON.stringify(r));
  }

  // 2. Server-side acceptance of legitimate emojis
  const goodEmojis = ['👍', '❤️', '🎉', '🔥', '🚀', '👍🏽', '👨‍👩‍👧'];
  for (const good of goodEmojis) {
    const r = await call(chat, db.P.caller_owner, { action: 'reaction.toggle', messageId: msgId, emoji: good });
    ok(r.status === 200, `reaction.toggle accepts valid emoji "${good}"`, JSON.stringify(r));
  }

  // 3. Client-side rendering: the module chat.js really calls (js/utils/reactions.js), not a copied template
  const reactions = await import(pathToFileURL(path.join(SB, '../js/utils/reactions.js')).href);
  const unesc = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&');
  const attr = (html, name) => { const m = html.match(new RegExp(name + '="([^"]*)"')); return m ? unesc(m[1]) : null; };
  const evil = ['"><img src=x onerror=alert(1)>', "' onfocus='alert(1)", '<script>alert(1)</script>', '" style="x:y" a="', '&quot;<b>'];
  for (const e of evil) {
    const html = reactions.reactionButtonHTML(msgId + '"><i>', { emoji: e, count: 3, names: ['A"><b>x', "O'Neil"], mine: true });
    const parts = html.match(/^(<button[^>]*>)([^<]*)(<\/button>)$/);   // an injected '>' or '<' would break this shape
    const shape = parts && parts[1].replace(/="[^"]*"/g, '=""');
    ok(!!parts && shape === '<button type="" class="" data-react="" data-emoji="" title="">', `rendered chip for ${JSON.stringify(e)} is exactly one button with the five expected attributes and plain text (nothing injected)`, html);
    ok(attr(html, 'data-emoji') === e, `data-emoji round-trips exactly (entity-encoded, not interpreted): ${JSON.stringify(e)}`);
    ok((html.match(/<button/g) || []).length === 1 && (html.match(/<\/button>/g) || []).length === 1, 'exactly one button element is produced');
  }
  const legit = ['👍', '❤️', '🎉', '👍🏽', '👨‍👩‍👧', '🏳️‍🌈', '1️⃣', '🇪🇬', '🧑🏿‍🤝‍🧑🏻'];
  for (const e of legit) {
    const html = reactions.reactionButtonHTML(msgId, { emoji: e, count: 2, names: ['Sam'], mine: false });
    ok(attr(html, 'data-emoji') === e && html.includes('>' + e + ' 2</button>'), `legitimate emoji stays intact in attribute and text: ${e}`);
  }
  const picker = reactions.quickEmojiHTML(['👍', '"><x']);
  ok(picker.includes('data-e="👍">👍</button>') && !picker.includes('"><x') && picker.includes('&quot;&gt;&lt;x'), 'the quick-reaction picker escapes too');
  // chat.js itself must keep using these helpers and must not interpolate an emoji raw
  const chatSrc = fs.readFileSync(path.join(SB, '../js/modules/chat/chat.js'), 'utf8');
  ok(/import \{ reactionButtonHTML, quickEmojiHTML \} from '..\/..\/utils\/reactions\.js'/.test(chatSrc) && chatSrc.includes('reactionButtonHTML(m.id, r)') && chatSrc.includes('quickEmojiHTML(QUICK_EMOJI)'), 'chat.js renders reactions and the picker through the tested module');
  ok(!/\$\{r\.emoji\}/.test(chatSrc) && !/data-emoji="\$\{(?!escapeHTML)/.test(chatSrc) && !/data-e="\$\{(?!escapeHTML)/.test(chatSrc), 'chat.js has no raw emoji interpolation left');

}


section('A19 JSON limits count BYTES (multi-byte UTF-8) and a misleading Content-Length cannot widen the limit');
{
  const { readJson } = httpMod;
  const LIMIT = 1000;
  const req = (body, headers = {}) => new Request('http://t/', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const bytesOf = (o) => new TextEncoder().encode(JSON.stringify(o)).byteLength;
  const run = async (body, headers) => { try { return { v: await readJson(req(body, headers), LIMIT) }; } catch (e) { return { s: e.status, m: e.message }; } };
  const stream = (chunks) => new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(x); c.close(); } });
  const sreq = (chunks, headers = {}) => new Request('http://t/', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: stream(chunks), duplex: 'half' });
  const srun = async (chunks, headers) => { try { return { v: await readJson(sreq(chunks, headers), LIMIT) }; } catch (e) { return { s: e.status, m: e.message }; } };

  // exact boundary with ASCII
  const exact = JSON.stringify({ t: 'a'.repeat(LIMIT - 8) });
  ok(exact.length === LIMIT && (await run(exact)).v?.t.length === LIMIT - 8, 'body of exactly the limit (bytes) is accepted');
  ok((await run(JSON.stringify({ t: 'a'.repeat(LIMIT - 7) }))).s === 413, 'one byte over the limit is refused with 413');

  // multi-byte: characters (UTF-16 units) stay far below the limit while bytes cross it
  const cases = [
    ['2-byte (e-acute)', 'é', 480, 500],
    ['3-byte (CJK)', '你', 330, 340],
    ['4-byte (emoji, 2 UTF-16 units each)', '😀', 240, 260],
    ['2-byte (Arabic)', 'ع', 480, 500],
  ];
  for (const [label, ch, below, above] of cases) {
    const lo = { t: ch.repeat(below) }, hi = { t: ch.repeat(above) };
    ok(bytesOf(lo) <= LIMIT && JSON.stringify(hi).length < LIMIT && bytesOf(hi) > LIMIT, `fixture sanity (${label}): the over-limit body has fewer than ${LIMIT} characters but more than ${LIMIT} bytes`, `${JSON.stringify(hi).length} chars / ${bytesOf(hi)} bytes`);
    const a = await run(JSON.stringify(lo)), b = await run(JSON.stringify(hi));
    ok(a.v?.t === lo.t, `${label}: just below the byte limit is accepted and decoded intact`, JSON.stringify(a).slice(0, 80));
    ok(b.s === 413, `${label}: above the byte limit is refused with 413 (a character-counting check would have let it through)`, JSON.stringify(b).slice(0, 80));
    const enc = new TextEncoder().encode(JSON.stringify(hi));
    const c = await srun([enc.slice(0, 500), enc.slice(500)]);
    ok(c.s === 413, `${label}: the same over-limit body sent as a stream (no Content-Length) is refused with 413`);
  }
  // a multi-byte character split across two chunks must decode correctly
  const split = new TextEncoder().encode(JSON.stringify({ t: 'é你😀' }));
  const cut = split.indexOf(0xC3) + 1;   // between the two bytes of é
  ok((await srun([split.slice(0, cut), split.slice(cut)])).v?.t === 'é你😀', 'a multi-byte character split across chunks is decoded correctly');
  ok((await srun([new Uint8Array([0x7b, 0xff, 0x7d])])).s === 400, 'invalid UTF-8 is refused with 400, not decoded with replacement characters');

  // misleading Content-Length
  const big = new TextEncoder().encode(JSON.stringify({ t: 'x'.repeat(5000) }));
  const bigChunks = [big.slice(0, 2000), big.slice(2000, 4000), big.slice(4000)];
  ok((await srun(bigChunks, { 'content-length': '10' })).s === 413, 'Content-Length understating the body (10) cannot bypass the streaming limit');
  ok((await srun(bigChunks, { 'content-length': '-5' })).s === 413, 'negative Content-Length cannot bypass the streaming limit');
  ok((await srun(bigChunks, { 'content-length': 'abc' })).s === 413, 'non-numeric Content-Length cannot bypass the streaming limit');
  ok((await srun(bigChunks, { 'content-length': '0' })).s === 413, 'Content-Length 0 with a large body cannot bypass the streaming limit');
  const small = new TextEncoder().encode(JSON.stringify({ a: 1 }));
  ok((await srun([small], { 'content-length': '999999' })).s === 413, 'an over-limit Content-Length is refused up front even when the real body is small');
  ok((await srun([small], { 'content-length': String(small.byteLength) })).v?.a === 1, 'an honest Content-Length with a small body is accepted');
  ok((await srun([small], { 'content-length': '1' })).v?.a === 1, 'a small body is still accepted when the header understates it but the real body is within the limit');
  // early stop: the reader is cancelled and not drained when the stream is oversized and the header lies
  let pulled = 0, cancelled = false;
  const endless = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(512)); }, cancel() { cancelled = true; } });
  let eres; try { await readJson(new Request('http://t/', { method: 'POST', headers: { 'content-length': '10' }, body: endless, duplex: 'half' }), LIMIT); } catch (e) { eres = e; }
  ok(eres?.status === 413 && cancelled && pulled <= 5, 'a lying Content-Length plus an endless stream: refused with 413, the stream is cancelled after a few chunks', `pulled=${pulled}`);
  // Finance keeps its own limit
  const fin = JSON.stringify({ items: Array.from({ length: 60 }, (_, i) => ({ d: 'é'.repeat(1500), q: 1, i })) });
  const finBytes = new TextEncoder().encode(fin).byteLength;
  let finOk = false, def413 = false;
  try { await readJson(req(fin), 200_000); finOk = finBytes < 200_000; } catch { /* */ }
  try { await readJson(req(fin), 32_768); } catch (e) { def413 = e.status === 413; }
  ok(finBytes > 32_768 && finBytes < 200_000 && finOk && def413, 'a 32 KB-200 KB multi-byte body passes the finance limit and fails the default one');
}

// =====================================================================================================
// Part B: real SQL (all migrations 001-027)
// =====================================================================================================
section('B migrations 001-027 on in-process Postgres');
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
  if (['020', '021', '022', '023', '024', '025', '026', '027'].some((p) => f.startsWith(p))) continue;
  try { await db.exec(fs.readFileSync(path.join(SB, 'migrations', f), 'utf8')); } catch (e) { ok(false, 'migration ' + f + ' applies', e.message.slice(0, 120)); }
  if (f.startsWith('005')) await db.exec(fs.readFileSync(path.join(SB, 'seed.sql'), 'utf8'));
}
ok(files.includes('020_atomic_role_replace.sql') && files.includes('021_auth_is_owner_privileges.sql') && files.includes('026_client_asset_scope_and_path_binding.sql') && files.includes('027_plan_asset_integrity_and_asset_ownership_guard.sql'), 'migrations 020, 021, 026 and 027 exist as separate files');

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

section('B3 Finance is executive-only (migration 022) - every finance table, every role');
// extra people: finance roles that belong to the Finance department, plus other non-executives
for (const [k, role] of [['fm', 'finance_manager'], ['acc', 'accountant'], ['dm', 'department_manager'], ['cli', 'client'], ['ceo2', 'ceo'], ['own2', 'owner']]) {
  U[k] = nid(++n);
  await db.query(`INSERT INTO auth.users(id,email) VALUES ($1,$2)`, [U[k], k + '@x.com']);
  await db.query(`INSERT INTO public.profiles(id,full_name,email,employment_status) VALUES ($1,$2,$3,'active')`, [U[k], k, k + '@x.com']);
  await db.query(`INSERT INTO public.user_roles(user_id,role_id) SELECT $1,id FROM public.roles WHERE name=$2`, [U[k], role]);
}
const finDept = (await db.query(`INSERT INTO public.departments(name, code) VALUES ('Finance','FIN') RETURNING id`)).rows[0].id;
const otherDept = (await db.query(`INSERT INTO public.departments(name, code) VALUES ('Creative','CRE') RETURNING id`)).rows[0].id;
for (const k of ['fm', 'acc']) {
  await db.query(`UPDATE public.profiles SET department_id=$1 WHERE id=$2`, [finDept, U[k]]);
  await db.query(`INSERT INTO public.user_departments(user_id, department_id, is_primary) VALUES ($1,$2,true)`, [U[k], finDept]);
}
await db.query(`UPDATE public.profiles SET department_id=$1 WHERE id=$2`, [otherDept, U.emp]);

const defVal = (c) => {
  const t = c.data_type;
  if (t === 'uuid') return crypto.randomUUID();
  if (t.includes('timestamp')) return new Date().toISOString();
  if (t === 'date') return '2026-01-15';
  if (t === 'boolean') return false;
  if (t === 'jsonb' || t === 'json') return '{}';
  if (['numeric', 'integer', 'bigint', 'smallint', 'double precision', 'real'].includes(t)) return 1;
  if (t === 'ARRAY') return '{}';
  return 'x';
};
const seed = async (table, ov = {}, schema = 'public') => {
  const cols = (await db.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2`, [schema, table])).rows;
  const names = [], vals = [];
  for (const c of cols) {
    if (c.column_name in ov) { names.push(c.column_name); vals.push(ov[c.column_name]); continue; }
    if (c.is_nullable === 'YES' || c.column_default !== null) continue;
    names.push(c.column_name); vals.push(defVal(c));
  }
  await db.exec(`SET session_replication_role = replica`);  // seed fixture rows without the finance guard triggers / FK checks
  try { await db.query(names.length ? `INSERT INTO ${schema}.${table}(${names.map((x) => '"' + x + '"').join(',')}) VALUES (${vals.map((_, i) => '$' + (i + 1)).join(',')})` : `INSERT INTO ${schema}.${table} DEFAULT VALUES`, vals); }
  finally { await db.exec(`SET session_replication_role = origin`); }
};
const cliA = crypto.randomUUID(), cliB = crypto.randomUUID();
await db.exec(`SET session_replication_role = replica`);
for (const [id, nm] of [[cliA, 'Client A (Finance dept client)'], [cliB, 'Client B (elsewhere)']]) await db.query(`INSERT INTO public.clients(id, name, company_name) VALUES ($1,$2,$2)`, [id, nm]);
await db.query(`INSERT INTO public.client_departments(client_id, department_id) VALUES ($1,$2)`, [cliA, finDept]);
await db.exec(`SET session_replication_role = origin`);
const inv = crypto.randomUUID(), expOther = crypto.randomUUID(), expOwn = crypto.randomUUID();
const FIN_TABLES = {
  finance_settings: {}, client_billing: { client_id: cliA }, retainer_plans: { client_id: cliA, name: 'Social media retainer' }, invoice_items: { invoice_id: inv, description_en: 'Design work' },
  invoice_payments: { invoice_id: inv }, invoice_number_seq: {}, finance_audit_log: {}, invoices: { id: inv, client_id: cliA, type: 'receivable' },
  budgets: {}, vendors: { name: 'Probe Vendor 2' }, money_figures: { entity: 'client_monthly', entity_id: cliA },
};
const seeded = [];
for (const [t, ov] of Object.entries(FIN_TABLES)) {
  if (t === 'finance_settings') { seeded.push(t); continue; } // singleton row is created by migration 017 itself
  try { await seed(t, ov); seeded.push(t); } catch (e) { ok(false, `seed ${t}`, e.message.slice(0, 140)); }
}
try { await seed('expenses', { id: expOther, submitted_by: U.sa1, status: 'submitted', amount: 700, title: 'Other claim', category: 'software' }); await seed('expenses', { id: expOwn, submitted_by: U.emp, status: 'submitted', amount: 500, title: 'Own claim', category: 'software' }); seeded.push('expenses'); } catch (e) { ok(false, 'seed expenses', e.message.slice(0, 140)); }
try { await seed('expense_approvals', { expense_id: expOwn, approver_id: U.sa1, action: 'approved' }); seeded.push('expense_approvals'); } catch (e) { ok(false, 'seed expense_approvals', e.message.slice(0, 140)); }
await seed('audit_logs', { action: 'EXPENSE_APPROVED', entity_type: 'expenses' });
await seed('audit_logs', { action: 'EMPLOYEE_UPDATED', entity_type: 'profiles' });
const ALL_FIN = [...seeded];
const count = async (role, user, t, where = '') => { const r = await as(role, user, `SELECT count(*)::int c FROM public.${t} ${where}`); return r.error ? 'ERR:' + r.error : r.rows[0].c; };

// the leak that migration 017 introduced, shown BEFORE the fix (proves the tests can fail)
const leaksBefore = [];
for (const t of ALL_FIN) if ((await count('authenticated', 'fm', t)) > 0 || (await count('authenticated', 'acc', t)) > 0) leaksBefore.push(t);
console.log('  before 022, finance_manager/accountant could read:', leaksBefore.join(', ') || 'nothing');
ok(leaksBefore.length >= 8, 'precondition: before migration 022 the finance roles read finance tables (migration 017 widened it)', leaksBefore.join());
const clientsBeforeFm = await count('authenticated', 'fm', 'clients');
ok(clientsBeforeFm === 2, 'precondition: before 022 a finance role sees every client (clients_select_finance)', String(clientsBeforeFm));

await db.exec(fs.readFileSync(path.join(SB, 'migrations/022_finance_executive_only.sql'), 'utf8'));
await db.exec(fs.readFileSync(path.join(SB, 'migrations/022_finance_executive_only.sql'), 'utf8')); // idempotent

const EXEC_USERS = [['super_admin', 'sa2'], ['owner', 'own'], ['owner', 'own2'], ['ceo', 'ceo'], ['ceo', 'ceo2']];
const DENIED_USERS = [['general_manager', 'gm'], ['hr_manager', 'hr'], ['finance_manager (Finance dept)', 'fm'], ['accountant (Finance dept)', 'acc'], ['department_manager', 'dm'], ['employee', 'emp'], ['client', 'cli']];
for (const t of ALL_FIN) {
  for (const [label, u] of EXEC_USERS) {
    const c = await count('authenticated', u, t);
    ok(typeof c === 'number' && c >= 1, `${t}: ${label} (${u}) can read`, String(c));
  }
  for (const [label, u] of DENIED_USERS) {
    const c = await count('authenticated', u, t);
    ok(c === 0, `${t}: ${label} reads nothing`, String(c));
  }
  const a = await as('anon', null, `SELECT count(*) FROM public.${t}`);
  ok(a.error !== undefined, `${t}: anon has no access`);
}
section('B3b direct-object access and writes');
for (const [label, u] of DENIED_USERS) {
  ok((await as('authenticated', u, `SELECT * FROM public.invoices WHERE id=$1`, [inv])).rows?.length === 0, `${label}: direct SELECT of an invoice by id returns nothing`);
  ok((await as('authenticated', u, `SELECT * FROM public.expenses WHERE id=$1`, [expOwn])).rows?.length === 0, `${label}: direct SELECT of an expense claim by id returns nothing (even the submitter's own)`);
  ok((await as('authenticated', u, `SELECT * FROM public.invoice_payments`)).rows?.length === 0, `${label}: payments invisible`);
}
ok((await as('authenticated', 'emp', `SELECT id FROM public.expenses WHERE submitted_by=$1`, [U.emp])).rows.length === 0, 'the submitter cannot read back their own expense claim');
ok((await as('authenticated', 'ceo', `SELECT * FROM public.expenses WHERE id=$1`, [expOwn])).rows.length === 1, 'ceo can read any expense claim by id');
for (const t of ['budgets', 'vendors', 'invoices', 'money_figures', 'finance_settings', 'invoice_payments', 'expense_approvals']) for (const [label, u] of DENIED_USERS) {
  const w = await as('authenticated', u, `DELETE FROM public.${t}`);
  ok(w.error !== undefined || w.rows?.length === 0, `${label}: cannot delete from ${t}`);
}
ok((await as('authenticated', 'fm', `INSERT INTO public.vendors(name) VALUES ('Planted')`)).error !== undefined, 'finance_manager cannot write vendors');
ok((await as('authenticated', 'acc', `INSERT INTO public.budgets(name) VALUES ('Planted')`)).error !== undefined, 'accountant cannot write budgets');
ok((await as('authenticated', 'emp', `INSERT INTO public.expenses(title, amount, category, submitted_by, status) VALUES ('Taxi', 40, 'travel', '${U.emp}', 'submitted')`)).error === undefined, 'filing a claim (INSERT) is still allowed for staff; it just cannot be read back');
ok((await as('authenticated', 'cli', `INSERT INTO public.expenses(title, amount, category, submitted_by, status) VALUES ('Taxi', 40, 'travel', '${U.cli}', 'submitted')`)).error !== undefined, 'a client cannot file a claim');

section('B3c clients (cross-client / department scope) and the Finance department');
ok((await count('authenticated', 'fm', 'clients')) === 1, 'finance_manager in the Finance department sees only its department\'s client, not every client');
ok((await as('authenticated', 'fm', `SELECT * FROM public.clients WHERE id=$1`, [cliB])).rows.length === 0, 'finance_manager: direct SELECT of another department\'s client returns nothing');
ok((await as('authenticated', 'fm', `SELECT * FROM public.clients WHERE id=$1`, [cliA])).rows.length === 1, 'finance_manager keeps normal department-scoped client visibility');
ok((await count('authenticated', 'own', 'clients')) === 2 && (await count('authenticated', 'ceo', 'clients')) === 2 && (await count('authenticated', 'sa2', 'clients')) === 2, 'executives still see all clients');
ok((await as('authenticated', 'cli', `SELECT * FROM public.clients`)).rows.length === 0, 'a client-role user sees no clients, hence no cross-client data');

section('B3d predicates, functions, storage, audit log');
for (const [label, u] of EXEC_USERS) ok((await as('authenticated', u, `SELECT public.auth_is_finance() x`)).rows[0].x === true, `auth_is_finance() true for ${label} (${u})`);
for (const [label, u] of DENIED_USERS) ok((await as('authenticated', u, `SELECT public.auth_is_finance() x`)).rows[0].x === false, `auth_is_finance() false for ${label}`);
ok((await as('anon', null, `SELECT public.auth_is_finance()`)).error?.includes('permission denied'), 'anon cannot call auth_is_finance()');
const finFns = (await db.query(`SELECT p.oid::regprocedure::text AS sig, proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND proname LIKE 'fin\\_%'`)).rows;
ok(finFns.length >= 15, `inventory: ${finFns.length} fin_* SQL functions found`);
for (const f of finFns) {
  const pure = ['fin_round', 'fin_calc_line'].includes(f.proname); // arithmetic helpers, no data
  const trig = (await db.query(`SELECT prorettype::regtype::text AS r FROM pg_proc WHERE oid = $1::regprocedure`, [f.sig])).rows[0].r === 'trigger'; // only callable as triggers
  if (pure || trig) continue;
  ok((await priv('anon', f.sig)) === false && (await priv('authenticated', f.sig)) === false && (await priv('service_role', f.sig)) === true, `${f.sig}: executable by service_role only (not by anon or authenticated)`);
}
ok(finFns.some((f) => f.proname === 'fin_invoice_save') && finFns.some((f) => f.proname === 'fin_payment_add'), 'the data-changing finance functions are in the inventory');
ok((await as('authenticated', 'own', `SELECT * FROM finance_backup.invoices_pre017`)).error !== undefined, 'the finance_backup schema is unreachable through the API even for an owner');
ok((await db.query(`SELECT count(*)::int c FROM storage.buckets WHERE name ILIKE '%financ%' OR name ILIKE '%invoice%' OR name ILIKE '%payroll%'`)).rows[0].c === 0, 'storage: no finance/invoice bucket exists');
ok((await db.query(`SELECT count(*)::int c FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='storage' AND (pg_get_expr(p.polqual,p.polrelid) ILIKE '%invoice%' OR pg_get_expr(p.polqual,p.polrelid) ILIKE '%financ%')`)).rows[0].c === 0, 'storage policies reference no finance object');
const auditCount = (u) => count('authenticated', u, 'audit_logs');
ok((await auditCount('gm')) === 1, 'general_manager still sees the non-finance audit event but not the finance one');
ok((await as('authenticated', 'gm', `SELECT action FROM public.audit_logs`)).rows.map((r) => r.action).join() === 'EMPLOYEE_UPDATED', 'GM sees EMPLOYEE_UPDATED only');
ok((await auditCount('own')) === 2 && (await auditCount('sa2')) === 2, 'owner and super_admin see both audit events');
ok((await as('authenticated', 'ceo', `SELECT action FROM public.audit_logs`)).rows.map((r) => r.action).join() === 'EXPENSE_APPROVED', 'ceo sees the finance audit event (and is unchanged for the rest)');
ok((await auditCount('fm')) === 0 && (await auditCount('emp')) === 0 && (await auditCount('hr')) === 0, 'finance_manager, employee and HR read no audit events');
// publication: tables in realtime are protected by the same RLS (postgres_changes evaluates policies per subscriber)
const pol = (await db.query(`SELECT c.relname, p.polcmd FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relname IN ('invoices','invoice_payments','retainer_plans','client_billing','expenses') AND p.polcmd IN ('r','*') AND pg_get_expr(p.polqual,p.polrelid) !~* 'auth_is_(finance|owner)\\(\\)'`)).rows;
ok(pol.length === 0, 'every SELECT policy on the realtime-published finance tables is executive-only', JSON.stringify(pol));
ok((await as('authenticated', 'own', `SELECT count(*)::int c FROM public.vendors`)).rows[0].c >= 1, 'owner still reads vendors after the migration');

section('B4 confidential Finance files in the document library and Storage (migration 024)');
{
  const ins = async (name, folder, vis, by, extra = '') => (await db.query(`INSERT INTO public.assets(name,file_name,file_size,file_type,storage_path,folder,visibility,uploaded_by) VALUES ($1,$1,10,'PDF',$2,$3,$4,$5) RETURNING id`, [name, `${U[by]}/${name}.pdf`, folder, vis, U[by]])).rows[0].id;
  const A = {};
  A.contract = await ins('contract-studio', 'Contracts', 'studio', 'emp');       // studio-wide by default, uploaded by an employee
  A.contractPrivate = await ins('contract-private', 'Contracts', 'private', 'hr'); // private to its uploader (admins still saw it)
  A.plain = await ins('brand-guide', 'Branding', 'studio', 'emp');
  A.legal = await ins('retainer-terms', 'Legal', 'studio', 'emp');                // not a Contracts folder: needs an explicit flag
  for (const k of Object.keys(A)) await db.query(`INSERT INTO storage.objects(bucket_id,name,owner_id) SELECT 'studio-assets', storage_path, uploaded_by::text FROM public.assets WHERE id=$1`, [A[k]]);
  const seen = async (u) => (await as('authenticated', u, `SELECT name FROM public.assets ORDER BY name`)).rows?.map((r) => r.name).join(',');
  const objs = async (u) => (await as('authenticated', u, `SELECT name FROM storage.objects WHERE bucket_id='studio-assets' ORDER BY name`)).rows?.map((r) => r.name.split('/')[1]).join(',');
  // FINDING (pre-existing, migration 007): the policy compares `a.storage_path = name`, and inside that subquery `name`
  // is assets.name (the display name), not the object's name, so as written it matches no object for ANYONE.
  ok((await objs('own')) === '' && (await objs('sa2')) === '', 'finding: the 007 studio_assets_read policy as written matches no object for anyone, not even an owner (fails closed)');
  // The checks below use the policy in its INTENDED form (qualified objects.name). TEST-ONLY override, not a migration.
  await db.exec(`DROP POLICY "studio_assets_read" ON storage.objects; CREATE POLICY "studio_assets_read" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'studio-assets' AND EXISTS (SELECT 1 FROM public.assets a WHERE a.storage_path = objects.name));`);
  ok((await seen('gm')).includes('contract-studio') && (await seen('gm')).includes('contract-private') && (await seen('emp')).includes('contract-studio'), 'precondition: before 024 a general_manager reads every contract (even private) and any employee reads the studio-wide one', await seen('gm'));
  ok((await objs('fm')).includes('contract-studio.pdf'), 'precondition: before 024 the contract file object is readable by any staff member (finance_manager here)');

  await db.exec(fs.readFileSync(path.join(SB, 'migrations/024_finance_confidential_assets.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(SB, 'migrations/024_finance_confidential_assets.sql'), 'utf8')); // idempotent
  const flag = async (id) => (await db.query(`SELECT finance_confidential f FROM public.assets WHERE id=$1`, [id])).rows[0].f;
  ok((await flag(A.contract)) && (await flag(A.contractPrivate)) && !(await flag(A.plain)) && !(await flag(A.legal)), 'existing Contracts rows are flagged by the backfill; other folders are not (folder name only restricts)');
  for (const u of ['sa2', 'own', 'own2', 'ceo', 'ceo2']) ok((await seen(u)) === 'brand-guide,contract-private,contract-studio,retainer-terms', `${u}: sees every file including the contracts`, await seen(u));
  for (const [label, u] of [['general_manager', 'gm'], ['hr_manager', 'hr'], ['finance_manager (Finance dept)', 'fm'], ['accountant (Finance dept)', 'acc'], ['department_manager', 'dm'], ['employee/uploader', 'emp']]) {
    const names = await seen(u);
    ok(!names.includes('contract'), `${label}: no contract is listed`, names);
    ok(!(await objs(u)).includes('contract'), `${label}: no contract file object is readable in Storage`, await objs(u));
    ok((await as('authenticated', u, `SELECT * FROM public.assets WHERE id=$1`, [A.contract])).rows?.length === 0, `${label}: direct SELECT of the contract by id returns nothing`);
  }
  ok((await seen('emp')).includes('brand-guide') && (await seen('gm')).includes('brand-guide'), 'unflagged files keep their normal visibility');
  for (const u of ['sa2', 'own', 'ceo']) ok((await objs(u)).includes('contract-studio.pdf') && (await objs(u)).includes('contract-private.pdf'), `${u}: contract file objects readable in Storage`);
  ok((await as('anon', null, `SELECT * FROM public.assets`)).error !== undefined, 'anon has no access to assets');
  // writes
  const w1 = await as('authenticated', 'emp', `INSERT INTO public.assets(name,file_name,file_size,file_type,storage_path,folder,visibility,uploaded_by) VALUES ('c2','c2',1,'PDF','${U.emp}/c2.pdf','Contracts','studio','${U.emp}')`);
  ok(w1.error !== undefined, 'an employee cannot add a file to the Contracts folder (RLS)', w1.error);
  const w2 = await as('authenticated', 'emp', `INSERT INTO public.assets(name,file_name,file_size,file_type,storage_path,folder,visibility,uploaded_by) VALUES ('c3','c3',1,'PDF','${U.emp}/c3.pdf','contracts','studio','${U.emp}')`);
  ok(w2.error !== undefined, 'the folder rule is case-insensitive');
  ok((await as('authenticated', 'emp', `INSERT INTO public.assets(name,file_name,file_size,file_type,storage_path,folder,visibility,uploaded_by) VALUES ('ok1','ok1',1,'PDF','${U.emp}/ok1.pdf','Branding','studio','${U.emp}')`)).error === undefined, 'an employee can still add ordinary files');
  ok((await as('authenticated', 'emp', `UPDATE public.assets SET folder='Contracts' WHERE name='ok1'`)).error !== undefined, 'an employee cannot move an ordinary file into Contracts');
  ok((await as('authenticated', 'gm', `UPDATE public.assets SET finance_confidential=false WHERE id=$1`, [A.contract])).rows?.length === 0 || (await flag(A.contract)), 'a general_manager cannot see or unflag a contract');
  ok((await flag(A.contract)) && (await as('authenticated', 'gm', `DELETE FROM public.assets WHERE id=$1`, [A.contract])).error === undefined && (await flag(A.contract)) !== undefined, 'a general_manager cannot delete a contract (row still there)');
  ok((await db.query(`SELECT count(*)::int c FROM public.assets WHERE id=$1`, [A.contract])).rows[0].c === 1, 'the contract row survived the GM delete attempt');
  // executives can flag any file and clear flags; non-executives cannot clear
  ok((await as('authenticated', 'ceo', `UPDATE public.assets SET finance_confidential=true WHERE id=$1`, [A.legal])).error === undefined && (await flag(A.legal)), 'ceo can flag any file as confidential Finance');
  ok(!(await seen('emp')).includes('retainer-terms') && !(await seen('gm')).includes('retainer-terms'), 'once flagged, the file disappears for employees and general_manager');
  ok((await as('authenticated', 'own', `UPDATE public.assets SET finance_confidential=false, folder='Legal' WHERE id=$1`, [A.legal])).error === undefined && !(await flag(A.legal)) && (await seen('emp')).includes('retainer-terms'), 'an executive can clear the flag');
  await as('authenticated', 'own', `UPDATE public.assets SET folder='Contracts' WHERE id=$1`, [A.legal]);
  ok(await flag(A.legal), 'moving a file into Contracts re-flags it, and the flag cannot be cleared while it stays there');
  await as('authenticated', 'own', `UPDATE public.assets SET finance_confidential=false WHERE id=$1`, [A.legal]);
  ok(await flag(A.legal), 'folder rule wins over an attempt to clear the flag');
  ok((await db.query(`SELECT count(*)::int c FROM storage.buckets WHERE name ILIKE '%financ%'`)).rows[0].c === 0, 'no separate finance bucket (confidential files live behind the assets flag)');
}

section('B5 redaction of existing financial notifications (migration 025)');
{
  const mk = async (user, type, title, content) => (await db.query(`INSERT INTO public.notifications(user_id,type,title,content,link,is_read,metadata) VALUES ($1,$2,$3,$4,'#finance',$5,'{"k":1}') RETURNING id`, [U[user], type, title, content, user === 'hr'])).rows[0].id;
  const N = {};
  const recipients = { sa2: 'super_admin', own: 'owner', ceo: 'ceo', gm: 'general_manager', fm: 'finance_manager', acc: 'accountant', hr: 'hr_manager', emp: 'employee' };
  for (const u of Object.keys(recipients)) {
    N['req_' + u] = await mk(u, 'expense_request', 'Expense claim to approve', 'Ahmed: Camera rental (EGP 1250.50)');
    N['inv_' + u] = await mk(u, 'invoice_drafts', 'Retainer invoices ready to review', '7 draft invoices created for 2026-11. Review and send them.');
    N['dec_' + u] = await mk(u, 'expense_decision', 'Expense approved', 'Camera rental');
    N['oth_' + u] = await mk(u, 'task_assigned', 'New task', 'Deliver logo (budget EGP 900 discussed)');
  }
  const snapshot = async () => (await db.query(`SELECT id, user_id, type, title, link, is_read, metadata::text AS metadata, created_at::text AS created_at, content FROM public.notifications ORDER BY id`)).rows;
  const before = await snapshot();
  const exec = ['sa2', 'own', 'ceo'], non = ['gm', 'fm', 'acc', 'hr', 'emp'];
  const readable = async (u) => (await as('authenticated', u, `SELECT content FROM public.notifications WHERE type IN ('expense_request','invoice_drafts')`)).rows.map((r) => r.content).join(' | ');
  for (const u of ['gm', 'fm', 'acc']) ok(/EGP 1250/.test(await readable(u)) || /7 draft/.test(await readable(u)), `precondition: ${u} can read amounts / counts in their notifications before the redaction`);
  await db.exec(fs.readFileSync(path.join(SB, 'migrations/025_redact_financial_notifications.sql'), 'utf8'));
  const after = await snapshot();
  ok(after.length === before.length, 'no notification was deleted', `${before.length} -> ${after.length}`);
  const byId = new Map(before.map((r) => [r.id, r]));
  let diffs = 0, contentChanged = 0;
  for (const r of after) { const o = byId.get(r.id); for (const k of Object.keys(o)) if (k !== 'content' && o[k] !== r[k]) diffs++; if (o.content !== r.content) contentChanged++; }
  ok(diffs === 0, 'ids, recipients, types, titles, links, read state, metadata and timestamps are all unchanged', 'diffs=' + diffs);
  ok(contentChanged === non.length * 2, `exactly the ${non.length * 2} financial notifications of non-executives changed content`, 'changed=' + contentChanged);
  for (const u of non) {
    for (const t of ['req', 'inv']) { const row = after.find((r) => r.id === N[`${t}_${u}`]); ok(!/\d/.test(row.content) && /executives only/.test(row.content), `${u}: ${t === 'req' ? 'expense_request' : 'invoice_drafts'} redacted (no digits, no title, no names)`, row.content); }
    ok(!/\d|Camera/.test(await readable(u)), `${u}: nothing financial is readable through their own notification feed`);
    ok(after.find((r) => r.id === N['dec_' + u]).content === 'Camera rental' && after.find((r) => r.id === N['oth_' + u]).content.includes('EGP 900'), `${u}: unrelated notification types are untouched`);
  }
  for (const u of exec) for (const t of ['req', 'inv']) ok(after.find((r) => r.id === N[`${t}_${u}`]).content === byId.get(N[`${t}_${u}`]).content, `${u} (executive): original ${t} notification untouched`);
  ok((await db.query(`SELECT count(*)::int c FROM finance_backup.notifications_pre025`)).rows[0].c === non.length * 2, 'the originals of the redacted rows are in finance_backup.notifications_pre025');
  ok((await as('authenticated', 'own', `SELECT * FROM finance_backup.notifications_pre025`)).error !== undefined, 'the backup is unreachable through the API, even for an owner');
  const mid = await snapshot();
  await db.exec(fs.readFileSync(path.join(SB, 'migrations/025_redact_financial_notifications.sql'), 'utf8'));
  ok(JSON.stringify(mid) === JSON.stringify(await snapshot()) && (await db.query(`SELECT count(*)::int c FROM finance_backup.notifications_pre025`)).rows[0].c === non.length * 2, 'running it again changes nothing (idempotent, backup keeps the first original)');
  await db.exec(`UPDATE public.notifications n SET content = b.original_content FROM finance_backup.notifications_pre025 b WHERE b.id = n.id`);
  ok(JSON.stringify(before) === JSON.stringify(await snapshot()), 'the documented rollback restores every row exactly');
  await db.exec(fs.readFileSync(path.join(SB, 'migrations/025_redact_financial_notifications.sql'), 'utf8'));
}

section('B6 last active super_admin guard, database level (migration 023)');
{
  // make the fixtures clean: every earlier super_admin is suspended, then two fresh active ones
  await db.exec(`UPDATE public.profiles SET employment_status='suspended' WHERE id IN (SELECT ur.user_id FROM public.user_roles ur JOIN public.roles r ON r.id=ur.role_id WHERE r.name='super_admin')`);
  const mkSa = async (k, status = 'active', role = 'super_admin') => {
    U[k] = nid(++n);
    await db.query(`INSERT INTO auth.users(id,email) VALUES ($1,$2)`, [U[k], k + '@x.com']);
    await db.query(`INSERT INTO public.profiles(id,full_name,email,employment_status) VALUES ($1,$2,$3,$4)`, [U[k], k, k + '@x.com', status]);
    await db.query(`INSERT INTO public.user_roles(user_id,role_id) SELECT $1,id FROM public.roles WHERE name=$2`, [U[k], role]);
  };
  await mkSa('g1'); await mkSa('g2');
  await db.exec(fs.readFileSync(path.join(SB, 'migrations/023_last_super_admin_guard.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(SB, 'migrations/023_last_super_admin_guard.sql'), 'utf8')); // idempotent
  const active = async () => (await db.query(`SELECT count(*)::int c FROM public.user_roles ur JOIN public.roles r ON r.id=ur.role_id AND r.name='super_admin' AND r.is_active JOIN public.profiles p ON p.id=ur.user_id AND p.employment_status='active'`)).rows[0].c;
  const attempt = async (sql, params = []) => { try { await db.query(sql, params); return 'ok'; } catch (e) { return e.message; } };
  ok((await active()) === 2, 'fixture: two active super_admins');
  ok((await attempt(`UPDATE public.profiles SET employment_status='suspended' WHERE id=$1`, [U.g1])) === 'ok' && (await active()) === 1, 'suspending one of two is allowed');
  const refused = async (sql, params, what) => { const r = await attempt(sql, params); ok(/last_super_admin/.test(r) && (await active()) === 1, `${what}: refused, one active super_admin remains`, r); };
  await refused(`UPDATE public.profiles SET employment_status='suspended' WHERE id=$1`, [U.g2], 'suspend the last one');
  await refused(`UPDATE public.profiles SET employment_status='inactive' WHERE id=$1`, [U.g2], 'deactivate the last one');
  await refused(`DELETE FROM public.profiles WHERE id=$1`, [U.g2], 'delete the last one (profile)');
  await refused(`DELETE FROM auth.users WHERE id=$1`, [U.g2], 'delete the last one (auth user, cascades)');
  await refused(`SELECT public.replace_user_role($1,(SELECT id FROM public.roles WHERE name='employee'),$1)`, [U.g2], 'demote the last one (replace_user_role)');
  await refused(`DELETE FROM public.user_roles WHERE user_id=$1`, [U.g2], 'remove the last one\'s role row');
  await refused(`UPDATE public.user_roles SET role_id=(SELECT id FROM public.roles WHERE name='employee') WHERE user_id=$1`, [U.g2], 're-point the last one\'s role row');
  await refused(`UPDATE public.roles SET is_active=false WHERE name='super_admin'`, [], 'deactivate the super_admin role');
  await refused(`DELETE FROM public.roles WHERE name='super_admin'`, [], 'delete the super_admin role');
  ok((await attempt(`SELECT public.replace_user_role($1,(SELECT id FROM public.roles WHERE name='super_admin'),$1)`, [U.g2])) === 'ok' && (await active()) === 1, 're-assigning super_admin to the last one is fine (same row)');
  ok((await attempt(`UPDATE public.user_roles SET assigned_by=NULL WHERE user_id=$1`, [U.g2])) === 'ok', 'harmless updates are not blocked');
  ok((await attempt(`UPDATE public.profiles SET employment_status='suspended' WHERE id=$1`, [U.g1])) === 'ok', 'an already-inactive super_admin can be updated freely');
  ok((await attempt(`DELETE FROM public.profiles WHERE id=$1`, [U.g1])) === 'ok' && (await active()) === 1, 'and removed');
  await mkSa('g3', 'active', 'employee');
  ok((await attempt(`UPDATE public.profiles SET employment_status='suspended' WHERE id=$1`, [U.g3])) === 'ok' && (await attempt(`DELETE FROM auth.users WHERE id=$1`, [U.g3])) === 'ok', 'ordinary employees are unaffected');
  await mkSa('g4');
  ok((await attempt(`UPDATE public.profiles SET employment_status='suspended' WHERE id=$1`, [U.g2])) === 'ok' && (await active()) === 1, 'with another active super_admin the first can go');
  ok((await attempt(`DELETE FROM public.profiles WHERE id=$1`, [U.g4])).includes('last_super_admin'), 'and the new last one is protected');
  ok((await as('authenticated', 'own', `SELECT public.guard_last_super_admin()`)).error !== undefined, 'the guard function is not callable through the API');
}

section('B7 client asset ownership and department scoping (migration 026)');
{
  await db.exec(`UPDATE public.profiles SET employment_status='active' WHERE id IN ('${U.sa2}','${U.own}','${U.ceo}')`);
  await db.exec(fs.readFileSync(path.join(SB, 'migrations/026_client_asset_scope_and_path_binding.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(SB, 'migrations/026_client_asset_scope_and_path_binding.sql'), 'utf8')); // idempotent

  // 1. Storage path binding trigger tests (P2-05)
  // 1a. Insert with mismatched storage path prefix is rejected
  const badPrefix = await as('authenticated', 'emp', `INSERT INTO public.assets(name,file_name,file_size,file_type,storage_path,folder,visibility,uploaded_by) VALUES ('bad','bad',10,'PDF','${U.sa1}/bad.pdf','General','studio','${U.emp}')`);
  ok(badPrefix.error && badPrefix.error.includes('Asset storage path must start with the uploader id'), 'insert with mismatched storage_path prefix is rejected', badPrefix.error);

  // 1b. Insert without slash is rejected
  const noSlash = await as('authenticated', 'emp', `INSERT INTO public.assets(name,file_name,file_size,file_type,storage_path,folder,visibility,uploaded_by) VALUES ('bad','bad',10,'PDF','noslash.pdf','General','studio','${U.emp}')`);
  ok(noSlash.error && noSlash.error.includes('Asset storage path must start with the uploader id'), 'insert with no slash in storage_path is rejected', noSlash.error);

  // 1c. Insert with matching uploader folder succeeds
  const goodIns = await as('authenticated', 'emp', `INSERT INTO public.assets(name,file_name,file_size,file_type,storage_path,folder,visibility,uploaded_by) VALUES ('good','good',10,'PDF','${U.emp}/good.pdf','General','studio','${U.emp}') RETURNING id`);
  ok(goodIns.rows?.length === 1, 'insert with matching uploader prefix succeeds', JSON.stringify(goodIns));
  const goodId = goodIns.rows?.[0]?.id;

  // 1d. Storage path is immutable on update
  const pathUpdate = await as('authenticated', 'emp', `UPDATE public.assets SET storage_path='${U.emp}/changed.pdf' WHERE id='${goodId}'`);
  ok(pathUpdate.error && pathUpdate.error.includes('Asset storage path cannot be changed'), 'updating storage_path is rejected by the trigger', pathUpdate.error);

  // 1e. Updating other fields succeeds leaving storage_path intact
  const nameUpdate = await as('authenticated', 'emp', `UPDATE public.assets SET name='renamed' WHERE id='${goodId}'`);
  ok(nameUpdate.error === undefined, 'updating other fields succeeds');
  const checkRow = await as('authenticated', 'emp', `SELECT name, storage_path FROM public.assets WHERE id='${goodId}'`);
  ok(checkRow.rows?.[0]?.name === 'renamed' && checkRow.rows?.[0]?.storage_path === `${U.emp}/good.pdf`, 'name changed while storage_path remained intact');

  // 2. Client-scoped assets tests (P2-04)
  // Setup (superuser fixtures): Client A belongs to finDept only (fm, acc are in it); Client B belongs to otherDept only.
  // Client B had NO department link before, so the earlier "department staff see it" assertion could only pass through the
  // uploader exception. It is linked here, and the checks below use a NON-uploader in each department.
  await db.exec(`SET session_replication_role = replica`);
  await db.query(`INSERT INTO public.client_departments(client_id, department_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [cliB, otherDept]);
  await db.query(`UPDATE public.profiles SET department_id=$1 WHERE id=$2`, [otherDept, U.dm]);
  await db.exec(`SET session_replication_role = origin`);
  // Insert asset for Client A uploaded by fm (visibility = 'studio'):
  const aClientA = (await db.query(`INSERT INTO public.assets(name,file_name,file_size,file_type,storage_path,folder,visibility,client_id,uploaded_by) VALUES ('client-a-deck','a.pdf',100,'PDF','${U.fm}/client-a-deck.pdf','Clients','studio','${cliA}','${U.fm}') RETURNING id`)).rows[0].id;

  // Insert asset for Client B uploaded by emp (visibility = 'studio'):
  const aClientB = (await db.query(`INSERT INTO public.assets(name,file_name,file_size,file_type,storage_path,folder,visibility,client_id,uploaded_by) VALUES ('client-b-deck','b.pdf',100,'PDF','${U.emp}/client-b-deck.pdf','Clients','studio','${cliB}','${U.emp}') RETURNING id`)).rows[0].id;

  // 2a. Client A's asset was uploaded by fm. The uploader sees it (exception), and so does a NON-uploader in the client's department (acc).
  const fmSeeA = await as('authenticated', 'fm', `SELECT id FROM public.assets WHERE id='${aClientA}'`);
  ok(fmSeeA.rows?.length === 1, 'the uploader (fm) sees their Client A asset');
  const accSeeA = await as('authenticated', 'acc', `SELECT id FROM public.assets WHERE id='${aClientA}'`);
  ok(accSeeA.rows?.length === 1, 'a NON-uploader in the client\'s department (acc, Finance dept) sees the Client A asset through department scoping');

  // 2b. emp (in otherDept, outside Client A) CANNOT see Client A's asset (even though visibility = 'studio')
  const empSeeA = await as('authenticated', 'emp', `SELECT id FROM public.assets WHERE id='${aClientA}'`);
  ok(empSeeA.rows?.length === 0, 'cross-department isolation: staff outside client department (emp) cannot see Client A asset');

  // 2c. Direct object query by id by emp returns 0 rows
  const empDirect = await as('authenticated', 'emp', `SELECT * FROM public.assets WHERE id='${aClientA}'`);
  ok(empDirect.rows?.length === 0, 'direct SELECT by id of client asset outside user departments returns nothing');

  // 2d. Client B's asset was uploaded by emp. dm is a NON-uploader who is in otherDept, the department Client B now belongs to.
  const dmSeeB = await as('authenticated', 'dm', `SELECT id FROM public.assets WHERE id='${aClientB}'`);
  ok(dmSeeB.rows?.length === 1, 'a NON-uploader in Client B\'s department (dm) sees the Client B asset through department scoping');
  const empSeeB = await as('authenticated', 'emp', `SELECT id FROM public.assets WHERE id='${aClientB}'`);
  ok(empSeeB.rows?.length === 1, 'the uploader (emp) sees their own Client B asset');

  // 2e. fm (in finDept, outside Client B) CANNOT see Client B's asset
  const fmSeeB = await as('authenticated', 'fm', `SELECT id FROM public.assets WHERE id='${aClientB}'`);
  ok(fmSeeB.rows?.length === 0, 'cross-department isolation: fm cannot see Client B asset');

  // 2f. Executives (own, sa2, ceo) can see ALL client assets
  for (const exec of ['own', 'sa2', 'ceo']) {
    const seeA = await as('authenticated', exec, `SELECT id FROM public.assets WHERE id='${aClientA}'`);
    const seeB = await as('authenticated', exec, `SELECT id FROM public.assets WHERE id='${aClientB}'`);
    ok(seeA.rows?.length === 1 && seeB.rows?.length === 1, `executive ${exec} sees all client assets regardless of department`);
  }

  // 2g. Uploader access preserved: if emp uploaded an asset for cliA, emp can still see it
  const aClientAByEmp = (await db.query(`INSERT INTO public.assets(name,file_name,file_size,file_type,storage_path,folder,visibility,client_id,uploaded_by) VALUES ('client-a-by-emp','a.pdf',100,'PDF','${U.emp}/client-a-by-emp.pdf','Clients','studio','${cliA}','${U.emp}') RETURNING id`)).rows[0].id;
  const empSeeOwnUpload = await as('authenticated', 'emp', `SELECT id FROM public.assets WHERE id='${aClientAByEmp}'`);
  ok(empSeeOwnUpload.rows?.length === 1, 'uploader access preserved: creator sees own upload even outside client department');

  // 2h. Non-client studio assets remain visible to all staff
  const aStudioPlain = (await db.query(`INSERT INTO public.assets(name,file_name,file_size,file_type,storage_path,folder,visibility,uploaded_by) VALUES ('studio-guide','g.pdf',10,'PDF','${U.own}/studio-guide.pdf','General','studio','${U.own}') RETURNING id`)).rows[0].id;
  for (const u of ['emp', 'fm', 'gm', 'own']) {
    const seeStudio = await as('authenticated', u, `SELECT id FROM public.assets WHERE id='${aStudioPlain}'`);
    ok(seeStudio.rows?.length === 1, `non-client studio asset is visible to ${u}`);
  }

  // 2i. Confidential finance files remain executive-only
  const aConfidentialClient = (await db.query(`INSERT INTO public.assets(name,file_name,file_size,file_type,storage_path,folder,visibility,client_id,uploaded_by) VALUES ('client-a-contract','c.pdf',10,'PDF','${U.own}/client-a-contract.pdf','Contracts','studio','${cliA}','${U.own}') RETURNING id`)).rows[0].id;
  ok((await as('authenticated', 'fm', `SELECT id FROM public.assets WHERE id='${aConfidentialClient}'`)).rows?.length === 0, 'confidential finance client asset is invisible to fm');
  ok((await as('authenticated', 'emp', `SELECT id FROM public.assets WHERE id='${aConfidentialClient}'`)).rows?.length === 0, 'confidential finance client asset is invisible to emp');
  ok((await as('authenticated', 'own', `SELECT id FROM public.assets WHERE id='${aConfidentialClient}'`)).rows?.length === 1, 'confidential finance client asset is visible to executive');

  // 2j. Unauthorized insertion for client that caller cannot see is rejected
  const unauthClientInsert = await as('authenticated', 'emp', `INSERT INTO public.assets(name,file_name,file_size,file_type,storage_path,folder,visibility,client_id,uploaded_by) VALUES ('sneak','s.pdf',10,'PDF','${U.emp}/sneak.pdf','Clients','studio','${cliA}','${U.emp}')`);
  ok(unauthClientInsert.error !== undefined, 'inserting an asset attached to a client the caller cannot see is rejected by RLS');
}

section('B8 migration 027 + client-asset authorization matrix (plan-asset integrity, ownership guard, legacy data, Storage)');
{
  const q = (u, sql, params) => as('authenticated', u, sql, params);
  const snap = async (sql) => JSON.stringify((await db.query(sql)).rows);
  const rep = async (fn) => { await db.exec('SET session_replication_role = replica'); try { return await fn(); } finally { await db.exec('SET session_replication_role = origin'); } };
  const mkUser = async (k, role, dept) => {
    U[k] = nid(++n);
    await db.query(`INSERT INTO auth.users(id,email) VALUES ($1,$2)`, [U[k], k + '@x.com']);
    await db.query(`INSERT INTO public.profiles(id,full_name,email,employment_status,department_id) VALUES ($1,$2,$3,'active',$4)`, [U[k], k, k + '@x.com', dept ?? null]);
    await db.query(`INSERT INTO public.user_roles(user_id,role_id) SELECT $1,id FROM public.roles WHERE name=$2`, [U[k], role]);
    if (dept) await db.query(`INSERT INTO public.user_departments(user_id,department_id,is_primary) VALUES ($1,$2,true)`, [U[k], dept]);
  };
  await mkUser('gmIn', 'general_manager', finDept);   // general_manager WITH access to Client A (Finance dept)
  await mkUser('sDept', 'employee', finDept);         // plain employee in the client's department, never an uploader
  await mkUser('plEd', 'employee', null);             // creator of Plan P
  await mkUser('victim2', 'employee', null);          // owner of a private file
  await mkUser('doomed', 'employee', null);           // will be deleted (foreign key action ON DELETE SET NULL)

  // ------------------------------------------------------------------ legacy fixtures, created BEFORE migration 027
  const planP = (await db.query(`INSERT INTO public.content_plans(title, created_by, department_id) VALUES ('Plan P', $1, $2) RETURNING id`, [U.plEd, finDept])).rows[0].id;
  const legacyAsset = await rep(async () => (await db.query(`INSERT INTO public.assets(name,file_name,file_size,file_type,storage_path,folder,visibility,uploaded_by) VALUES ('legacy-file','old.pdf',10,'PDF','legacy-import/old-file.pdf','General','studio',$1) RETURNING id`, [U.emp])).rows[0].id);
  const mkPlanAsset = (path, by, file = 'x.png') => rep(async () => (await db.query(`INSERT INTO public.content_post_assets(plan_id,storage_path,file_name,file_type,file_size,position,uploaded_by) VALUES ($1,$2,$3,'image/png',1,1,$4) RETURNING id`, [planP, path, file, by])).rows[0].id);
  const legacyNull1 = await mkPlanAsset('legacy-import/orphan1.png', null, 'o1.png');
  const legacyNull2 = await mkPlanAsset('legacy-import/orphan2.png', null, 'o2.png');
  const dataSnap = async () => (await snap(`SELECT * FROM public.assets ORDER BY id`)) + (await snap(`SELECT * FROM public.content_post_assets ORDER BY id`));
  const before = await dataSnap();
  ok(JSON.parse(await snap(`SELECT count(*)::int c FROM public.content_post_assets WHERE uploaded_by IS NULL`))[0].c === 2, 'fixture: two legacy plan assets with a NULL owner and non-conforming paths exist before 027');

  await db.exec(fs.readFileSync(path.join(SB, 'migrations/027_plan_asset_integrity_and_asset_ownership_guard.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(SB, 'migrations/027_plan_asset_integrity_and_asset_ownership_guard.sql'), 'utf8')); // idempotent
  await db.exec(fs.readFileSync(path.join(SB, 'migrations/026_client_asset_scope_and_path_binding.sql'), 'utf8'));            // 026 re-run on top of 027: still idempotent
  ok(before === (await dataSnap()), 'legacy data: applying 027 (twice) and re-running 026 rewrote and deleted nothing (assets and plan assets identical)');

  // ================================================================== M1: content_post_assets
  const pa = (path_, by) => `INSERT INTO public.content_post_assets(plan_id,storage_path,file_name,file_type,file_size,position,uploaded_by) VALUES ('${planP}','${path_}','p.png','image/png',1,1,${by ? `'${by}'` : 'NULL'}) RETURNING id`;
  const ownPath = `${U.plEd}/plans/${planP}/ok.png`;
  const ins1 = await q('plEd', pa(ownPath, U.plEd));
  ok(ins1.rows?.length === 1, 'M1 normal creation: the plan creator adds a visual under their own plan folder', JSON.stringify(ins1));
  const paId = ins1.rows?.[0]?.id;
  const upd = async (u, set, id = paId) => q(u, `UPDATE public.content_post_assets SET ${set} WHERE id='${id}' RETURNING id`);
  ok((await upd('plEd', `layout='{"x":10,"y":10,"w":50,"h":50,"fit":"cover","z":1}'::jsonb, position=7`)).rows?.length === 1, 'M1 normal metadata update (layout, position) by the plan creator works');
  ok((await upd('sDept', `position=8`)).rows?.length === 1, 'M1 authorized editor: a department member of the plan can update metadata');
  ok((await upd('gmIn', `position=9`)).rows?.length === 1, 'M1 authorized editor: an administrator can update metadata');
  ok((await upd('emp', `position=1`)).rows?.length === 0, 'M1 unauthorized user (not creator, not in the plan\'s department, not admin): update affects 0 rows');
  const secretPath = `${U.victim2}/secret-uuid.pdf`;
  const att = [
    ['change uploaded_by to another user', `uploaded_by='${U.sDept}'`, /uploader cannot be changed/],
    ['set uploaded_by = NULL', `uploaded_by=NULL`, /uploader cannot be changed/],
    ['change storage_path', `storage_path='${U.plEd}/plans/${planP}/other.png'`, /storage path cannot be changed/],
    ['plant another user\'s Storage path', `storage_path='${secretPath}'`, /storage path cannot be changed/],
    ['the original bypass: uploaded_by = NULL together with a foreign storage_path', `uploaded_by=NULL, storage_path='${secretPath}'`, /storage path cannot be changed/],
    ['move to another plan', `plan_id='${crypto.randomUUID()}'`, /another plan|violates foreign key|cannot move/],
  ];
  for (const [label, set, re] of att) { const r = await upd('plEd', set); ok(r.error !== undefined && re.test(r.error), `M1 attempt refused: ${label}`, JSON.stringify(r)); }
  const row = (await db.query(`SELECT storage_path, uploaded_by FROM public.content_post_assets WHERE id=$1`, [paId])).rows[0];
  ok(row.storage_path === ownPath && row.uploaded_by === U.plEd, 'M1 after all attempts the row still has its original path and owner');
  const insBad = await q('plEd', pa(secretPath, U.plEd));
  ok(insBad.error !== undefined, 'M1 inserting a row that points at another user\'s path is refused (path CHECK)', insBad.error);
  const insNull = await q('plEd', pa(`legacy-import/new.png`, null));
  ok(insNull.error !== undefined, 'M1 inserting a NULL-owner row through the API is refused', insNull.error);
  let opNull = ''; try { await db.query(pa(`legacy-import/op.png`, null)); } catch (e) { opNull = e.message; }
  ok(/needs an uploader/.test(opNull), 'M1 a NULL-owner insert is refused even for a superuser session (the trigger, not only RLS)', opNull);
  let opSet = ''; try { await db.query(`UPDATE public.content_post_assets SET uploaded_by=NULL WHERE id='${paId}'`); } catch (e) { opSet = e.message; }
  ok(/uploader cannot be changed/.test(opSet), 'M1 nulling the owner of a live user is refused even for a superuser session', opSet);

  // Storage: after every attempt the attacker still cannot read the victim's private object, but plan visuals stay readable by staff
  await db.query(`INSERT INTO public.assets(name,file_name,file_size,file_type,storage_path,folder,visibility,uploaded_by) VALUES ('secret','secret.pdf',1,'PDF',$1,'Docs','private',$2)`, [secretPath, U.victim2]);
  await db.query(`INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES ('studio-assets',$1,$2),('studio-assets',$3,$4)`, [secretPath, U.victim2, ownPath, U.plEd]);
  const names = async (u, list) => (await q(u, `SELECT name FROM storage.objects WHERE name = ANY($1::text[])`, [list])).rows?.map((r) => r.name).sort().join(',');
  ok(!(await names('plEd', [secretPath, ownPath])).includes('secret-uuid'), 'M1 Storage: the plan editor still cannot read the victim\'s private object after planting attempts');
  ok((await names('emp', [ownPath])) === ownPath, 'M1 Storage: legitimate plan visuals stay readable by staff (no broader and no narrower access)');

  // legacy NULL-owner rows: not re-owned, not rewritten, still editable for metadata and deletable by editors
  ok((await upd('plEd', `position=4`, legacyNull1)).rows?.length === 1, 'M1 legacy NULL-owner row: a plan editor can still change metadata (position)');
  ok((await upd('plEd', `layout='{"x":1}'::jsonb`, legacyNull1)).rows?.length === 1, 'M1 legacy NULL-owner row: layout update works');
  const l1 = await upd('plEd', `uploaded_by='${U.plEd}'`, legacyNull1);
  ok(l1.error !== undefined && /uploader cannot be changed/.test(l1.error), 'M1 legacy NULL-owner row cannot be claimed by an editor', l1.error);
  const l2 = await upd('plEd', `storage_path='${ownPath}x'`, legacyNull1);
  ok(l2.error !== undefined && /storage path cannot be changed/.test(l2.error), 'M1 legacy NULL-owner row: its path cannot be changed');
  ok((await upd('emp', `position=2`, legacyNull1)).rows?.length === 0, 'M1 legacy NULL-owner row: an unauthorized user still cannot touch it');
  const del = await q('plEd', `DELETE FROM public.content_post_assets WHERE id='${legacyNull2}' RETURNING id`);
  ok(del.rows?.length === 1, 'M1 legacy NULL-owner row: an editor can still delete it (replace by re-uploading)');
  const lrow = (await db.query(`SELECT storage_path, uploaded_by FROM public.content_post_assets WHERE id=$1`, [legacyNull1])).rows[0];
  ok(lrow.uploaded_by === null && lrow.storage_path === 'legacy-import/orphan1.png', 'M1 legacy row keeps its NULL owner and original path');

  // foreign key action: deleting a user still works and sets the owner to NULL (the one allowed change)
  const doomedPath = `${U.doomed}/plans/${planP}/d.png`;
  const doomedAsset = await mkPlanAsset(doomedPath, U.doomed, 'd.png');
  let delErr = ''; try { await db.query(`DELETE FROM auth.users WHERE id=$1`, [U.doomed]); } catch (e) { delErr = e.message; }
  const after = (await db.query(`SELECT uploaded_by, storage_path FROM public.content_post_assets WHERE id=$1`, [doomedAsset])).rows[0];
  ok(delErr === '' && after && after.uploaded_by === null && after.storage_path === doomedPath, 'M1 deleting a user (ON DELETE SET NULL) is not blocked: the plan asset survives with a NULL owner and the same path', delErr);

  // ================================================================== M2: client assets, full matrix
  const A_ = ['sDept', 'fm', 'dm', 'emp', 'gmIn', 'gm', 'own', 'ceo', 'sa2'];
  const EX = { own: 1, ceo: 1, sa2: 1 };
  const mkAsset = async (name, o) => (await db.query(`INSERT INTO public.assets(name,file_name,file_size,file_type,storage_path,folder,visibility,department_id,client_id,uploaded_by,finance_confidential) VALUES ($1,$1,10,'PDF',$2,'Clients',$3,$4,$5,$6,$7) RETURNING id`,
    [name, `${U[o.by]}/${name}.pdf`, o.vis, o.dept ?? null, o.client === undefined ? cliA : o.client, U[o.by], !!o.fin])).rows[0].id;
  const sees = async (u, id) => (await q(u, `SELECT id FROM public.assets WHERE id=$1`, [id])).rows?.length === 1;
  const expectSee = async (label, id, exp) => { for (const u of A_) { const got = await sees(u, id); ok(got === !!exp[u], `SELECT ${label}: ${u} ${exp[u] ? 'sees' : 'does not see'} it`, `got ${got}`); } };

  // uploader = fm (in the client's department)
  const aStudio = await mkAsset('mx-studio', { by: 'fm', vis: 'studio' });
  const aDeptIn = await mkAsset('mx-dept-in', { by: 'fm', vis: 'department', dept: finDept });
  const aDeptOut = await mkAsset('mx-dept-out', { by: 'fm', vis: 'department', dept: otherDept });
  const aPrivate = await mkAsset('mx-private', { by: 'fm', vis: 'private' });
  await expectSee('client asset, studio', aStudio, { ...EX, fm: 1, sDept: 1, gmIn: 1 });
  await expectSee('client asset, department = the client\'s department', aDeptIn, { ...EX, fm: 1, sDept: 1, gmIn: 1 });
  await expectSee('client asset, department = ANOTHER department (visibility does not override client scoping, and department visibility still applies)', aDeptOut, { ...EX, fm: 1, gmIn: 1 });
  await expectSee('client asset, private', aPrivate, { ...EX, fm: 1, gmIn: 1 });
  // uploader = emp, who is OUTSIDE the client's department (models someone who moved department or lost access)
  const bStudio = await mkAsset('mx-up-studio', { by: 'emp', vis: 'studio' });
  const bPrivate = await mkAsset('mx-up-private', { by: 'emp', vis: 'private' });
  const bDept = await mkAsset('mx-up-dept', { by: 'emp', vis: 'department', dept: finDept });
  await expectSee('uploader outside the client\'s department, studio (documented exception: uploader keeps access)', bStudio, { ...EX, emp: 1, fm: 1, sDept: 1, gmIn: 1 });
  await expectSee('uploader outside the client\'s department, private', bPrivate, { ...EX, emp: 1, gmIn: 1 });
  await expectSee('uploader outside the client\'s department, department visibility', bDept, { ...EX, emp: 1, fm: 1, sDept: 1, gmIn: 1 });
  // asset without a client and a confidential asset
  const nStudio = await mkAsset('mx-noclient', { by: 'emp', vis: 'studio', client: null });
  await expectSee('studio asset without a client (existing behaviour preserved)', nStudio, Object.fromEntries(A_.map((u) => [u, 1])));
  const fin = await mkAsset('mx-confidential', { by: 'emp', vis: 'studio', fin: true });
  await expectSee('finance-confidential client asset (executives only; the uploader and the client\'s department do not count)', fin, { ...EX });

  // UPDATE / DELETE
  const mut = async (kind, u, id) => (await q(u, kind === 'update' ? `UPDATE public.assets SET description='t-${u}' WHERE id=$1 RETURNING id` : `DELETE FROM public.assets WHERE id=$1 RETURNING id`, [id])).rows?.length === 1;
  const WRITE = { ...EX, fm: 1, gmIn: 1 };   // uploader, executives, general_manager WITH client access
  for (const u of A_) { const got = await mut('update', u, aStudio); ok(got === !!WRITE[u], `UPDATE client asset (studio, uploaded by fm): ${u} ${WRITE[u] ? 'may' : 'may not'}`, `got ${got}`); }
  for (const u of A_) { const got = await mut('update', u, aDeptIn); ok(got === !!WRITE[u], `UPDATE client asset (department-visible): ${u} ${WRITE[u] ? 'may' : 'may not'} (department staff who did not upload cannot edit)`, `got ${got}`); }
  for (const u of A_) { const id = await mkAsset('del-' + u, { by: 'fm', vis: 'studio' }); const got = await mut('delete', u, id); ok(got === !!WRITE[u], `DELETE client asset: ${u} ${WRITE[u] ? 'may' : 'may not'}`, `got ${got}`); }
  ok(await mut('update', 'emp', bStudio) && await mut('delete', 'emp', await mkAsset('del-up', { by: 'emp', vis: 'studio' })), 'UPDATE and DELETE: the uploader outside the department keeps write access to their own client uploads (documented exception)');
  ok(!(await mut('update', 'emp', aStudio)), 'UPDATE: the same outside employee cannot edit somebody else\'s client asset');

  // ownership and client_id cannot be used to bypass the rules (migration 027)
  const X = await mkAsset('mx-bypass', { by: 'fm', vis: 'studio' });
  const row_ = async () => (await db.query(`SELECT uploaded_by, client_id FROM public.assets WHERE id=$1`, [X])).rows[0];
  const tryU = async (u, set) => q(u, `UPDATE public.assets SET ${set} WHERE id='${X}' RETURNING id`);
  let r;
  r = await tryU('fm', `client_id='${cliB}'`);
  ok(r.error && /cannot move a file/.test(r.error), 'uploader cannot re-point their client asset to a client they cannot see', r.error);
  r = await tryU('fm', `client_id=NULL`);
  ok(r.error && /detach/.test(r.error), 'uploader cannot detach a client asset (that would make it studio-wide)', r.error);
  r = await tryU('fm', `uploaded_by='${U.sDept}'`);
  ok(r.error && /ownership/.test(r.error), 'uploader cannot hand the file to someone else', r.error);
  r = await tryU('gmIn', `uploaded_by='${U.sDept}'`);
  ok(r.error && /ownership/.test(r.error), 'a general_manager (even with client access) cannot transfer ownership', r.error);
  r = await tryU('gmIn', `client_id='${cliB}'`);
  ok(r.error && /cannot move a file/.test(r.error), 'a general_manager cannot move a file to a client they cannot see', r.error);
  r = await tryU('gmIn', `client_id=NULL`);
  ok(r.error && /detach/.test(r.error), 'a general_manager cannot detach a client file', r.error);
  r = await tryU('dm', `client_id='${cliB}'`);
  ok(r.rows?.length === 0 || r.error !== undefined, 'a user with no write access cannot re-point it either');
  const keep = await row_();
  ok(keep.uploaded_by === U.fm && keep.client_id === cliA, 'after every refused attempt the owner and client are unchanged');
  r = await tryU('own', `uploaded_by='${U.sDept}'`);
  ok(r.rows?.length === 1 && (await row_()).uploaded_by === U.sDept, 'an executive can transfer ownership (documented: the new owner gets the uploader exception)');
  ok(await mut('update', 'sDept', X), 'consequence of the transfer: the new owner can now edit the file');
  await tryU('own', `uploaded_by='${U.fm}'`);
  r = await tryU('own', `client_id=NULL`);
  ok(r.rows?.length === 1 && await sees('dm', X), 'an executive can detach a client asset; it then becomes an ordinary studio asset (dm sees it)');
  r = await tryU('own', `client_id='${cliA}'`);
  ok(r.rows?.length === 1 && !(await sees('dm', X)) && (await row_()).client_id === cliA, 'an executive can attach it back; client scoping applies again');
  const E1 = await mkAsset('mx-attach', { by: 'emp', vis: 'studio', client: null });
  r = await q('emp', `UPDATE public.assets SET client_id='${cliA}' WHERE id='${E1}' RETURNING id`);
  ok(r.error && /cannot move a file/.test(r.error), 'attaching a file to a client the uploader cannot see is refused');
  r = await q('emp', `UPDATE public.assets SET client_id='${cliB}' WHERE id='${E1}' RETURNING id`);
  ok(r.rows?.length === 1, 'attaching a file to a client the uploader CAN see (Client B, their department) is allowed');
  await db.query(`SELECT set_config('request.jwt.claim.sub','',false)`);
  let opErr = ''; try { await db.query(`UPDATE public.assets SET uploaded_by='${U.sDept}', client_id=NULL WHERE id='${X}'`); } catch (e) { opErr = e.message; }
  ok(opErr === '', 'an operator session without an end-user (service role / SQL editor) is not blocked by the guard', opErr);

  // legacy asset with a non-conforming path
  ok((await q('emp', `UPDATE public.assets SET name='legacy-renamed', description='ok' WHERE id='${legacyAsset}' RETURNING id`)).rows?.length === 1, 'legacy asset (path does not start with the uploader id): metadata can still be edited');
  const lp = await q('emp', `UPDATE public.assets SET storage_path='${U.emp}/new.pdf' WHERE id='${legacyAsset}' RETURNING id`);
  ok(lp.error && /cannot be changed/.test(lp.error), 'legacy asset: its path still cannot be changed');
  ok((await db.query(`SELECT storage_path FROM public.assets WHERE id=$1`, [legacyAsset])).rows[0].storage_path === 'legacy-import/old-file.pdf', 'legacy asset keeps its original non-conforming path (never rewritten)');

  // ---------------------------------------------------------------- Storage objects for client assets
  const objNames = { studio: `${U.fm}/mx-studio.pdf`, private: `${U.fm}/mx-private.pdf`, deptOut: `${U.fm}/mx-dept-out.pdf` };
  for (const nme of Object.values(objNames)) await db.query(`INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES ('studio-assets',$1,$2)`, [nme, U.fm]);
  const AW = `DROP POLICY "studio_assets_read" ON storage.objects; CREATE POLICY "studio_assets_read" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'studio-assets' AND EXISTS (SELECT 1 FROM public.assets a WHERE a.storage_path = name));`;
  const INTENDED = AW.replace('a.storage_path = name', 'a.storage_path = objects.name');
  const sees2 = async (u, nme) => (await q(u, `SELECT name FROM storage.objects WHERE name=$1`, [nme])).rows?.length === 1;
  await db.exec(AW);
  let anyAsWritten = false; for (const u of A_) for (const nme of Object.values(objNames)) if (await sees2(u, nme)) anyAsWritten = true;
  ok(!anyAsWritten, 'Storage, policy AS WRITTEN in migration 007: nobody (not even executives) can read a client asset object (fails closed; the 007 name-binding defect)');
  await db.exec(INTENDED);
  const expectObj = async (label, nme, exp) => { for (const u of A_) { const got = await sees2(u, nme); ok(got === !!exp[u], `Storage object (${label}), policy in its INTENDED form: ${u} ${exp[u] ? 'reads' : 'cannot read'} it`, `got ${got}`); } };
  await expectObj('client asset, studio', objNames.studio, { ...EX, fm: 1, sDept: 1, gmIn: 1 });
  await expectObj('client asset, private', objNames.private, { ...EX, fm: 1, gmIn: 1 });
  await expectObj('client asset, department of another department', objNames.deptOut, { ...EX, fm: 1, gmIn: 1 });
  console.log('  NOT TESTED HERE (needs staging): the real Supabase Storage API (signed URL creation, bucket settings, upload limits), and whether the live storage.objects policy matches migration 007 as written or its intended form.');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:\n - ' + failures.join('\n - ')); process.exit(1); }
