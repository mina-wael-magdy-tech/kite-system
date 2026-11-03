/**
 * KITE SYSTEM — Edge Function client
 * All privileged / business-rule operations go through server-side Edge Functions.
 * This wrapper surfaces the server's error message instead of a generic one.
 */

import { getSupabase } from '../supabase-client.js';

async function invoke(name, body) {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Application is not configured');

  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let message = error.message;
    // FunctionsHttpError carries the Response; the server's JSON has the real reason.
    try {
      const payload = await error.context?.json?.();
      if (payload?.error) message = payload.error;
    } catch { /* keep generic message */ }
    throw new Error(message || 'Request failed');
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export const Api = {
  workflow: (action, params = {}) => invoke('workflow', { action, ...params }),

  createTask: (p) => Api.workflow('task.create', p),
  setTaskStatus: (taskId, status) => Api.workflow('task.set_status', { taskId, status }),
  reassignTask: (taskId, assigneeId) => Api.workflow('task.reassign', { taskId, assigneeId }),
  updateTask: (taskId, fields) => Api.workflow('task.update', { taskId, ...fields }),
  deleteTask: (taskId) => Api.workflow('task.delete', { taskId }),
  updateEmployee: (userId, fields) => Api.workflow('employee.update', { userId, ...fields }),
  decideExpense: (expenseId, decision, notes) => Api.workflow('expense.decide', { expenseId, decision, notes }),
  decideLeave: (leaveId, decision, notes) => Api.workflow('leave.decide', { leaveId, decision, notes }),

  inviteEmployee: (p) => invoke('invite-employee', p),
  deleteEmployee: (userId) => invoke('invite-employee', { action: 'delete', userId }),
  acceptInvitation: () => invoke('accept-invitation', {})
};
