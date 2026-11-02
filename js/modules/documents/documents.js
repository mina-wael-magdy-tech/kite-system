/**
 * PULSE STUDIO OS — Module K: Document Management & Digital Asset Vault
 * File uploads, deliverable assets, design guidelines, and Supabase Storage integration.
 */

import { getSupabase } from '../../supabase-client.js';
import { Toast } from '../../services/toast-service.js';
import { escapeHTML, formatDate } from '../../utils/helpers.js';
import { CONFIG } from '../../config.js';
import { isValidFileSize, isValidFileExtension } from '../../utils/validators.js';

export class DocumentsModule {
  constructor(app) {
    this.app = app;
    this.documents = [];
  }

  async render(container) {
    container.innerHTML = `
      <div class="page-container animate-fade-in">
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-4);">
          <div>
            <h1 class="font-display font-bold text-xl text-white">Digital Assets & Documents Vault</h1>
            <p class="text-xs text-muted" style="margin-top: 2px;">
              Secure storage for creative assets, brand guidelines, blueprints & client deliverables.
            </p>
          </div>

          <button type="button" class="btn btn-primary btn-sm" id="btnUploadDoc">
            <i data-lucide="upload-cloud"></i> Upload New Asset
          </button>
        </div>

        <!-- Document Grid -->
        <div id="docsGrid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--space-4);">
          <div class="empty-state" style="border:none; padding: 40px 0; grid-column: 1 / -1;">
            <div class="empty-state-icon animate-spin">⟳</div>
            <div class="empty-state-title">Loading vault files...</div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('btnUploadDoc')?.addEventListener('click', () => {
      this.openUploadModal();
    });

    await this.loadDocuments();
  }

  async loadDocuments() {
    const supabase = getSupabase();
    if (!supabase) return;

    try {
      const { data: docs, error } = await supabase
        .from('task_attachments')
        .select(`
          *,
          uploader:profiles!task_attachments_uploaded_by_fkey(full_name),
          task:tasks(title, task_number)
        `)
        .order('created_at', { ascending: false });

      this.documents = docs || [];
      this.renderDocs();
    } catch (err) {
      console.warn('Docs error:', err);
      this.renderDocs();
    }
  }

  renderDocs() {
    const container = document.getElementById('docsGrid');
    if (!container) return;

    const displayDocs = this.documents;
    if (displayDocs.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <div class="empty-state-icon">🗂️</div>
          <div class="empty-state-title">No assets uploaded yet</div>
          <div class="empty-state-desc">Upload deliverables against a task. Only people who can see the task can open its files.</div>
        </div>
      `;
      return;
    }

    container.innerHTML = displayDocs.map(doc => {
      const sizeMB = (doc.file_size / (1024 * 1024)).toFixed(1);

      return `
        <div class="card" style="padding: var(--space-4); display: flex; flex-direction: column; justify-content: space-between; gap: var(--space-3);">
          <div>
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-2);">
              <span class="badge badge-indigo text-2xs">${escapeHTML(doc.file_type || 'Asset')}</span>
              <span class="badge badge-slate font-mono">${sizeMB} MB</span>
            </div>

            <h3 class="font-display font-bold text-xs text-white truncate" title="${escapeHTML(doc.file_name)}">
              ${escapeHTML(doc.file_name)}
            </h3>

            <div class="text-2xs text-muted" style="margin-top: 4px;">
              Deliverable: <strong class="text-slate-200">${escapeHTML(doc.task?.task_number || 'General')}</strong>
            </div>
          </div>

          <div style="border-top: 1px solid var(--border-subtle); padding-top: var(--space-2-5); font-size: var(--text-2xs); color: var(--text-dim); display: flex; justify-content: space-between;">
            <span>👤 ${escapeHTML(doc.uploader?.full_name || 'Specialist')}</span>
            <span class="font-mono">${formatDate(doc.created_at)}</span>
          </div>

          <button type="button" class="btn btn-secondary btn-sm btn-download-doc" style="width: 100%;" data-path="${escapeHTML(doc.storage_path)}" data-name="${escapeHTML(doc.file_name)}">
            <i data-lucide="download"></i> Download Asset
          </button>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.btn-download-doc').forEach(btn => {
      btn.addEventListener('click', () => this.downloadAsset(btn.dataset.path, btn.dataset.name));
    });
  }

  // Short-lived signed URL; access is decided by the storage policy (task visibility).
  async downloadAsset(path, fileName) {
    const supabase = getSupabase();
    if (!supabase) return;
    const { data, error } = await supabase.storage
      .from(CONFIG.STORAGE_BUCKETS.TASK_ATTACHMENTS)
      .createSignedUrl(path, 60, { download: fileName });
    if (error || !data?.signedUrl) {
      Toast.error('You do not have access to this file, or it no longer exists.', 'Download Failed');
      return;
    }
    const a = document.createElement('a');
    a.href = data.signedUrl;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async openUploadModal() {
    const modalBackdrop = document.getElementById('globalModalBackdrop');
    const modalDialog = document.getElementById('globalModalDialog');
    if (!modalBackdrop || !modalDialog) return;

    const supabase = getSupabase();
    const { data: taskRows } = await supabase
      .from('tasks')
      .select('id, task_number, title')
      .not('status', 'in', '("cancelled")')
      .order('created_at', { ascending: false })
      .limit(100);
    const tasks = taskRows || [];
    if (tasks.length === 0) {
      Toast.warning('Create or receive a task first: files are attached to deliverables.', 'No tasks available');
      return;
    }

    modalDialog.style.maxWidth = '460px';
    modalDialog.innerHTML = `
      <div class="modal-header">
        <h2 class="modal-title font-display">Upload Deliverable Asset</h2>
        <button type="button" class="modal-close-btn" id="btnCancelUpload">&times;</button>
      </div>

      <form id="uploadDocForm">
        <div class="modal-body" style="display: flex; flex-direction: column; gap: var(--space-3-5);">
          <div class="form-group">
            <label class="form-label" for="assetFile">Select Asset File *</label>
            <input id="assetFile" type="file" required class="form-control" style="padding-top: 8px;" />
          </div>

          <div class="form-group">
            <label class="form-label" for="assetTask">Deliverable (task) *</label>
            <select id="assetTask" required class="form-control">
              ${tasks.map(t => `<option value="${escapeHTML(t.id)}">${escapeHTML(t.task_number)} — ${escapeHTML(t.title)}</option>`).join('')}
            </select>
          </div>
          <p class="text-2xs text-dim">Max ${Math.round(CONFIG.MAX_FILE_SIZE_BYTES / 1048576)} MB. Allowed: ${CONFIG.ALLOWED_FILE_EXTENSIONS.join(', ')}.</p>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary btn-sm" id="btnCancelUploadAction">Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm">Upload to Vault</button>
        </div>
      </form>
    `;

    modalBackdrop.classList.add('active');

    document.getElementById('btnCancelUpload')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));
    document.getElementById('btnCancelUploadAction')?.addEventListener('click', () => modalBackdrop.classList.remove('active'));

    document.getElementById('uploadDocForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const file = document.getElementById('assetFile')?.files?.[0];
      const taskId = document.getElementById('assetTask')?.value;
      if (!file || !taskId) return;

      if (!isValidFileExtension(file.name)) {
        Toast.error('This file type is not allowed.', 'Upload Rejected');
        return;
      }
      if (!isValidFileSize(file.size)) {
        Toast.error(`File must be between 1 byte and ${Math.round(CONFIG.MAX_FILE_SIZE_BYTES / 1048576)} MB.`, 'Upload Rejected');
        return;
      }

      const submitBtn = e.target.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;

      const bucket = CONFIG.STORAGE_BUCKETS.TASK_ATTACHMENTS;
      const safeName = file.name.replace(/[^\w.\-]+/g, '_').slice(-120);
      const path = `${taskId}/${crypto.randomUUID()}-${safeName}`;

      try {
        const { error: upErr } = await supabase.storage.from(bucket).upload(path, file, {
          upsert: false,
          contentType: file.type || 'application/octet-stream'
        });
        if (upErr) throw upErr;

        const { error: rowErr } = await supabase.from('task_attachments').insert({
          task_id: taskId,
          file_name: file.name,
          file_size: file.size,
          file_type: file.type || file.name.split('.').pop().toUpperCase(),
          storage_path: path,
          uploaded_by: this.app.currentUser.id
        });
        if (rowErr) {
          await supabase.storage.from(bucket).remove([path]); // don't leave orphans behind
          throw rowErr;
        }

        Toast.success(`"${file.name}" uploaded`, 'Uploaded');
        modalBackdrop.classList.remove('active');
        await this.loadDocuments();
      } catch (err) {
        console.error('Upload error:', err);
        Toast.error(err.message || 'Upload failed', 'Upload Failed');
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }
}
