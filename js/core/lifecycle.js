/**
 * KITE SYSTEM — Lifecycle scope
 * Everything a page registers (listeners, timers, subscriptions, handlers) goes through one Scope, and the
 * router disposes the scope when the user leaves the page. Disposing twice is harmless; registering after
 * disposal runs the cleanup immediately, so a late async callback can never leave a listener behind.
 */
export class Scope {
  constructor(name = 'scope') {
    this.name = name;
    this.disposed = false;
    this.cleanups = [];
    this.controller = new AbortController();
  }

  /** Aborted on dispose: pass to fetch() so in-flight requests of a page that was left stop. */
  get signal() { return this.controller.signal; }

  /** False once the page was left: async code checks this before touching the DOM. */
  isActive() { return !this.disposed; }

  /** Number of registered cleanups still pending (used by the lifecycle tests). */
  get size() { return this.cleanups.length; }

  /** Registers a cleanup function. Returns it so it can be called early; it still runs at most once. */
  add(fn) {
    if (typeof fn !== 'function') return () => {};
    let done = false;
    const once = () => { if (done) return; done = true; this.cleanups = this.cleanups.filter((c) => c !== once); try { fn(); } catch (err) { console.warn(`[${this.name}] cleanup failed:`, err); } };
    if (this.disposed) { once(); return once; }
    this.cleanups.push(once);
    return once;
  }

  on(target, type, handler, options) {
    if (!target?.addEventListener) return () => {};
    if (this.disposed) return () => {};
    target.addEventListener(type, handler, options);
    return this.add(() => target.removeEventListener(type, handler, options));
  }

  interval(fn, ms) {
    if (this.disposed) return () => {};
    const id = setInterval(fn, ms);
    return this.add(() => clearInterval(id));
  }

  timeout(fn, ms) {
    if (this.disposed) return () => {};
    const id = setTimeout(() => { release(); fn(); }, ms);
    const release = this.add(() => clearTimeout(id));
    return release;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try { this.controller.abort(); } catch { /* ignore */ }
    const list = this.cleanups.slice().reverse();
    this.cleanups = [];
    for (const fn of list) fn();
  }
}
