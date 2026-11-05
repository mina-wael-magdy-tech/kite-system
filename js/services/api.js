/**
 * KITE SYSTEM — Edge Function client
 * All privileged / business-rule operations go through server-side Edge Functions.
 * This wrapper surfaces the server's error message instead of a generic one.
 */

import { getSupabase } from '../supabase-client.js';

const SESSION_ERROR = /invalid or expired session|missing authorization/i;

async function callFunction(supabase, name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let message = error.message;
    // FunctionsHttpError carries the Response; the server's JSON has the real reason.
    try {
      const payload = await error.context?.json?.();
      if (payload?.error) message = payload.error;
    } catch { /* keep generic message */ }
    return { error: message || 'Request failed' };
  }
  if (data?.error) return { error: data.error };
  return { data };
}

async function invoke(name, body) {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Application is not configured');

  // getSession() refreshes an expired access token before we call the function
  await supabase.auth.getSession();
  let result = await callFunction(supabase, name, body);

  // Token rejected: force one refresh and retry; if that fails the login is really gone.
  if (result.error && SESSION_ERROR.test(result.error)) {
    const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
    if (!refreshErr && refreshed?.session) {
      result = await callFunction(supabase, name, body);
    }
    if (result.error && SESSION_ERROR.test(result.error)) {
      await supabase.auth.signOut({ scope: 'local' });
      window.location.href = 'login.html';
      throw new Error('Your session has expired. Please sign in again.');
    }
  }

  if (result.error) throw new Error(result.error);
  return result.data;
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

  broadcast: (params) => invoke('broadcast', params),
  finance: (action, params = {}) => invoke('finance', { action, ...params }),

  chat: (action, params = {}) => invoke('chat', { action, ...params }),
  createChannel: (p) => Api.chat('channel.create', p),
  updateChannel: (p) => Api.chat('channel.update', p),
  setChannelMembers: (id, memberIds) => Api.chat('channel.members', { id, memberIds }),
  archiveChannel: (id, archived) => Api.chat('channel.archive', { id, archived }),
  deleteChannel: (id) => Api.chat('channel.delete', { id }),
  startDirectMessage: (userId) => Api.chat('dm.create', { userId }),
  editMessage: (id, content) => Api.chat('message.edit', { id, content }),
  deleteMessage: (id) => Api.chat('message.delete', { id }),

  toggleReaction: (messageId, emoji) => Api.chat('reaction.toggle', { messageId, emoji }),
  startCall: (conversationId, kind = 'video') => Api.chat('call.start', { conversationId, kind }),
  sendMessage: (conversationId, content, extra = {}) => Api.chat('message.send', { conversationId, content, ...extra }),
  commentTask: (taskId, content) => Api.workflow('task.comment', { taskId, content }),
  taskFileAdded: (taskId, fileName) => Api.workflow('task.file_added', { taskId, fileName }),
  leaveSubmitted: (leaveId) => Api.workflow('leave.submitted', { leaveId }),
  expenseSubmitted: (expenseId) => Api.workflow('expense.submitted', { expenseId }),

  // Kite Drive (client files stored on Hostinger)
  kiteDrive: (action, params = {}) => invoke('kite-drive', { action, ...params }),

  // content plans (feed calendars shared with clients)
  contentPlan: (action, params = {}) => invoke('content-plan', { action, ...params }),
  getPlanShare: (planId) => Api.contentPlan('share.get', { planId }),
  enablePlanShare: (planId, opts = {}) => Api.contentPlan('share.enable', { planId, ...opts }),
  disablePlanShare: (planId) => Api.contentPlan('share.disable', { planId }),
  assignPublisher: (postId, publisherId) => Api.contentPlan('post.assign', { postId, publisherId }),
  contentPostChanged: (postId) => Api.contentPlan('post.changed', { postId }),
  publishPost: (postId, publishedUrl) => Api.contentPlan('post.publish', { postId, publishedUrl }),

  inviteEmployee: (p) => invoke('invite-employee', p),
  deleteEmployee: (userId) => invoke('invite-employee', { action: 'delete', userId }),
  acceptInvitation: () => invoke('accept-invitation', {})
};
