/**
 * KITE SYSTEM — Toast Notification Service
 * Lightweight stackable alert toasts matching prototype styling.
 */

import { CONFIG } from '../config.js';
import { escapeHTML } from '../utils/helpers.js';

class ToastManager {
  constructor() {
    this.container = null;
    this.ensureContainer();
  }

  ensureContainer() {
    let el = document.getElementById('toastContainer');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toastContainer';
      el.className = 'toast-container';
      document.body.appendChild(el);
    }
    this.container = el;
  }

  show(message, type = 'indigo', title = '') {
    this.ensureContainer();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let iconSymbol = 'ℹ';
    if (type === 'emerald') iconSymbol = '✓';
    if (type === 'amber') iconSymbol = '⚠';
    if (type === 'rose') iconSymbol = '✕';

    toast.innerHTML = `
      <div class="toast-icon font-bold">${iconSymbol}</div>
      <div class="toast-content">
        ${title ? `<div class="toast-title">${escapeHTML(title)}</div>` : ''}
        <div class="toast-message">${escapeHTML(message)}</div>
      </div>
      <button type="button" class="toast-close" aria-label="Close">&times;</button>
    `;

    // Close button handler
    toast.querySelector('.toast-close').addEventListener('click', () => {
      this.dismiss(toast);
    });

    this.container.appendChild(toast);

    // Auto dismiss
    setTimeout(() => {
      this.dismiss(toast);
    }, CONFIG.TOAST_AUTO_DISMISS_MS);
  }

  dismiss(toast) {
    if (!toast || !toast.parentElement) return;
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    setTimeout(() => {
      if (toast.parentElement) toast.remove();
    }, 200);
  }

  success(msg, title = 'Success') { this.show(msg, 'emerald', title); }
  error(msg, title = 'Error')     { this.show(msg, 'rose', title); }
  warning(msg, title = 'Warning') { this.show(msg, 'amber', title); }
  info(msg, title = 'Notice')     { this.show(msg, 'indigo', title); }
}

export const Toast = new ToastManager();
