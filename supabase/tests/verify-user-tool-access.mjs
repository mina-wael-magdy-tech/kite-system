// ====================================================================
// Security & Access Control Test: User Tool Access (Migration 040)
// Tests granular admin-managed tool grants (Google Flow) under real RLS.
// In-process PostgreSQL (PGlite) - strictly local, never touches any remote database.
// Run:  npm --prefix supabase/tests run test:tool-access
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

const execFile = async (relPath) => {
  const full = path.join(SB, relPath);
  const sql = fs.readFileSync(full, 'utf8');
  await db.exec(sql);
};

// --------------------------------------------------------------------
// Setup: Apply complete migration chain 001 through 040
// --------------------------------------------------------------------
section('0. Setup: Apply migrations 001 through 040');

const migrationFiles = fs.readdirSync(path.join(SB, 'migrations'))
  .filter((f) => /^\d{3}_.*\.sql$/.test(f))
  .sort();

for (const f of migrationFiles.filter((x) => x <= '040')) {
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
ok(true, 'migrations 001-040 applied successfully');

// Check idempotency (applying 040 again succeeds without error)
try {
  await execFile('migrations/040_user_tool_access.sql');
  ok(true, 'migration 040 is idempotent (safe to apply twice)');
} catch (err) {
  ok(false, 'migration 040 idempotency failed', err.message);
}

// --------------------------------------------------------------------
// Fixture setup: Create test users (admin, granted employee, restricted employee)
// --------------------------------------------------------------------
section('1. Setup Test Fixtures');

const ADMIN = '00000000-0000-4000-8000-000000000010';
const EMP_GRANTED = '00000000-0000-4000-8000-000000000020';
const EMP_RESTRICTED = '00000000-0000-4000-8000-000000000030';

await db.query("INSERT INTO auth.users(id, email) VALUES ($1, 'admin@pulse.com'), ($2, 'emp1@pulse.com'), ($3, 'emp2@pulse.com')", [ADMIN, EMP_GRANTED, EMP_RESTRICTED]);
await db.query("INSERT INTO public.profiles(id, full_name, email, employment_status) VALUES ($1, 'Admin User', 'admin@pulse.com', 'active'), ($2, 'Granted Emp', 'emp1@pulse.com', 'active'), ($3, 'Restricted Emp', 'emp2@pulse.com', 'active')", [ADMIN, EMP_GRANTED, EMP_RESTRICTED]);

const gmRoleId = (await db.query("SELECT id FROM public.roles WHERE name = 'general_manager'")).rows[0].id;
const empRoleId = (await db.query("SELECT id FROM public.roles WHERE name = 'employee'")).rows[0].id;

await db.query("INSERT INTO public.user_roles(user_id, role_id) VALUES ($1, $2)", [ADMIN, gmRoleId]);
await db.query("INSERT INTO public.user_roles(user_id, role_id) VALUES ($1, $3), ($2, $3)", [EMP_GRANTED, EMP_RESTRICTED, empRoleId]);

const runAs = async (uid, sql, params = []) => {
  await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub', '${uid || ''}', false); SET ROLE ${uid ? 'authenticated' : 'anon'};`);
  try {
    const res = await db.query(sql, params);
    await db.exec('RESET ROLE');
    return { ok: true, rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
  } catch (err) {
    await db.exec('RESET ROLE');
    return { ok: false, error: err.message };
  }
};

// --------------------------------------------------------------------
// Security & RLS Tests: user_tool_access
// --------------------------------------------------------------------
section('2. RLS & Access Control Tests');

// Test 1: Admin can grant google_flow access to EMP_GRANTED
{
  const res = await runAs(ADMIN,
    `INSERT INTO public.user_tool_access(user_id, tool_key, granted_by) VALUES ($1, 'google_flow', $2) RETURNING id`,
    [EMP_GRANTED, ADMIN]
  );
  ok(res.ok, '1. Admin can grant google_flow tool access to employee', res.error);
}

// Test 2: EMP_GRANTED can see their own tool grant
{
  const res = await runAs(EMP_GRANTED, "SELECT tool_key FROM public.user_tool_access");
  ok(res.ok && res.rows.length === 1 && res.rows[0].tool_key === 'google_flow', '2. Granted employee can view their own tool grant', JSON.stringify(res));
}

// Test 3: EMP_RESTRICTED cannot see any tool grant (table appears empty to them)
{
  const res = await runAs(EMP_RESTRICTED, "SELECT tool_key FROM public.user_tool_access");
  ok(res.ok && res.rows.length === 0, '3. Restricted employee sees 0 tool grants (hidden by RLS)', JSON.stringify(res));
}

// Test 4: EMP_RESTRICTED cannot self-grant access (INSERT blocked by RLS WITH CHECK)
{
  const res = await runAs(EMP_RESTRICTED,
    `INSERT INTO public.user_tool_access(user_id, tool_key, granted_by) VALUES ($1, 'google_flow', $1)`,
    [EMP_RESTRICTED]
  );
  ok(!res.ok, '4. Non-admin employee cannot self-grant tool access (RLS insert policy blocks non-admin)', res.error);
}

// Test 5: EMP_RESTRICTED cannot delete another user's grant
{
  const res = await runAs(EMP_RESTRICTED, `DELETE FROM public.user_tool_access WHERE user_id = $1`, [EMP_GRANTED]);
  ok(!res.ok || res.rowCount === 0, '5. Non-admin employee cannot delete other users’ tool grants (0 rows affected)');
}

// Test 6: Admin can see all tool grants
{
  const res = await runAs(ADMIN, "SELECT user_id, tool_key FROM public.user_tool_access");
  ok(res.ok && res.rows.length >= 1, '6. Admin can list all tool grants studio-wide', `Count: ${res.rows?.length}`);
}

// Test 7: Duplicate grant constraint enforced
{
  let dupErr = null;
  try {
    await db.query(`INSERT INTO public.user_tool_access(user_id, tool_key) VALUES ($1, 'google_flow')`, [EMP_GRANTED]);
  } catch (err) {
    dupErr = err.message;
  }
  ok(dupErr !== null && (dupErr.includes('duplicate key') || dupErr.includes('unique')), '7. Duplicate tool grant on (user_id, tool_key) is rejected', dupErr);
}

// Test 8: Empty tool key check constraint enforced
{
  let emptyErr = null;
  try {
    await db.query(`INSERT INTO public.user_tool_access(user_id, tool_key) VALUES ($1, '  ')`, [EMP_RESTRICTED]);
  } catch (err) {
    emptyErr = err.message;
  }
  ok(emptyErr !== null && emptyErr.includes('check constraint'), '8. Empty tool_key is rejected by database CHECK constraint', emptyErr);
}

// Test 9: Admin can revoke tool grant
{
  const res = await runAs(ADMIN, `DELETE FROM public.user_tool_access WHERE user_id = $1 AND tool_key = 'google_flow'`, [EMP_GRANTED]);
  ok(res.ok && res.rowCount === 1, '9. Admin can revoke tool grant from employee');

  // Verify EMP_GRANTED now sees 0 grants
  const resAfter = await runAs(EMP_GRANTED, "SELECT tool_key FROM public.user_tool_access");
  ok(resAfter.ok && resAfter.rows.length === 0, '9b. Revoked employee now sees 0 grants', JSON.stringify(resAfter));
}

// --------------------------------------------------------------------
// Rollback & Re-application verification
// --------------------------------------------------------------------
section('3. Rollback & Re-apply Verification');

await execFile('maintenance/rollback-040.sql');
ok(true, 'rollback-040.sql applied cleanly');

const tableExistsAfterRollback = (await db.query(
  "SELECT count(*)::int AS c FROM information_schema.tables WHERE table_name = 'user_tool_access'"
)).rows[0].c;
ok(tableExistsAfterRollback === 0, 'user_tool_access table is dropped after rollback');

await execFile('migrations/040_user_tool_access.sql');
const tableExistsAfterReapply = (await db.query(
  "SELECT count(*)::int AS c FROM information_schema.tables WHERE table_name = 'user_tool_access'"
)).rows[0].c;
ok(tableExistsAfterReapply === 1, 'migration 040 re-applies cleanly and table exists again');

// --------------------------------------------------------------------
// Final Summary
// --------------------------------------------------------------------
console.log(`\n========================================`);
console.log(`Tool Access Test Complete: ${passed} passed, ${failed} failed`);
console.log(`========================================\n`);

if (failed > 0) {
  process.exit(1);
}
