// Vercel build: copies ONLY the public web files into dist/ and writes dist/env.js
// from environment variables. Nothing else (supabase/, docs/, scripts/) is ever served.
//
// Required Vercel env vars (Project Settings -> Environment Variables):
//   SUPABASE_URL        https://<project-ref>.supabase.co
//   SUPABASE_ANON_KEY   the public anon / publishable key (NEVER the service_role key)
import { cpSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';

const url = (process.env.SUPABASE_URL || '').trim();
const key = (process.env.SUPABASE_ANON_KEY || '').trim();

if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url)) fail('SUPABASE_URL must look like https://<project-ref>.supabase.co');
if (key.length < 40) fail('SUPABASE_ANON_KEY is missing or too short');
if (/service_role/i.test(key) || decodeJwtRole(key) === 'service_role') fail('SUPABASE_ANON_KEY contains a service_role key. Refusing to publish a secret.');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
for (const f of readdirSync('.').filter((n) => n.endsWith('.html'))) cpSync(f, `dist/${f}`);
for (const d of ['css', 'js', 'vendor']) cpSync(d, `dist/${d}`, { recursive: true });

writeFileSync('dist/env.js',
  `window.ENV_SUPABASE_URL = ${JSON.stringify(url)};\nwindow.ENV_SUPABASE_ANON_KEY = ${JSON.stringify(key)};\n`);
console.log('Built dist/ for', url);

function decodeJwtRole(t) {
  try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).role; } catch { return null; }
}
function fail(msg) { console.error('BUILD ERROR: ' + msg); process.exit(1); }
