// Access-control regression tests: applies every migration to an in-process Postgres (PGlite)
// with Supabase-style stubs, then attacks the policies as different users.
// Usage: npm install && node verify-rls.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const M = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' ');
const db = new PGlite();

const stubs = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth; CREATE SCHEMA storage;
CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, raw_user_meta_data jsonb);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth, storage, public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint);
CREATE TABLE storage.objects (id uuid DEFAULT gen_random_uuid(), bucket_id text, name text, owner_id text);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY; GRANT ALL ON storage.objects, storage.buckets TO authenticated, service_role;
`;
await db.exec(stubs);

for (const f of ['migrations/001_initial_schema.sql','migrations/002_rls_policies.sql','migrations/003_updated_at.sql','migrations/004_storage.sql','migrations/005_push_subscriptions.sql','seed.sql']) {
  try { await db.exec(fs.readFileSync(M + f, 'utf8')); console.log('OK   ', f); }
  catch (e) { console.log('FAIL ', f, '->', e.message); process.exit(1); }
}

// ---------- fixtures (as superuser) ----------
const id = (n) => `00000000-0000-0000-0000-0000000000${n}`;
const U = { admin: id('01'), emp: id('02'), emp2: id('03'), hr: id('04'), fin: id('05'), stranger: id('06'), susp: id('07'), client: id('08') };
for (const [k, v] of Object.entries(U))
  await db.query(`INSERT INTO auth.users(id,email) VALUES ($1,$2)`, [v, k + '@x.com']);
const prof = (k, status = 'active') => db.query(
  `INSERT INTO public.profiles(id,full_name,email,employment_status) VALUES ($1,$2,$3,$4)`, [U[k], k, k + '@x.com', status]);
for (const k of ['admin','emp','emp2','hr','fin','susp','client']) await prof(k, k === 'susp' ? 'suspended' : 'active');
// stranger: signed-up auth user with NO profile
const role = async (k, r) => db.query(
  `INSERT INTO public.user_roles(user_id,role_id) SELECT $1,id FROM public.roles WHERE name=$2`, [U[k], r]);
await role('admin','super_admin'); await role('emp','employee'); await role('emp2','employee');
await role('hr','hr_manager'); await role('fin','finance_manager'); await role('susp','employee'); await role('client','client');

const dept = '11111111-1111-1111-1111-111111111101';
const t1 = '99999999-0000-0000-0000-000000000001';
await db.query(`INSERT INTO public.tasks(id,title,assigned_to,created_by,department_id) VALUES ($1,'T1',$2,$3,$4)`, [t1, U.emp, U.admin, dept]);
await db.query(`INSERT INTO public.expenses(id,title,amount,category,submitted_by,status) VALUES (gen_random_uuid(),'E',10,'other',$1,'submitted')`, [U.emp]);
await db.query(`INSERT INTO public.leave_requests(user_id,leave_type_id,start_date,end_date,total_days,reason) SELECT $1,id,now(),now(),1,'r' FROM public.leave_types LIMIT 1`, [U.emp]);
const dm = '33333333-3333-3333-3333-3333333333aa';
await db.query(`INSERT INTO public.conversations(id,type,name,is_public) VALUES ($1,'direct','dm',false)`, [dm]);
await db.query(`INSERT INTO public.conversation_members(conversation_id,user_id) VALUES ($1,$2)`, [dm, U.emp]);
await db.query(`INSERT INTO public.audit_logs(action,entity_type) VALUES ('X','Y')`);
console.log('task_number default ->', (await db.query(`SELECT task_number FROM public.tasks WHERE id=$1`, [t1])).rows[0].task_number,
            '| employee_id default ->', (await db.query(`SELECT employee_id FROM public.profiles WHERE id=$1`, [U.admin])).rows[0].employee_id);

// ---------- test harness ----------
let pass = 0, fail = 0;
async function as(user, sql, params = []) {
  await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub','${user ? U[user] : ''}',false); SET ROLE ${user ? 'authenticated' : 'anon'};`);
  try { const r = await db.query(sql, params); await db.exec('RESET ROLE'); return { rows: r.rows, count: r.affectedRows ?? r.rows.length }; }
  catch (e) { await db.exec('RESET ROLE'); return { error: e.message }; }
}
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + extra)); };
const denied = (r) => !!r.error && /permission denied|row-level security|violates/i.test(r.error);

// anon
check('anon cannot read profiles', denied(await as(null, 'SELECT id FROM public.profiles')));
check('anon cannot call auth_is_admin()', denied(await as(null, 'SELECT public.auth_is_admin()')));
// stranger (valid JWT, no profile) — the open-signup scenario
for (const t of ['departments','campaigns','profiles','tasks','conversations','roles','company_settings']) {
  const r = await as('stranger', `SELECT count(*)::int c FROM public.${t}`);
  check(`stranger sees 0 rows in ${t}`, !r.error && r.rows[0].c === 0, JSON.stringify(r));
}
// suspended
let r = await as('susp', 'SELECT count(*)::int c FROM public.departments');
check('suspended user sees no departments', r.rows[0].c === 0);
// client role isn't staff
r = await as('client', 'SELECT count(*)::int c FROM public.departments');
check('client-role user sees no departments', r.rows[0].c === 0);
r = await as('client', 'SELECT count(*)::int c FROM public.profiles');
check('client-role user sees only own profile', r.rows[0].c === 1);
// profile escalation attempts
r = await as('emp', `UPDATE public.profiles SET employment_status='active', is_first_admin=true WHERE id='${U.emp}'`);
check('employee cannot set is_first_admin / status', denied(r), JSON.stringify(r));
r = await as('emp', `UPDATE public.profiles SET department_id='${dept}' WHERE id='${U.emp}'`);
check('employee cannot change own department', denied(r), JSON.stringify(r));
r = await as('emp', `UPDATE public.profiles SET email='evil@x.com' WHERE id='${U.emp}'`);
check('employee cannot change own email', denied(r), JSON.stringify(r));
r = await as('emp', `UPDATE public.profiles SET bio='hi', phone='1' WHERE id='${U.emp}'`);
check('employee CAN edit own bio/phone', !r.error && r.count === 1, JSON.stringify(r));
r = await as('emp', `UPDATE public.profiles SET bio='pwn' WHERE id='${U.emp2}'`);
check('employee cannot edit a colleague', !r.error && r.count === 0, JSON.stringify(r));
r = await as('emp', `SELECT emergency_contact_name FROM public.profiles`);
check('emergency contact columns not readable', denied(r), JSON.stringify(r));
// role tables
r = await as('emp', `INSERT INTO public.user_roles(user_id,role_id) SELECT '${U.emp}', id FROM public.roles WHERE name='super_admin'`);
check('employee cannot grant self super_admin', denied(r), JSON.stringify(r));
r = await as('admin', `INSERT INTO public.user_roles(user_id,role_id) SELECT '${U.emp}', id FROM public.roles WHERE name='owner'`);
check('even admin cannot write user_roles from client (service only)', denied(r), JSON.stringify(r));
r = await as('emp', 'SELECT count(*)::int c FROM public.user_roles');
check('employee can read roles (UI needs it)', !r.error && r.rows[0].c >= 1);
// tasks
r = await as('emp', 'SELECT count(*)::int c FROM public.tasks');
check('assignee sees their task', r.rows[0].c === 1, JSON.stringify(r));
r = await as('emp2', 'SELECT count(*)::int c FROM public.tasks');
check('peer does NOT see colleague task', r.rows[0].c === 0, JSON.stringify(r));
r = await as('admin', 'SELECT count(*)::int c FROM public.tasks');
check('admin sees all tasks', r.rows[0].c === 1);
r = await as('emp', `UPDATE public.tasks SET status='completed' WHERE id='${t1}'`);
check('client cannot UPDATE tasks directly', denied(r), JSON.stringify(r));
r = await as('emp', `INSERT INTO public.tasks(title,created_by) VALUES ('x','${U.emp}')`);
check('client cannot INSERT tasks directly', denied(r), JSON.stringify(r));
r = await as('emp', `INSERT INTO public.task_activity_logs(task_id,action) VALUES ('${t1}','FORGED')`);
check('client cannot forge task activity logs', denied(r), JSON.stringify(r));
r = await as('emp', `INSERT INTO public.notifications(user_id,type,title,content) VALUES ('${U.admin}','t','phish','x')`);
check('client cannot create notifications for others', denied(r), JSON.stringify(r));
r = await as('emp', `INSERT INTO public.task_comments(task_id,user_id,content) VALUES ('${t1}','${U.emp}','hello')`);
check('assignee can comment', !r.error, JSON.stringify(r));
r = await as('emp2', `INSERT INTO public.task_comments(task_id,user_id,content) VALUES ('${t1}','${U.emp2}','sneak')`);
check('non-participant cannot comment on others’ task', denied(r), JSON.stringify(r));
r = await as('emp2', `SELECT count(*)::int c FROM public.task_comments`);
check('non-participant cannot read task comments', r.rows[0].c === 0);
// audit / RPC
r = await as('emp', 'SELECT count(*)::int c FROM public.audit_logs');
check('employee cannot read audit logs', r.rows[0].c === 0);
r = await as('admin', 'SELECT count(*)::int c FROM public.audit_logs');
check('admin can read audit logs', r.rows[0].c === 1);
r = await as('admin', `INSERT INTO public.audit_logs(action,entity_type) VALUES ('FORGE','X')`);
check('nobody can write audit logs from client', denied(r), JSON.stringify(r));
r = await as('admin', `UPDATE public.audit_logs SET action='tamper'`);
check('nobody can tamper with audit logs', denied(r), JSON.stringify(r));
// finance
r = await as('emp', 'SELECT count(*)::int c FROM public.invoices');
check('employee cannot read invoices', denied(r) || r.rows[0].c === 0, JSON.stringify(r));
r = await as('emp', `SELECT count(*)::int c FROM public.expenses`);
check('employee sees own expense', r.rows[0].c === 1);
r = await as('emp2', `SELECT count(*)::int c FROM public.expenses`);
check('peer cannot see others’ expenses', r.rows[0].c === 0);
r = await as('fin', `SELECT count(*)::int c FROM public.expenses`);
check('finance manager sees expenses', r.rows[0].c === 1);
r = await as('emp', `UPDATE public.expenses SET status='approved'`);
check('employee cannot self-approve expense', denied(r), JSON.stringify(r));
r = await as('fin', `UPDATE public.expenses SET status='approved'`);
check('finance cannot update expenses from client (must use workflow)', denied(r), JSON.stringify(r));
r = await as('emp', `INSERT INTO public.expenses(title,amount,category,submitted_by,status) VALUES ('a',5,'other','${U.emp}','approved')`);
check('cannot insert pre-approved expense', denied(r), JSON.stringify(r));
r = await as('emp', `INSERT INTO public.expenses(title,amount,category,submitted_by,status) VALUES ('a',5,'other','${U.emp}','submitted')`);
check('can submit own expense', !r.error, JSON.stringify(r));
r = await as('emp', `INSERT INTO public.expenses(title,amount,category,submitted_by,status) VALUES ('a',5,'other','${U.emp2}','submitted')`);
check('cannot submit expense as someone else', denied(r), JSON.stringify(r));
// HR
r = await as('emp2', `SELECT count(*)::int c FROM public.leave_requests`);
check('peer cannot see others’ leave', r.rows[0].c === 0);
r = await as('hr', `SELECT count(*)::int c FROM public.leave_requests`);
check('HR sees leave requests', r.rows[0].c === 1);
r = await as('emp', `UPDATE public.leave_requests SET status='approved'`);
check('employee cannot self-approve leave', denied(r), JSON.stringify(r));
r = await as('emp', `INSERT INTO public.leave_requests(user_id,leave_type_id,start_date,end_date,total_days,reason,status) SELECT '${U.emp}',id,now(),now(),1,'r','approved' FROM public.leave_types LIMIT 1`);
check('cannot file pre-approved leave', denied(r), JSON.stringify(r));
// chat
r = await as('emp2', `SELECT count(*)::int c FROM public.conversations`);
check('peer sees only the 2 public channels (not DM / #client-briefs)', r.rows[0].c === 2, JSON.stringify(r));
r = await as('emp2', `INSERT INTO public.messages(conversation_id,sender_id,content) VALUES ('${dm}','${U.emp2}','intrude')`);
check('cannot post into someone else’s DM', denied(r), JSON.stringify(r));
r = await as('emp2', `SELECT count(*)::int c FROM public.messages WHERE conversation_id='${dm}'`);
check('cannot read someone else’s DM', r.rows[0].c === 0);
r = await as('emp', `INSERT INTO public.messages(conversation_id,sender_id,content) VALUES ('${dm}','${U.emp}','hi')`);
check('member can post in DM', !r.error, JSON.stringify(r));
r = await as('emp', `INSERT INTO public.messages(conversation_id,sender_id,content,message_type) VALUES ('${dm}','${U.emp}','x','system')`);
check('cannot forge system messages', denied(r), JSON.stringify(r));
r = await as('emp', `INSERT INTO public.messages(conversation_id,sender_id,content) VALUES ('33333333-3333-3333-3333-333333333302','${U.emp}','hello all')`);
check('can post in public channel', !r.error, JSON.stringify(r));
// CRM
r = await as('emp', `INSERT INTO public.clients(name,company_name) VALUES ('a','b')`);
check('non-manager cannot create clients', denied(r), JSON.stringify(r));
r = await as('emp', `SELECT count(*)::int c FROM public.leads`);
check('non-manager sees no leads', r.rows[0].c === 0);
r = await as('admin', `INSERT INTO public.clients(name,company_name) VALUES ('a','b')`);
check('admin can create clients', !r.error, JSON.stringify(r));
// departments
r = await as('emp', `INSERT INTO public.departments(name) VALUES ('Hack')`);
check('employee cannot create departments', denied(r), JSON.stringify(r));
r = await as('admin', `INSERT INTO public.departments(name) VALUES ('Ops')`);
check('admin can create departments', !r.error, JSON.stringify(r));
// notifications
await db.query(`INSERT INTO public.notifications(user_id,type,title,content) VALUES ($1,'t','n','c')`, [U.emp]);
r = await as('emp2', 'SELECT count(*)::int c FROM public.notifications');
check('cannot read others’ notifications', r.rows[0].c === 0);
r = await as('emp', `UPDATE public.notifications SET is_read=true`);
check('can mark own notifications read', !r.error && r.count === 1, JSON.stringify(r));
r = await as('emp', `UPDATE public.notifications SET title='x'`);
check('cannot edit notification content', denied(r), JSON.stringify(r));
// attendance
r = await as('emp', `INSERT INTO public.attendance_records(user_id,check_in) VALUES ('${U.emp}', now())`);
check('can check in for self', !r.error, JSON.stringify(r));
r = await as('emp', `INSERT INTO public.attendance_records(user_id,check_in,date) VALUES ('${U.emp2}', now(), current_date)`);
check('cannot check in for someone else', denied(r), JSON.stringify(r));
r = await as('emp2', `SELECT count(*)::int c FROM public.attendance_records`);
check('peer cannot see others’ attendance', r.rows[0].c === 0);
// definer helpers cannot be coerced
r = await as('emp', `SELECT public.auth_is_admin() a`);
check('auth_is_admin() false for employee', r.rows[0].a === false);
// storage
await db.query(`INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES ('task-attachments','${t1}/a.pdf','${U.emp}')`);
r = await as('emp', `SELECT count(*)::int c FROM storage.objects`);
check('assignee can see task attachment object', r.rows[0].c === 1, JSON.stringify(r));
r = await as('emp2', `SELECT count(*)::int c FROM storage.objects`);
check('peer cannot see task attachment object', r.rows[0].c === 0);
r = await as('emp2', `INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES ('task-attachments','${t1}/evil.pdf','${U.emp2}')`);
check('peer cannot upload into others’ task', denied(r), JSON.stringify(r));
r = await as('emp2', `INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES ('task-attachments','not-a-uuid/x.pdf','${U.emp2}')`);
check('malformed path rejected without error leak', denied(r), JSON.stringify(r));
// push subscriptions (written only by the server)
await db.query(`INSERT INTO public.push_subscriptions(user_id,endpoint,p256dh,auth) VALUES ($1,'https://fcm.googleapis.com/fcm/send/aaa','KEYA','AUTHA'),($2,'https://fcm.googleapis.com/fcm/send/bbb','KEYB','AUTHB')`, [U.emp, U.emp2]);
r = await as('emp', `SELECT count(*)::int c FROM public.push_subscriptions`);
check('user sees only their own push subscriptions', r.rows[0].c === 1, JSON.stringify(r));
r = await as('emp', `SELECT p256dh FROM public.push_subscriptions`);
check('push secret keys (p256dh/auth) are not readable from the browser', denied(r), JSON.stringify(r));
r = await as('emp', `SELECT auth FROM public.push_subscriptions`);
check('push auth secret is not readable from the browser', denied(r), JSON.stringify(r));
r = await as('emp', `INSERT INTO public.push_subscriptions(user_id,endpoint,p256dh,auth) VALUES ('${U.emp}','https://evil.example/x','k','a')`);
check('browser cannot insert a push subscription (server validates the endpoint)', denied(r), JSON.stringify(r));
r = await as('emp', `UPDATE public.push_subscriptions SET endpoint='https://evil.example/x'`);
check('browser cannot rewrite a push endpoint (SSRF guard)', denied(r), JSON.stringify(r));
r = await as('emp', `DELETE FROM public.push_subscriptions`);
check('browser cannot delete subscriptions directly', denied(r), JSON.stringify(r));
r = await as('stranger', `SELECT count(*)::int c FROM public.push_subscriptions`);
check('stranger sees no push subscriptions', denied(r) || r.rows[0].c === 0, JSON.stringify(r));
r = await as(null, `SELECT 1 FROM public.push_subscriptions`);
check('anon cannot touch push subscriptions', denied(r), JSON.stringify(r));

// updated_at trigger is the only trigger
const trg = await db.query(`SELECT count(DISTINCT tgname)::int c, string_agg(DISTINCT tgname, ',') n FROM pg_trigger WHERE NOT tgisinternal`);
check('only trigger in DB is trg_set_updated_at', trg.rows[0].n === 'trg_set_updated_at', trg.rows[0].n);
const fns = await db.query(`SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND proname NOT LIKE 'auth\\_%' ORDER BY 1`);
console.log('non-predicate functions in public:', fns.rows.map(x => x.proname).join(', '));
const nopol = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN (SELECT tablename FROM pg_policies WHERE schemaname='public') ORDER BY 1`);
console.log('tables with RLS but no policy (service-only):', nopol.rows.map(x => x.tablename).join(', '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
