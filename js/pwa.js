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
function watchForUpdates(reg) {
  const announce = (worker) => {
    Toast.info('A new version of Kite System is ready. Reloading to update…', 'Update available');
    worker.postMessage({ type: 'SKIP_WAITING' });
  };
  if (reg.waiting && navigator.serviceWorker.controller) announce(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) announce(worker);
    });
  });
  // check for a new deploy whenever the app comes back to the foreground
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
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
