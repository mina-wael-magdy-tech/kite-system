// Phase 4 (SEC-02, DAT-01, PERF-04) tests for the Kite Drive PHP API: the REAL api/index.php runs under PHP's built-in web server
// (php -S) against a throwaway SQLite database and a temp upload folder. No MySQL, no network, no real Drive, no production access.
//   node verify-drive.mjs                      tests the working tree
//   DRIVE_API_DIR=<dir with index.php> node verify-drive.mjs     tests another copy of api/ (used for the "before" evidence on the old commit)
// Skipped (exit 0) when php is not installed.
import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const API_SRC = process.env.DRIVE_API_DIR || path.join(REPO, 'integrations', 'kite-drive', 'api');
const php = spawnSync('php', ['-v']);
if (php.status !== 0) { console.log('SKIPPED: php is not installed'); process.exit(0); }

let passed = 0, failed = 0;
const ok = (c, name, d = '') => { if (c) passed++; else { failed++; console.log('FAIL', name, d); } };
const section = (s) => console.log('\n== ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECRET = 'k'.repeat(48);
const b64 = (b) => Buffer.from(b).toString('base64url');
const sign = (claims) => { const p = b64(JSON.stringify({ aud: 'kite-drive', sub: 'u1', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: crypto.randomUUID(), ...claims })); return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url'); };

/** One Drive root: api/ copy, a db.php with a SQLite file, an uploads folder with fixtures, a php -S server on its own port. */
async function drive(label, urlTokens, port) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `kite-drive-${label}-`));
  fs.cpSync(API_SRC, path.join(root, 'api'), { recursive: true });
  fs.rmSync(path.join(root, 'api', '_log'), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'uploads'));
  fs.writeFileSync(path.join(root, 'api', 'config.php'), `<?php return ['secret' => '${SECRET}', 'allowed_origins' => ['https://app.test'], 'url_tokens' => '${urlTokens}', 'max_file_bytes' => 5368709120];`);
  const dbPath = path.join(root, 'drive.sqlite').replace(/\\/g, '/');
  fs.writeFileSync(path.join(root, 'db.php'), `<?php
$pdo = new PDO('sqlite:${dbPath}'); $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION); $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
$pdo->exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, password TEXT, role TEXT, logo_path TEXT)");
$pdo->exec("CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INT, folder_id INT, filename TEXT, original_name TEXT, file_path TEXT, file_type TEXT, uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP)");
$pdo->exec("CREATE TABLE IF NOT EXISTS folders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INT, parent_id INT, name TEXT)");
`);
  // fixtures: a Drive client (id 1) with a photo, a text file and a big binary; another client's file (id 4)
  spawnSync('php', ['-r', `$p = new PDO('sqlite:${dbPath}'); $p->exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, password TEXT, role TEXT, logo_path TEXT)");
    $p->exec("CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INT, folder_id INT, filename TEXT, original_name TEXT, file_path TEXT, file_type TEXT, uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP)");
    $p->exec("CREATE TABLE folders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INT, parent_id INT, name TEXT)");
    $p->exec("INSERT INTO users (name,email,role) VALUES ('Client One','one@x.test','client'),('Client Two','two@x.test','client')");
    $im = imagecreatetruecolor(300, 200); imagepng($im, '${root.replace(/\\/g, '/')}/uploads/photo.png');
    file_put_contents('${root.replace(/\\/g, '/')}/uploads/note.txt', 'hello drive');
    file_put_contents('${root.replace(/\\/g, '/')}/uploads/big.bin', str_repeat('x', 3000000));
    file_put_contents('${root.replace(/\\/g, '/')}/uploads/other.txt', 'not yours');
    $ins = $p->prepare("INSERT INTO files (user_id, filename, original_name, file_path, file_type) VALUES (?,?,?,?,?)");
    $ins->execute([1,'photo.png','photo.png','uploads/photo.png','image/png']); $ins->execute([1,'note.txt','note.txt','uploads/note.txt','text/plain']);
    $ins->execute([1,'big.bin','big.bin','uploads/big.bin','application/octet-stream']); $ins->execute([2,'other.txt','other.txt','uploads/other.txt','text/plain']);`]);
  const log = [];
  const proc = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => log.push(String(d))); proc.stderr.on('data', (d) => log.push(String(d)));
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/api/index.php`); break; } catch { await sleep(100); } }
  const base = `http://127.0.0.1:${port}/api/index.php`;
  return {
    root, log, base, stop: () => { proc.kill(); },
    hdr: (token, query, init = {}) => fetch(`${base}?${query}`, { ...init, headers: { ...(init.headers || {}), 'X-Drive-Token': token } }),
    url: (token, query, init = {}) => fetch(`${base}?${query}&token=${encodeURIComponent(token)}`, init),
  };
}

const view = (fid) => sign({ scope: 'view', cid: 1, ...(fid ? { fid } : {}) });
const download = (fid) => sign({ scope: 'download', cid: 1, fid });
const servers = [];
try {
  const strict = await drive('strict', 'strict', 8700 + Math.floor(Math.random() * 100));
  const legacy = await drive('legacy', 'legacy', 8800 + Math.floor(Math.random() * 100));
  servers.push(strict, legacy);

  section('SEC-02 token transport: the header works for every action (new)');
  for (const [name, q, t, expect] of [
    ['view', 'action=view&id=2', view(), 'hello drive'], ['download', 'action=download', download(2), 'hello drive'],
  ]) {
    const r = await strict.hdr(t, q);
    ok(r.status === 200 && (await r.text()) === expect, `header token accepted for ${name} and the file is returned`, String(r.status));
  }
  { const r = await strict.hdr(view(), 'action=logo'); ok(r.status === 404, 'header token accepted for logo (this client has none: 404, not 401)', String(r.status)); }
  const photo = await strict.hdr(view(), 'action=thumb&id=1');
  ok(photo.status === 200 && photo.headers.get('content-type') === 'image/jpeg', 'thumbnail via header is a JPEG');
  ok(photo.headers.get('referrer-policy') === 'no-referrer', 'responses carry Referrer-Policy: no-referrer', String(photo.headers.get('referrer-policy')));

  section('SEC-02 strict policy: address tokens are single-use / file-bound / refused');
  let r = await strict.url(view(), 'action=view&id=2');
  ok(r.status === 401, 'strict: a client-wide view token in the address is refused', String(r.status));
  r = await strict.url(view(2), 'action=view&id=2');
  ok(r.status === 200 && (await r.text()) === 'hello drive', 'strict: a view token locked to the file works in the address');
  r = await strict.url(view(2), 'action=view&id=2');
  ok(r.status === 200, 'strict: ... repeatedly (video range requests)');
  r = await strict.url(view(2), 'action=view&id=1');
  ok(r.status === 403, 'a file-locked token cannot open another file', String(r.status));
  r = await strict.url(view(), 'action=thumb&id=1');
  ok(r.status === 401, 'strict: thumbnails in the address are refused (they use the header)', String(r.status));
  r = await strict.url(view(), 'action=logo');
  ok(r.status === 401, 'strict: the logo in the address is refused', String(r.status));
  const dl = download(2);
  r = await strict.url(dl, 'action=download');
  ok(r.status === 200 && (await r.text()) === 'hello drive', 'strict: a download link works once');
  r = await strict.url(dl, 'action=download');
  ok(r.status === 401, 'strict: the same download link replayed is refused', String(r.status));
  r = await strict.url(sign({ scope: 'download', cid: 1, fid: 2, jti: undefined }), 'action=download');
  ok(r.status === 401, 'strict: a download link without a token id is refused', String(r.status));
  r = await strict.url(sign({ scope: 'view', cid: 1 }), 'action=tree');
  ok(r.status === 401, 'a token in the address is never read for other actions (tree)', String(r.status));
  r = await strict.url(download(4), 'action=download');
  ok(r.status === 404, 'a download token for another client\'s file id finds nothing (client binding)', String(r.status));

  section('SEC-02 legacy policy keeps the old web app working (release train)');
  r = await legacy.url(view(), 'action=view&id=2');
  ok(r.status === 200, 'legacy: an unbound view token in the address still works');
  r = await legacy.url(view(), 'action=thumb&id=1');
  ok(r.status === 200, 'legacy: a thumbnail in the address still works');
  const dl2 = download(2);
  r = await legacy.url(dl2, 'action=download'); const first = r.status; r = await legacy.url(dl2, 'action=download');
  ok(first === 200 && r.status === 401, 'legacy: a new-style download link (with token id) is single-use as well', `${first}/${r.status}`);
  const noJti = sign({ scope: 'download', cid: 1, fid: 2, jti: undefined }); // JSON drops undefined: an OLD token without jti
  r = await legacy.url(noJti, 'action=download'); const a1 = r.status; r = await legacy.url(noJti, 'action=download');
  ok(a1 === 200 && r.status === 200, 'legacy: an old download link (no token id) keeps working exactly as before');

  section('SEC-02 logs: where a token can leak');
  const urlLines = strict.log.join('').split('\n').filter((l) => /token=/.test(l));
  const headerCalls = strict.log.join('').split('\n').filter((l) => /\[\d{3}\]: GET \/api\/index\.php\?action=(thumb|view|logo|download)[^\s]*\s*$/.test(l) && !/token=/.test(l));
  ok(urlLines.length > 0, 'EVIDENCE: a token in the address IS written to the server log line (why addresses must be single-use or file-bound)');
  ok(headerCalls.length === 4, 'the 4 header requests (view, download, logo, thumb) left no token in the log', String(headerCalls.length));
  const lastTokenInLog = urlLines.map((l) => l.match(/token=([^&\s]+)/)?.[1]).filter(Boolean);
  const burned = lastTokenInLog.filter((t) => { try { const c = JSON.parse(Buffer.from(decodeURIComponent(t).split('.')[0], 'base64url')); return c.scope === 'download'; } catch { return false; } });
  let usable = 0;
  for (const t of burned) { const x = await strict.url(decodeURIComponent(t), 'action=download'); if (x.status === 200) usable++; }
  ok(burned.length > 0 && usable === 0, 'EVIDENCE: every download token found in the log is already dead (replay refused)', `${burned.length} found, ${usable} usable`);
  const probe = view();
  const errRes = await strict.url(probe, 'action=thumb&id=1');
  const errBody = await errRes.text();
  ok(errRes.status === 401 && !errBody.includes(probe) && !errBody.includes(probe.split('.')[0]), 'an error response never echoes the token');

  section('PERF-04 thumbnails: a grid must never download the big original');
  r = await strict.hdr(view(), 'action=thumb&id=3');
  ok(r.status === 404, 'a large file that cannot be shrunk answers 404 (the app shows an icon), not the 3 MB original', String(r.status));
  r = await strict.hdr(view(), 'action=thumb&id=2');
  ok(r.status === 200 && (await r.text()) === 'hello drive', 'a small non-image still falls back to the original (unchanged behaviour)');
  r = await strict.hdr(view(), 'action=view&id=3');
  ok(r.status === 200 && (await r.arrayBuffer()).byteLength === 3000000, 'the same large file is still fully viewable / downloadable through view');

  section('DAT-01 create_client: a repeated request does not create a second account');
  const adm = sign({ scope: 'admin' });
  const body = JSON.stringify({ name: 'New Client', email: 'new@x.test', password: 'password123' });
  r = await strict.hdr(adm, 'action=create_client', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
  const created = await r.json();
  ok(r.status === 200 && created.id > 2, 'first create works', JSON.stringify(created));
  r = await strict.hdr(adm, 'action=create_client', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
  ok(r.status === 409, 'the repeat answers 409 (the web app then adopts the account by e-mail)', String(r.status));
  const count = spawnSync('php', ['-r', `echo (new PDO('sqlite:${path.join(strict.root, 'drive.sqlite').replace(/\\/g, '/')}'))->query("SELECT count(*) FROM users WHERE email='new@x.test'")->fetchColumn();`]);
  ok(String(count.stdout) === '1', 'exactly one account exists', String(count.stdout));

  section('PERF-04 uploads: finishing twice stores the file once');
  const wr = sign({ scope: 'write', cid: 1 });
  const post = (q, b) => strict.hdr(wr, q, { method: 'POST', body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' } });
  const content = Buffer.from('chunked upload content');
  const start = await (await post('action=upload_init', { name: 'doc.txt', size: content.length })).json();
  ok(!!start.uploadId, 'upload starts', JSON.stringify(start));
  const ch = await strict.hdr(wr, `action=upload_chunk&id=${start.uploadId}&offset=0`, { method: 'POST', body: content });
  ok(ch.status === 200, 'chunk accepted', String(ch.status));
  const c1 = await (await post('action=upload_complete', { uploadId: start.uploadId })).json();
  const c2 = await post('action=upload_complete', { uploadId: start.uploadId });
  const c2j = await c2.json();
  ok(c2.status === 200 && c1.fileId === c2j.fileId, 'a retried complete returns the SAME file (no duplicate)', JSON.stringify([c1, c2j]));
  const stored = spawnSync('php', ['-r', `echo (new PDO('sqlite:${path.join(strict.root, 'drive.sqlite').replace(/\\/g, '/')}'))->query("SELECT count(*) FROM files WHERE original_name='doc.txt'")->fetchColumn();`]);
  ok(String(stored.stdout) === '1', 'exactly one file row', String(stored.stdout));

  section('the command-line unit tests (api/lib.php)');
  const unit = spawnSync('php', [path.join(REPO, 'integrations', 'kite-drive', 'tests', 'lib_test.php')], { encoding: 'utf8' });
  const m = /RESULT passed=(\d+) failed=(\d+)/.exec(unit.stdout || '');
  ok(!!m && Number(m[2]) === 0, `lib_test.php: ${m ? m[1] + ' passed, ' + m[2] + ' failed' : 'did not run'}`, (unit.stdout || '').split('\n').filter((l) => l.startsWith('FAIL')).join(' | ') || unit.stderr);
  if (m) passed += Number(m[1]) - 1;
} finally {
  for (const s of servers) { s.stop(); }
  await sleep(300);
  for (const s of servers) { try { fs.rmSync(s.root, { recursive: true, force: true }); } catch { /* still locked */ } }
}
console.log(`\nverify-drive: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
