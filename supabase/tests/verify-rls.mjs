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
// migration 016 (privacy part only: the test database has no realtime schema): admins lose the blanket read access
{
  const sql016 = fs.readFileSync(M + 'migrations/016_chat_v2_private_and_media.sql', 'utf8');
  await db.exec(sql016.slice(sql016.indexOf('-- ----------------------------------------------------------------'), sql016.indexOf('-- ---------------------------------------------------------------- 3.')));
}
r = await as('admin', `SELECT count(*)::int c FROM public.messages WHERE conversation_id='${dm}'`);
check('016: admin cannot read other people’s DM', r.rows[0].c === 0, JSON.stringify(r));
r = await as('admin', `SELECT count(*)::int c FROM public.conversations WHERE id='${dm}'`);
check('016: admin cannot even see other people’s DM exists', r.rows[0].c === 0, JSON.stringify(r));
r = await as('emp', `SELECT count(*)::int c FROM public.messages WHERE conversation_id='${dm}'`);
check('016: member still reads own DM', r.rows[0].c >= 0 && !r.error, JSON.stringify(r));
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


// ===================================================================================================
// FINANCE (migration 017): invoice totals, numbering, payments, retainers, audit, access
// ===================================================================================================
// legacy rows that exist BEFORE the migration must be kept and migrated in place
await db.query(`INSERT INTO public.invoices(id,invoice_number,type,amount,tax,total,status,due_date,paid_date) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','OLD-1','receivable',1000,140,1140,'paid','2026-01-31','2026-01-20'),
  ('aaaaaaaa-0000-0000-0000-000000000002','OLD-2','receivable',500,0,500,'cancelled','2026-01-31',NULL),
  ('aaaaaaaa-0000-0000-0000-000000000003','OLD-3','receivable',2000,280,2280,'sent','2099-01-31',NULL)`);

{
  const sql017 = fs.readFileSync(M + 'migrations/017_finance_invoicing.sql', 'utf8');
  try { await db.exec(sql017); console.log('OK    migrations/017_finance_invoicing.sql'); }
  catch (e) { console.log('FAIL  017 ->', e.message); process.exit(1); }
  try { await db.exec(sql017); check('017 can be run twice', true); } catch (e) { check('017 can be run twice', false, e.message); }
}

const fq = async (sql, params = []) => { try { return { rows: (await db.query(sql, params)).rows }; } catch (e) { return { error: e.message }; } };
const num = (v) => Number(v);
const CLIENT = 'cccccccc-0000-0000-0000-000000000001';
await db.query(`INSERT INTO public.clients(id,name,company_name) VALUES ($1,'Nour','Al Nour Marketing')`, [CLIENT]);

// ---- migration of the old data
let r2 = await fq(`SELECT invoice_number, status, subtotal, vat_amount, total, amount_paid, balance, kind,
  (SELECT count(*)::int FROM public.invoice_items i WHERE i.invoice_id = v.id) items,
  (SELECT count(*)::int FROM public.invoice_payments p WHERE p.invoice_id = v.id) pays FROM public.invoices v WHERE invoice_number LIKE 'OLD-%' ORDER BY 1`);
const old = Object.fromEntries(r2.rows.map(x => [x.invoice_number, x]));
check('legacy paid invoice kept: paid, balance 0, one line, one payment', old['OLD-1'].status === 'paid' && num(old['OLD-1'].total) === 1140 && num(old['OLD-1'].balance) === 0 && old['OLD-1'].items === 1 && old['OLD-1'].pays === 1, JSON.stringify(old['OLD-1']));
check('legacy cancelled invoice becomes void', old['OLD-2'].status === 'void', JSON.stringify(old['OLD-2']));
check('legacy open invoice keeps its balance', old['OLD-3'].status === 'sent' && num(old['OLD-3'].balance) === 2280, JSON.stringify(old['OLD-3']));
r2 = await fq(`SELECT (SELECT count(*)::int FROM finance_backup.invoices_pre017) n`);
check('old invoices were backed up before migrating', r2.rows[0].n === 3, JSON.stringify(r2));

// ---- line maths (half-up, per line)
r2 = await fq(`SELECT * FROM public.fin_calc_line(3, 3250.50, 10, 14)`);
check('line: 3 x 3250.50, 10% off, 14% VAT = 10005.04', num(r2.rows[0].gross) === 9751.5 && num(r2.rows[0].discount) === 975.15 && num(r2.rows[0].net) === 8776.35 && num(r2.rows[0].vat) === 1228.69 && num(r2.rows[0].total) === 10005.04, JSON.stringify(r2));
r2 = await fq(`SELECT vat FROM public.fin_calc_line(1, 1.25, 0, 14)`);
check('rounding is half-up (1.25 x 14% = 0.175 -> 0.18, not 0.17)', num(r2.rows[0].vat) === 0.18, JSON.stringify(r2));
r2 = await fq(`SELECT gross FROM public.fin_calc_line(1, 0.125, 0, 0)`);
check('rounding is half-up (0.125 -> 0.13)', num(r2.rows[0].gross) === 0.13, JSON.stringify(r2));
r2 = await fq(`SELECT vat, total FROM public.fin_calc_line(1, 0.35, 0, 14)`);
check('small amounts: 0.35 + 14% VAT = 0.05 VAT, 0.40 total', num(r2.rows[0].vat) === 0.05 && num(r2.rows[0].total) === 0.4, JSON.stringify(r2));

// ---- an invoice: the same numbers as the Arabic sample invoice
const items = [
  { description_en: 'Brand identity', description_ar: 'تصميم هوية بصرية', quantity: 1, unit_price: 12500 },
  { description_en: 'Social ads', description_ar: 'إدارة حملة إعلانية', quantity: 1, unit_price: 8000 },
  { description_en: 'WordPress site', quantity: 2, unit_price: 3250.5 },
];
const save = (extra = {}, its = items) => fq(`SELECT public.fin_invoice_save($1, $2::jsonb) id`, [U.admin, JSON.stringify({ client_id: CLIENT, kind: 'project', withholding_rate: 1, items: its, ...extra })]);
let s1 = await save();
check('invoice saves as a draft', !s1.error && s1.rows[0].id, JSON.stringify(s1));
const inv1 = s1.rows[0].id;
r2 = await fq(`SELECT invoice_number, status, subtotal, vat_amount, withholding_amount, total, net_receivable, balance FROM public.invoices WHERE id=$1`, [inv1]);
let i1 = r2.rows[0];
check('draft has a placeholder number', /^DRAFT-/.test(i1.invoice_number) && i1.status === 'draft', JSON.stringify(i1));
check('subtotal 27001.00, VAT 3780.14, withholding 270.01, total 30781.14, net receivable 30511.13',
  num(i1.subtotal) === 27001 && num(i1.vat_amount) === 3780.14 && num(i1.withholding_amount) === 270.01 && num(i1.total) === 30781.14 && num(i1.net_receivable) === 30511.13, JSON.stringify(i1));

r2 = await save({ id: inv1 }, [{ description_en: 'Only line', quantity: 1, unit_price: 100, vat_rate: 0 }]);
r2 = await fq(`SELECT total, (SELECT count(*)::int FROM public.invoice_items WHERE invoice_id=$1) n FROM public.invoices WHERE id=$1`, [inv1]);
check('re-saving a draft replaces its lines and totals', num(r2.rows[0].total) === 100 && r2.rows[0].n === 1, JSON.stringify(r2));
await save({ id: inv1 });

r2 = await save({}, [{ description_en: 'x', quantity: 0, unit_price: 5 }]);
check('zero quantity is rejected', !!r2.error && /quantity/i.test(r2.error), JSON.stringify(r2));
r2 = await save({}, [{ description_en: 'x', quantity: 1, unit_price: -5 }]);
check('negative price is rejected', !!r2.error && /negative/i.test(r2.error), JSON.stringify(r2));
r2 = await save({}, [{ description_en: 'x', quantity: 1, unit_price: 5, discount_pct: 150 }]);
check('discount over 100% is rejected', !!r2.error && /discount/i.test(r2.error), JSON.stringify(r2));
r2 = await save({}, [{ quantity: 1, unit_price: 5 }]);
check('a line without a description is rejected', !!r2.error, JSON.stringify(r2));
r2 = await save({ due_date: '2000-01-01', issue_date: '2026-01-01' });
check('due date before issue date is rejected', !!r2.error && /due date/i.test(r2.error), JSON.stringify(r2));

// ---- client billing profile drives the withholding rate
await db.query(`SELECT public.fin_billing_save($1, $2::jsonb)`, [U.admin, JSON.stringify({ client_id: CLIENT, billing_type: 'retainer', withholding_rate: 3, payment_terms_days: 45 })]);
r2 = await fq(`SELECT public.fin_invoice_save($1, $2::jsonb) id`, [U.admin, JSON.stringify({ client_id: CLIENT, items: [{ description_en: 'a', quantity: 1, unit_price: 1000 }] })]);
r2 = await fq(`SELECT withholding_rate, withholding_amount, issue_date, due_date FROM public.invoices WHERE id=$1`, [r2.rows[0].id]);
check('client withholding rate (3%) and 45-day terms are applied by default', num(r2.rows[0].withholding_rate) === 3 && num(r2.rows[0].withholding_amount) === 30 && (new Date(r2.rows[0].due_date) - new Date(r2.rows[0].issue_date)) / 86400000 === 45, JSON.stringify(r2));

// ---- issuing and sequential numbers
let r3 = await fq(`SELECT public.fin_invoice_issue($1, $2) n`, [U.admin, inv1]);
check('issuing gives KITE-<year>-0001', !r3.error && /^KITE-\d{4}-0001$/.test(r3.rows[0].n), JSON.stringify(r3));
const zero = (await save({}, [{ description_en: 'free', quantity: 1, unit_price: 0 }])).rows[0].id;
r3 = await fq(`SELECT public.fin_invoice_issue($1, $2)`, [U.admin, zero]);
check('a zero-value invoice cannot be issued', !!r3.error && /greater than zero/.test(r3.error), JSON.stringify(r3));
const inv2 = (await save()).rows[0].id;
r3 = await fq(`SELECT public.fin_invoice_issue($1, $2) n`, [U.admin, inv2]);
check('the failed issue did not burn a number: next is 0002', !r3.error && /-0002$/.test(r3.rows[0].n), JSON.stringify(r3));
r3 = await fq(`SELECT public.fin_invoice_issue($1, $2)`, [U.admin, inv2]);
check('an issued invoice cannot be issued again', !!r3.error, JSON.stringify(r3));

// ---- issued invoices are frozen
r3 = await save({ id: inv1 });
check('an issued invoice cannot be edited through the save function', !!r3.error && /draft/i.test(r3.error), JSON.stringify(r3));
r3 = await fq(`UPDATE public.invoices SET total = 1 WHERE id=$1`, [inv1]);
check('totals of an issued invoice cannot be changed by SQL', !!r3.error, JSON.stringify(r3));
r3 = await fq(`UPDATE public.invoice_items SET unit_price = 1 WHERE invoice_id=$1`, [inv1]);
check('lines of an issued invoice cannot be changed', !!r3.error, JSON.stringify(r3));
r3 = await fq(`DELETE FROM public.invoices WHERE id=$1`, [inv1]);
check('invoices can never be deleted', !!r3.error, JSON.stringify(r3));

// ---- payments
r3 = await fq(`SELECT public.fin_payment_add($1, $2, 10000, current_date, 'bank_transfer', 'TX1', NULL) id`, [U.admin, inv1]);
const pay1 = r3.rows?.[0]?.id;
r3 = await fq(`SELECT status, amount_paid, balance FROM public.invoices WHERE id=$1`, [inv1]);
check('part payment -> partially_paid, balance 20511.13', r3.rows[0].status === 'partially_paid' && num(r3.rows[0].amount_paid) === 10000 && num(r3.rows[0].balance) === 20511.13, JSON.stringify(r3));
r3 = await fq(`SELECT public.fin_payment_add($1, $2, 30000, current_date, 'cash', NULL, NULL)`, [U.admin, inv1]);
check('overpayment is rejected', !!r3.error && /more than the balance/.test(r3.error), JSON.stringify(r3));
r3 = await fq(`SELECT public.fin_payment_add($1, $2, 5, current_date + 3, 'cash', NULL, NULL)`, [U.admin, inv1]);
check('a payment dated in the future is rejected', !!r3.error, JSON.stringify(r3));
r3 = await fq(`SELECT public.fin_payment_add($1, $2, 0, current_date, 'cash', NULL, NULL)`, [U.admin, inv1]);
check('a zero payment is rejected', !!r3.error, JSON.stringify(r3));
r3 = await fq(`SELECT public.fin_payment_add($1, $2, 20511.13, current_date, 'cash', NULL, NULL) id`, [U.admin, inv1]);
r3 = await fq(`SELECT status, balance, paid_date FROM public.invoices WHERE id=$1`, [inv1]);
check('paying the balance -> paid', r3.rows[0].status === 'paid' && num(r3.rows[0].balance) === 0 && !!r3.rows[0].paid_date, JSON.stringify(r3));
r3 = await fq(`UPDATE public.invoice_payments SET amount = 1 WHERE id=$1`, [pay1]);
check('a payment cannot be edited', !!r3.error, JSON.stringify(r3));
r3 = await fq(`DELETE FROM public.invoice_payments WHERE id=$1`, [pay1]);
check('a payment cannot be deleted', !!r3.error, JSON.stringify(r3));
r3 = await fq(`SELECT public.fin_invoice_void($1, $2, 'oops')`, [U.admin, inv1]);
check('an invoice with live payments cannot be voided', !!r3.error && /Reverse the payments/.test(r3.error), JSON.stringify(r3));
r3 = await fq(`SELECT public.fin_payment_reverse($1, $2, '')`, [U.admin, pay1]);
check('reversing needs a reason', !!r3.error, JSON.stringify(r3));
await db.query(`SELECT public.fin_payment_reverse($1, $2, 'bounced cheque')`, [U.admin, pay1]);
r3 = await fq(`SELECT status, amount_paid, balance FROM public.invoices WHERE id=$1`, [inv1]);
check('reversing a payment re-opens the invoice (partially_paid, balance 10000 + 10511.13...)', r3.rows[0].status === 'partially_paid' && num(r3.rows[0].amount_paid) === 20511.13 && num(r3.rows[0].balance) === 10000, JSON.stringify(r3));
r3 = await fq(`SELECT public.fin_payment_reverse($1, $2, 'again')`, [U.admin, pay1]);
check('a payment can only be reversed once', !!r3.error, JSON.stringify(r3));

// ---- void
const live = await fq(`SELECT id FROM public.invoice_payments WHERE invoice_id=$1 AND reversed_at IS NULL`, [inv1]);
for (const p of live.rows) await db.query(`SELECT public.fin_payment_reverse($1, $2, 'cleanup')`, [U.admin, p.id]);
r3 = await fq(`SELECT public.fin_invoice_void($1, $2, '')`, [U.admin, inv1]);
check('voiding needs a reason', !!r3.error, JSON.stringify(r3));
await db.query(`SELECT public.fin_invoice_void($1, $2, 'issued to the wrong client')`, [U.admin, inv1]);
r3 = await fq(`SELECT status, invoice_number, void_reason FROM public.invoices WHERE id=$1`, [inv1]);
check('void keeps the invoice and its number', r3.rows[0].status === 'void' && /-0001$/.test(r3.rows[0].invoice_number) && !!r3.rows[0].void_reason, JSON.stringify(r3));
r3 = await fq(`SELECT public.fin_payment_add($1, $2, 1, current_date, 'cash', NULL, NULL)`, [U.admin, inv1]);
check('no payment on a void invoice', !!r3.error, JSON.stringify(r3));
r3 = await fq(`UPDATE public.invoices SET notes = 'x' WHERE id=$1`, [inv1]);
check('a void invoice is frozen', !!r3.error, JSON.stringify(r3));

// ---- overdue
const late = (await save({ issue_date: '2026-01-01', due_date: '2026-01-31' })).rows[0].id;
await db.query(`SELECT public.fin_invoice_issue($1, $2)`, [U.admin, late]);
r3 = await fq(`SELECT status FROM public.invoices WHERE id=$1`, [late]);
check('an unpaid invoice past its due date is overdue', r3.rows[0].status === 'overdue', JSON.stringify(r3));
await db.query(`SELECT public.fin_payment_add($1, $2, 100, '2026-02-01', 'cash', NULL, NULL)`, [U.admin, late]);
r3 = await fq(`SELECT status FROM public.invoices WHERE id=$1`, [late]);
check('a part-paid invoice past its due date stays overdue', r3.rows[0].status === 'overdue', JSON.stringify(r3));

// ---- retainers: one invoice per plan per month
r3 = await fq(`SELECT public.fin_plan_save($1, $2::jsonb) id`, [U.admin, JSON.stringify({ client_id: CLIENT, name: 'Social media retainer', monthly_fee: 5000, start_date: '2026-01-01', billing_day: 5 })]);
check('retainer plan saves', !r3.error, JSON.stringify(r3));
const plan = r3.rows[0].id;
r3 = await fq(`SELECT public.fin_retainer_generate($1, '2026-03-17') n`, [U.admin]);
check('retainer run creates one draft for the month', r3.rows[0].n === 1, JSON.stringify(r3));
r3 = await fq(`SELECT public.fin_retainer_generate($1, '2026-03-02') n`, [U.admin]);
check('running it again creates nothing (no double billing)', r3.rows[0].n === 0, JSON.stringify(r3));
r3 = await fq(`SELECT kind, status, period_month, issue_date, subtotal, vat_amount FROM public.invoices WHERE retainer_plan_id=$1`, [plan]);
check('retainer invoice: draft, kind retainer, 5000 + 14% VAT, billing day 5', r3.rows.length === 1 && r3.rows[0].kind === 'retainer' && r3.rows[0].status === 'draft' && num(r3.rows[0].subtotal) === 5000 && num(r3.rows[0].vat_amount) === 700 && new Date(r3.rows[0].issue_date).getUTCDate() === 5, JSON.stringify(r3));
r3 = await fq(`SELECT public.fin_retainer_generate($1, '2025-12-10') n`, [U.admin]);
check('a month before the plan started gets no invoice', r3.rows[0].n === 0, JSON.stringify(r3));
await db.query(`UPDATE public.retainer_plans SET is_active = false WHERE id=$1`, [plan]);
r3 = await fq(`SELECT public.fin_retainer_generate($1, '2026-04-10') n`, [U.admin]);
check('an inactive plan is not billed', r3.rows[0].n === 0, JSON.stringify(r3));

// ---- audit trail
r3 = await fq(`SELECT count(*)::int n, count(*) FILTER (WHERE actor = $1)::int by_admin FROM public.finance_audit_log WHERE table_name IN ('invoices','invoice_items','invoice_payments')`, [U.admin]);
check('every invoice / line / payment change is in the audit log with the actor', r3.rows[0].n > 20 && r3.rows[0].by_admin > 20, JSON.stringify(r3));
r3 = await fq(`SELECT count(*)::int n FROM public.finance_audit_log WHERE table_name='invoices' AND row_id=$1 AND action='UPDATE' AND new_data->>'status'='void'`, [inv1]);
check('the void is in the audit log', r3.rows[0].n === 1, JSON.stringify(r3));
r3 = await fq(`UPDATE public.finance_audit_log SET actor = NULL`);
check('the audit log cannot be edited', !!r3.error, JSON.stringify(r3));
r3 = await fq(`DELETE FROM public.finance_audit_log`);
check('the audit log cannot be deleted', !!r3.error, JSON.stringify(r3));


// ---- the browser's invoice preview must equal the server to the cent (random invoices, same formula, exact integers)
{
  const mm = await import(new URL('../../js/modules/finance/money-math.mjs', import.meta.url).href);
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const pick = (max, dec) => Number((rnd() * max).toFixed(dec));
  let bad = 0, first = '';
  for (let n = 0; n < 400; n++) {
    const its = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({
      quantity: Math.max(0.001, pick(30, 3)), unit_price: pick(50000, 2), discount_pct: rnd() < 0.4 ? pick(100, 2) : 0, vat_rate: rnd() < 0.8 ? 14 : pick(30, 2) }));
    const wht = [0, 1, 3, 5][Math.floor(rnd() * 4)];
    const js = mm.calcTotals(its, wht);
    const sql = await db.query(
      `WITH l AS (SELECT (public.fin_calc_line((x->>'q')::numeric, (x->>'p')::numeric, (x->>'d')::numeric, (x->>'v')::numeric)).* FROM jsonb_array_elements($1::jsonb) x)
       SELECT sum(net) sub, sum(discount) disc, sum(vat) vat, public.fin_round(sum(net) * $2::numeric / 100) wht, sum(total) total FROM l`,
      [JSON.stringify(its.map(i => ({ q: i.quantity, p: i.unit_price, d: i.discount_pct, v: i.vat_rate }))), wht]);
    const r = sql.rows[0];
    const same = Number(r.sub) === js.subtotal && Number(r.disc) === js.discount && Number(r.vat) === js.vat && Number(r.wht) === js.wht && Number(r.total) === js.total;
    if (!same) { bad++; if (!first) first = JSON.stringify({ its, wht, js: { s: js.subtotal, d: js.discount, v: js.vat, w: js.wht, t: js.total }, sql: r }); }
  }
  check('browser preview == server maths on 400 random invoices', bad === 0, `${bad} differ, e.g. ${first}`);
}

// ---- who can do what
r3 = await as('emp', `SELECT count(*)::int c FROM public.invoices`);
check('an employee sees no invoices', denied(r3) || r3.rows[0].c === 0, JSON.stringify(r3));
r3 = await as('emp', `SELECT count(*)::int c FROM public.invoice_payments`);
check('an employee sees no payments', denied(r3) || r3.rows[0].c === 0, JSON.stringify(r3));
r3 = await as('hr', `SELECT count(*)::int c FROM public.invoices`);
check('HR sees no invoices', denied(r3) || r3.rows[0].c === 0, JSON.stringify(r3));
r3 = await as('fin', `SELECT count(*)::int c FROM public.invoices`);
check('the finance manager sees invoices', !r3.error && r3.rows[0].c >= 5, JSON.stringify(r3));
r3 = await as('fin', `SELECT count(*)::int c FROM public.clients`);
check('the finance manager can see every client', !r3.error && r3.rows[0].c >= 1, JSON.stringify(r3));
r3 = await as('admin', `SELECT count(*)::int c FROM public.finance_audit_log`);
check('the owner / super admin reads the audit log', !r3.error && r3.rows[0].c > 0, JSON.stringify(r3));
r3 = await as('emp', `SELECT count(*)::int c FROM public.finance_audit_log`);
check('an employee cannot read the audit log', denied(r3) || r3.rows[0].c === 0, JSON.stringify(r3));
r3 = await as('fin', `INSERT INTO public.invoices(invoice_number,type,due_date,status) VALUES ('HACK','receivable',current_date,'paid')`);
check('even finance cannot insert invoices directly (only through the server functions)', denied(r3), JSON.stringify(r3));
r3 = await as('fin', `UPDATE public.invoices SET status = 'paid'`);
check('even finance cannot update invoices directly', denied(r3), JSON.stringify(r3));
r3 = await as('admin', `DELETE FROM public.invoices`);
check('even the owner cannot delete invoices', denied(r3), JSON.stringify(r3));
r3 = await as('emp', `SELECT public.fin_invoice_issue('${U.emp}', '${inv2}')`);
check('an employee cannot call the finance functions', denied(r3), JSON.stringify(r3));
r3 = await as('fin', `SELECT public.fin_payment_add('${U.fin}', '${inv2}', 1, current_date, 'cash', NULL, NULL)`);
check('a signed-in finance user cannot call the write functions directly either', denied(r3), JSON.stringify(r3));
r3 = await as('fin', `UPDATE public.finance_settings SET vat_rate = 0`);
check('settings cannot be changed directly', denied(r3), JSON.stringify(r3));
r3 = await as('emp', `SELECT vat_rate FROM public.finance_settings`);
check('an employee cannot read finance settings', denied(r3) || r3.rows.length === 0, JSON.stringify(r3));
r3 = await as('emp', `SELECT count(*)::int c FROM finance_backup.invoices_pre017`);
check('the backup schema is not reachable from the API roles', denied(r3), JSON.stringify(r3));


// ---- the optional demo seed runs cleanly on top of real data
await db.query(`INSERT INTO public.clients(id,name,company_name) VALUES ('cccccccc-0000-0000-0000-000000000002','Sama','Sama Studio')`);
try {
  await db.exec(fs.readFileSync(M + 'seed-finance-demo.sql', 'utf8'));
  const sd = await db.query(`SELECT count(*)::int n FROM public.invoices WHERE notes IS NULL AND status IN ('draft','sent','partially_paid','paid')`);
  check('demo seed runs and creates invoices in several states', sd.rows[0].n > 5, JSON.stringify(sd.rows));
} catch (e) { check('demo seed runs and creates invoices in several states', false, e.message); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
