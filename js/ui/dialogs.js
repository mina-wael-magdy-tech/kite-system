/**
 * KITE SYSTEM — Shared dialogs
 * One confirm dialog and one edit-form dialog reused by every module, so editing and
 * deleting behave (and fail) the same way everywhere. All values are escaped.
 */

import { escapeHTML } from '../utils/helpers.js';

const backdrop = () => document.getElementById('globalModalBackdrop');
const dialog = () => document.getElementById('globalModalDialog');

export function closeDialog() {
  backdrop()?.classList.remove('active');
}

function show(html, maxWidth = '520px') {
  const d = dialog();
  const b = backdrop();
  if (!d || !b) throw new Error('Modal container missing');
  d.style.maxWidth = maxWidth;
  d.innerHTML = html;
  b.classList.add('active');
  return d;
}

/** Promise<boolean>. Used before every destructive action. */
export function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    const d = show(`
      <div class="modal-header">
        <h2 class="modal-title font-display">${escapeHTML(title)}</h2>
      </div>
      <div class="modal-body">
        <p class="text-sm text-muted" style="line-height: 1.55;">${escapeHTML(message)}</p>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary btn-sm" data-act="cancel">Cancel</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-sm" data-act="ok">${escapeHTML(confirmLabel)}</button>
      </div>
    `, '440px');
    const done = (v) => { closeDialog(); resolve(v); };
    d.querySelector('[data-act="cancel"]').addEventListener('click', () => done(false));
    d.querySelector('[data-act="ok"]').addEventListener('click', () => done(true));
    d.querySelector('[data-act="ok"]').focus();
  });
}

function fieldHTML(f) {
  const id = `fd_${f.name}`;
  const req = f.required ? 'required' : '';
  const label = `<label class="form-label" for="${id}">${escapeHTML(f.label)}${f.required ? ' *' : ''}</label>`;
  const hint = f.hint ? `<p class="text-2xs text-dim" style="margin-top: 4px;">${escapeHTML(f.hint)}</p>` : '';
  const val = f.value ?? '';
  let control;
  if (f.type === 'textarea') {
    control = `<textarea id="${id}" name="${f.name}" rows="${f.rows || 3}" class="form-control" ${req} ${f.maxlength ? `maxlength="${f.maxlength}"` : ''}>${escapeHTML(val)}</textarea>`;
  } else if (f.type === 'select') {
    control = `<select id="${id}" name="${f.name}" class="form-control" ${req}>${(f.options || []).map(o =>
      `<option value="${escapeHTML(o.value)}" ${String(o.value) === String(val) ? 'selected' : ''}>${escapeHTML(o.label)}</option>`).join('')}</select>`;
  } else {
    const attrs = [
      f.type === 'number' ? `step="${f.step ?? 'any'}"` : '',
      f.min !== undefined ? `min="${f.min}"` : '',
      f.max !== undefined ? `max="${f.max}"` : '',
      f.maxlength ? `maxlength="${f.maxlength}"` : '',
      f.placeholder ? `placeholder="${escapeHTML(f.placeholder)}"` : ''
    ].join(' ');
    control = `<input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${escapeHTML(val)}" class="form-control" ${req} ${attrs} />`;
  }
  return `<div class="form-group" style="${f.half ? '' : 'grid-column: 1 / -1;'}">${label}${control}${hint}</div>`;
}

/**
 * Edit form dialog.
 *  fields: [{ name, label, type, value, required, options, half, hint, ... }]
 *  onSubmit(values) -> Promise (throw to keep the dialog open and show the message)
 *  onDelete()       -> Promise (optional; asks for confirmation first)
 */
export function formDialog({ title, subtitle = '', fields, submitLabel = 'Save changes', onSubmit, onDelete, deleteLabel = 'Delete', deleteMessage, maxWidth = '560px' }) {
  const d = show(`
    <div class="modal-header">
      <div>
        <h2 class="modal-title font-display">${escapeHTML(title)}</h2>
        ${subtitle ? `<p class="text-2xs text-muted">${escapeHTML(subtitle)}</p>` : ''}
      </div>
      <button type="button" class="modal-close-btn" data-act="close" aria-label="Close">&times;</button>
    </div>
    <form id="kiteFormDialog" novalidate>
      <div class="modal-body" style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3-5);">
        ${fields.map(fieldHTML).join('')}
        <div id="kiteFormError" class="alert alert-error hidden" style="grid-column: 1 / -1; margin: 0;"></div>
      </div>
      <div class="modal-footer" style="justify-content: space-between;">
        <div>${onDelete ? `<button type="button" class="btn btn-danger btn-sm" data-act="delete">${escapeHTML(deleteLabel)}</button>` : ''}</div>
        <div style="display: flex; gap: var(--space-2);">
          <button type="button" class="btn btn-secondary btn-sm" data-act="close">Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm" data-act="save">${escapeHTML(submitLabel)}</button>
        </div>
      </div>
    </form>
  `, maxWidth);

  const form = d.querySelector('#kiteFormDialog');
  const err = d.querySelector('#kiteFormError');
  const showError = (msg) => { err.textContent = msg; err.classList.remove('hidden'); };
  const setBusy = (busy) => d.querySelectorAll('button').forEach(b => { b.disabled = busy; });

  d.querySelectorAll('[data-act="close"]').forEach(b => b.addEventListener('click', closeDialog));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.add('hidden');
    if (!form.reportValidity()) return;
    const values = {};
    for (const f of fields) {
      const el = form.elements[f.name];
      let v = el.value.trim();
      if (f.type === 'number') v = v === '' ? null : Number(v);
      else if (v === '' && !f.required) v = null;
      values[f.name] = v;
    }
    setBusy(true);
    try {
      await onSubmit(values);
      closeDialog();
    } catch (ex) {
      showError(ex?.message || 'Could not save changes');
      setBusy(false);
    }
  });

  d.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: deleteLabel + '?',
      message: deleteMessage || 'This cannot be undone.',
      confirmLabel: deleteLabel,
      danger: true
    });
    if (!ok) return;
    try {
      await onDelete();
      closeDialog();
    } catch (ex) {
      // the confirm dialog replaced the form; reopen a minimal error notice
      show(`<div class="modal-header"><h2 class="modal-title font-display">Could not delete</h2></div>
            <div class="modal-body"><div class="alert alert-error">${escapeHTML(ex?.message || 'Delete failed')}</div></div>
            <div class="modal-footer"><button type="button" class="btn btn-secondary btn-sm" data-act="close">Close</button></div>`, '440px')
        .querySelector('[data-act="close"]').addEventListener('click', closeDialog);
    }
  });

  d.querySelector('input, textarea, select')?.focus();
}
