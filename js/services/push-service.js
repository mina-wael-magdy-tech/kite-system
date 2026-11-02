/**
 * KITE SYSTEM — Push notification client
 * Permission, subscription and unsubscription for THIS device.
 * Subscriptions are stored by the server (workflow function), never written by the browser.
 */

import { CONFIG } from '../config.js';
import { Api } from './api.js';
import { PWA } from '../pwa.js';

function urlBase64ToUint8Array(b64) {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function registration() {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.ready);
}

export const Push = {
  isSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  },
  isConfigured() { return Boolean(CONFIG.VAPID_PUBLIC_KEY); },

  /**
   * One of: unsupported | needs-install (iOS in Safari) | not-configured | denied | off | on
   */
  async state() {
    if (PWA.needsManualInstall()) return 'needs-install';   // iOS only delivers web push to installed apps
    if (!this.isSupported()) return 'unsupported';
    if (!this.isConfigured()) return 'not-configured';
    if (Notification.permission === 'denied') return 'denied';
    const reg = await registration();
    const sub = await reg?.pushManager.getSubscription();
    return Notification.permission === 'granted' && sub ? 'on' : 'off';
  },

  async enable() {
    if (!this.isSupported() || !this.isConfigured()) throw new Error('Push notifications are not available on this device.');
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notifications were not allowed. You can change this in your browser settings.');

    const reg = await registration();
    if (!reg) throw new Error('The app is still starting. Please try again in a moment.');

    const key = urlBase64ToUint8Array(CONFIG.VAPID_PUBLIC_KEY);
    let sub = await reg.pushManager.getSubscription();
    try {
      sub = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    } catch (err) {
      // A subscription created with a different key blocks a new one: clear it and retry once
      if (err?.name === 'InvalidStateError') {
        await (await reg.pushManager.getSubscription())?.unsubscribe();
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      } else {
        throw err;
      }
    }
    await this.save(sub);
    return sub;
  },

  async save(sub) {
    const json = sub.toJSON();
    await Api.workflow('push.subscribe', {
      endpoint: json.endpoint,
      p256dh: json.keys?.p256dh,
      auth: json.keys?.auth,
      userAgent: navigator.userAgent
    });
  },

  /** Turn off on this device: forget it on the server first, then in the browser. */
  async disable() {
    const reg = await registration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    try { await Api.workflow('push.unsubscribe', { endpoint }); } catch { /* server cleans expired endpoints itself */ }
    await sub.unsubscribe();
  },

  /** On every app start: make sure the server still knows this device (e.g. after a re-login). */
  async sync() {
    try {
      if (!this.isSupported() || !this.isConfigured() || Notification.permission !== 'granted') return;
      const reg = await registration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) await this.save(sub);
    } catch { /* non-critical */ }
  },

  async sendTest() { return Api.workflow('push.test'); }
};

// The push service rotated this device's subscription
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'RESUBSCRIBE_PUSH') Push.enable().catch(() => {});
});
