// Phase 4 (FUN-01, ARC-02) frontend lifecycle tests. The REAL js/router.js, js/core/*.js, the real ChatModule and the real
// DrivePanel are bundled with esbuild and run under Node with a small fake DOM / window / Supabase Realtime that COUNTS every
// listener, timer, channel and blob address, so "repeated navigation does not accumulate anything" is measured, not assumed.
//   node verify-frontend.mjs                       tests the working tree
//   FRONTEND_DIR=<dir containing js/> node verify-frontend.mjs     tests another copy (used for the "before" run on the old commit)
// No browser, no network, no Supabase, no production access.
import { build } from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.FRONTEND_DIR || path.resolve(HERE, '..', '..');
const JS = path.join(ROOT, 'js');
let passed = 0, failed = 0;
const ok = (c, name, d = '') => { if (c) passed++; else { failed++; console.log('FAIL', name, d); } };
const section = (s) => console.log('\n== ' + s);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const has = (f) => fs.existsSync(path.join(JS, f));

// ------------------------------------------------------------------ fake browser that counts everything
const counters = { listeners: new Map(), intervals: new Set(), timeouts: new Set(), channelsCreated: 0, channelsRemoved: 0, blobsMade: 0, blobsRevoked: 0 };
const bucket = (t, type) => { const k = t.__name + ':' + type; if (!counters.listeners.has(k)) counters.listeners.set(k, new Set()); return counters.listeners.get(k); };
const live = (name) => [...counters.listeners.entries()].filter(([k]) => k.startsWith(name + ':')).reduce((n, [, s]) => n + s.size, 0);
function fakeEl(tag = 'div') {
  const el = {
    tag, children: [], dataset: {}, style: {}, _html: '', hidden: false, isConnected: true, className: '', textContent: '', value: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, focus() {}, remove() { this.isConnected = false; },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); this.children = []; },
    replaceChildren(...n) { this.children.forEach((c) => { c.isConnected = false; }); this.children = n; n.forEach((c) => { c.isConnected = true; }); },
    appendChild(c) { this.children.push(c); return c; },
    querySelector: () => fakeEl(), querySelectorAll: () => [], closest: () => null, getAttribute: () => null, setAttribute() {},
  };
  return el;
}
const win = { __name: 'window', location: { hash: '' }, addEventListener(t, h) { bucket(win, t).add(h); }, removeEventListener(t, h) { bucket(win, t).delete(h); }, lucide: null };
const doc = {
  __name: 'document', hidden: false, body: fakeEl('body'),
  addEventListener(t, h) { bucket(doc, t).add(h); }, removeEventListener(t, h) { bucket(doc, t).delete(h); },
  createElement: (t) => fakeEl(t), getElementById: () => fakeEl(), querySelectorAll: () => [], querySelector: () => null, activeElement: null,
};
globalThis.window = win; globalThis.document = doc; globalThis.location = { reload() {} };
const realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval, realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
globalThis.setInterval = (fn, ms) => { const id = realSetInterval(fn, ms); counters.intervals.add(id); return id; };
globalThis.clearInterval = (id) => { counters.intervals.delete(id); realClearInterval(id); };
globalThis.URL.createObjectURL = () => { counters.blobsMade++; return 'blob:fake/' + counters.blobsMade; };
globalThis.URL.revokeObjectURL = () => { counters.blobsRevoked++; };
globalThis.__sb = {
  channel() { counters.channelsCreated++; const ch = { on() { return ch; }, subscribe() { return ch; }, state: 'joined' }; return ch; },
  removeChannel() { counters.channelsRemoved++; },
};

// ------------------------------------------------------------------ bundle the real code with the heavy dependencies stubbed
const STUBS = {
  'supabase-client': 'export const getSupabase = () => globalThis.__sb;',
  'toast-service': 'export const Toast = { success() {}, error() {}, info() {}, warning() {} };',
  'api': 'export const Api = new Proxy({}, { get: () => async () => ({}) });',
  'call-service': 'export const Calls = new Proxy({}, { get: () => () => {} });',
  'permission-service': 'export const Permissions = { isAdmin: () => false, hasRole: () => false, canAccessModule: (r) => !(globalThis.__denied || []).includes(r) };',
  'dialogs': 'export const formDialog = () => {}; export const confirmDialog = async () => true; export const infoDialog = () => {};',
  'linkify': 'export const linkify = (s) => s;',
  'reactions': 'export const reactionButtonHTML = () => ""; export const quickEmojiHTML = () => "";',
  'assignees': 'export const ASSIGNEE_SELECT = ""; export const assigneeOptionsHTML = () => ""; export const selectedDeptId = () => null;',
  'notification-service': 'export const Notifications = { activeConversationId: null };',
  'pagination': 'export const PAGE_SIZE = { drive: 50 }; export const pageSlice = (a) => a; export const mountPager = () => {};',
  'realtime-service': `export const Realtime = globalThis.__RT = { clears: 0, watches: 0, clear() { this.clears++; }, watch() { this.watches++; } };`,
};
const stubPlugin = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      if (!a.path.startsWith('.')) return null;
      const base = path.basename(a.path).replace(/\.js$/, '');
      if (STUBS[base]) return { path: base, namespace: 'stub' };
      return null;
    });
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
  },
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-fe-'));
async function load(rel) {
  const r = await build({ entryPoints: [path.join(JS, rel)], bundle: true, format: 'esm', platform: 'node', write: false, plugins: [stubPlugin], logLevel: 'silent' });
  const out = path.join(tmp, rel.replace(/[\\/]/g, '_') + '.mjs');
  fs.writeFileSync(out, r.outputFiles[0].text);
  return import(pathToFileURL(out).href + '?' + Date.now());
}

const { Router } = await load('router.js');
const hasScope = has('core/lifecycle.js');
const { Scope } = hasScope ? await load('core/lifecycle.js') : {};
const contract = has('core/module-contract.js') ? await load('core/module-contract.js') : {};

const go = async (router, hash) => { win.location.hash = '#' + hash; await router.handleHashChange(); };
const mkRouter = () => { const r = new Router(); r.contentContainer = fakeEl('main'); return r; };
const hostOf = (r) => r.contentContainer.children[0] || r.contentContainer;   // the old router drew straight into the container
const deferred = () => { let resolve; const promise = new Promise((res) => { resolve = res; }); return { promise, resolve }; };

// ================================================================== FUN-01 render guard
section('FUN-01 router: a slow render of a page the user already left must not win');
{
  const r = mkRouter(); const gate = deferred();
  const wrote = [];
  r.register('slow', { title: 'Slow', render: async (c) => { await gate.promise; c.innerHTML = 'SLOW PAGE'; wrote.push('slow'); } });
  r.register('fast', { title: 'Fast', render: async (c) => { c.innerHTML = 'FAST PAGE'; wrote.push('fast'); } });
  const first = go(r, 'slow');
  await tick(5);
  await go(r, 'fast');
  gate.resolve(); await first; await tick(5);
  const current = hostOf(r);
  ok(r.currentRoute === 'fast', 'the current route is the last one asked for');
  ok(current.innerHTML === 'FAST PAGE', 'the screen shows the fast page', current.innerHTML.slice(0, 40));
  ok(r.contentContainer.children.length === 1, 'exactly one page host on screen');
}
section('FUN-01 router: a repeated hashchange event for the page already shown renders it once');
{
  const r = mkRouter(); let renders = 0;
  r.register('a', { title: 'A', render: async (c) => { renders++; c.innerHTML = 'A'; } });
  await go(r, 'a'); await go(r, 'a'); await go(r, 'a');
  ok(renders === 1, 'three identical events render once', 'renders=' + renders);
  await go(r, 'a?x=1');
  ok(renders === 2, 'a different query string is a different page and renders again', 'renders=' + renders);
}
section('FUN-01 router: errors');
{
  const r = mkRouter(); const gate = deferred();
  r.register('bad', { title: 'Bad', render: async () => { await gate.promise; throw new Error('late failure'); } });
  r.register('good', { title: 'Good', render: async (c) => { c.innerHTML = 'GOOD'; } });
  const first = go(r, 'bad'); await tick(5); await go(r, 'good'); gate.resolve(); await first; await tick(5);
  ok(hostOf(r).innerHTML === 'GOOD' && !/late failure/.test(r.contentContainer.children.map((c) => c.innerHTML).join('')), 'an error from a page the user already left is not shown');
  const r2 = mkRouter(); r2.register('boom', { title: 'Boom', render: async () => { throw new Error('boom!'); } });
  await go(r2, 'boom');
  ok(/Failed to load/.test(hostOf(r2).innerHTML) && /boom!/.test(hostOf(r2).innerHTML), 'the current page failing shows the error card');
  let again = 0; r2.register('boom', { title: 'Boom', render: async (c) => { again++; c.innerHTML = 'ok now'; } });
  await go(r2, 'boom');
  ok(again === 1 && hostOf(r2).innerHTML === 'ok now', 'after a failure the same address can be tried again');
}
section('FUN-01 router: permission and unknown routes never render');
{
  const r = mkRouter(); let renders = 0; r.defaultRoute = 'home';
  r.register('home', { title: 'Home', render: async (c) => { renders++; c.innerHTML = 'H'; } });
  r.register('secret', { title: 'Secret', render: async (c) => { renders++; c.innerHTML = 'S'; } });
  globalThis.__denied = ['secret'];
  const nav = []; r.navigate = async (id) => { nav.push(id); };
  await go(r, 'secret');
  ok(renders === 0 && nav.join() === 'home', 'a denied route renders nothing and is redirected');
  await go(r, 'nope');
  ok(renders === 0 && nav.join() === 'home,home', 'an unknown route renders nothing and is redirected');
  globalThis.__denied = [];
}
section('FUN-01 router: destroy() removes its own window listener; init() twice adds one');
{
  const before = live('window');
  const r = new Router(); r.register('x', { title: 'X', render: async () => {} });
  win.location.hash = '#x';
  r.init(fakeEl('main')); r.init(fakeEl('main'));
  ok(live('window') === before + 1, 'init() called twice registers one hashchange listener', String(live('window') - before));
  if (typeof r.destroy === 'function') { r.destroy(); ok(live('window') === before, 'destroy() removes it'); } else ok(false, 'destroy() exists');
}

// ================================================================== ARC-02 contract + disposal
section('ARC-02 module contract');
if (contract.defineModule) {
  const { defineModule, assertInstance } = contract;
  const good = defineModule({ id: 'tasks', title: 'Tasks', create: () => ({ render() {} }) });
  ok(good.breadcrumbs.join() === 'Tasks' && Object.isFrozen(good), 'a valid contract is frozen and gets default breadcrumbs');
  for (const [name, def] of [['no id', { title: 'T', create() {} }], ['bad id', { id: 'Bad Id', title: 'T', create() {} }], ['no title', { id: 'x', create() {} }], ['no create', { id: 'x', title: 'T' }], ['bad breadcrumbs', { id: 'x', title: 'T', create() {}, breadcrumbs: 'a' }]]) {
    let threw = false; try { defineModule(def); } catch { threw = true; }
    ok(threw, `defineModule refuses: ${name}`);
  }
  let threw = false; try { assertInstance('x', { dispose: 1, render() {} }); } catch { threw = true; }
  ok(threw && (() => { try { assertInstance('x', {}); return false; } catch { return true; } })(), 'an instance without render() or with a non-function dispose() is refused');
} else ok(false, 'js/core/module-contract.js exists');

section('ARC-02 registry: every route in the shell has a contract');
if (has('modules/registry.js')) {
  const reg = fs.readFileSync(path.join(JS, 'modules/registry.js'), 'utf8');
  const ids = [...reg.matchAll(/defineModule\(\{ id: '([a-z-]+)'/g)].map((m) => m[1]);
  ok(ids.length === new Set(ids).size && ids.length === 17, `17 unique module ids (${ids.length})`);
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const routes = [...new Set([...html.matchAll(/data-route="([a-z-]+)"/g)].map((m) => m[1]))];
  ok(routes.length > 5 && routes.every((x) => ids.includes(x)), 'every data-route in index.html is registered', routes.filter((x) => !ids.includes(x)).join());
  const app = fs.readFileSync(path.join(JS, 'app.js'), 'utf8');
  ok(!/AppRouter\.register\('/.test(app) && /MODULES/.test(app), 'app.js registers the list, not 17 hand-written blocks');
} else ok(false, 'js/modules/registry.js exists');

section('ARC-02 scope: everything registered through it is released');
if (Scope) {
  const base = { win: live('window'), doc: live('document'), iv: counters.intervals.size };
  const s = new Scope('t');
  const handlers = Array.from({ length: 5 }, () => () => {});
  handlers.forEach((h, i) => s.on(i % 2 ? win : doc, 'x' + i, h));
  s.interval(() => {}, 1000); s.interval(() => {}, 1000);
  ok(live('window') + live('document') === base.win + base.doc + 5 && counters.intervals.size === base.iv + 2, 'registered: 5 listeners, 2 intervals');
  let ran = 0; s.add(() => ran++); s.add(() => { throw new Error('cleanup bug'); }); s.add(() => ran++);
  s.dispose(); s.dispose();
  ok(live('window') + live('document') === base.win + base.doc && counters.intervals.size === base.iv, 'dispose removed every listener and interval');
  ok(ran === 2, 'a throwing cleanup does not stop the others; cleanups run once');
  ok(s.signal.aborted && !s.isActive(), 'the signal is aborted and isActive() is false');
  const late = []; s.add(() => late.push('x')); s.on(win, 'late', () => {}); s.interval(() => {}, 5);
  ok(late.length === 1 && live('window') === base.win && counters.intervals.size === base.iv, 'registering AFTER dispose cleans up immediately (a late async callback leaves nothing behind)');
  const t = new Scope('t2'); let fired = 0; t.timeout(() => fired++, 5); await tick(30); ok(fired === 1 && t.size === 0, 'a timeout that fired releases its cleanup');
  const u = new Scope('t3'); u.timeout(() => fired++, 20); u.dispose(); await tick(40); ok(fired === 1, 'a pending timeout never fires after dispose');
} else ok(false, 'js/core/lifecycle.js exists');

section('ARC-02 repeated navigation (300 visits across 4 pages) accumulates nothing');
if (Scope) {
  const r = mkRouter();
  const base = { win: live('window'), doc: live('document'), iv: counters.intervals.size, clears: globalThis.__RT.clears };
  const visits = { a: 0, b: 0, c: 0, d: 0 }, disposed = { a: 0, b: 0, c: 0, d: 0 };
  const page = (id) => ({ title: id, create: () => ({
    async render(c, q, scope) { visits[id]++; c.innerHTML = id; scope.on(doc, 'click', () => {}); scope.on(win, 'resize', () => {}); scope.interval(() => {}, 1000); await tick(0); },
    dispose() { disposed[id]++; },
  }) });
  for (const id of ['a', 'b', 'c', 'd']) r.register(id, page(id));
  for (let i = 0; i < 300; i++) await go(r, 'abcd'[i % 4] + (i % 7 === 0 ? '?n=' + i : ''));
  ok(Object.values(visits).reduce((x, y) => x + y) >= 290, 'the pages were drawn', JSON.stringify(visits));
  ok(live('document') - base.doc <= 1 && live('window') - base.win <= 2 && counters.intervals.size - base.iv <= 1, 'after 300 visits only the CURRENT page holds listeners / intervals',
    `doc+${live('document') - base.doc} win+${live('window') - base.win} iv+${counters.intervals.size - base.iv}`);
  r.destroy();
  ok(live('document') === base.doc && live('window') === base.win && counters.intervals.size === base.iv, 'destroy() leaves nothing registered', `doc+${live('document') - base.doc} win+${live('window') - base.win} iv+${counters.intervals.size - base.iv}`);
  ok(Object.keys(visits).every((k) => disposed[k] >= visits[k] - 1), 'dispose() ran for every page that was left', JSON.stringify([visits, disposed]));
  ok(globalThis.__RT.clears - base.clears >= 290, 'Realtime.clear() ran on every navigation');
} else ok(false, 'scope-based repeated navigation test needs core/lifecycle.js');

section('ARC-02 the real ChatModule releases its channels, document listener and timers');
{
  const { ChatModule } = await load('modules/chat/chat.js');
  const app = { currentUser: { id: 'u1' }, currentProfile: {} };
  const base = { doc: live('document'), iv: counters.intervals.size, made: counters.channelsCreated, removed: counters.channelsRemoved };
  const visit = () => {
    const chat = new ChatModule(app);
    chat.subscribeRealtime();          // what render() does
    chat.attachEventListeners();       // registers the document click listener
    chat.setFallbackPolling(true);     // the WebSocket-down fallback timer
    return chat;
  };
  const chats = [];
  for (let i = 0; i < 25; i++) { const c = visit(); chats.push(c); if (typeof c.dispose === 'function') c.dispose(); }
  const made = counters.channelsCreated - base.made, removed = counters.channelsRemoved - base.removed;
  ok(typeof chats[0].dispose === 'function', 'ChatModule has dispose() (module contract)');
  ok(made >= 25 && removed === made, `every realtime channel opened was removed (opened ${made}, removed ${removed})`);
  ok(live('document') === base.doc, 'no document click listener is left after 25 visits', String(live('document') - base.doc));
  ok(counters.intervals.size === base.iv, 'no polling timer is left after 25 visits', String(counters.intervals.size - base.iv));
  // a render that finishes AFTER the user left must not open anything
  const late = new ChatModule(app); if (late.dispose) late.dispose();
  const m0 = counters.channelsCreated; late.subscribeRealtime(); late.attachEventListeners();
  ok(counters.channelsCreated === m0 && live('document') === base.doc, 'a late render after dispose opens no channel and adds no listener');
  const again = new ChatModule(app); again.subscribeRealtime();
  ok(counters.channelsCreated === m0 + 1, 'a fresh instance still subscribes normally');
  if (again.dispose) again.dispose();
}

section('ARC-02 the real DrivePanel releases its lightbox listeners, blobs and tokens');
{
  const { DrivePanel } = await load('modules/clients/drive-panel.js');
  const dp = new DrivePanel(); dp.clientId = 'c1';
  ok(typeof dp.dispose === 'function', 'DrivePanel has dispose()');
  const base = { doc: live('document'), win: live('window'), revoked: counters.blobsRevoked };
  dp.listing = { files: [{ id: 1, name: 'a.png', size: 5, type: 'image/png' }], folders: [] };
  for (let i = 0; i < 10; i++) { try { dp.openPreview(dp.listing.files, 0); } catch { /* the preview needs a richer DOM; the listeners are added first */ } }
  ok(live('document') - base.doc <= 1 && live('window') - base.win <= 1, 'opening the preview 10 times keeps at most one set of listeners', `doc+${live('document') - base.doc} win+${live('window') - base.win}`);
  dp.blobs.set('c1:thumb:1', 'blob:a'); dp.blobs.set('c1:thumb:2', 'blob:b'); dp.tokens.set('k', { token: 'secret-token' });
  if (dp.dispose) dp.dispose();
  ok(live('document') === base.doc && live('window') === base.win, 'dispose() removed the lightbox listeners');
  ok(dp.tokens.size === 0, 'dispose() forgot the Drive tokens');
  ok(counters.blobsRevoked - base.revoked >= 2 && dp.blobs.size === 0, 'dispose() revoked every blob address (the image bytes are freed)');
}

section('SEC-02 browser: no Drive token in an address except a file-locked view link or a single-use link');
{
  const src = fs.readFileSync(path.join(JS, 'modules/clients/drive-panel.js'), 'utf8');
  const urlTokenUses = [...src.matchAll(/&token=\$\{encodeURIComponent/g)].length;
  ok(urlTokenUses === 2, 'two places build an address with a token: fileUrl (file-locked view / single-use zip) and the single-use download', String(urlTokenUses));
  ok(/scope: 'download', fileId/.test(src), 'the download address uses a download token locked to one file');
  ok(!/action=logo&token|action=thumb.*token/.test(src), 'thumbnails and the logo are not requested with an address token');
  ok(!/this\.fileUrl\(this\.view/.test(src), 'the client-wide view token is never put in an address');
  ok(/'X-Drive-Token'/.test(src) && /fetchBytes/.test(src), 'thumbnails, logo, text and fonts use the header');
  ok(/fileToken\(lb\.clientId, file\.id\)/.test(src), 'media / PDF / new-tab links use a token locked to the one file');
  ok(/Api\.kiteDrive\('token', \{ clientId, scope: 'view' \}\)/.test(src), 'the zip link uses a fresh single-use token, not the cached one');
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\nverify-frontend: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
