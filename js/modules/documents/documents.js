/**
 * KITE SYSTEM — Module K: Digital Asset Vault
 * Studio-wide asset library (logos, guidelines, footage, contracts…) plus task deliverables.
 * Multi-file + drag & drop upload, folders, visibility (studio / department / private),
 * image previews, rename / move / delete, and live updates for everyone.
 */

import { getSupabase } from '../../supabase-client.js';
import { Toast } from '../../services/toast-service.js';
import { Realtime } from '../../services/realtime-service.js';
import { Api } from '../../services/api.js';
import { Permissions } from '../../permissions/permission-service.js';
import { formDialog, confirmDialog, htmlDialog, closeDialog } from '../../ui/dialogs.js';
import { escapeHTML, formatDate } from '../../utils/helpers.js';
import { CONFIG } from '../../config.js';

const DEFAULT_FOLDERS = ['General', 'Branding', 'Logos', 'Social Media', 'Video & Motion', 'Print & BTL', 'Web', 'Client Files', 'Contracts', 'Guidelines'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'];
const TYPE_GROUPS = {
  image: IMAGE_EXT,
  video: ['mp4', 'mov', 'webm'],
  audio: ['mp3', 'wav'],
  design: ['psd', 'ai', 'eps', 'indd', 'fig', 'sketch', 'xd'],
  doc: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv'],
  archive: ['zip', 'rar']
};
const TYPE_LABEL = { image: 'Images', video: 'Video', audio: 'Audio', design: 'Design files', doc: 'Documents', archive: 'Archives', other: 'Other' };
const TYPE_ICON = { image: 'image', video: 'film', audio: 'music', design: 'pen-tool', doc: 'file-text', archive: 'archive', other: 'file' };
const MB = 1048576;

const extOf = (name = '') => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const groupOf = (name) => {
  const e = extOf(name);
  return Object.keys(TYPE_GROUPS).find(g => TYPE_GROUPS[g].includes(e)) || 'other';
};
const sizeLabel = (bytes) => (bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export class DocumentsModule {
  constructor(app) {
    this.app = app;
    this.assets = [];        // unified list: studio assets + task deliverables
    this.projects = [];
    this.departments = [];
    this.thumbs = {};        // storage_path -> signed url (images)
    this.filters = { q: '', folder: 'ALL', type: 'ALL', source: 'ALL' };
    this.pending = [];       // files chosen in the upload dialog
  }

  async render(container) {
    container.innerHTML = `
      <div class="page-container animate-fade-in" id="vaultRoot">
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-4);">
          <div>
            <h1 class="font-display font-bold text-xl text-white">Digital Assets & Documents Vault</h1>
            <p class="text-xs text-muted" style="margin-top: 2px;">
              Upload and share logos, brand guidelines, footage, contracts and client deliverables. Drop files anywhere on this page.
            </p>
          </div>
          <button type="button" class="btn btn-primary btn-sm" id="btnUploadDoc">
            <i data-lucide="upload-cloud"></i> Upload Assets
          </button>
        </div>

        <div class="glass-panel" style="padding: var(--space-3); display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3);">
          <div style="position: relative; min-width: 220px; flex: 1;">
            <input type="text" id="vaultSearch" placeholder="Search files, folders, uploaders..." class="form-control" style="height: 36px; padding-left: 32px;" />
            <i data-lucide="search" style="position: absolute; left: 10px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; color: var(--text-dim);"></i>
          </div>
          <select id="vaultFolder" class="form-control" style="width: auto; height: 36px;"><option value="ALL">All folders</option></select>
          <select id="vaultType" class="form-control" style="width: auto; height: 36px;">
            <option value="ALL">All types</option>
            ${Object.keys(TYPE_LABEL).map(k => `<option value="${k}">${TYPE_LABEL[k]}</option>`).join('')}
          </select>
          <select id="vaultSource" class="form-control" style="width: auto; height: 36px;">
            <option value="ALL">Assets & task files</option>
            <option value="asset">Studio assets only</option>
            <option value="task">Task deliverables only</option>
          </select>
        </div>

        <div id="vaultDrop" style="display: none; border: 2px dashed var(--kite-red-500); border-radius: var(--radius-lg); padding: var(--space-6); text-align: center; background: var(--tint-red-soft); font-weight: 700;">
          Drop files to upload
        </div>

        <div id="docsGrid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: var(--space-4);">
          <div class="empty-state" style="border:none; padding: 40px 0; grid-column: 1 / -1;">
            <div class="empty-state-icon animate-spin">⟳</div>
            <div class="empty-state-title">Loading vault files...</div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('btnUploadDoc')?.addEventListener('click', () => this.openUploadModal());
    document.getElementById('vaultSearch')?.addEventListener('input', (e) => { this.filters.q = e.target.value.toLowerCase(); this.renderDocs(); });
    document.getElementById('vaultFolder')?.addEventListener('change', (e) => { this.filters.folder = e.target.value; this.renderDocs(); });
    document.getElementById('vaultType')?.addEventListener('change', (e) => { this.filters.type = e.target.value; this.renderDocs(); });
    document.getElementById('vaultSource')?.addEventListener('change', (e) => { this.filters.source = e.target.value; this.renderDocs(); });
    this.bindDragAndDrop(document.getElementById('vaultRoot'));

    await this.loadDocuments();
    // everyone sees new uploads / deletions / edits as they happen
    Realtime.watch(['assets', 'task_attachments'], () => this.loadDocuments());
  }

  // ------------------------------------------------------------ data

  async loadDocuments() {
    const supabase = getSupabase();
    if (!supabase) return;

    try {
      const [assetsRes, taskRes] = await Promise.all([
        supabase.from('assets')
          .select('*, uploader:profiles!assets_uploaded_by_fkey(full_name), project:projects(name, code), department:departments(name)')
          .order('created_at', { ascending: false }),
        supabase.from('task_attachments')
          .select('*, uploader:profiles!task_attachments_uploaded_by_fkey(full_name), task:tasks(title, task_number)')
          .order('created_at', { ascending: false })
      ]);

      const studio = (assetsRes.data || []).map(a => ({
        ...a, source: 'asset', bucket: CONFIG.STORAGE_BUCKETS.STUDIO_ASSETS, displayName: a.name || a.file_name
      }));
      const task = (taskRes.data || []).map(t => ({
        ...t, source: 'task', bucket: CONFIG.STORAGE_BUCKETS.TASK_ATTACHMENTS, displayName: t.file_name,
        folder: t.task?.task_number ? `Task ${t.task.task_number}` : 'Task deliverables', visibility: 'task'
      }));
      this.assets = [...studio, ...task].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      this.refreshFolderFilter();
      await this.loadThumbs();
      this.renderDocs();
    } catch (err) {
      console.warn('Docs error:', err);
      this.renderDocs();
    }
  }

  /** Short-lived signed URLs for image thumbnails (batched per bucket). */
  async loadThumbs() {
    const supabase = getSupabase();
    const wanted = this.assets.filter(a => IMAGE_EXT.includes(extOf(a.file_name)) && !this.thumbs[a.storage_path] && a.file_size < 8 * MB);
    for (const bucket of [CONFIG.STORAGE_BUCKETS.STUDIO_ASSETS, CONFIG.STORAGE_BUCKETS.TASK_ATTACHMENTS]) {
      const paths = wanted.filter(a => a.bucket === bucket).slice(0, 60).map(a => a.storage_path);
      if (!paths.length) continue;
      const { data } = await supabase.storage.from(bucket).createSignedUrls(paths, 3600);
      (data || []).forEach(r => { if (r.signedUrl && r.path) this.thumbs[r.path] = r.signedUrl; });
    }
  }

  refreshFolderFilter() {
    const select = document.getElementById('vaultFolder');
    if (!select) return;
    const folders = [...new Set(this.assets.map(a => a.folder).filter(Boolean))].sort();
    select.innerHTML = '<option value="ALL">All folders</option>' +
      folders.map(f => `<option value="${escapeHTML(f)}" ${f === this.filters.folder ? 'selected' : ''}>${escapeHTML(f)}</option>`).join('');
    if (!folders.includes(this.filters.folder)) this.filters.folder = 'ALL';
  }

  filtered() {
    const { q, folder, type, source } = this.filters;
    return this.assets.filter(a => {
      if (source !== 'ALL' && a.source !== source) return false;
      if (folder !== 'ALL' && a.folder !== folder) return false;
      if (type !== 'ALL' && groupOf(a.file_name) !== type) return false;
      if (q) {
        const hay = `${a.displayName} ${a.file_name} ${a.folder || ''} ${a.description || ''} ${a.uploader?.full_name || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  // ------------------------------------------------------------ display

  renderDocs() {
    const container = document.getElementById('docsGrid');
    if (!container) return;

    const list = this.filtered();
    if (list.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <div class="empty-state-icon">🗂️</div>
          <div class="empty-state-title">${this.assets.length ? 'No files match your filters' : 'No assets uploaded yet'}</div>
          <div class="empty-state-desc">${this.assets.length ? 'Try clearing the search or filters.' : 'Click “Upload Assets” or drag files onto this page.'}</div>
        </div>`;
      return;
    }

    const me = this.app.currentUser.id;
    const isAdmin = Permissions.isAdmin();

    container.innerHTML = list.map(a => {
      const group = groupOf(a.file_name);
      const thumb = this.thumbs[a.storage_path];
      const canManage = a.uploaded_by === me || isAdmin;
      const visBadge = a.source === 'task' ? 'Task file'
        : a.visibility === 'private' ? '🔒 Only me'
        : a.visibility === 'department' ? `🏢 ${escapeHTML(a.department?.name || 'Department')}` : '🌐 Studio';
      const key = `${a.source}:${a.id}`;

      return `
        <div class="card entity-card" style="padding: 0; display: flex; flex-direction: column; overflow: hidden;">
          <div class="asset-preview" data-key="${key}" style="height: 130px; background: var(--studio-950); display: flex; align-items: center; justify-content: center; cursor: ${group === 'image' ? 'zoom-in' : 'default'}; position: relative;">
            ${thumb
              ? `<img src="${escapeHTML(thumb)}" alt="" loading="lazy" style="width: 100%; height: 100%; object-fit: cover;" />`
              : `<i data-lucide="${TYPE_ICON[group]}" style="width: 38px; height: 38px; color: var(--text-dim);"></i>`}
            <span class="badge badge-slate font-mono" style="position: absolute; top: 8px; left: 8px;">${escapeHTML(extOf(a.file_name).toUpperCase() || 'FILE')}</span>
            ${canManage && a.source === 'asset' ? `<span class="card-actions" style="position: absolute; top: 6px; right: 6px; margin: 0;">
              <button type="button" class="card-act asset-edit" data-key="${key}" title="Edit details" aria-label="Edit details"><i data-lucide="pencil"></i></button>
              <button type="button" class="card-act card-act-delete asset-delete" data-key="${key}" title="Delete file" aria-label="Delete file"><i data-lucide="trash-2"></i></button>
            </span>` : ''}
            ${canManage && a.source === 'task' ? `<span class="card-actions" style="position: absolute; top: 6px; right: 6px; margin: 0;">
              <button type="button" class="card-act card-act-delete asset-delete" data-key="${key}" title="Delete file" aria-label="Delete file"><i data-lucide="trash-2"></i></button>
            </span>` : ''}
          </div>

          <div style="padding: var(--space-3); display: flex; flex-direction: column; gap: 6px; flex: 1;">
            <h3 class="font-display font-bold text-xs text-white truncate" title="${escapeHTML(a.displayName)}">${escapeHTML(a.displayName)}</h3>
            <div style="display: flex; flex-wrap: wrap; gap: 4px;">
              <span class="badge badge-indigo text-2xs">${escapeHTML(a.folder || 'General')}</span>
              <span class="badge badge-slate text-2xs">${visBadge}</span>
              <span class="badge badge-slate font-mono text-2xs">${sizeLabel(a.file_size)}</span>
            </div>
            ${a.description ? `<p class="text-2xs text-muted line-clamp-2">${escapeHTML(a.description)}</p>` : ''}
            ${a.project ? `<div class="text-2xs text-muted">Project: <strong>${escapeHTML(a.project.name)}</strong></div>` : ''}
            ${a.task ? `<div class="text-2xs text-muted">Task: <strong>${escapeHTML(a.task.task_number)}</strong> ${escapeHTML(a.task.title || '')}</div>` : ''}
            <div style="margin-top: auto; padding-top: var(--space-2); border-top: 1px solid var(--border-subtle); font-size: var(--text-2xs); color: var(--text-dim); display: flex; justify-content: space-between; gap: 6px;">
              <span class="truncate">👤 ${escapeHTML(a.uploader?.full_name || 'Specialist')}</span>
              <span class="font-mono">${formatDate(a.created_at)}</span>
            </div>
            <button type="button" class="btn btn-secondary btn-sm asset-download" data-key="${key}" style="width: 100%;">
              <i data-lucide="download"></i> Download
            </button>
          </div>
        </div>`;
    }).join('');

    const find = (key) => this.assets.find(a => `${a.source}:${a.id}` === key);
    container.querySelectorAll('.asset-download').forEach(b => b.addEventListener('click', () => this.download(find(b.dataset.key))));
    container.querySelectorAll('.asset-edit').forEach(b => b.addEventListener('click', () => this.editAsset(find(b.dataset.key))));
    container.querySelectorAll('.asset-delete').forEach(b => b.addEventListener('click', () => this.deleteAsset(find(b.dataset.key))));
    container.querySelectorAll('.asset-preview').forEach(el => el.addEventListener('click', () => {
      const a = find(el.dataset.key);
      if (a && IMAGE_EXT.includes(extOf(a.file_name))) this.preview(a);
    }));
    if (window.lucide) window.lucide.createIcons();
  }

  async signedUrl(asset, opts) {
    const { data, error } = await getSupabase().storage.from(asset.bucket).createSignedUrl(asset.storage_path, 120, opts);
    if (error || !data?.signedUrl) throw new Error('You do not have access to this file, or it no longer exists.');
    return data.signedUrl;
  }

  async download(asset) {
    if (!asset) return;
    try {
      const url = await this.signedUrl(asset, { download: asset.file_name });
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      Toast.error(err.message, 'Download Failed');
    }
  }

  async preview(asset) {
    try {
      const url = await this.signedUrl(asset);
      htmlDialog({
        title: asset.displayName,
        maxWidth: '900px',
        html: `<div style="text-align: center; background: var(--studio-950); border-radius: var(--radius-md); padding: var(--space-3);">
                 <img src="${escapeHTML(url)}" alt="${escapeHTML(asset.displayName)}" style="max-width: 100%; max-height: 70vh; object-fit: contain;" />
               </div>`
      });
    } catch (err) {
      Toast.error(err.message, 'Preview Failed');
    }
  }

  // ------------------------------------------------------------ manage

  editAsset(asset) {
    if (!asset) return;
    const folders = [...new Set([...DEFAULT_FOLDERS, ...this.assets.filter(a => a.source === 'asset').map(a => a.folder)])];
    formDialog({
      title: 'Edit file details',
      subtitle: asset.file_name,
      fields: [
        { name: 'name', label: 'Display name', required: true, value: asset.name || asset.file_name, maxlength: 150 },
        { name: 'folder', label: 'Folder', type: 'select', half: true, value: asset.folder, options: folders.map(f => ({ value: f, label: f })) },
        { name: 'visibility', label: 'Who can see it', type: 'select', half: true, value: asset.visibility, options: [
          { value: 'studio', label: 'Whole studio' }, { value: 'department', label: 'One department' }, { value: 'private', label: 'Only me (and admins)' }] },
        { name: 'description', label: 'Description', type: 'textarea', rows: 3, value: asset.description || '', maxlength: 500 }
      ],
      onSubmit: async (v) => {
        const patch = { name: v.name, folder: v.folder, visibility: v.visibility, description: v.description };
        if (v.visibility === 'department' && !asset.department_id) {
          patch.department_id = this.app.currentProfile?.department_id || null;
          if (!patch.department_id) throw new Error('Pick the department when uploading, or choose another visibility.');
        }
        const { error } = await getSupabase().from('assets').update(patch).eq('id', asset.id);
        if (error) throw error;
        Toast.success('Details saved', 'Saved');
        await this.loadDocuments();
      }
    });
  }

  async deleteAsset(asset) {
    if (!asset) return;
    const ok = await confirmDialog({ title: 'Delete this file?', message: `"${asset.displayName}" will be permanently removed for everyone.`, confirmLabel: 'Delete file', danger: true });
    if (!ok) return;
    const supabase = getSupabase();
    try {
      const table = asset.source === 'asset' ? 'assets' : 'task_attachments';
      const { data, error } = await supabase.from(table).delete().eq('id', asset.id).select('id');
      if (error || !data?.length) throw new Error(error?.message || 'You are not allowed to delete this file.');
      await supabase.storage.from(asset.bucket).remove([asset.storage_path]);
      delete this.thumbs[asset.storage_path];
      Toast.success('File deleted', 'Deleted');
      await this.loadDocuments();
    } catch (err) {
      Toast.error(err.message, 'Delete Failed');
    }
  }

  // ------------------------------------------------------------ upload

  /** Show the drop overlay while files are dragged over the page; open the upload dialog on drop. */
  bindDragAndDrop(root) {
    if (!root) return;
    const zone = document.getElementById('vaultDrop');
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    root.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; zone.style.display = 'block'; });
    root.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    root.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) zone.style.display = 'none'; });
    root.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      zone.style.display = 'none';
      this.openUploadModal([...e.dataTransfer.files]);
    });
  }

  validateFile(file, maxBytes) {
    const ext = extOf(file.name);
    if (!CONFIG.ALLOWED_FILE_EXTENSIONS.includes(ext)) return `“${file.name}”: .${ext || '?'} files are not allowed`;
    if (!file.size) return `“${file.name}” is empty`;
    if (file.size > maxBytes) return `“${file.name}” is larger than ${Math.round(maxBytes / MB)} MB`;
    return null;
  }

  async openUploadModal(initialFiles = []) {
    const modalBackdrop = document.getElementById('globalModalBackdrop');
    const modalDialog = document.getElementById('globalModalDialog');
    if (!modalBackdrop || !modalDialog) return;
    const supabase = getSupabase();

    const [{ data: projectRows }, { data: deptRows }, { data: taskRows }] = await Promise.all([
      supabase.from('projects').select('id, name, code').order('name'),
      supabase.from('departments').select('id, name').order('name'),
      supabase.from('tasks').select('id, task_number, title').not('status', 'in', '("cancelled")').order('created_at', { ascending: false }).limit(100)
    ]);
    this.projects = projectRows || [];
    this.departments = deptRows || [];
    const tasks = taskRows || [];
    const folders = [...new Set([...DEFAULT_FOLDERS, ...this.assets.filter(a => a.source === 'asset').map(a => a.folder)])];
    const myDept = this.app.currentProfile?.department_id || '';

    this.pending = [];
    modalDialog.style.maxWidth = '560px';
    modalDialog.innerHTML = `
      <div class="modal-header">
        <h2 class="modal-title font-display">Upload Assets</h2>
        <button type="button" class="modal-close-btn" id="btnCancelUpload">&times;</button>
      </div>

      <form id="uploadDocForm">
        <div class="modal-body" style="display: flex; flex-direction: column; gap: var(--space-3);">
          <label id="uploadDropZone" style="display: block; border: 2px dashed var(--border-strong, var(--border-subtle)); border-radius: var(--radius-md); padding: var(--space-5); text-align: center; cursor: pointer; background: var(--studio-950);">
            <i data-lucide="upload-cloud" style="width: 28px; height: 28px; color: var(--kite-red-600);"></i>
            <div class="font-bold text-sm" style="margin-top: 6px;">Drop files here or click to browse</div>
            <div class="text-2xs text-dim" style="margin-top: 4px;">Up to ${Math.round(CONFIG.MAX_FILE_SIZE_BYTES / MB)} MB each · ${CONFIG.ALLOWED_FILE_EXTENSIONS.join(', ')}</div>
            <input id="assetFile" type="file" multiple style="display: none;" />
          </label>
          <div id="uploadFileList" style="display: flex; flex-direction: column; gap: 4px; max-height: 140px; overflow-y: auto;"></div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
            <div class="form-group">
              <label class="form-label" for="assetFolder">Folder</label>
              <input id="assetFolder" list="assetFolderList" class="form-control" value="General" maxlength="60" />
              <datalist id="assetFolderList">${folders.map(f => `<option value="${escapeHTML(f)}"></option>`).join('')}</datalist>
            </div>
            <div class="form-group">
              <label class="form-label" for="assetVisibility">Who can see it</label>
              <select id="assetVisibility" class="form-control">
                <option value="studio">Whole studio</option>
                <option value="department">One department</option>
                <option value="private">Only me (and admins)</option>
              </select>
            </div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
            <div class="form-group" id="assetDeptWrap" style="display: none;">
              <label class="form-label" for="assetDept">Department</label>
              <select id="assetDept" class="form-control">
                ${this.departments.map(d => `<option value="${d.id}" ${d.id === myDept ? 'selected' : ''}>${escapeHTML(d.name)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="assetProject">Project (optional)</label>
              <select id="assetProject" class="form-control">
                <option value="">No project</option>
                ${this.projects.map(p => `<option value="${p.id}">${escapeHTML(p.name)}</option>`).join('')}
              </select>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="assetDesc">Description (optional)</label>
            <input id="assetDesc" class="form-control" maxlength="500" placeholder="What is this file for?" />
          </div>

          <div class="form-group">
            <label class="form-label" for="assetTask">Attach to a task deliverable (optional)</label>
            <select id="assetTask" class="form-control">
              <option value="">No — keep in the studio library</option>
              ${tasks.map(t => `<option value="${escapeHTML(t.id)}">${escapeHTML(t.task_number)} — ${escapeHTML(t.title)}</option>`).join('')}
            </select>
            <p class="text-2xs text-dim" style="margin-top: 4px;">Task files follow the task's visibility and are limited to ${Math.round(CONFIG.MAX_TASK_FILE_SIZE_BYTES / MB)} MB.</p>
          </div>

          <div id="uploadProgress" class="text-2xs text-muted" style="display: none;"></div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary btn-sm" id="btnCancelUploadAction">Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm" id="btnDoUpload">Upload to Vault</button>
        </div>
      </form>
    `;
    modalBackdrop.classList.add('active');
    if (window.lucide) window.lucide.createIcons();

    const fileInput = document.getElementById('assetFile');
    const dropZone = document.getElementById('uploadDropZone');
    const listEl = document.getElementById('uploadFileList');
    const visibility = document.getElementById('assetVisibility');

    const addFiles = (files) => {
      for (const f of files) {
        if (!this.pending.some(p => p.name === f.name && p.size === f.size)) this.pending.push(f);
      }
      renderList();
    };
    const renderList = () => {
      listEl.innerHTML = this.pending.map((f, i) => `
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: var(--text-xs); padding: 4px 8px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);">
          <span class="truncate">${escapeHTML(f.name)} <span class="text-dim">· ${sizeLabel(f.size)}</span></span>
          <button type="button" data-rm="${i}" class="text-muted" aria-label="Remove">&times;</button>
        </div>`).join('');
      listEl.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => { this.pending.splice(Number(b.dataset.rm), 1); renderList(); }));
    };

    fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dropZone.style.borderColor = 'var(--kite-red-500)'; }));
    ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dropZone.style.borderColor = ''; }));
    dropZone.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));
    visibility.addEventListener('change', () => { document.getElementById('assetDeptWrap').style.display = visibility.value === 'department' ? '' : 'none'; });
    document.getElementById('btnCancelUpload')?.addEventListener('click', closeDialog);
    document.getElementById('btnCancelUploadAction')?.addEventListener('click', closeDialog);

    if (initialFiles.length) addFiles(initialFiles);

    document.getElementById('uploadDocForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!this.pending.length) { Toast.warning('Choose at least one file first.', 'No files'); return; }

      const taskId = document.getElementById('assetTask').value || null;
      const maxBytes = taskId ? CONFIG.MAX_TASK_FILE_SIZE_BYTES : CONFIG.MAX_FILE_SIZE_BYTES;
      const problems = this.pending.map(f => this.validateFile(f, maxBytes)).filter(Boolean);
      if (problems.length) { Toast.error(problems[0] + (problems.length > 1 ? ` (+${problems.length - 1} more)` : ''), 'Upload Rejected'); return; }

      const meta = {
        folder: (document.getElementById('assetFolder').value.trim() || 'General').slice(0, 60),
        visibility: visibility.value,
        department_id: visibility.value === 'department' ? (document.getElementById('assetDept').value || null) : null,
        project_id: document.getElementById('assetProject').value || null,
        description: document.getElementById('assetDesc').value.trim() || null
      };
      if (meta.visibility === 'department' && !meta.department_id) { Toast.error('Choose a department.', 'Missing department'); return; }

      const btn = document.getElementById('btnDoUpload');
      const progress = document.getElementById('uploadProgress');
      btn.disabled = true;
      progress.style.display = 'block';

      let done = 0;
      const failed = [];
      for (const file of this.pending) {
        progress.textContent = `Uploading ${done + 1} of ${this.pending.length}: ${file.name}…`;
        try {
          await this.uploadOne(file, meta, taskId);
          done++;
        } catch (err) {
          console.error('Upload error:', err);
          failed.push(`${file.name}: ${err.message || 'failed'}`);
        }
      }

      if (done) Toast.success(`${done} file${done === 1 ? '' : 's'} uploaded`, 'Uploaded');
      if (failed.length) {
        Toast.error(failed[0] + (failed.length > 1 ? ` (+${failed.length - 1} more)` : ''), 'Upload Failed');
        this.pending = this.pending.filter(f => failed.some(m => m.startsWith(f.name + ':')));
        progress.textContent = `${failed.length} file(s) failed — fix the problem and press Upload again.`;
        btn.disabled = false;
        renderList();
      } else {
        closeDialog();
      }
      await this.loadDocuments();
    });
  }

  async uploadOne(file, meta, taskId) {
    const supabase = getSupabase();
    const me = this.app.currentUser.id;
    const safeName = file.name.replace(/[^\w.\-]+/g, '_').slice(-120);
    const contentType = file.type || 'application/octet-stream';

    if (taskId) {
      const bucket = CONFIG.STORAGE_BUCKETS.TASK_ATTACHMENTS;
      const path = `${taskId}/${crypto.randomUUID()}-${safeName}`;
      const { error: upErr } = await supabase.storage.from(bucket).upload(path, file, { upsert: false, contentType });
      if (upErr) throw upErr;
      const { error: rowErr } = await supabase.from('task_attachments').insert({
        task_id: taskId, file_name: file.name, file_size: file.size,
        file_type: file.type || extOf(file.name).toUpperCase(), storage_path: path, uploaded_by: me
      });
      if (rowErr) { await supabase.storage.from(bucket).remove([path]); throw rowErr; }
      Api.taskFileAdded(taskId, file.name).catch(() => {});
      return;
    }

    const bucket = CONFIG.STORAGE_BUCKETS.STUDIO_ASSETS;
    const path = `${me}/${crypto.randomUUID()}-${safeName}`;
    const { error: upErr } = await supabase.storage.from(bucket).upload(path, file, { upsert: false, contentType });
    if (upErr) throw upErr;
    const { error: rowErr } = await supabase.from('assets').insert({
      name: file.name, file_name: file.name, file_size: file.size,
      file_type: file.type || extOf(file.name).toUpperCase(), storage_path: path, uploaded_by: me, ...meta
    });
    if (rowErr) { await supabase.storage.from(bucket).remove([path]); throw rowErr; } // no orphans
  }
}
