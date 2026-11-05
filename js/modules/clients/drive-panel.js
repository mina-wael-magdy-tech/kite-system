/**
 * KITE SYSTEM — Kite Drive section of a client's Files tab.
 * Files stay on Hostinger: the `kite-drive` Edge Function checks the staff member and signs a short-lived
 * token, then the browser talks straight to Drive's API. Uploads go in chunks and carry on after a dropped
 * connection, so large videos work.
 */

import { Api } from '../../services/api.js';
import { Toast } from '../../services/toast-service.js';
import { formDialog, confirmDialog } from '../../ui/dialogs.js';
import { escapeHTML, formatDate } from '../../utils/helpers.js';

const CHUNK_RETRIES = 5;
const TOKEN_MARGIN_SECONDS = 60;
const sizeText = (n) => {
  if (n == null) return 'Missing from server';
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class DrivePanel {
  constructor() {
    this.el = null;
    this.clientId = null;
    this.status = null;
    this.listing = null;
    this.folderId = null;
    this.error = null;
    this.uploads = [];       // { id, name, done, total, failed }
    this.tokens = new Map(); // "clientId:scope" -> { token, apiUrl, expiresAt }
  }

  /** The hub repaints its tabs on live updates, so this re-attaches without losing the folder or uploads. */
  mount(el, clientId) {
    this.el = el;
    if (clientId !== this.clientId) {
      this.clientId = clientId;
      this.status = null;
      this.listing = null;
      this.folderId = null;
      this.error = null;
      this.load();
    }
    this.paint();
  }

  async load() {
    const clientId = this.clientId;
    try {
      const status = await Api.kiteDrive('status', { clientId });
      if (clientId !== this.clientId) return;
      this.status = status;
      this.error = null;
      if (status.linked) await this.loadFolder(this.folderId);
      else this.paint();
    } catch (err) {
      if (clientId !== this.clientId) return;
      this.error = err.message;
      this.paint();
    }
  }

  async loadFolder(folderId) {
    const clientId = this.clientId;
    try {
      const query = folderId ? `action=list&folder=${folderId}` : 'action=list';
      const listing = await this.call(clientId, 'read', query);
      if (clientId !== this.clientId) return;
      this.listing = listing;
      this.folderId = folderId;
      this.error = null;
    } catch (err) {
      if (clientId !== this.clientId) return;
      this.error = err.message;
    }
    this.paint();
  }

  async token(clientId, scope) {
    const key = `${clientId}:${scope}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - TOKEN_MARGIN_SECONDS > Date.now() / 1000) return cached;
    const fresh = await Api.kiteDrive('token', { clientId, scope });
    this.tokens.set(key, fresh);
    return fresh;
  }

  async call(clientId, scope, query, init = {}) {
    const { token, apiUrl } = await this.token(clientId, scope);
    const res = await fetch(`${apiUrl}?${query}`, { ...init, headers: { ...(init.headers || {}), 'X-Drive-Token': token } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || `Kite Drive error (${res.status})`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  // ---------------------------------------------------------------- painting
  paint() {
    if (!this.el?.isConnected) return;
    this.el.innerHTML = `<section class="glass-panel ch-sec ch-drive">${this.contentHTML()}</section>`;
    this.bind();
    window.lucide?.createIcons();
  }

  headHTML(actions = '') {
    const name = this.status?.driveName;
    return `<div class="ch-row ch-drive-head">
      <h3><i data-lucide="hard-drive"></i> Kite Drive${name ? ` <span class="text-xs text-muted">· ${escapeHTML(name)}</span>` : ''}</h3>
      <div class="ch-drive-actions">${actions}</div></div>`;
  }

  contentHTML() {
    if (this.error && !this.status) return `${this.headHTML()}<p class="text-xs text-muted">${escapeHTML(this.error)}</p>`;
    if (!this.status) return `${this.headHTML()}<p class="text-xs text-muted">Loading…</p>`;
    const s = this.status;
    if (!s.configured) return `${this.headHTML()}<p class="text-xs text-muted">Kite Drive isn't set up yet.</p>`;
    if (!s.linked) {
      return `${this.headHTML(s.canLink ? '<button type="button" class="btn btn-primary btn-sm" data-drive="link"><i data-lucide="link"></i> Link to Kite Drive</button>' : '')}
        <p class="text-xs text-muted">${s.canLink ? 'Link this client to their Kite Drive account to see and deliver their files here.' : 'This client isn\'t linked to Kite Drive yet. Ask an admin to link them.'}</p>`;
    }
    const actions = `
      ${s.canUpload ? '<label class="btn btn-primary btn-sm" style="cursor:pointer;"><i data-lucide="upload-cloud"></i> Upload to Drive<input data-drive="upload" type="file" multiple hidden /></label>' : ''}
      ${s.driveUrl ? `<a class="btn btn-secondary btn-sm" href="${escapeHTML(s.driveUrl)}" target="_blank" rel="noopener noreferrer"><i data-lucide="external-link"></i> Open</a>` : ''}
      ${s.canLink ? '<button type="button" class="btn btn-secondary btn-sm" data-drive="unlink"><i data-lucide="unlink"></i> Unlink</button>' : ''}`;
    return `${this.headHTML(actions)}${this.uploadsHTML()}${this.error ? `<p class="text-xs text-muted">${escapeHTML(this.error)}</p>` : ''}${this.listingHTML()}`;
  }

  uploadsHTML() {
    if (!this.uploads.length) return '';
    return `<div class="ch-drive-uploads">${this.uploads.map((u) => {
      const pct = u.total ? Math.floor((u.done / u.total) * 100) : 0;
      return `<div class="ch-drive-upload"><span class="ch-ellipsis">${escapeHTML(u.name)}</span>
        <em>${u.failed ? escapeHTML(u.failed) : `${pct}%`}</em>
        <div class="ch-drive-bar"><i data-upload-bar="${u.id}" style="width:${pct}%"></i></div></div>`;
    }).join('')}</div>`;
  }

  listingHTML() {
    const l = this.listing;
    if (!l) return this.error ? '' : '<p class="text-xs text-muted">Loading…</p>';
    const crumbs = [{ id: null, name: 'All files' }, ...l.breadcrumb];
    const trail = crumbs.map((c, i) => (i === crumbs.length - 1
      ? `<b>${escapeHTML(c.name)}</b>`
      : `<button type="button" class="ch-drive-crumb" data-drive-folder="${c.id ?? ''}">${escapeHTML(c.name)}</button>`)).join('<span>/</span>');
    if (!l.folders.length && !l.files.length) {
      return `<div class="ch-drive-trail">${trail}</div><p class="text-xs text-muted">This folder is empty.</p>`;
    }
    return `<div class="ch-drive-trail">${trail}</div><div class="ch-files">
      ${l.folders.map((f) => `<button type="button" class="ch-file" data-drive-folder="${f.id}"><i data-lucide="folder"></i><span class="ch-ellipsis"><b>${escapeHTML(f.name)}</b><em>Folder</em></span></button>`).join('')}
      ${l.files.map((f) => `<button type="button" class="ch-file" data-drive-file="${f.id}"><i data-lucide="file"></i><span class="ch-ellipsis"><b>${escapeHTML(f.name)}</b><em>${sizeText(f.size)} · ${formatDate(f.at)}</em></span><i data-lucide="download"></i></button>`).join('')}
    </div>`;
  }

  bind() {
    const el = this.el;
    el.querySelector('[data-drive="link"]')?.addEventListener('click', () => this.link());
    el.querySelector('[data-drive="unlink"]')?.addEventListener('click', () => this.unlink());
    el.querySelector('[data-drive="upload"]')?.addEventListener('change', (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      this.uploadAll(files);
    });
    el.querySelectorAll('[data-drive-folder]').forEach((b) => b.addEventListener('click', () => {
      this.loadFolder(b.dataset.driveFolder ? Number(b.dataset.driveFolder) : null);
    }));
    el.querySelectorAll('[data-drive-file]').forEach((b) => b.addEventListener('click', () => this.download(Number(b.dataset.driveFile))));
  }

  // ---------------------------------------------------------------- actions
  async download(fileId) {
    try {
      const { token, apiUrl } = await Api.kiteDrive('token', { clientId: this.clientId, scope: 'download', fileId });
      window.open(`${apiUrl}?action=download&token=${encodeURIComponent(token)}`, '_blank', 'noopener');
    } catch (err) {
      Toast.error(err.message, 'Download failed');
    }
  }

  async link() {
    const clientId = this.clientId;
    let options;
    try {
      ({ clients: options } = await Api.kiteDrive('link.options'));
    } catch (err) {
      Toast.error(err.message, 'Could not load Kite Drive accounts');
      return;
    }
    if (!options.length) {
      Toast.error('Every Kite Drive account is already linked to a client.', 'Nothing to link');
      return;
    }
    formDialog({
      title: 'Link to Kite Drive',
      subtitle: 'Staff who can see this client will be able to see this Drive account\'s files.',
      submitLabel: 'Link',
      fields: [{
        name: 'driveUserId', label: 'Kite Drive account', type: 'select', required: true,
        options: options.map((c) => ({ value: String(c.id), label: `${c.name} (${c.email})` }))
      }],
      onSubmit: async (values) => {
        await Api.kiteDrive('link.set', { clientId, driveUserId: Number(values.driveUserId) });
        Toast.success('Linked to Kite Drive');
        this.folderId = null;
        this.listing = null;
        await this.load();
      }
    });
  }

  async unlink() {
    const ok = await confirmDialog({
      title: 'Unlink from Kite Drive?',
      message: 'Staff will no longer see this account\'s files here. Nothing is deleted from Kite Drive, and the client can still log in.',
      confirmLabel: 'Unlink', danger: true
    });
    if (!ok) return;
    try {
      await Api.kiteDrive('link.remove', { clientId: this.clientId });
      this.tokens.clear();
      this.listing = null;
      this.folderId = null;
      await this.load();
    } catch (err) {
      Toast.error(err.message, 'Could not unlink');
    }
  }

  async uploadAll(files) {
    // Keep the client and folder chosen now, even if someone browses elsewhere during a long upload.
    const clientId = this.clientId, folderId = this.folderId;
    const entries = files.map((file) => ({ id: crypto.randomUUID(), file, name: file.name, done: 0, total: file.size, failed: null }));
    this.uploads.push(...entries);
    this.paint();
    let ok = 0;
    for (const entry of entries) {
      try {
        await this.uploadOne(clientId, folderId, entry);
        ok++;
        this.uploads = this.uploads.filter((u) => u !== entry);
      } catch (err) {
        entry.failed = err.message;
        Toast.error(`${entry.name}: ${err.message}`, 'Upload failed');
      }
      this.paint();
    }
    if (ok) {
      Toast.success(`${ok} file${ok === 1 ? '' : 's'} sent to Kite Drive`, 'Uploaded');
      if (clientId === this.clientId && folderId === this.folderId) await this.loadFolder(folderId);
    }
  }

  async uploadOne(clientId, folderId, entry) {
    const { file } = entry;
    if (!file.size) throw new Error('This file is empty');
    const postJson = (action, body) => this.call(clientId, 'write', `action=${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const { uploadId, chunkSize } = await postJson('upload_init', { name: file.name, size: file.size, folderId });

    let offset = 0, failures = 0;
    while (offset < file.size) {
      try {
        const chunk = file.slice(offset, offset + chunkSize);
        const res = await this.call(clientId, 'write', `action=upload_chunk&id=${uploadId}&offset=${offset}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk
        });
        offset = res.offset;
        failures = 0;
      } catch (err) {
        if (err.status === 409 && Number.isInteger(err.body?.offset)) {
          offset = err.body.offset; // the server says where it got to
        } else if (err.status && err.status < 500) {
          throw err;
        } else if (++failures >= CHUNK_RETRIES) {
          throw new Error('The connection to Kite Drive keeps dropping. Please try again.');
        } else {
          await wait(1000 * 2 ** failures);
        }
      }
      entry.done = offset;
      this.paintProgress(entry);
    }
    await postJson('upload_complete', { uploadId });
  }

  /** Updates just the bar, so a large upload doesn't redraw the file list every few seconds. */
  paintProgress(entry) {
    const pct = Math.floor((entry.done / entry.total) * 100);
    const bar = this.el?.querySelector(`[data-upload-bar="${entry.id}"]`);
    if (!bar) return;
    bar.style.width = `${pct}%`;
    bar.parentElement.previousElementSibling.textContent = `${pct}%`;
  }
}
