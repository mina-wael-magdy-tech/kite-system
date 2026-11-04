/* KITE SYSTEM — Service worker
 *
 * 1. Offline app shell: every static file is precached; pages/JS/CSS are served
 *    network-first (a new deploy is picked up immediately) and fall back to the cache.
 * 2. NEVER touches API traffic: Supabase auth, REST, storage and functions are cross-origin
 *    and bypass this worker entirely, so no private data is ever cached here.
 * 3. Web Push: shows notifications and routes taps into the app.
 *
 * The build id and the precache list below are stamped by scripts/build.mjs on every deploy.
 */

const BUILD = '__BUILD_ID__';
const CACHE = `kite-${BUILD}`;
const PRECACHE = '__PRECACHE__';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const list = Array.isArray(PRECACHE) ? PRECACHE : [];
    // addAll is all-or-nothing; cache individually so one bad file cannot block the install
    await Promise.all(list.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => null)));
    await cache.add(new Request(OFFLINE_URL, { cache: 'reload' })).catch(() => null);
  })());
  // activation waits for the page to ask (so users are never reloaded mid-edit)
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('kite-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

const isStaticAsset = (url) => /\/(fonts|vendor|assets)\//.test(url.pathname);

async function networkFirst(request, { navigation = false } = {}) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (navigation) {
      const offline = await cache.match(OFFLINE_URL);
      if (offline) return offline;
    }
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) {
    // refresh in the background
    fetch(request).then((r) => { if (r && r.ok) cache.put(request, r.clone()); }).catch(() => {});
    return cached;
  }
  const response = await fetch(request);
  if (response && response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;       // Supabase etc.: not our business
  if (url.pathname === '/sw.js' || url.pathname === '/env.js') return; // always live

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, { navigation: true }));
  } else if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(networkFirst(request));
  }
});

// ---------------------------------------------------------------- Web Push

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }

  const title = data.title || 'Kite System';
  const options = {
    body: data.body || '',
    icon: '/assets/icon-192.png',
    badge: '/assets/badge-96.png',
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),          // a new message in the same chat buzzes again instead of silently replacing
    vibrate: data.requireInteraction ? [400, 150, 400, 150, 400] : [120, 60, 120],  // Android: without it many phones stay silent
    requireInteraction: data.requireInteraction === true,   // incoming calls stay until answered
    silent: false,
    timestamp: Date.now(),
    data: { url: data.url || '/index.html#dashboard' }
  };

  event.waitUntil((async () => {
    // The app is open and in front: it already shows its own toast / ringing screen, a system banner would double up.
    if (!data.requireInteraction) {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (open.some((c) => c.visibilityState === 'visible' && c.focused)) return;
    }
    await self.registration.showNotification(title, options);
    try {
      if (typeof data.badgeCount === 'number' && self.navigator.setAppBadge) await self.navigator.setAppBadge(data.badgeCount);
    } catch { /* badges are optional */ }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Only ever open this app's own pages
  let target;
  try {
    const u = new URL(event.notification.data?.url || '/index.html#dashboard', self.location.origin);
    target = u.origin === self.location.origin ? u.href : new URL('/index.html#dashboard', self.location.origin).href;
  } catch { target = new URL('/index.html#dashboard', self.location.origin).href; }

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
        await client.focus();
        client.postMessage({ type: 'NAVIGATE', url: target });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

// The push service rotated our subscription: ask an open page to subscribe again.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    windows.forEach((c) => c.postMessage({ type: 'RESUBSCRIBE_PUSH' }));
  })());
});
