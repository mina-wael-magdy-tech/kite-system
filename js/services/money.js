/**
 * KITE SYSTEM — money figures (budgets, monthly fees, deal values)
 * Only the owner / CEO may see or change money. The figures live in their own table (`money_figures`)
 * that the database only opens to them, so this is enforced on the server, not just hidden on screen.
 */

import { getSupabase } from '../supabase-client.js';
import { Permissions } from '../permissions/permission-service.js';

export const OWNER_ROLES = ['owner', 'ceo', 'super_admin'];

export const Money = {
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
  }
};
