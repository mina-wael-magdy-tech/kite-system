/**
 * KITE SYSTEM — PWA runtime
 * Registers the service worker, offers installation, and handles app updates.
 * Loaded on every page.
 */

import { Toast } from './services/toast-service.js';

const listeners = new Set();
let installEvent = null;

export const PWA = {
  isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  },
  isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  },
  /** Android/desktop Chrome/Edge: a native install prompt is available. */
  canPromptInstall() { return Boolean(installEvent) && !this.isStandalone(); },
  /** iOS Safari: no prompt exists, we show "Share → Add to Home Screen" instructions instead. */
  needsManualInstall() { return this.isIOS() && !this.isStandalone(); },
  async promptInstall() {
    if (!installEvent) return false;
    installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    installEvent = null;
    emit();
    return outcome === 'accepted';
  },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  async registration() {
    return 'serviceWorker' in navigator ? navigator.serviceWorker.getRegistration() : null;
  }
};

function emit() { listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } }); }

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  emit();
});
window.addEventListener('appinstalled', () => {
  installEvent = null;
  Toast.success('Kite System was added to your device', 'Installed');
  emit();
});

// -------------------------------------------------- service worker + updates
function showUpdatePopup(worker) {
  if (document.getElementById('kiteUpdatePopup')) return;
  const css = (el, rules) => { Object.assign(el.style, rules); return el; };
  const wrap = css(document.createElement('div'), { position: 'fixed', inset: '0', zIndex: '10000', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(20,32,48,.5)', padding: '16px' });
  wrap.id = 'kiteUpdatePopup';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-labelledby', 'kiteUpdateTitle');
  const card = css(document.createElement('div'), { background: '#fff', color: '#14202e', borderRadius: '12px', padding: '24px', width: '100%', maxWidth: '380px', fontFamily: "'Poppins','Cairo','Segoe UI',sans-serif", boxShadow: '0 8px 24px rgba(20,32,48,.25)', textAlign: 'center' });
  const bar = css(document.createElement('div'), { height: '6px', margin: '-24px -24px 20px', borderRadius: '12px 12px 0 0', background: 'linear-gradient(90deg,#e01b28 0 50%,#fbba48 50% 78%,#7bcbe3 78% 100%)' });
  const title = css(document.createElement('h2'), { margin: '0 0 8px', fontSize: '18px', fontWeight: '700' });
  title.id = 'kiteUpdateTitle'; title.textContent = 'New update available';
  const text = css(document.createElement('p'), { margin: '0 0 20px', fontSize: '14px', lineHeight: '1.6', color: '#4b5a6b' });
  text.textContent = 'A newer version of Kite System is ready. Update now to get the latest changes. The page will reload.';
  const row = css(document.createElement('div'), { display: 'flex', gap: '8px' });
  const btn = (label, primary) => {
    const b = css(document.createElement('button'), { flex: '1', padding: '11px 12px', borderRadius: '8px', font: 'inherit', fontSize: '14px', fontWeight: '600', cursor: 'pointer', border: primary ? '1px solid #e01b28' : '1px solid #d4dce6', background: primary ? '#e01b28' : '#fff', color: primary ? '#fff' : '#14202e' });
    b.type = 'button'; b.textContent = label; return b;
  };
  const later = btn('Later', false);
  const now = btn('Update now', true);
  later.addEventListener('click', () => wrap.remove());
  now.addEventListener('click', () => { now.disabled = true; now.textContent = 'Updating…'; worker.postMessage({ type: 'SKIP_WAITING' }); });
  row.append(later, now);
  card.append(bar, title, text, row);
  wrap.append(card);
  document.body.append(wrap);
  now.focus();
}

function watchForUpdates(reg) {
  const announce = (worker) => showUpdatePopup(worker);
  if (reg.waiting && navigator.serviceWorker.controller) announce(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) announce(worker);
    });
  });
  // check for a new deploy whenever the app comes back to the foreground, and every 30 minutes
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  // Reload only when a NEW worker replaces an existing one (an update), never on the very first install.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });

  // Notification taps arrive here when the app is already open
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'NAVIGATE') {
      try {
        const u = new URL(event.data.url);
        if (u.origin === location.origin) {
          if (u.pathname === location.pathname) location.hash = u.hash;
          else location.href = u.href;
        }
      } catch { /* ignore */ }
    }
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then(watchForUpdates)
      .catch((err) => console.warn('Service worker registration failed:', err));
  });
}
