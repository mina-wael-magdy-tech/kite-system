/**
 * KITE SYSTEM — Notification troubleshooting panel
 * Runs live checks on THIS device, then lists the fixes that match what it found.
 */

import { Push } from '../services/push-service.js';
import { PWA } from '../pwa.js';
import { htmlDialog } from './dialogs.js';
import { Toast } from '../services/toast-service.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function detectBrowser() {
  const ua = navigator.userAgent;
  if (/SamsungBrowser/i.test(ua)) return 'Samsung Internet';
  if (/Firefox/i.test(ua)) return 'Firefox';
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/Chrome/i.test(ua)) return 'Chrome';
  if (/Safari/i.test(ua)) return 'Safari';
  return 'Unknown';
}
const isAndroid = () => /android/i.test(navigator.userAgent);
const isSamsung = () => /SamsungBrowser|SM-[A-Z0-9]+|Samsung/i.test(navigator.userAgent);

/** Each check: { label, ok: true|false|null (null = informational), detail } */
async function runChecks() {
  const checks = [];
  const add = (label, ok, detail) => checks.push({ label, ok, detail });
  const browser = detectBrowser();

  add('Secure connection', window.isSecureContext, window.isSecureContext ? 'HTTPS' : 'Notifications need a secure (https) connection.');
  add('Push supported', Push.isSupported(), Push.isSupported() ? `${browser} supports push` : `${browser} cannot receive push on this device.`);
  add('Server push configured', Push.isConfigured(), Push.isConfigured() ? 'Yes' : 'An administrator must enable push on the server.');

  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  add('Permission for this site', perm === 'granted', perm === 'granted' ? 'Allowed' : perm === 'denied' ? 'Blocked: allow it in the site settings.' : 'Not asked yet. Turn notifications on first.');

  let sub = null;
  try {
    const reg = await PWA.registration();
    add('Background worker running', Boolean(reg?.active), reg?.active ? 'Active' : 'Not active yet. Reload the app once.');
    sub = await reg?.pushManager?.getSubscription();
  } catch { add('Background worker running', false, 'Could not read the service worker.'); }
  add('This device is subscribed', Boolean(sub), sub ? `Registered with ${new URL(sub.endpoint).hostname}` : 'No subscription. Press "Repair".');

  try {
    const hit = await (await caches.open('pushlog')).match('/__pushlog');
    if (hit) {
      const { at, status } = await hit.json();
      const when = new Date(at).toLocaleTimeString();
      const bad = status.startsWith('failed') || status === 'received';
      add('Last push that reached this phone', bad ? false : true, `${when}: ${status}${status === 'received' ? ' (arrived but was not shown: the phone is blocking it)' : ''}`);
    } else {
      add('Last push that reached this phone', null, 'None yet. Close the app, press "Send a test", then re-open this panel. If still none, the message never reaches this phone.');
    }
  } catch { /* not available */ }
  add('Installed as an app', PWA.isStandalone() ? true : null, PWA.isStandalone() ? 'Yes' : 'Running in the browser. Installing improves reliability.');
  add('Browser', browser === 'Samsung Internet' ? false : null, browser === 'Samsung Internet'
    ? 'Samsung Internet is unreliable for push. Use Chrome instead.' : browser);
  add('Connection', navigator.onLine, navigator.onLine ? 'Online' : 'Offline');
  return checks;
}

function guideHTML() {
  const samsung = isSamsung();
  const android = isAndroid();
  if (!android) {
    return `<ul class="text-xs text-muted" style="line-height:1.7;padding-left:18px;">
      <li>Make sure notifications are allowed for this site in the browser settings.</li>
      <li>Check that Do Not Disturb / Focus is not silencing the browser or app.</li>
      <li>Press <b>Repair</b>, then <b>Send a test</b>.</li></ul>`;
  }
  const steps = [
    ['Use Chrome', 'Open the app in <b>Chrome</b> and choose <b>Install app</b>. Do not use Samsung Internet or "Add to Home screen" from it.'],
    ['Stop battery sleep', 'Settings → Battery → Background usage limits: turn off <b>Put unused apps to sleep</b> and <b>Auto disable unused apps</b>. Remove Chrome and Kite from <b>Sleeping apps</b> and <b>Deep sleeping apps</b>.'],
    ['Unrestricted battery', 'Settings → Apps → Chrome (and the installed Kite app) → Battery → <b>Unrestricted</b>.'],
    ['All notification switches', 'Settings → Apps → Chrome / Kite → Notifications: turn on the app switch <b>and</b> every category inside it. Also check lock-screen notifications.'],
    ['No silencing', 'Turn off Do Not Disturb and Focus modes, or allow Chrome / Kite in them.'],
    ['Reinstall once', 'Remove the installed app, clear Chrome site data for this address, install again, then turn notifications on and press <b>Send a test</b>.']
  ];
  return `${samsung ? '<p class="text-2xs text-dim" style="margin-bottom:6px;">Samsung phones (Galaxy Note / S series) stop background apps aggressively. Do these in order:</p>' : ''}
    <ol class="text-xs text-muted" style="line-height:1.6;padding-left:18px;display:grid;gap:8px;">
      ${steps.map(([t, d]) => `<li><b class="text-white">${t}.</b> ${d}</li>`).join('')}
    </ol>`;
}

function render(checks) {
  const icon = (ok) => ok === true ? '<span style="color:var(--success,#22c55e);font-weight:700;">&#10003;</span>'
    : ok === false ? '<span style="color:var(--danger,#e01b28);font-weight:700;">&#10007;</span>'
      : '<span class="text-dim">&#8226;</span>';
  const rows = checks.map((c) => `
    <div style="display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--border,rgba(255,255,255,.08));">
      <div style="width:16px;text-align:center;">${icon(c.ok)}</div>
      <div style="flex:1;min-width:0;"><div class="text-xs font-bold text-white">${esc(c.label)}</div>
      <div class="text-2xs text-muted" style="line-height:1.45;">${esc(c.detail)}</div></div>
    </div>`).join('');
  const failed = checks.filter((c) => c.ok === false).length;
  const summary = failed
    ? `<p class="text-xs" style="margin-bottom:8px;color:var(--danger,#e01b28);">${failed} problem${failed > 1 ? 's' : ''} found on this device.</p>`
    : '<p class="text-xs text-muted" style="margin-bottom:8px;">This device looks correctly set up. If alerts still do not appear, the phone is blocking them: follow the steps below.</p>';
  return `${summary}<div>${rows}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0;">
      <button type="button" class="btn btn-primary btn-sm" data-ts="repair">Repair</button>
      <button type="button" class="btn btn-secondary btn-sm" data-ts="test">Send a test</button>
      <button type="button" class="btn btn-ghost btn-sm" data-ts="recheck">Re-check</button>
    </div>
    <div class="text-xs font-bold text-white" style="margin-bottom:6px;">If the phone still stays silent</div>
    ${guideHTML()}`;
}

export async function openPushTroubleshoot(onChange) {
  const dlg = htmlDialog({ title: 'Notification troubleshooting', html: '<p class="text-xs text-muted">Checking this device…</p>', maxWidth: '520px' });
  const body = dlg.querySelector('.modal-body');

  const refresh = async () => {
    body.innerHTML = render(await runChecks());
    body.querySelectorAll('[data-ts]').forEach((btn) => btn.addEventListener('click', async () => {
      const act = btn.getAttribute('data-ts');
      btn.disabled = true;
      try {
        if (act === 'repair') {
          // drop the old subscription so a fresh one is created and re-registered on the server
          await Push.disable().catch(() => {});
          await Push.enable();
          Toast.success('Notifications were re-registered for this device', 'Repaired');
        }
        if (act === 'test') { await Push.sendTest(); Toast.success('Test sent: it should arrive in a few seconds', 'Sent'); }
      } catch (err) {
        Toast.error(err.message || 'Something went wrong', 'Notifications');
      }
      await refresh();
      onChange?.();
    }));
  };
  await refresh();
}
