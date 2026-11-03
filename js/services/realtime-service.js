/**
 * KITE SYSTEM — Realtime page watcher
 * A page calls Realtime.watch(['tasks', ...], () => reload()) and gets a (debounced) callback
 * whenever someone changes one of those tables. The router calls Realtime.clear() on every
 * navigation so only the open page listens. Uses Supabase Realtime (WebSocket); RLS still
 * decides which changes each person receives.
 */

import { getSupabase } from '../supabase-client.js';

class RealtimeService {
  constructor() {
    this.channel = null;
    this.timer = null;
    this.pollTimer = null;
    this.status = 'idle';
  }

  /**
   * @param {string[]} tables  tables to watch
   * @param {() => (void|Promise<void>)} onChange  called (debounced) after any insert/update/delete
   * @param {{ debounceMs?: number, pollMs?: number }} [opts]  pollMs: refresh this often while the socket is down
   */
  watch(tables, onChange, { debounceMs = 400, pollMs = 8000 } = {}) {
    this.clear();
    const supabase = getSupabase();
    if (!supabase || !tables?.length) return;

    const fire = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        if (document.hidden) { this.dirty = true; return; } // refresh when the tab becomes visible
        Promise.resolve(onChange()).catch(err => console.warn('Realtime refresh failed:', err));
      }, debounceMs);
    };

    let ch = supabase.channel(`kite-watch-${Date.now()}`);
    for (const table of tables) {
      ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, fire);
    }
    this.channel = ch.subscribe((status) => {
      this.status = status;
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      if (status !== 'SUBSCRIBED' && pollMs) {
        // WebSocket not connected: keep the page fresh by polling until it reconnects
        this.pollTimer = setInterval(() => { if (!document.hidden) fire(); }, pollMs);
      }
    });

    this.onVisible = () => {
      if (!document.hidden && this.dirty) { this.dirty = false; fire(); }
    };
    document.addEventListener('visibilitychange', this.onVisible);
  }

  clear() {
    clearTimeout(this.timer);
    clearInterval(this.pollTimer);
    this.timer = this.pollTimer = null;
    if (this.onVisible) document.removeEventListener('visibilitychange', this.onVisible);
    this.onVisible = null;
    this.dirty = false;
    const supabase = getSupabase();
    if (this.channel && supabase) supabase.removeChannel(this.channel);
    this.channel = null;
    this.status = 'idle';
  }
}

export const Realtime = new RealtimeService();
