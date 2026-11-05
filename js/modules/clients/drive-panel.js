/**
 * KITE SYSTEM — Kite Drive section of a client's Files tab: the same file management as Drive's admin panel.
 * Files stay on Hostinger: the `kite-drive` Edge Function checks the staff member and signs a short-lived
 * token, then the browser talks straight to Drive's API. Uploads go in chunks and carry on after a dropped
 * connection, so large videos work.
 */

import { Api } from '../../services/api.js';
import { Toast } from '../../services/toast-service.js';
import { formDialog, confirmDialog } from '../../ui/dialogs.js';
import { escapeHTML, formatDate } from '../../utils/helpers.js';
import { PAGE_SIZE, pageSlice, mountPager } from '../../ui/pagination.js';

const CHUNK_RETRIES = 5;
const TOKEN_MARGIN_SECONDS = 60;
const TEXT_PREVIEW_BYTES = 2097152;
const FONT_PREVIEW_BYTES = 31457280;
const UPLOAD_ROWS_SHOWN = 6;
const sizeText = (n) => {
  if (n == null) return 'Missing from server';
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const KINDS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg'],
  pdf: ['pdf'],
  video: ['mp4', 'webm', 'mov', 'm4v'],
  audio: ['mp3', 'wav', 'ogg', 'm4a'],
  text: ['txt', 'csv', 'json', 'md', 'xml', 'log', 'html', 'htm', 'css', 'js', 'ts', 'java', 'py', 'php', 'yml', 'yaml', 'srt', 'vtt'],
  font: ['ttf', 'otf', 'woff', 'woff2']
};
const KIND_ICON = { image: 'image', pdf: 'file-text', video: 'play-circle', audio: 'music', text: 'file-code', font: 'type' };
const OPENS_IN_TAB = new Set(['image', 'pdf', 'video', 'audio']);
const extOf = (name = '') => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const kindOf = (file) => Object.keys(KINDS).find((k) => KINDS[k].includes(extOf(file.name))) || null;

/** Reads a dropped folder entry into files, keeping each file's folder path. */
async function readEntry(entry, parts, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ file, parts });
    return;
  }
  const reader = entry.createReader();
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return;
    for (const child of batch) await readEntry(child, [...parts, entry.name], out);
  }
}

export class DrivePanel {
  constructor() {
    this.el = null;
    this.clientId = null;
    this.status = null;
    this.listing = null;
    this.folderId = null;
    this.error = null;
    this.selected = new Set(); // "file:12", "folder:3"
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
      this.view = null;
      this.folderId = null;
      this.error = null;
      this.selected.clear();
      this.page = 1;
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
      if (folderId !== this.folderId) { this.selected.clear(); this.page = 1; }
      // Drive sends one page at a time. An older Drive that ignores page and size sends the whole folder,
      // and the panel then cuts it into pages itself.
      const query = `action=list${folderId ? `&folder=${folderId}` : ''}&size=${PAGE_SIZE.drive}&page=${this.page || 1}`;
      const [listing, view] = await Promise.all([this.call(clientId, 'read', query), this.token(clientId, 'view')]);
      if (clientId !== this.clientId) return;
      this.view = view;
      if (listing.total != null) this.page = listing.page; // Drive moved us to the last page if ours was past the end
      this.listing = listing;
      this.folderId = folderId;
      this.error = null;
      // Anything selected that has since gone (deleted, moved) must not stay selected.
      const present = new Set([...listing.files.map((f) => `file:${f.id}`), ...listing.folders.map((f) => `folder:${f.id}`)]);
      this.selected.forEach((key) => { if (!present.has(key)) this.selected.delete(key); });
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

  postJson(clientId, scope, action, body) {
    return this.call(clientId, scope, `action=${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
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
    const logo = this.listing?.hasLogo && this.view
      ? `<img class="ch-drive-logo" src="${escapeHTML(`${this.view.apiUrl}?action=logo&token=${encodeURIComponent(this.view.token)}`)}" alt="" />` : '<i data-lucide="hard-drive"></i>';
    return `<div class="ch-row ch-drive-head">
      <h3>${logo} Kite Drive${name ? ` <span class="text-xs text-muted">· ${escapeHTML(name)}</span>` : ''}</h3>
      <div class="ch-drive-actions">${actions}</div></div>`;
  }

  contentHTML() {
    if (this.error && !this.status) return `${this.headHTML()}<p class="text-xs text-muted">${escapeHTML(this.error)}</p>`;
    if (!this.status) return `${this.headHTML()}<p class="text-xs text-muted">Loading…</p>`;
    const s = this.status;
    if (!s.configured) return `${this.headHTML()}<p class="text-xs text-muted">Kite Drive isn't set up yet.</p>`;
    if (!s.linked) {
      return `${this.headHTML(s.canLink ? `
        <button type="button" class="btn btn-primary btn-sm" data-drive="create"><i data-lucide="user-plus"></i> Create Drive account</button>
        <button type="button" class="btn btn-secondary btn-sm" data-drive="link"><i data-lucide="link"></i> Link existing account</button>` : '')}
        <p class="text-xs text-muted">${s.canLink ? 'Link this client to their Kite Drive account to see and deliver their files here.' : 'This client isn\'t linked to Kite Drive yet. Ask an admin to link them.'}</p>`;
    }
    const manage = s.canUpload ? `
      <button type="button" class="btn btn-secondary btn-sm" data-drive="mkdir"><i data-lucide="folder-plus"></i> New folder</button>
      <label class="btn btn-primary btn-sm" style="cursor:pointer;"><i data-lucide="upload-cloud"></i> Upload files<input data-drive="upload" type="file" multiple hidden /></label>
      <label class="btn btn-secondary btn-sm" style="cursor:pointer;"><i data-lucide="folder-up"></i> Upload folder<input data-drive="upload-folder" type="file" webkitdirectory multiple hidden /></label>
      <label class="btn btn-secondary btn-sm" style="cursor:pointer;" title="Upload a ZIP and unpack it into folders"><i data-lucide="file-archive"></i> Unpack ZIP<input data-drive="upload-zip" type="file" accept=".zip,application/zip" hidden /></label>
      <label class="btn btn-secondary btn-sm" style="cursor:pointer;"><i data-lucide="image-plus"></i> Logo<input data-drive="logo" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden /></label>` : '';
    const actions = `${manage}
      ${s.driveUrl ? `<a class="btn btn-secondary btn-sm" href="${escapeHTML(s.driveUrl)}" target="_blank" rel="noopener noreferrer"><i data-lucide="external-link"></i> Open</a>` : ''}
      ${s.canLink ? '<button type="button" class="btn btn-secondary btn-sm" data-drive="account"><i data-lucide="key-round"></i> Login details</button>' : ''}
      ${s.canLink ? '<button type="button" class="btn btn-secondary btn-sm" data-drive="unlink"><i data-lucide="unlink"></i> Unlink</button>' : ''}`;
    return `${this.headHTML(actions)}${this.uploadsHTML()}${this.error ? `<p class="text-xs text-muted">${escapeHTML(this.error)}</p>` : ''}${this.listingHTML()}
      ${s.canUpload ? '<div class="ch-drive-drop" hidden>Drop files or folders to upload here</div>' : ''}`;
  }

  uploadsHTML() {
    if (!this.uploads.length) return '';
    const failedFirst = [...this.uploads].sort((a, b) => Number(Boolean(b.failed)) - Number(Boolean(a.failed)));
    const rows = failedFirst.slice(0, UPLOAD_ROWS_SHOWN).map((u) => {
      const pct = u.total ? Math.floor((u.done / u.total) * 100) : 0;
      return `<div class="ch-drive-upload"><span class="ch-ellipsis">${escapeHTML(u.name)}</span>
        <em>${u.failed ? escapeHTML(u.failed) : `${pct}%`}</em>
        <div class="ch-drive-bar"><i data-upload-bar="${u.id}" style="width:${pct}%"></i></div></div>`;
    }).join('');
    const more = this.uploads.length - UPLOAD_ROWS_SHOWN;
    return `<div class="ch-drive-uploads">${rows}${more > 0 ? `<em class="text-2xs text-muted">and ${more} more waiting…</em>` : ''}</div>`;
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
    // Folders first, then files. Drive already sent just this page; a file keeps its place within it,
    // so the preview's next and previous work on the page you're looking at.
    let cards = [...l.folders.map((f) => this.folderCardHTML(f)), ...l.files.map((f, i) => this.fileCardHTML(f, i))];
    if (l.total == null) { // an older Drive that sent everything: cut the page here
      const items = [...l.folders.map((f) => () => this.folderCardHTML(f)), ...l.files.map((f, i) => () => this.fileCardHTML(f, i))];
      const shown = pageSlice(items, this.page || 1, PAGE_SIZE.drive);
      this.page = shown.page;
      cards = shown.rows.map((html) => html());
    }
    return `<div class="ch-drive-trail">${trail}</div>
      <div class="ch-drive-tools">${this.toolsHTML()}</div>
      <div class="ch-drive-grid">${cards.join('')}</div>
      <div class="ch-drive-pager"></div>`;
  }

  toolsHTML() {
    const l = this.listing, count = this.selected.size;
    const total = l.files.length + l.folders.length;
    const manage = this.status?.canUpload;
    const allLabel = count === total ? "Clear selection" : (this.listing.total > total ? "Select all on this page" : "Select all");
    if (!count) return `<button type="button" class="btn btn-secondary btn-sm" data-tool="all"><i data-lucide="check-square"></i> ${allLabel}</button>`;
    return `<b class="text-xs">${count} selected</b>
      <button type="button" class="btn btn-secondary btn-sm" data-tool="all"><i data-lucide="check-square"></i> ${allLabel}</button>
      <button type="button" class="btn btn-secondary btn-sm" data-tool="zip"><i data-lucide="download"></i> Download</button>
      ${manage ? `<button type="button" class="btn btn-secondary btn-sm" data-tool="move"><i data-lucide="folder-input"></i> Move</button>
      ${count === 1 ? '<button type="button" class="btn btn-secondary btn-sm" data-tool="rename"><i data-lucide="pencil"></i> Rename</button>' : ''}
      <button type="button" class="btn btn-danger btn-sm" data-tool="delete"><i data-lucide="trash-2"></i> Delete</button>` : ''}`;
  }

  checkHTML(key, name) {
    return `<label class="ch-drive-check" title="Select"><input type="checkbox" data-select="${key}" aria-label="Select ${name}" ${this.selected.has(key) ? 'checked' : ''} /></label>`;
  }

  folderCardHTML(f) {
    const key = `folder:${f.id}`, name = escapeHTML(f.name);
    return `<article class="ch-drive-card${this.selected.has(key) ? ' is-selected' : ''}" data-card="${key}">
      ${this.checkHTML(key, name)}
      <button type="button" class="ch-drive-thumb" data-drive-folder="${f.id}" aria-label="Open folder ${name}"><span class="ch-drive-icon ch-drive-folder"><i data-lucide="folder"></i></span></button>
      <div class="ch-drive-info">
        <button type="button" class="ch-drive-name" data-drive-folder="${f.id}" title="${name}"><b>${name}</b><em>Folder</em></button>
      </div>
    </article>`;
  }

  fileUrl(view, action, fileId) {
    return `${view.apiUrl}?action=${action}&id=${fileId}&token=${encodeURIComponent(view.token)}`;
  }

  fileCardHTML(f, i) {
    const kind = kindOf(f), key = `file:${f.id}`;
    const name = escapeHTML(f.name);
    const preview = kind === 'image' && this.view
      ? `<img data-thumb="${f.id}" src="${escapeHTML(this.fileUrl(this.view, 'thumb', f.id))}" alt="" loading="lazy" decoding="async" />`
      : this.fileIconHTML(f, kind);
    return `<article class="ch-drive-card${this.selected.has(key) ? ' is-selected' : ''}" data-card="${key}">
      ${this.checkHTML(key, name)}
      <button type="button" class="ch-drive-thumb" data-drive-open="${i}" aria-label="${kind ? 'Preview' : 'Download'} ${name}">${preview}</button>
      <div class="ch-drive-info">
        <button type="button" class="ch-drive-name" data-drive-open="${i}" title="${name}"><b>${name}</b><em>${sizeText(f.size)} · ${formatDate(f.at)}</em></button>
        <button type="button" class="ch-drive-dl" data-drive-file="${f.id}" aria-label="Download ${name}" title="Download"><i data-lucide="download"></i></button>
      </div>
    </article>`;
  }

  fileIconHTML(f, kind) {
    const ext = extOf(f.name);
    return `<span class="ch-drive-icon"><i data-lucide="${KIND_ICON[kind] || 'file'}"></i>${ext ? `<small>${escapeHTML(ext.slice(0, 5))}</small>` : ''}</span>`;
  }

  bind() {
    const el = this.el;
    const on = (name, handler) => el.querySelector(`[data-drive="${name}"]`)?.addEventListener('click', handler);
    const picked = (name, handler) => el.querySelector(`[data-drive="${name}"]`)?.addEventListener('change', (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (files.length) handler(files);
    });
    on('link', () => this.link());
    on('create', () => this.createAccount());
    on('unlink', () => this.unlink());
    on('account', () => this.editAccount());
    on('mkdir', () => this.newFolder());
    picked('upload', (files) => this.uploadAll(files.map((file) => ({ file, parts: [] }))));
    picked('upload-folder', (files) => this.uploadAll(files.map((file) => ({ file, parts: (file.webkitRelativePath || '').split('/').slice(0, -1) }))));
    picked('upload-zip', (files) => this.uploadAll(files.map((file) => ({ file, parts: [], extract: true }))));
    picked('logo', (files) => this.setLogo(files[0]));
    el.querySelectorAll('[data-drive-folder]').forEach((b) => b.addEventListener('click', () => {
      this.loadFolder(b.dataset.driveFolder ? Number(b.dataset.driveFolder) : null);
    }));
    el.querySelectorAll('[data-drive-file]').forEach((b) => b.addEventListener('click', () => this.download(Number(b.dataset.driveFile))));
    el.querySelectorAll('[data-drive-open]').forEach((b) => b.addEventListener('click', () => this.openFile(Number(b.dataset.driveOpen))));
    el.querySelectorAll('img[data-thumb]').forEach((img) => img.addEventListener('error', () => this.thumbFailed(img)));
    el.querySelectorAll('[data-select]').forEach((box) => box.addEventListener('change', () => {
      if (box.checked) this.selected.add(box.dataset.select);
      else this.selected.delete(box.dataset.select);
      box.closest('.ch-drive-card')?.classList.toggle('is-selected', box.checked);
      this.paintTools();
    }));
    this.bindTools();
    this.bindDrop();
    if (this.listing) {
      mountPager(el.querySelector('.ch-drive-pager'), {
        page: this.page || 1, total: this.listing.total ?? this.listing.files.length + this.listing.folders.length, size: PAGE_SIZE.drive,
        label: 'items', top: el,
        onPage: (n) => {
          this.page = n;
          if (this.listing.total == null) this.paint();
          else { this.selected.clear(); return this.loadFolder(this.folderId); }
        }
      });
    }
  }

  bindTools() {
    const tools = this.el.querySelector('.ch-drive-tools');
    if (!tools) return;
    const on = (name, handler) => tools.querySelector(`[data-tool="${name}"]`)?.addEventListener('click', handler);
    on('all', () => this.toggleAll());
    on('zip', () => this.downloadSelected());
    on('move', () => this.moveSelected());
    on('rename', () => this.renameSelected());
    on('delete', () => this.deleteSelected());
  }

  paintTools() {
    const tools = this.el?.querySelector('.ch-drive-tools');
    if (!tools || !this.listing) return;
    tools.innerHTML = this.toolsHTML();
    this.bindTools();
    window.lucide?.createIcons();
  }

  toggleAll() {
    const l = this.listing;
    const total = l.files.length + l.folders.length;
    if (this.selected.size === total) this.selected.clear();
    else {
      l.files.forEach((f) => this.selected.add(`file:${f.id}`));
      l.folders.forEach((f) => this.selected.add(`folder:${f.id}`));
    }
    this.el.querySelectorAll('[data-select]').forEach((box) => {
      box.checked = this.selected.has(box.dataset.select);
      box.closest('.ch-drive-card')?.classList.toggle('is-selected', box.checked);
    });
    this.paintTools();
  }

  selectedItems() {
    return [...this.selected].map((key) => {
      const [type, id] = key.split(':');
      return { type, id: Number(id) };
    });
  }

  bindDrop() {
    const section = this.el.querySelector('.ch-drive');
    const hint = this.el.querySelector('.ch-drive-drop');
    if (!section || !hint) return;
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    section.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; hint.hidden = false; } });
    section.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; hint.hidden = true; } });
    section.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    section.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      hint.hidden = true;
      // Entries must be read before the first await: the browser empties the drop right after this event.
      const entries = [...e.dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
      const items = [];
      try {
        for (const entry of entries) await readEntry(entry, [], items);
      } catch (err) {
        Toast.error(err.message, 'Could not read the dropped files');
        return;
      }
      if (items.length) this.uploadAll(items);
    });
  }

  /** The view token may have run out while scrolling a long folder: try once with a fresh one, then show an icon. */
  async thumbFailed(img) {
    const clientId = this.clientId, fileId = Number(img.dataset.thumb);
    // Drive builds a thumbnail the first time it is asked for, and a page of new images can overwhelm it for
    // a moment. So a failed thumbnail is asked for again, twice, after a pause that grows, before the icon stays.
    const tries = Number(img.dataset.retried || 0);
    if (tries < 2) {
      img.dataset.retried = String(tries + 1);
      try {
        const view = await this.token(clientId, 'view');
        await new Promise((resolve) => setTimeout(resolve, 1200 * (tries + 1) + Math.random() * 800));
        if (clientId !== this.clientId || !img.isConnected) return;
        this.view = view;
        img.src = `${this.fileUrl(view, 'thumb', fileId)}&retry=${tries + 1}`; // a new address, so the browser asks again
        return;
      } catch { /* falls through to the icon */ }
    }
    const file = this.listing?.files.find((f) => f.id === fileId);
    if (file && img.isConnected) {
      img.outerHTML = this.fileIconHTML(file, kindOf(file));
      window.lucide?.createIcons();
    }
  }

  openFile(index) {
    const file = this.listing?.files[index];
    if (!file) return;
    if (kindOf(file)) this.openPreview(this.listing.files, index);
    else this.download(file.id);
  }

  // ---------------------------------------------------------------- preview window
  openPreview(files, index) {
    this.closePreview();
    const box = document.createElement('div');
    box.className = 'drive-lb';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'File preview');
    box.tabIndex = -1;
    box.innerHTML = `
      <header class="drive-lb-bar">
        <div class="drive-lb-title"><b data-lb="name"></b><span data-lb="count"></span></div>
        <a class="drive-lb-btn" data-lb="tab" target="_blank" rel="noopener noreferrer" title="Open in a new tab" aria-label="Open in a new tab"><i data-lucide="external-link"></i></a>
        <button type="button" class="drive-lb-btn" data-lb="download" title="Download" aria-label="Download"><i data-lucide="download"></i></button>
        <button type="button" class="drive-lb-btn" data-lb="close" title="Close" aria-label="Close"><i data-lucide="x"></i></button>
      </header>
      <div class="drive-lb-body">
        <button type="button" class="drive-lb-nav" data-lb="prev" aria-label="Previous file"><i data-lucide="chevron-left"></i></button>
        <div class="drive-lb-stage" data-lb="stage"></div>
        <button type="button" class="drive-lb-nav" data-lb="next" aria-label="Next file"><i data-lucide="chevron-right"></i></button>
      </div>`;
    document.body.appendChild(box);

    const part = (name) => box.querySelector(`[data-lb="${name}"]`);
    const state = { box, files, index, clientId: this.clientId, returnFocus: document.activeElement, part };
    state.onKey = (e) => {
      if (e.key === 'Escape') this.closePreview();
      else if (e.key === 'ArrowLeft') this.stepPreview(-1);
      else if (e.key === 'ArrowRight') this.stepPreview(1);
    };
    state.onHash = () => this.closePreview();
    document.addEventListener('keydown', state.onKey);
    window.addEventListener('hashchange', state.onHash);
    this.lb = state;

    part('close').addEventListener('click', () => this.closePreview());
    part('download').addEventListener('click', () => this.download(state.files[state.index].id));
    part('prev').addEventListener('click', () => this.stepPreview(-1));
    part('next').addEventListener('click', () => this.stepPreview(1));
    box.querySelector('.drive-lb-body').addEventListener('click', (e) => {
      if (e.target.classList.contains('drive-lb-body') || e.target === part('stage')) this.closePreview();
    });
    const single = files.length < 2;
    part('prev').hidden = single;
    part('next').hidden = single;
    window.lucide?.createIcons();
    box.focus();
    this.showPreview();
  }

  stepPreview(delta) {
    const lb = this.lb;
    if (!lb || lb.files.length < 2) return;
    lb.index = (lb.index + delta + lb.files.length) % lb.files.length;
    this.showPreview();
  }

  stopMedia(stage) {
    stage.querySelectorAll('video, audio').forEach((m) => { m.pause(); m.removeAttribute('src'); m.load(); });
  }

  clearPreviewFont(lb) {
    if (lb.font) {
      document.fonts.delete(lb.font);
      lb.font = null;
    }
  }

  async showPreview() {
    const lb = this.lb;
    if (!lb) return;
    const file = lb.files[lb.index], kind = kindOf(file), stage = lb.part('stage');
    this.stopMedia(stage);
    this.clearPreviewFont(lb);
    lb.part('name').textContent = file.name;
    lb.part('count').textContent = `${lb.index + 1} of ${lb.files.length} · ${sizeText(file.size)}`;
    lb.part('tab').hidden = !OPENS_IN_TAB.has(kind);
    lb.part('tab').removeAttribute('href');
    stage.innerHTML = '<p class="drive-lb-note">Loading…</p>';

    const shown = lb.index;
    const current = () => this.lb === lb && lb.index === shown;
    const noPreview = (message) => {
      if (!current()) return;
      this.stopMedia(stage);
      stage.innerHTML = `<div class="drive-lb-none">${this.fileIconHTML(file, kind)}<p>${escapeHTML(message)}</p>
        <button type="button" class="btn btn-primary btn-sm" data-lb="fallback"><i data-lucide="download"></i> Download</button></div>`;
      stage.querySelector('[data-lb="fallback"]').addEventListener('click', () => this.download(file.id));
      window.lucide?.createIcons();
    };
    if (!kind) { noPreview('This file type can\'t be previewed.'); return; }

    let url;
    try {
      url = this.fileUrl(await this.token(lb.clientId, 'view'), 'view', file.id);
    } catch (err) {
      noPreview(err.message);
      return;
    }
    if (!current()) return; // moved on while waiting

    if (kind === 'text') { await this.showText(url, file, stage, current, noPreview); return; }
    if (kind === 'font') { await this.showFont(url, file, lb, stage, current, noPreview); return; }

    lb.part('tab').href = url;
    const safe = escapeHTML(url), label = escapeHTML(file.name);
    stage.innerHTML = {
      image: `<img src="${safe}" alt="${label}" />`,
      video: `<video src="${safe}" controls autoplay playsinline></video>`,
      audio: `<audio src="${safe}" controls autoplay></audio>`,
      pdf: `<iframe src="${safe}" title="${label}"></iframe>`
    }[kind];
    stage.querySelector('img, video, audio')?.addEventListener('error', () => noPreview('This file can\'t be previewed here. You can still download it.'));
  }

  /** Shown as plain text, never run: an uploaded web page can't do anything from here. */
  async showText(url, file, stage, current, noPreview) {
    if (file.size > TEXT_PREVIEW_BYTES) { noPreview('This file is too large to preview. You can still download it.'); return; }
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error();
      const text = await res.text();
      if (!current()) return;
      const pre = document.createElement('pre');
      pre.className = 'drive-lb-text';
      pre.textContent = text;
      stage.replaceChildren(pre);
    } catch {
      noPreview('This file can\'t be previewed here. You can still download it.');
    }
  }

  async showFont(url, file, lb, stage, current, noPreview) {
    if (file.size > FONT_PREVIEW_BYTES) { noPreview('This font is too large to preview. You can still download it.'); return; }
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error();
      const face = new FontFace(`drive-preview-${file.id}`, await res.arrayBuffer());
      await face.load();
      if (!current()) return;
      document.fonts.add(face);
      lb.font = face;
      const sample = document.createElement('div');
      sample.className = 'drive-lb-font';
      sample.style.fontFamily = `"${face.family}"`;
      sample.innerHTML = '<p class="big">Aa Bb Cc 123</p><p dir="auto" class="big">أبجد هوز ١٢٣</p><p>The quick brown fox jumps over the lazy dog</p><p dir="auto">نص تجريبي لمعاينة شكل هذا الخط</p>';
      stage.replaceChildren(sample);
    } catch {
      noPreview('This font can\'t be previewed here. You can still download it.');
    }
  }

  closePreview() {
    const lb = this.lb;
    if (!lb) return;
    this.lb = null;
    this.stopMedia(lb.part('stage'));
    this.clearPreviewFont(lb);
    document.removeEventListener('keydown', lb.onKey);
    window.removeEventListener('hashchange', lb.onHash);
    lb.box.remove();
    if (lb.returnFocus?.isConnected) lb.returnFocus.focus();
  }

  // ---------------------------------------------------------------- file actions
  async download(fileId) {
    try {
      const { token, apiUrl } = await Api.kiteDrive('token', { clientId: this.clientId, scope: 'download', fileId });
      window.open(`${apiUrl}?action=download&token=${encodeURIComponent(token)}`, '_blank', 'noopener');
    } catch (err) {
      Toast.error(err.message, 'Download failed');
    }
  }

  async downloadSelected() {
    const items = this.selectedItems();
    // One file downloads as itself; anything else becomes a ZIP.
    if (items.length === 1 && items[0].type === 'file') {
      this.download(items[0].id);
      return;
    }
    const clientId = this.clientId;
    try {
      Toast.success('Preparing your ZIP. Large selections can take a minute.', 'Download');
      const { zipId } = await this.postJson(clientId, 'view', 'zip_prepare', { items });
      const view = await this.token(clientId, 'view');
      const a = document.createElement('a');
      a.href = this.fileUrl(view, 'zip', zipId);
      a.download = 'Kite Drive files.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      Toast.error(err.message, 'Download failed');
    }
  }

  newFolder() {
    const clientId = this.clientId, parentId = this.folderId;
    formDialog({
      title: 'New folder',
      subtitle: 'The client will see this folder in their Kite Drive.',
      submitLabel: 'Create folder',
      fields: [{ name: 'name', label: 'Folder name', required: true, maxlength: 200 }],
      onSubmit: async (values) => {
        await this.postJson(clientId, 'write', 'mkdir', { name: values.name, parentId });
        Toast.success('Folder created');
        if (clientId === this.clientId) await this.loadFolder(this.folderId);
      }
    });
  }

  renameSelected() {
    const [item] = this.selectedItems();
    if (!item) return;
    const list = item.type === 'file' ? this.listing.files : this.listing.folders;
    const current = list.find((x) => x.id === item.id);
    if (!current) return;
    const clientId = this.clientId;
    formDialog({
      title: `Rename ${item.type}`,
      submitLabel: 'Rename',
      fields: [{ name: 'name', label: 'Name', required: true, maxlength: 200, value: current.name }],
      onSubmit: async (values) => {
        await this.postJson(clientId, 'write', 'rename', { ...item, name: values.name });
        Toast.success('Renamed');
        if (clientId === this.clientId) await this.loadFolder(this.folderId);
      }
    });
  }

  async moveSelected() {
    const clientId = this.clientId, items = this.selectedItems();
    let folders;
    try {
      ({ folders } = await this.call(clientId, 'read', 'action=tree'));
    } catch (err) {
      Toast.error(err.message, 'Could not load folders');
      return;
    }
    // A folder can't go inside itself, so hide the ones being moved and everything in them.
    const hidden = new Set(items.filter((i) => i.type === 'folder').map((i) => i.id));
    const options = [{ value: 'root', label: 'All files (top level)' }];
    const walk = (parentId, depth) => {
      folders.filter((f) => f.parentId === parentId && !hidden.has(f.id)).forEach((f) => {
        options.push({ value: String(f.id), label: `${'   '.repeat(depth + 1)}${f.name}` });
        walk(f.id, depth + 1);
      });
    };
    walk(null, 0);
    formDialog({
      title: `Move ${items.length} item${items.length === 1 ? '' : 's'}`,
      submitLabel: 'Move here',
      fields: [{ name: 'target', label: 'Move to', type: 'select', required: true, options, value: 'root' }],
      onSubmit: async (values) => {
        await this.postJson(clientId, 'write', 'move', { items, targetId: values.target === 'root' ? null : Number(values.target) });
        Toast.success('Moved');
        this.selected.clear();
        if (clientId === this.clientId) await this.loadFolder(this.folderId);
      }
    });
  }

  async deleteSelected() {
    const clientId = this.clientId, items = this.selectedItems();
    const folders = items.filter((i) => i.type === 'folder').length;
    const ok = await confirmDialog({
      title: `Delete ${items.length} item${items.length === 1 ? '' : 's'}?`,
      message: `${folders ? 'Everything inside the selected folders goes too. ' : ''}This permanently removes them from Kite Drive, including for the client, and can't be undone.`,
      confirmLabel: 'Delete permanently', danger: true
    });
    if (!ok) return;
    try {
      const res = await this.postJson(clientId, 'write', 'delete', { items });
      Toast.success(`${res.files} file${res.files === 1 ? '' : 's'} deleted`, 'Deleted');
      this.selected.clear();
      if (clientId === this.clientId) await this.loadFolder(this.folderId);
    } catch (err) {
      Toast.error(err.message, 'Could not delete');
    }
  }

  async setLogo(file) {
    const clientId = this.clientId;
    try {
      await this.call(clientId, 'write', 'action=logo_set', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      Toast.success('Logo updated');
      if (clientId === this.clientId) await this.loadFolder(this.folderId);
    } catch (err) {
      Toast.error(err.message, 'Could not update the logo');
    }
  }

  // ---------------------------------------------------------------- linking
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
      Toast.error('Every Kite Drive account is already linked. Create a new one instead.', 'Nothing to link');
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

  createAccount() {
    const clientId = this.clientId;
    formDialog({
      title: 'Create a Kite Drive account',
      subtitle: 'The client logs in to Kite Drive with this email and password. Send them the password yourself: nothing is emailed.',
      submitLabel: 'Create and link',
      fields: [
        { name: 'name', label: 'Name shown in Drive', required: true, maxlength: 120 },
        { name: 'email', label: 'Login email', type: 'email', required: true, maxlength: 254 },
        { name: 'password', label: 'Password', type: 'password', required: true, minlength: 8, maxlength: 128, hint: 'At least 8 characters.' }
      ],
      onSubmit: async (values) => {
        await Api.kiteDrive('link.create', { clientId, name: values.name, email: values.email, password: values.password });
        Toast.success('Drive account created and linked');
        this.folderId = null;
        this.listing = null;
        await this.load();
      }
    });
  }

  /** The client's login to Kite Drive: see the email, change it, or set a new password. */
  async editAccount() {
    const clientId = this.clientId;
    let account;
    try {
      account = await Api.kiteDrive('link.account', { clientId });
    } catch (err) {
      Toast.error(err.message, 'Could not open the login details');
      return;
    }
    const site = this.status?.driveUrl;
    formDialog({
      title: 'Kite Drive login',
      subtitle: `${site ? `The client logs in at ${site}. ` : ''}A password can be set but never shown, because Drive keeps only a scrambled copy. Leave it empty to keep the current one. Send the client their new details yourself: nothing is emailed.`,
      submitLabel: 'Save login',
      fields: [
        { name: 'name', label: 'Name shown in Drive', value: account.name || '', maxlength: 120 },
        { name: 'email', label: 'Login email', type: 'email', value: account.email || '', required: true, maxlength: 254 },
        { name: 'password', label: 'New password', type: 'password', minlength: 8, maxlength: 128, hint: 'At least 8 characters. Empty means no change.' }
      ],
      onSubmit: async (values) => {
        const changes = {};
        if (values.name && values.name !== account.name) changes.name = values.name;
        if (values.email && values.email.toLowerCase() !== String(account.email).toLowerCase()) changes.email = values.email;
        if (values.password) changes.password = values.password;
        if (!Object.keys(changes).length) throw new Error('Nothing changed');
        const saved = await Api.kiteDrive('link.update', { clientId, ...changes });
        Toast.success(saved.changed?.includes('password') ? 'Login saved. Share the new password with the client.' : 'Login saved');
        if (clientId === this.clientId) { this.status = { ...this.status, driveName: saved.name || this.status.driveName }; this.paint(); }
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

  // ---------------------------------------------------------------- uploads
  /** items: [{ file, parts: ["A", "B"], extract }]. Folders in `parts` are created under the current folder. */
  async uploadAll(items) {
    // Keep the client and folder chosen now, even if someone browses elsewhere during a long upload.
    const clientId = this.clientId, folderId = this.folderId;
    const folderIds = new Map();
    const entries = items.map((item) => ({
      id: crypto.randomUUID(), file: item.file, parts: item.parts || [], extract: Boolean(item.extract),
      name: [...(item.parts || []), item.file.name].join('/'), done: 0, total: item.file.size, failed: null
    }));
    this.uploads.push(...entries);
    this.paint();
    let ok = 0;
    for (const entry of entries) {
      try {
        const key = entry.parts.join('/');
        if (entry.parts.length && !folderIds.has(key)) {
          const { id } = await this.postJson(clientId, 'write', 'ensure_path', { parentId: folderId, parts: entry.parts });
          folderIds.set(key, id);
        }
        const result = await this.uploadOne(clientId, entry.parts.length ? folderIds.get(key) : folderId, entry);
        ok++;
        this.uploads = this.uploads.filter((u) => u !== entry);
        if (result.skippedCount) {
          Toast.error(`${result.skippedCount} file${result.skippedCount === 1 ? ' was' : 's were'} skipped from ${entry.file.name}, such as ${result.skipped[0]}.`, 'Some files not unpacked');
        }
      } catch (err) {
        entry.failed = err.message;
        Toast.error(`${entry.name}: ${err.message}`, 'Upload failed');
      }
      this.paint();
    }
    if (ok) {
      Toast.success(`${ok} upload${ok === 1 ? '' : 's'} sent to Kite Drive`, 'Uploaded');
      if (clientId === this.clientId && folderId === this.folderId) await this.loadFolder(folderId);
    }
  }

  async uploadOne(clientId, folderId, entry) {
    const { file } = entry;
    if (!file.size) throw new Error('This file is empty');
    const { uploadId, chunkSize } = await this.postJson(clientId, 'write', 'upload_init', { name: file.name, size: file.size, folderId });

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
    return this.postJson(clientId, 'write', 'upload_complete', { uploadId, extract: entry.extract });
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
