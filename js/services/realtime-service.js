/**
 * KITE SYSTEM — Realtime page watcher
 * A page calls Realtime.watch(['tasks', ...], (changed) => reload()) and gets a coalesced callback
 * whenever someone changes one of those tables. The router calls Realtime.clear() on every
 * navigation so only the open page listens. Uses Supabase Realtime (WebSocket); RLS still
 * decides which changes each person receives.
 *
 * Coalescing (Phase 6): a burst of changes produces ONE refresh, not one per event, and never two refreshes at once.
 *   - debounce:  the refresh runs `debounceMs` after the LAST change ...
 *   - max wait:  ... but never later than `maxWaitMs` after the FIRST one, so a steady stream of changes cannot postpone it forever.
 *   - single flight: while a refresh is running, further changes are remembered and answered by exactly one more refresh afterwards.
 *   - the callback receives the Set of tables that changed (plus '*' when the cause was not a table: polling while the socket
 *     is down, or the tab becoming visible again), so a page can refresh only the parts that can have changed.
 *     A callback that ignores the argument keeps working: it simply refreshes everything, once.
 */
import { getSupabase } from '../supabase-client.js';
let seq = 0; // supabase-js hands back an existing channel for a repeated name, so every name must be unique
class RealtimeService {
  constructor() {
    this.channel = null;
    this.timer = null;
    this.pollTimer = null;
    this.status = 'idle';
    this.gen = 0;           // every watch()/clear() starts a new generation; a refresh of an old page never starts another one
    this.dirty = false;
    this.dirtyTables = new Set();
  }
  /**
   * @param {string[]} tables  tables to watch
   * @param {(changed: Set<string>) => (void|Promise<void>)} onChange  called (coalesced) after insert/update/delete
   * @param {{ debounceMs?: number, maxWaitMs?: number, pollMs?: number }} [opts]  pollMs: refresh this often while the socket is down
   */
  watch(tables, onChange, { debounceMs = 400, maxWaitMs = 4000, pollMs = 8000 } = {}) {
    this.clear();
    const supabase = getSupabase();
    if (!supabase || !tables?.length) return;
    const gen = ++this.gen;
    const changed = new Set();
    let firstAt = 0, inflight = false, again = false;
    const run = async () => {
      this.timer = null; firstAt = 0;
      if (gen !== this.gen) return;
      if (document.hidden) { changed.forEach((t) => this.dirtyTables.add(t)); changed.clear(); this.dirty = true; return; } // refresh when the tab becomes visible
      if (inflight) { again = true; return; }                      // single flight: one more refresh once this one is done
      inflight = true;
      const batch = new Set(changed); changed.clear();
      try { await onChange(batch); } catch (err) { console.warn('Realtime refresh failed:', err); }
      finally {
        inflight = false;
        if (again && gen === this.gen) { again = false; fire(); }
      }
    };
    const fire = (table = '*') => {
      changed.add(table);
      const now = Date.now();
      if (!firstAt) firstAt = now;
      clearTimeout(this.timer);
      this.timer = setTimeout(run, Math.max(0, Math.min(debounceMs, firstAt + maxWaitMs - now)));
    };
    let ch = supabase.channel(`kite-watch-${++seq}-${Date.now()}`);
    for (const table of tables) {
      ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => fire(table));
    }
    this.channel = ch.subscribe((status) => {
      this.status = status;
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      if (status !== 'SUBSCRIBED' && pollMs) {
        // WebSocket not connected: keep the page fresh by polling until it reconnects
        this.pollTimer = setInterval(() => { if (!document.hidden) fire('*'); }, pollMs);
      }
    });
    this.onVisible = () => {
      if (!document.hidden && this.dirty) {
        this.dirty = false;
        const tablesSeen = [...this.dirtyTables]; this.dirtyTables.clear();
        (tablesSeen.length ? tablesSeen : ['*']).forEach((t) => changed.add(t));
        fire(tablesSeen[0] ?? '*');
      }
    };
    document.addEventListener('visibilitychange', this.onVisible);
  }
  clear() {
    this.gen++;
    clearTimeout(this.timer);
    clearInterval(this.pollTimer);
    this.timer = this.pollTimer = null;
    if (this.onVisible) document.removeEventListener('visibilitychange', this.onVisible);
    this.onVisible = null;
    this.dirty = false;
    this.dirtyTables.clear();
    const supabase = getSupabase();
    if (this.channel && supabase) supabase.removeChannel(this.channel);
    this.channel = null;
    this.status = 'idle';
  }
}
export const Realtime = new RealtimeService();
