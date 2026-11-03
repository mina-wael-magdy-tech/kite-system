/**
 * KITE SYSTEM — Client-Side Hash Router
 * Handles seamless module mounting, permission verification, and URL state.
 */

import { Permissions } from './permissions/permission-service.js';
import { Toast } from './services/toast-service.js';
import { escapeHTML } from './utils/helpers.js';
import { Realtime } from './services/realtime-service.js';

export class Router {
  constructor() {
    this.routes = new Map();
    this.currentRoute = null;
    this.contentContainer = null;
    this.defaultRoute = 'dashboard';
  }

  init(contentContainer) {
    this.contentContainer = contentContainer;
    window.addEventListener('hashchange', () => this.handleHashChange());
    this.handleHashChange();
  }

  register(routeId, handlerConfig) {
    // handlerConfig: { title, breadcrumbs, moduleInstance, requiredRole }
    this.routes.set(routeId, handlerConfig);
  }

  async navigate(routeId, params = {}) {
    window.location.hash = `#${routeId}`;
  }

  async handleHashChange() {
    const rawHash = window.location.hash.slice(1);
    const [routeId, queryString] = rawHash.split('?');
    const targetRoute = routeId || this.defaultRoute;

    const routeConfig = this.routes.get(targetRoute);
    if (!routeConfig) {
      console.warn(`Route "${targetRoute}" not found, redirecting to default.`);
      this.navigate(this.defaultRoute);
      return;
    }

    // Permission check
    if (!Permissions.canAccessModule(targetRoute)) {
      Toast.error('You do not have permission to view this module.', 'Access Denied');
      this.navigate(this.defaultRoute);
      return;
    }

    this.currentRoute = targetRoute;
    Realtime.clear(); // the previous page stops listening; the new page subscribes in its render()

    // Update active nav item in sidebar
    document.querySelectorAll('.nav-item, .bottom-nav a').forEach(el => {
      const routeAttr = el.getAttribute('data-route');
      if (routeAttr === targetRoute) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });

    // Update breadcrumbs in topbar
    this.renderBreadcrumbs(routeConfig.breadcrumbs || [routeConfig.title]);

    // Render module content
    if (this.contentContainer && routeConfig.render) {
      this.contentContainer.innerHTML = `
        <div class="empty-state" style="border:none; padding: 48px 0;">
          <div class="empty-state-icon animate-spin">⟳</div>
          <div class="empty-state-title">Loading ${escapeHTML(routeConfig.title)}...</div>
        </div>
      `;

      try {
        await routeConfig.render(this.contentContainer, queryString);
        if (window.lucide) {
          window.lucide.createIcons();
        }
      } catch (err) {
        console.error(`Error rendering route ${targetRoute}:`, err);
        this.contentContainer.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon text-rose">✕</div>
            <div class="empty-state-title">Failed to load ${escapeHTML(routeConfig.title)}</div>
            <div class="empty-state-desc">${escapeHTML(err.message || 'An unexpected error occurred.')}</div>
            <button class="btn btn-secondary btn-sm" id="btnReloadPage">Reload Page</button>
          </div>
        `;
        document.getElementById('btnReloadPage')?.addEventListener('click', () => location.reload());
      }
    }
  }

  renderBreadcrumbs(crumbs = []) {
    const el = document.getElementById('breadcrumbList');
    if (!el) return;

    el.innerHTML = crumbs
      .map((crumb, idx) => {
        const isLast = idx === crumbs.length - 1;
        return `
          <li class="${isLast ? 'breadcrumb-current' : 'text-muted'}">${crumb}</li>
          ${!isLast ? '<li class="breadcrumb-separator">/</li>' : ''}
        `;
      })
      .join('');
  }
}

export const AppRouter = new Router();
