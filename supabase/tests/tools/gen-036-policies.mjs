// Generates the policy section of migration 036 (and its rollback) from the REAL policies that migrations 001..035 leave behind.
//   node supabase/tests/tools/gen-036-policies.mjs <out-dir>
// It writes   <out-dir>/036_policies.sql   (ALTER POLICY ... rewritten)   and   <out-dir>/036_policies_rollback.sql   (the originals).
// The rewrite is purely mechanical and is proven equivalent by supabase/tests/verify-perf.mjs (visible rows + write checks per role):
//   * a column-free helper call  auth_is_x() / auth_has_role('x')  and  auth.uid()   ->   (SELECT ...)      (evaluated once per statement)
//   * auth_can_view_task(<column>)  ->  EXISTS (SELECT 1 FROM public.tasks WHERE tasks.id = <table>.<column>)   (tasks' own RLS decides)
//   * the tasks SELECT policy itself  ->  helpers that return the caller's id sets (evaluated once per statement)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL, fileURLToPath } from 'url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SB = path.resolve(HERE, '..', '..');
const OUT = path.resolve(process.argv[2] || '.');
const req = createRequire(path.join(SB, 'tests', 'package.json'));
const EP = (await import(pathToFileURL(req.resolve('embedded-postgres')).href)).default;
const pg = (await import(pathToFileURL(req.resolve('pg')).href)).default;

export const TASKS_EXPR = `((SELECT public.auth_is_staff()) AND ((SELECT public.auth_is_admin()) OR (assigned_to = (SELECT auth.uid())) OR (created_by = (SELECT auth.uid())) OR ((SELECT public.auth_is_active()) AND (department_id IN (SELECT public.auth_managed_department_ids()))) OR (id IN (SELECT public.auth_assigned_task_ids())) OR ((project_id IS NOT NULL) AND (project_id IN (SELECT public.auth_managed_project_ids())))))`;

/** the rewrite (exported so the test can reuse the exact same function) */
export function rewrite(expr, table) {
  if (!expr) return expr;
  let e = expr;
  if (table === 'tasks' && /^\(?\s*(public\.)?auth_can_view_task\(id\)\s*\)?$/.test(e.trim())) return TASKS_EXPR;
  e = e.replace(/(?<![\w.])(?:public\.)?auth_can_view_task\(\s*([a-z_]+)\s*\)/g, (_, col) => `(EXISTS ( SELECT 1 FROM public.tasks t_vis WHERE (t_vis.id = ${table}.${col})))`);
  // column-free helpers, not already wrapped in a sub-select
  e = e.replace(/(?<!SELECT )(?<![\w.])(?:public\.)?(auth_(?:is|has)_[a-z_]+)\(\s*((?:'[a-z_]+'(?:::text)?)?)\s*\)/g, (_, fn, arg) => `(SELECT public.${fn}(${arg}))`);
  e = e.replace(/(?<!SELECT )(?<![\w.])auth\.uid\(\)/g, '(SELECT auth.uid())');
  return e;
}
const alter = (p, q, w) => {
  const parts = [];
  if (q != null) parts.push(`USING (${q})`);
  if (w != null) parts.push(`WITH CHECK (${w})`);
  return `ALTER POLICY ${JSON.stringify(p.policyname)} ON public.${p.tablename} ${parts.join(' ')};`;
};
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const testSrc = fs.readFileSync(path.join(SB, 'tests', 'verify-integrity.mjs'), 'utf8');
  const STUBS = /const STUBS = `([\s\S]*?)`;/.exec(testSrc)[1];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-gen-'));
  const PORT = 56900 + Math.floor(Math.random() * 90);
  const server = new EP({ databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'pw', port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
  try {
    await server.initialise(); await server.start();
    const c0 = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'pw', database: 'postgres' }); await c0.connect();
    await c0.query(`CREATE DATABASE kite ENCODING 'UTF8' TEMPLATE template0 LOCALE 'C'`); await c0.end();
    const db = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'pw', database: 'kite' }); await db.connect();
    await db.query(STUBS);
    for (const f of fs.readdirSync(path.join(SB, 'migrations')).filter((x) => /^\d{3}_.*\.sql$/.test(x) && x < '036').sort()) {
      await db.query(fs.readFileSync(path.join(SB, 'migrations', f), 'utf8'));
      if (f.startsWith('005')) await db.query(fs.readFileSync(path.join(SB, 'seed.sql'), 'utf8'));
    }
    const pol = (await db.query(`SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename, policyname`)).rows;
    const fwd = [], back = [];
    let changed = 0;
    for (const p of pol) {
      const q = rewrite(p.qual, p.tablename), w = rewrite(p.with_check, p.tablename);
      if (q === p.qual && w === p.with_check) continue;
      changed++;
      fwd.push(alter(p, q, w)); back.push(alter(p, p.qual, p.with_check));
    }
    fs.writeFileSync(path.join(OUT, '036_policies.sql'), fwd.join('\n') + '\n');
    fs.writeFileSync(path.join(OUT, '036_policies_rollback.sql'), back.join('\n') + '\n');
    console.log(`policies ${pol.length}, rewritten ${changed}`);
    await db.end();
  } finally { try { await server.stop(); } catch { /* */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
  process.exit(0);
}
