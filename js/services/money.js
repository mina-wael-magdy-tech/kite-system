/**
 * KITE SYSTEM — money figures (budgets, monthly fees, deal values)
 * Only the owner / CEO may see or change money. The figures live in their own table (`money_figures`)
 * that the database only opens to them, so this is enforced on the server, not just hidden on screen.
 */

import { getSupabase } from '../supabase-client.js';
import { Permissions } from '../permissions/permission-service.js';

export const OWNER_ROLES = ['owner', 'ceo', 'super_admin'];
/** Finance data is EXECUTIVE-ONLY (same set as the database function auth_is_finance() and the `finance` Edge Function).
 *  finance_manager and accountant have no Finance access. */
export const FINANCE_ROLES = [...OWNER_ROLES];
/** can void invoices / reverse payments / change tax settings (executives only) */
export const FINANCE_SENIOR_ROLES = [...OWNER_ROLES];

export const Money = {
  /** true for the executive tier (super_admin, owner, CEO): the only people who may see Finance */
  canFinance() { return FINANCE_ROLES.some(r => Permissions.hasRole(r)); },
  isSenior() { return FINANCE_SENIOR_ROLES.some(r => Permissions.hasRole(r)); },

  /** true for the owner / CEO only */
  canSee() { return OWNER_ROLES.some(r => Permissions.hasRole(r)); },

  /** Map of entity_id -> amount for one kind of figure (empty for everyone except the owner). */
  async map(entity) {
    const out = new Map();
    if (!this.canSee()) return out;
    const { data } = await getSupabase().from('money_figures').select('entity_id, amount').eq('entity', entity);
    (data || []).forEach(r => out.set(r.entity_id, Number(r.amount)));
    return out;
  },

  /** Save (or clear, when amount is empty) one figure. Ignored for everyone except the owner. */
  async save(entity, id, amount, userId) {
    if (!this.canSee() || !id) return;
    const sb = getSupabase();
    const n = Number(amount);
    if (amount === '' || amount === null || amount === undefined || !Number.isFinite(n) || n <= 0) {
      await sb.from('money_figures').delete().eq('entity', entity).eq('entity_id', id);
      return;
    }
    const { error } = await sb.from('money_figures').upsert(
      { entity, entity_id: id, amount: n, updated_by: userId, updated_at: new Date().toISOString() },
      { onConflict: 'entity,entity_id' }
    );
    if (error) throw error;
  },

  /**
   * Insert a record AND (for the owner / CEO) its money figure in ONE database call, so a failure can never leave a record
   * without its figure (migration 032). Everyone else inserts normally; row-level security is the same either way.
   * Returns { data: { id }, error } like supabase-js.
   */
  async insertWithFigure(table, row, amount) {
    const sb = getSupabase();
    if (!this.canSee()) return sb.from(table).insert(row).select('id').single();
    const n = Number(amount);
    const { data, error } = await sb.rpc('create_entity_with_figure', { p_table: table, p_row: row, p_amount: Number.isFinite(n) && n > 0 ? n : null });
    return { data: data ? { id: data } : null, error };
  },

  /**
   * Update a record AND (owner / CEO) its figure in one call. Returns { data: [{ id }], error }; "not found / not permitted"
   * comes back as an empty list, the same as a plain update that row-level security filtered out.
   */
  async updateWithFigure(table, id, row, amount) {
    const sb = getSupabase();
    if (!this.canSee()) return sb.from(table).update(row).eq('id', id).select('id');
    const n = Number(amount);
    const { data, error } = await sb.rpc('update_entity_with_figure', { p_table: table, p_id: id, p_row: row, p_amount: Number.isFinite(n) && n > 0 ? n : null, p_touch_figure: true });
    if (error && /not_found_or_not_permitted/.test(error.message)) return { data: [], error: null };
    return { data: error ? null : [{ id: data }], error };
  }
};
