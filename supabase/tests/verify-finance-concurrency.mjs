// Real-PostgreSQL regression + concurrency tests for the Phase 3.A finance integrity fixes (migration 028).
// PGlite (verify-rls.mjs) is a single connection and cannot test races, so this script starts a throwaway real
// PostgreSQL server (embedded-postgres, local port, temp directory) and races genuine connections.
// It never touches any remote database. Run:   npm install --no-save embedded-postgres pg   &&   node verify-finance-concurrency.mjs
// Without the optional dependencies it prints SKIPPED and exits 0.
//
// Three databases on the throwaway server:
//   old    = 017 only         -> proves each race is REAL (F-01, F-14 fail without 028)
//   fin    = 017 + 028        -> proves each fix holds, incl. a randomized multi-connection stress run
//   legacy = 017, corrupted legacy rows, then 028 -> proves nothing historical is rewritten or blocked,
//            constraints that the data cannot satisfy stay NOT VALID, and the documented rollback works
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
const ok = (c, name, d = '') => { if (c) passed++; else { failed++; console.log('FAIL', name, d); } };
const section = (s) => console.log('\n== ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (x) => Number(x);
const sql = (f) => fs.readFileSync(path.join(SB, f), 'utf8');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-fin-'));
const PORT = 55100 + Math.floor(Math.random() * 800);
const server = new EmbeddedPostgres({ databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'pw', port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
const connect = async (db, notices) => {
  const c = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'pw', database: db });
  await c.connect(); c.on('error', () => {}); if (notices) c.on('notice', (n) => notices.push(n.message)); return c;
};
const U = '00000000-0000-4000-8000-000000000001';
const items = (price = 1000, vat = 0) => [{ description_en: 'work', quantity: 1, unit_price: price, vat_rate: vat }];

/** Creates a database (UTF8: 017 contains Arabic text) with the Supabase stubs and migrations 001, 003, 017. */
async function makeDb(name, { legacyRows = false } = {}) {
  const c0 = await connect('postgres');
  await c0.query(`CREATE DATABASE ${name} ENCODING 'UTF8' TEMPLATE template0 LOCALE 'C'`); await c0.end();
  const c = await connect(name);
  await c.query(`CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, raw_user_meta_data jsonb);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION public.auth_is_active() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;`);
  await c.query(sql('migrations/001_initial_schema.sql'));
  await c.query(sql('migrations/003_updated_at.sql'));
  await c.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [U, 'a@x.test']);
  await c.query("INSERT INTO public.profiles(id,full_name,email) VALUES ($1,'A','a@x.test')", [U]);
  if (legacyRows) {   // exactly what an installation had BEFORE the finance upgrade
    await c.query(`INSERT INTO public.invoices(id,invoice_number,type,amount,tax,total,status,due_date,paid_date) VALUES
      ('aaaaaaaa-0000-0000-0000-000000000001','OLD-1','receivable',1000,140,1140,'paid','2026-01-31','2026-01-20'),
      ('aaaaaaaa-0000-0000-0000-000000000002','OLD-2','receivable',500,0,500,'cancelled','2026-01-31',NULL),
      ('aaaaaaaa-0000-0000-0000-000000000003','OLD-3','receivable',2000,280,2280,'sent','2099-01-31',NULL)`);
  }
  await c.query(sql('migrations/017_finance_invoicing.sql'));
  return c;
}

const api = (c) => ({
  client: async (n = 'Client') => (await c.query("INSERT INTO public.clients(name,company_name) VALUES ($1,$1) RETURNING id", [n + Math.random()])).rows[0].id,
  save: async (client, its = items(), extra = {}) => (await c.query('SELECT public.fin_invoice_save($1,$2::jsonb) id', [U, JSON.stringify({ client_id: client, kind: 'project', withholding_rate: 0, items: its, ...extra })])).rows[0].id,
  issue: async (id) => (await c.query('SELECT public.fin_invoice_issue($1,$2) n', [U, id])).rows[0].n,
  invoice: async (client, price = 1000) => { const a = api(c); const id = await a.save(client, items(price)); await a.issue(id); return id; },
  state: async (id) => {
    const r = (await c.query(`SELECT i.status, i.amount_paid, i.balance,
      (SELECT coalesce(sum(amount),0) FROM public.invoice_payments p WHERE p.invoice_id=i.id AND p.reversed_at IS NULL) truth FROM public.invoices i WHERE id=$1`, [id])).rows[0];
    return { status: r.status, paid: num(r.amount_paid), balance: num(r.balance), truth: num(r.truth), consistent: num(r.amount_paid) === num(r.truth) };
  },
});
const pay = (c, inv, amt, req = null) => (req === null
  ? c.query(`SELECT public.fin_payment_add($1,$2,$3,current_date,'cash',NULL,NULL) id`, [U, inv, amt])   // the original 7-argument call (works before and after 028)
  : c.query(`SELECT public.fin_payment_add($1,$2,$3,current_date,'cash',NULL,NULL,$4::uuid) id`, [U, inv, amt, req])).then((r) => r.rows[0].id);
const reverse = (c, id) => c.query('SELECT public.fin_payment_reverse($1,$2,$3)', [U, id, 'test']);
const uuid = (n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`;

const conns = [];
const track = (c) => { conns.push(c); return c; };
try {
  await server.initialise(); await server.start();
  const c0 = await connect('postgres');
  await c0.query(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`); await c0.end();
  console.log('real PostgreSQL ' + (await (await connect('postgres')).query('SHOW server_version')).rows[0].server_version + ' on port ' + PORT);

  // ================================================================== OLD: the races are real without 028
  section('0. WITHOUT migration 028 the F-01 / F-14 races are real');
  const old = track(await makeDb('old')); const O = api(old); const oc = await O.client();
  {
    const inv = await O.invoice(oc); const p1 = await pay(old, inv, 300);
    const a = track(await connect('old')), b = track(await connect('old'));
    await a.query('BEGIN'); await pay(a, inv, 200);
    const rev = reverse(b, p1); await sleep(500); await a.query('COMMIT'); await rev;
    const s = await O.state(inv);
    ok(!s.consistent, 'old R1: payment_add racing payment_reverse leaves amount_paid wrong', JSON.stringify(s));
    const inv2 = await O.invoice(oc); const q1 = await pay(old, inv2, 300), q2 = await pay(old, inv2, 200);
    await a.query('BEGIN'); await reverse(a, q1);
    const rev2 = reverse(b, q2); await sleep(500); await a.query('COMMIT'); await rev2;
    const s2 = await O.state(inv2);
    ok(!s2.consistent && s2.truth === 0, 'old R2: two simultaneous reversals leave amount_paid wrong (paid must be 0)', JSON.stringify(s2));
    const o3 = await O.invoice(oc); await pay(old, o3, 400); await pay(old, o3, 400);
    ok((await O.state(o3)).paid === 800, 'old F-03: the same payment sent twice is recorded twice (no request id exists)');
    const cl = await O.client();
    await old.query(`SELECT public.fin_plan_save($1,$2::jsonb)`, [U, JSON.stringify({ client_id: cl, name: 'Plan', monthly_fee: 1000, start_date: '2026-01-01' })]);
    const r = await Promise.allSettled([a.query("SELECT public.fin_retainer_generate($1,'2027-05-01')", [U]), b.query("SELECT public.fin_retainer_generate($1,'2027-05-01')", [U])]);
    ok(r.some((x) => x.status === 'rejected' && /uq_invoice_retainer_month/.test(x.reason.message)), 'old F-14: two concurrent runs - one fails with a unique violation', r.map((x) => x.status).join());
    await a.end(); await b.end();
  }

  // ================================================================== FIN: fixed
  section('1. WITH 028: F-01 payment_add / payment_reverse / reverse+reverse (deterministic interleavings)');
  const fin = track(await makeDb('fin')); await fin.query(sql('migrations/028_finance_integrity.sql')); await fin.query(sql('migrations/028_finance_integrity.sql')); // twice = idempotent
  const F = api(fin); const fc = await F.client();
  {
    const a = track(await connect('fin')), b = track(await connect('fin'));
    const inv = await F.invoice(fc); const p1 = await pay(fin, inv, 300);
    await a.query('BEGIN'); await pay(a, inv, 200);
    const rev = reverse(b, p1); await sleep(500); await a.query('COMMIT'); await rev;
    let s = await F.state(inv);
    ok(s.consistent && s.paid === 200 && s.balance === 800 && s.status === 'partially_paid', 'R1: reverse waits for the payment, then recomputes: paid 200 / balance 800', JSON.stringify(s));
    // R1b: the other order (reverse first holds the lock, payment waits)
    const inv1b = await F.invoice(fc); const x1 = await pay(fin, inv1b, 300);
    await a.query('BEGIN'); await reverse(a, x1);
    const add = pay(b, inv1b, 200); await sleep(500); await a.query('COMMIT'); await add;
    s = await F.state(inv1b); ok(s.consistent && s.paid === 200 && s.status === 'partially_paid', 'R1b: payment waits for the reversal: paid 200', JSON.stringify(s));
    // R2
    const inv2 = await F.invoice(fc); const q1 = await pay(fin, inv2, 300), q2 = await pay(fin, inv2, 200);
    await a.query('BEGIN'); await reverse(a, q1);
    const rev2 = reverse(b, q2); await sleep(500); await a.query('COMMIT'); await rev2;
    s = await F.state(inv2); ok(s.consistent && s.paid === 0 && s.status === 'sent' && s.balance === 1000, 'R2: two simultaneous reversals: paid 0, balance 1000, status sent', JSON.stringify(s));
    // the invoice lock is what serialises: a reverse blocked on an open invoice transaction really waits
    const inv3 = await F.invoice(fc); const z = await pay(fin, inv3, 100);
    await a.query('BEGIN'); await a.query('SELECT 1 FROM public.invoices WHERE id=$1 FOR UPDATE', [inv3]);
    let done = false; const w = reverse(b, z).then(() => { done = true; });
    await sleep(400); const waited = !done; await a.query('COMMIT'); await w;
    ok(waited && done, 'reverse takes the parent INVOICE lock (it waited for an unrelated holder of the invoice row)');
    await a.end(); await b.end();
  }

  section('2. WITH 028: randomized multi-connection stress (add / reverse / void attempts), no drift, no deadlock');
  {
    const invs = []; for (let i = 0; i < 6; i++) invs.push(await F.invoice(fc, 1000));
    const W = 8, N = 45; const workers = []; for (let i = 0; i < W; i++) workers.push(track(await connect('fin')));
    let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const expected = /more than the balance|already reversed|cannot record a payment|Payment not found/;
    const bad = []; let adds = 0, revs = 0, reqN = 1000;
    await Promise.all(workers.map(async (w) => {
      for (let k = 0; k < N; k++) {
        const inv = invs[Math.floor(rnd() * invs.length)];
        try {
          if (rnd() < 0.6) { await pay(w, inv, [50, 100, 150, 200][Math.floor(rnd() * 4)], uuid(++reqN)); adds++; }
          else {
            const live = (await w.query('SELECT id FROM public.invoice_payments WHERE invoice_id=$1 AND reversed_at IS NULL', [inv])).rows;
            if (live.length) { await reverse(w, live[Math.floor(rnd() * live.length)].id); revs++; }
          }
        } catch (e) { if (!expected.test(e.message)) bad.push(e.message); }
      }
    }));
    ok(bad.length === 0, 'stress: no unexpected error (no deadlock, no constraint failure)', bad.slice(0, 3).join(' | '));
    ok(adds > 40 && revs > 15, `stress: real work happened (${adds} payments, ${revs} reversals)`);
    const drift = (await fin.query('SELECT count(*)::int c FROM public.fin_reconcile_invoices()')).rows[0].c;
    ok(drift === 0, 'stress: fin_reconcile_invoices() reports zero problems after the run', String(drift));
    let allOk = true; for (const i of invs) { const s = await F.state(i); if (!s.consistent || s.paid > 1000 || s.balance !== 1000 - s.paid) allOk = false; }
    ok(allOk, 'stress: every invoice: amount_paid = sum of live payments, never above the total, balance = total - paid');
    await Promise.all(workers.map((w) => w.end()));
  }

  section('3. WITH 028: F-03 idempotency under concurrency');
  {
    const inv = await F.invoice(fc); const REQ = uuid(1);
    const cs = await Promise.all(Array.from({ length: 8 }, () => connect('fin').then(track)));
    const r = await Promise.allSettled(cs.map((c) => pay(c, inv, 400, REQ)));
    const ids = new Set(r.filter((x) => x.status === 'fulfilled').map((x) => x.value));
    ok(r.every((x) => x.status === 'fulfilled') && ids.size === 1, '8 simultaneous identical requests -> 8 successes, ONE payment id', JSON.stringify(r.map((x) => x.status)));
    const s = await F.state(inv); ok(s.paid === 400 && s.consistent, 'the invoice shows 400 paid once', JSON.stringify(s));
    const n = (await fin.query('SELECT count(*)::int c FROM public.invoice_payments WHERE request_id=$1', [REQ])).rows[0].c;
    ok(n === 1, 'one row carries the request id');
    // distinct ids racing past the balance: exactly two of three 400s fit into 1000
    const inv2 = await F.invoice(fc);
    const r2 = await Promise.allSettled([1, 2, 3].map((i) => pay(cs[i], inv2, 400, uuid(100 + i))));
    const s2 = await F.state(inv2);
    ok(r2.filter((x) => x.status === 'fulfilled').length === 2 && s2.paid === 800, 'three concurrent 400s on a 1000 invoice: two succeed, one is refused (no overpayment)', JSON.stringify([r2.map((x) => x.status), s2]));
    // same id racing on two DIFFERENT invoices: one wins, the other is refused
    const iA = await F.invoice(fc), iB = await F.invoice(fc);
    const r3 = await Promise.allSettled([pay(cs[4], iA, 100, uuid(200)), pay(cs[5], iB, 100, uuid(200))]);
    ok(r3.filter((x) => x.status === 'fulfilled').length === 1, 'one request id racing on two invoices: only one payment is created', r3.map((x) => x.status + (x.reason ? ':' + x.reason.message.slice(0, 40) : '')).join());
    await Promise.all(cs.map((c) => c.end()));
  }

  section('4. WITH 028: F-04 client removed (real foreign key path)');
  {
    const c1 = await F.client(); const d = await F.save(c1);
    await fin.query('DELETE FROM public.clients WHERE id=$1', [c1]);
    ok((await fin.query('SELECT client_id FROM public.invoices WHERE id=$1', [d])).rows[0].client_id === null, 'the draft survives the client delete with client_id NULL (history kept)');
    let e = ''; try { await F.issue(d); } catch (x) { e = x.message; }
    ok(/Choose a client/.test(e), 'issuing it is refused', e);
    ok((await fin.query("SELECT count(*)::int c FROM public.invoices WHERE id=$1 AND status='draft' AND invoice_number LIKE 'DRAFT-%'", [d])).rows[0].c === 1, 'it is still a draft and consumed no invoice number');
    const c2 = await F.client(); await F.invoice(c2);
    e = ''; try { await fin.query('DELETE FROM public.clients WHERE id=$1', [c2]); } catch (x) { e = x.message; }
    ok(e !== '', 'a client with an issued invoice still cannot be deleted', e);
  }

  section('5. WITH 028: F-13 unpayable invoice, F-05 constraints on a real server');
  {
    let e = ''; try { await F.save(fc, items(500, 0), { withholding_rate: 100 }); } catch (x) { e = x.message; }
    ok(/Nothing to collect/.test(e), 'F-13: 100% withholding, 0% VAT is refused at save', e);
    const okInv = await F.save(fc, items(500, 14), { withholding_rate: 100 }); await F.issue(okInv);
    const s = await F.state(okInv); const net = num((await fin.query('SELECT net_receivable n FROM public.invoices WHERE id=$1', [okInv])).rows[0].n);
    ok(net === 70 && s.status === 'sent', 'F-13: with VAT the net receivable (the VAT, 70) is collectable', JSON.stringify({ net, s }));
    await pay(fin, okInv, 70); ok((await F.state(okInv)).status === 'paid', 'F-13: and it can be paid in full');
    const inv = await F.invoice(fc);
    for (const [name, q] of [['negative balance', 'UPDATE public.invoices SET balance=-1 WHERE id=$1'], ['paid above net', 'UPDATE public.invoices SET amount_paid=5000 WHERE id=$1'],
      ['paid status with balance', "UPDATE public.invoices SET status='paid' WHERE id=$1"], ['back to draft', "UPDATE public.invoices SET status='draft' WHERE id=$1"],
      ['total != subtotal+vat', 'UPDATE public.invoices SET total=total+1 WHERE id=$1']]) {
      let err = ''; try { await fin.query(q, [inv]); } catch (x) { err = x.message; }
      ok(err !== '', 'F-05: ' + name + ' is refused', err);
    }
    let e2 = ''; try { await fin.query('BEGIN'); await fin.query('UPDATE public.invoices SET amount_paid=10, balance=990 WHERE id=$1', [inv]); await fin.query('COMMIT'); } catch (x) { e2 = x.message; await fin.query('ROLLBACK'); }
    ok(/out of balance/.test(e2), 'F-05: amount_paid that disagrees with the payments is refused at COMMIT', e2);
    ok((await F.state(inv)).consistent, 'F-05: the refused transaction left the invoice untouched');
  }

  section('6. WITH 028: F-10 duplicate plans, F-14 concurrent retainer runs');
  {
    const cl = await F.client(); const plan = (n) => JSON.stringify({ client_id: cl, name: n, monthly_fee: 1000, start_date: '2026-01-01' });
    const cs = await Promise.all(Array.from({ length: 6 }, () => connect('fin').then(track)));
    const r = await Promise.allSettled(cs.map((c) => c.query('SELECT public.fin_plan_save($1,$2::jsonb)', [U, plan('Social')])));
    ok(r.filter((x) => x.status === 'fulfilled').length === 1, 'F-10: six concurrent identical plan saves -> exactly one plan', r.map((x) => x.status).join());
    ok((await fin.query("SELECT count(*)::int c FROM public.retainer_plans WHERE client_id=$1", [cl])).rows[0].c === 1, 'F-10: one plan stored');
    await fin.query('SELECT public.fin_plan_save($1,$2::jsonb)', [U, plan('Ads')]);
    // 12 plans total in the database for the month (other tests created plans too): compare with what exists
    const planCount = (await fin.query("SELECT count(*)::int c FROM public.retainer_plans WHERE is_active AND start_date <= '2027-06-30'")).rows[0].c;
    const runs = await Promise.allSettled(cs.slice(0, 4).map((c) => c.query("SELECT public.fin_retainer_generate($1,'2027-06-01') n", [U])));
    ok(runs.every((x) => x.status === 'fulfilled'), 'F-14: four concurrent runs, none fails', runs.map((x) => x.status + (x.reason ? ':' + x.reason.message.slice(0, 60) : '')).join());
    const created = runs.reduce((t, x) => t + (x.status === 'fulfilled' ? x.value.rows[0].n : 0), 0);
    const inv = (await fin.query("SELECT count(*)::int c, count(DISTINCT retainer_plan_id)::int d FROM public.invoices WHERE period_month='2027-06-01'")).rows[0];
    ok(created === planCount && inv.c === planCount && inv.d === planCount, `F-14: each of the ${planCount} plans billed exactly once (${created} created in total)`, JSON.stringify({ created, planCount, inv }));
    // the skip path itself: another transaction already holds a plan's (retainer, month) slot and commits during the run
    const cl2 = await F.client(); await fin.query('SELECT public.fin_plan_save($1,$2::jsonb)', [U, JSON.stringify({ client_id: cl2, name: 'Slot', monthly_fee: 700, start_date: '2026-01-01' })]);
    const pid = (await fin.query("SELECT id FROM public.retainer_plans WHERE client_id=$1", [cl2])).rows[0].id;
    const a = cs[4], b = cs[5];
    await a.query('BEGIN');
    const d1 = await a.query('SELECT public.fin_invoice_save($1,$2::jsonb) id', [U, JSON.stringify({ client_id: cl2, kind: 'retainer', items: items(700) })]);
    await a.query("UPDATE public.invoices SET retainer_plan_id=$1, period_month='2027-07-01' WHERE id=$2", [pid, d1.rows[0].id]);   // a manual / parallel creation, uncommitted
    const gen = b.query("SELECT public.fin_retainer_generate($1,'2027-07-01') n", [U]);
    await sleep(600); await a.query('COMMIT'); const g = await gen;
    const cnt = (await fin.query("SELECT count(*)::int c FROM public.invoices WHERE retainer_plan_id=$1 AND period_month='2027-07-01'", [pid])).rows[0].c;
    const stray = (await fin.query("SELECT count(*)::int c FROM public.invoices i WHERE kind='retainer' AND status='draft' AND retainer_plan_id IS NULL")).rows[0].c;
    ok(cnt === 1 && stray === 0, 'F-14: a plan billed meanwhile by someone else is skipped; no duplicate and no stray draft is left', JSON.stringify({ cnt, stray, n: g.rows[0].n }));
    await Promise.all(cs.map((c) => c.end()));
  }

  section('7. WITH 028: nothing already recorded was changed by the migration (snapshot on the fin database)');
  ok((await fin.query('SELECT count(*)::int c FROM public.fin_reconcile_invoices()')).rows[0].c === 0, 'reconcile is clean after all of the above');
  ok((await fin.query("SELECT count(*)::int c FROM public.finance_audit_log WHERE action='DELETE' AND table_name IN ('invoices','invoice_payments')")).rows[0].c === 0, 'no invoice or payment was ever deleted');

  // ================================================================== LEGACY: data that does not satisfy the new rules
  section('8. LEGACY database: corrupt / duplicate historical rows are audited, never rewritten, never block valid work');
  const notices = [];
  const leg = track(await makeDb('legacy', { legacyRows: true })); const L = api(leg); const lc = await L.client();
  const lg = track(await connect('legacy', notices));
  {
    // historical damage that 017 allowed: a paid-in-excess invoice, a paid status with a balance, and two identical active plans
    const bad1 = await L.invoice(lc); await pay(leg, bad1, 100);
    await leg.query("ALTER TABLE public.invoices DISABLE TRIGGER USER");
    await leg.query("UPDATE public.invoices SET status='paid', balance=500 WHERE id=$1", [bad1]);
    await leg.query("ALTER TABLE public.invoices ENABLE TRIGGER USER");
    const cl = await L.client(); const pl = JSON.stringify({ client_id: cl, name: 'Dup', monthly_fee: 100, start_date: '2026-01-01' });
    await leg.query('SELECT public.fin_plan_save($1,$2::jsonb)', [U, pl]); await leg.query('SELECT public.fin_plan_save($1,$2::jsonb)', [U, pl]);
    const snap = async () => JSON.stringify((await leg.query(`SELECT (SELECT json_agg(i ORDER BY id) FROM public.invoices i) inv, (SELECT json_agg(to_jsonb(p) - 'request_id' ORDER BY id) FROM public.invoice_payments p) pay,
      (SELECT json_agg(t ORDER BY id) FROM public.invoice_items t) itm, (SELECT json_agg(r ORDER BY id) FROM public.retainer_plans r) plans`)).rows[0]);
    const before = await snap();
    await lg.query(sql('migrations/028_finance_integrity.sql'));
    { const after = await snap(); if (before !== after) { const A = JSON.parse(before), B = JSON.parse(after); for (const k of Object.keys(A)) if (JSON.stringify(A[k]) !== JSON.stringify(B[k])) console.log('DIFF in', k, JSON.stringify(A[k]).slice(0, 600), 'VS', JSON.stringify(B[k]).slice(0, 600)); } ok(before === after, 'applying 028 changed NO existing invoice, line, payment or plan (byte-identical snapshot)'); }
    ok(notices.some((m) => /duplicate ACTIVE retainer plans/.test(m)), 'the duplicate plans were reported (NOTICE), not touched', notices.join(' | ').slice(0, 200));
    ok((await leg.query("SELECT count(*)::int c FROM pg_indexes WHERE indexname='uq_retainer_plan_active'")).rows[0].c === 0, 'the unique plan index was NOT created while duplicates exist');
    ok(notices.some((m) => /invoices_balance_chk/.test(m) || /invoices_paid_status_chk/.test(m)), 'the CHECKs the data cannot satisfy were reported (NOTICE)');
    const cons = (await leg.query("SELECT conname, convalidated FROM pg_constraint WHERE conrelid='public.invoices'::regclass AND conname LIKE 'invoices\\_%\\_chk'")).rows;
    ok(cons.length === 6 && cons.some((x) => x.convalidated) && cons.some((x) => !x.convalidated), 'all six exist; the compliant ones are VALIDATED, the violated ones stay NOT VALID', JSON.stringify(cons));
    const rec = (await leg.query('SELECT problem FROM public.fin_reconcile_invoices() WHERE invoice_id=$1', [bad1])).rows.map((r) => r.problem);
    ok(rec.some((p) => /status is paid but a balance/.test(p)), 'reconcile lists the historical problem for review', rec.join(' | '));
    // new, valid work is unaffected
    const good = await L.invoice(lc); await pay(leg, good, 250, uuid(500)); await pay(leg, good, 750, uuid(501));
    ok((await L.state(good)).status === 'paid', 'a new invoice is issued and paid normally on the legacy database');
    ok((await leg.query("SELECT status, balance::numeric b FROM public.invoices WHERE invoice_number='OLD-3'")).rows[0].b == 2280, 'legacy OLD-3 keeps its balance; and can still take a payment');
    await pay(leg, (await leg.query("SELECT id FROM public.invoices WHERE invoice_number='OLD-3'")).rows[0].id, 280, uuid(502));
    ok((await leg.query("SELECT status, amount_paid::numeric p FROM public.invoices WHERE invoice_number='OLD-3'")).rows[0].p == 280, 'OLD-3 recorded the payment through the new function');
    // but the NEW bad writes are blocked even though the old damage exists
    let e = ''; try { await leg.query('UPDATE public.invoices SET balance=-1 WHERE id=$1', [good]); } catch (x) { e = x.message; }
    ok(e !== '', 'new violations are refused even while legacy violations exist', e);
    // after the data is cleaned (an operator decision), re-running 028 validates everything and creates the index
    await leg.query("ALTER TABLE public.invoices DISABLE TRIGGER USER"); await leg.query("ALTER TABLE public.invoices DISABLE TRIGGER fin_paid_sum_invoice");
    await leg.query("UPDATE public.invoices SET status='partially_paid', balance=net_receivable-amount_paid WHERE id=$1", [bad1]);
    await leg.query("ALTER TABLE public.invoices ENABLE TRIGGER fin_paid_sum_invoice"); await leg.query("ALTER TABLE public.invoices ENABLE TRIGGER USER");
    await leg.query("UPDATE public.retainer_plans SET is_active=false WHERE id=(SELECT id FROM public.retainer_plans WHERE name='Dup' ORDER BY created_at DESC, id LIMIT 1)");
    await lg.query(sql('migrations/028_finance_integrity.sql'));
    ok((await leg.query("SELECT bool_and(convalidated) v FROM pg_constraint WHERE conrelid='public.invoices'::regclass AND conname LIKE 'invoices\\_%\\_chk'")).rows[0].v === true, 're-running 028 after the clean-up VALIDATES every CHECK');
    ok((await leg.query("SELECT count(*)::int c FROM pg_indexes WHERE indexname='uq_retainer_plan_active'")).rows[0].c === 1, '... and creates the unique plan index');
  }

  section('9. The documented ROLLBACK works and loses no data');
  {
    const hdr = sql('migrations/028_finance_integrity.sql'); const i = hdr.indexOf('-- ROLLBACK'); const j = hdr.indexOf('-- ====', i);
    const rb = hdr.slice(i, j).split('\n').slice(1).map((l) => l.replace(/\r$/, '').replace(/^-- ?/, '')).filter((l) => !/^\s*--/.test(l) && !/^\s*$/.test(l)).join('\n');
    ok(/DROP FUNCTION IF EXISTS public.fin_payment_add\(uuid, uuid, numeric, date, text, text, text, uuid\)/.test(rb) && /fin_paid_sum_invoice/.test(rb), 'the rollback text is present in the migration header');
    const snap = async () => JSON.stringify((await leg.query(`SELECT (SELECT count(*) FROM public.invoices) a, (SELECT sum(total) FROM public.invoices) b, (SELECT count(*) FROM public.invoice_payments) c, (SELECT sum(amount) FROM public.invoice_payments) d, (SELECT count(*) FROM public.retainer_plans) e, (SELECT count(*) FROM public.invoice_items) f`)).rows[0]);
    const before = await snap();
    await leg.query(rb);
    ok(await snap() === before, 'rollback statements ran; every historical row and total is unchanged');
    ok((await leg.query("SELECT count(*)::int c FROM pg_constraint WHERE conrelid='public.invoices'::regclass AND conname LIKE 'invoices\\_%\\_chk'")).rows[0].c === 0, 'the six CHECKs are gone');
    await leg.query(sql('migrations/017_finance_invoicing.sql'));   // step 2 of the rollback: restore the original function bodies
    ok(await snap() === before, 're-running 017 afterwards still changes no data');
    ok((await leg.query("SELECT count(*)::int c FROM pg_proc WHERE proname='fin_payment_add' AND pronargs=7")).rows[0].c === 1, 'the original 7-argument fin_payment_add is back');
    const inv = await L.invoice(lc); await leg.query("SELECT public.fin_payment_add($1,$2,100,current_date,'cash',NULL,NULL)", [U, inv]);
    ok((await L.state(inv)).paid === 100, 'finance works again exactly as before 028');
    await lg.query(sql('migrations/028_finance_integrity.sql'));
    ok((await leg.query("SELECT count(*)::int c FROM pg_proc WHERE proname='fin_payment_add'")).rows[0].c >= 1 && (await leg.query("SELECT count(*)::int c FROM pg_constraint WHERE conrelid='public.invoices'::regclass AND conname LIKE 'invoices\\_%\\_chk'")).rows[0].c === 6, '028 can be applied again after a rollback');
    { const rr = (await leg.query('SELECT invoice_number, problem FROM public.fin_reconcile_invoices()')).rows; ok(rr.length === 3 && rr.every((x) => /^OLD-/.test(x.invoice_number) && /without a client/.test(x.problem)), 'and reconcile reports only the three legacy invoices that never had a client (information, nothing blocked)', JSON.stringify(rr)); }
  }
} catch (e) { failed++; console.log('SCRIPT ERROR', e); }
finally {
  for (const c of conns) { try { await c.end(); } catch { /* already closed */ } }
  try { await server.stop(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
