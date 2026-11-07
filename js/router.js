/**
 * KITE SYSTEM — Client-Side Hash Router
 * Handles seamless module mounting, permission verification, and URL state.
 */

import { Permissions } from './permissions/permission-service.js';
import { Toast } from './services/toast-service.js';
import { escapeHTML } from './utils/helpers.js';
import { Realtime } from './services/realtime-service.js';
import { Scope } from './core/lifecycle.js';
import { assertInstance } from './core/module-contract.js';

export class Router {
  constructor() {
    this.routes = new Map();
    this.currentRoute = null;
    this.contentContainer = null;
    this.defaultRoute = 'dashboard';
    this.navSeq = 0;        // bumped by every navigation: a render that finishes for an older number is ignored
    this.renderKey = null;  // "route?query" of the page shown (or being drawn): a repeated event for it does nothing
    this.active = null;     // { instance, scope } of the page on screen
    this.onHash = null;
  }

  init(contentContainer) {
    this.contentContainer = contentContainer;
    if (!this.onHash) {
      this.onHash = () => this.handleHashChange();
      window.addEventListener('hashchange', this.onHash);
    }
    this.handleHashChange();
  }

  /** Removes the router's own listener and the page on screen (tests, sign-out). */
  destroy() {
    if (this.onHash) window.removeEventListener('hashchange', this.onHash);
    this.onHash = null;
    this.navSeq++;
    this.teardown();
    this.renderKey = null;
  }

  /**
   * register(routeId, { title, breadcrumbs, create(app)->instance })   the module contract (see core/module-contract.js)
   * register(routeId, { title, breadcrumbs, render(container, query) }) legacy form: no instance, nothing to dispose
   */
  register(routeId, handlerConfig) {
    this.routes.set(routeId, handlerConfig);
  }

  async navigate(routeId, params = {}) {
    window.location.hash = `#${routeId}`;
  }

  /** Leaves the page on screen: its instance first, then everything its scope registered. Never throws. */
  teardown() {
    const prev = this.active;
    this.active = null;
    if (!prev) return;
    try { prev.instance?.dispose?.(); } catch (err) { console.warn('Module dispose failed:', err); }
    prev.scope.dispose();
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

    // the same page asked for again (a repeated event): drawing it twice would only duplicate its listeners and requests
    const key = `${targetRoute}?${queryString || ''}`;
    if (key === this.renderKey) return;
    this.renderKey = key;
    const token = ++this.navSeq;
    const stale = () => token !== this.navSeq;

    this.currentRoute = targetRoute;
    this.teardown();   // the previous page stops listening before the new one starts
    Realtime.clear();  // (the new page subscribes in its render())

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

    // Render module content. Each visit draws into its own host element, so a slow render of a page that was already
    // left can only write into a node that is no longer on screen.
    const draws = typeof routeConfig.create === 'function' || typeof routeConfig.render === 'function';
    if (this.contentContainer && draws) {
      const host = document.createElement('div');
      host.dataset.route = targetRoute;
      host.style.display = 'contents';
      host.innerHTML = `
        <div class="empty-state" style="border:none; padding: 48px 0;">
          <div class="empty-state-icon animate-spin">⟳</div>
          <div class="empty-state-title">Loading ${escapeHTML(routeConfig.title)}...</div>
        </div>
      `;
      this.contentContainer.replaceChildren(host);

      const scope = new Scope(targetRoute);
      let instance = null;
      this.active = { instance: null, scope };
      try {
        if (typeof routeConfig.create === 'function') {
          instance = assertInstance(targetRoute, routeConfig.create());
          this.active.instance = instance;
          await instance.render(host, queryString, scope);
        } else {
          await routeConfig.render(host, queryString, scope);
        }
        if (stale()) return;
        if (window.lucide) {
          window.lucide.createIcons();
        }
      } catch (err) {
        if (stale()) return;                 // an error of a page the user already left is not worth a screen
        this.renderKey = null;               // let the same address be tried again
        console.error(`Error rendering route ${targetRoute}:`, err);
        host.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon text-rose">✕</div>
            <div class="empty-state-title">Failed to load ${escapeHTML(routeConfig.title)}</div>
            <div class="empty-state-desc">${escapeHTML(err.message || 'An unexpected error occurred.')}</div>
            <button class="btn btn-secondary btn-sm" id="btnReloadPage">Reload Page</button>
          </div>
        `;
        host.querySelector('#btnReloadPage')?.addEventListener('click', () => location.reload());
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
          <li class="${isLast ? 'breadcrumb-current' : 'text-muted'}">${escapeHTML(String(crumb))}</li>
          ${!isLast ? '<li class="breadcrumb-separator">/</li>' : ''}
        `;
      })
      .join('');
  }
}

export const AppRouter = new Router();
