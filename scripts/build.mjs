// Vercel build: copies ONLY the public web files (html, css, js, vendor, assets, fonts) into dist/ and writes dist/env.js
// from environment variables. Nothing else (supabase/, docs/, scripts/) is ever served.
//
// Required Vercel env vars (Project Settings -> Environment Variables):
//   SUPABASE_URL        https://<project-ref>.supabase.co
//   SUPABASE_ANON_KEY   the public anon / publishable key (NEVER the service_role key)
//   ICE_SERVERS         (optional) JSON array of WebRTC STUN/TURN servers for calls
//   VAPID_PUBLIC_KEY    (optional) public Web Push key; push notifications stay off without it
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const url = (process.env.SUPABASE_URL || '').trim();
const key = (process.env.SUPABASE_ANON_KEY || '').trim();

if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url)) fail('SUPABASE_URL must look like https://<project-ref>.supabase.co');
if (key.length < 40) fail('SUPABASE_ANON_KEY is missing or too short');
if (/service_role/i.test(key) || decodeJwtRole(key) === 'service_role') fail('SUPABASE_ANON_KEY contains a service_role key. Refusing to publish a secret.');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
for (const f of readdirSync('.').filter((n) => n.endsWith('.html'))) cpSync(f, `dist/${f}`);
for (const d of ['css', 'js', 'vendor', 'assets', 'fonts']) cpSync(d, `dist/${d}`, { recursive: true });

const vapid = (process.env.VAPID_PUBLIC_KEY || '').trim();
if (vapid && !/^[A-Za-z0-9_-]{80,100}$/.test(vapid)) fail('VAPID_PUBLIC_KEY is not a valid public key');

let ice = (process.env.ICE_SERVERS || '').trim();
if (ice) { try { if (!Array.isArray(JSON.parse(ice))) throw 0; } catch { fail('ICE_SERVERS must be a JSON array'); } }

writeFileSync('dist/env.js',
  `window.ENV_SUPABASE_URL = ${JSON.stringify(url)};\nwindow.ENV_SUPABASE_ANON_KEY = ${JSON.stringify(key)};\nwindow.ENV_VAPID_PUBLIC_KEY = ${JSON.stringify(vapid)};\nwindow.ENV_ICE_SERVERS = ${JSON.stringify(ice)};\n`);

// ---- PWA: manifest, offline page, and the service worker stamped with this build
for (const f of ['manifest.webmanifest', 'offline.html']) cpSync(f, `dist/${f}`);
const buildId = (process.env.VERCEL_GIT_COMMIT_SHA || String(Date.now())).slice(0, 12);

const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const SKIP = new Set(['env.js', 'sw.js']);
const BIG = /(@2x|pptxgen|icon-512|icon-maskable|logo-vertical\.png|logo-mark\.png)/; // keep the offline cache lean
const precache = walk('dist')
  .map((p) => '/' + relative('dist', p).split(sep).join('/'))
  .filter((u) => !SKIP.has(u.slice(1)) && !BIG.test(u));

let sw = readFileSync('sw.js', 'utf8');
if (!sw.includes('__BUILD_ID__') || !sw.includes("'__PRECACHE__'")) fail('sw.js placeholders are missing');
sw = sw.split('__BUILD_ID__').join(buildId).split("'__PRECACHE__'").join(JSON.stringify(precache));
if (sw.includes('__BUILD_ID__') || sw.includes('__PRECACHE__')) fail('service worker placeholders were not all replaced');
writeFileSync('dist/sw.js', sw);
console.log(`PWA: service worker ${buildId}, ${precache.length} files precached`);
console.log('Built dist/ for', url);

function decodeJwtRole(t) {
  try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).role; } catch { return null; }
}
function fail(msg) { console.error('BUILD ERROR: ' + msg); process.exit(1); }
