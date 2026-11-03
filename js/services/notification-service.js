/**
 * KITE SYSTEM — Notification Service
 * Persisted notifications, unread badges and live alerts (Supabase Realtime over WebSocket).
 * Understands each notification type: icon, colour, where it leads, and when it should stay quiet
 * (e.g. no pop-up for a chat you are already reading).
 */

import { getSupabase } from '../supabase-client.js';
import { Toast } from './toast-service.js';

const BASE_TITLE = document.title;

/** icon = lucide icon; tone = css colour variable used for the icon bubble. */
export const NOTIFICATION_TYPES = {
  chat_message:        { icon: 'message-circle', tone: 'var(--kite-blue-400)',  label: 'Chat' },
  task_assigned:       { icon: 'clipboard-check', tone: 'var(--kite-red-500)',   label: 'Tasks' },
  task_status_updated: { icon: 'refresh-cw',      tone: 'var(--kite-amber-400)', label: 'Tasks' },
  task_updated:        { icon: 'pencil',          tone: 'var(--kite-amber-400)', label: 'Tasks' },
  task_deleted:        { icon: 'trash-2',         tone: 'var(--kite-red-700)',   label: 'Tasks' },
  task_comment:        { icon: 'message-square',  tone: 'var(--kite-blue-400)',  label: 'Tasks' },
  task_file:           { icon: 'paperclip',       tone: 'var(--kite-blue-400)',  label: 'Tasks' },
  due_digest:          { icon: 'alarm-clock',     tone: 'var(--kite-amber-400)', label: 'Deadlines' },
  leave_request:       { icon: 'calendar-clock',  tone: 'var(--kite-amber-400)', label: 'HR' },
  leave_decision:      { icon: 'calendar-check',  tone: 'var(--kite-red-500)',   label: 'HR' },
  expense_request:     { icon: 'receipt',         tone: 'var(--kite-amber-400)', label: 'Finance' },
  expense_decision:    { icon: 'badge-check',     tone: 'var(--kite-red-500)',   label: 'Finance' },
  employee_joined:     { icon: 'user-plus',       tone: 'var(--kite-blue-400)',  label: 'People' },
  role_changed:        { icon: 'shield',          tone: 'var(--kite-red-500)',   label: 'People' }
};
const FALLBACK = { icon: 'bell', tone: 'var(--text-dim)', label: 'Update' };

export function describeNotification(n) {
  return NOTIFICATION_TYPES[n.type] || FALLBACK;
}

class NotificationService {
  constructor() {
    this.notifications = [];
    this.channel = null;
    this.userId = null;
    this.onChange = null; // set by the app: re-render the open panel when something arrives
  }

  async loadUserNotifications(userId) {
    const supabase = getSupabase();
    if (!supabase || !userId) return [];
    this.userId = userId;

    try {
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(60);

      if (error) throw error;
      this.notifications = data || [];
      this.updateBadges();
      return this.notifications;
    } catch (err) {
      console.warn('Failed to load notifications:', err);
      return [];
    }
  }

  getUnreadCount() {
    return this.notifications.filter(n => !n.is_read).length;
  }

  updateBadges() {
    const unread = this.getUnreadCount();
    const dot = document.getElementById('notificationDot');
    if (dot) {
      dot.style.display = unread > 0 ? 'block' : 'none';
    }

    // Unread count on the installed app icon and in the browser tab title
    try {
      if (navigator.setAppBadge) { unread > 0 ? navigator.setAppBadge(unread) : navigator.clearAppBadge(); }
    } catch { /* optional */ }
    document.title = unread > 0 ? `(${unread > 99 ? '99+' : unread}) ${BASE_TITLE}` : BASE_TITLE;

    const badge = document.getElementById('notifBadge');
    if (badge) {
      badge.textContent = unread > 0 ? String(unread) : '';
      badge.style.display = unread > 0 ? 'inline-block' : 'none';
    }

    // chat tab badge on the sidebar / phone tab bar
    const chatUnread = this.notifications.filter(n => !n.is_read && n.type === 'chat_message').length;
    document.querySelectorAll('[data-route="chat"]').forEach(el => {
      let b = el.querySelector('.nav-count');
      if (chatUnread > 0) {
        if (!b) { b = document.createElement('span'); b.className = 'nav-count'; el.appendChild(b); }
        b.textContent = chatUnread > 99 ? '99+' : String(chatUnread);
      } else if (b) {
        b.remove();
      }
    });
  }

  async markAsRead(notificationId) {
    const supabase = getSupabase();
    if (!supabase) return;

    const item = this.notifications.find(n => n.id === notificationId);
    if (item) item.is_read = true;
    this.updateBadges();
    try {
      await supabase.from('notifications').update({ is_read: true }).eq('id', notificationId);
    } catch (err) {
      console.warn('Could not mark notification read:', err);
    }
  }

  /** Opening a conversation reads all of its chat alerts. */
  async markConversationRead(conversationId) {
    const supabase = getSupabase();
    if (!supabase || !this.userId || !conversationId) return;
    const unread = this.notifications.filter(n => !n.is_read && n.metadata?.conversation_id === conversationId);
    if (!unread.length) return;
    unread.forEach(n => { n.is_read = true; });
    this.updateBadges();
    this.onChange?.();
    try {
      await supabase.from('notifications').update({ is_read: true })
        .eq('user_id', this.userId).eq('is_read', false).eq('metadata->>conversation_id', conversationId);
    } catch (err) {
      console.warn('Could not mark chat notifications read:', err);
    }
  }

  async markAllAsRead(userId) {
    const supabase = getSupabase();
    if (!supabase || !userId) return;

    try {
      await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('user_id', userId);

      this.notifications.forEach(n => (n.is_read = true));
      this.updateBadges();
      Toast.success('All notifications marked as read', 'Updated');
    } catch (err) {
      console.warn('Could not mark all notifications read:', err);
    }
  }

  /** Is the person looking at this chat right now? Then an alert would only be noise. */
  isViewing(n) {
    if (n.type !== 'chat_message') return false;
    if (!window.location.hash.startsWith('#chat') || document.hidden) return false;
    const params = new URLSearchParams((window.location.hash.split('?')[1]) || '');
    const open = this.activeConversationId || params.get('c');
    return !!open && open === n.metadata?.conversation_id;
  }

  subscribeRealtime(userId) {
    const supabase = getSupabase();
    if (!supabase || !userId) return;
    this.userId = userId;

    if (this.channel) {
      supabase.removeChannel(this.channel);
    }

    this.channel = supabase
      .channel(`public:notifications:${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`
        },
        payload => {
          const n = payload.new;
          if (this.notifications.some(x => x.id === n.id)) return;

          if (this.isViewing(n)) {
            n.is_read = true; // already on screen: read it silently
            this.notifications.unshift(n);
            this.markAsRead(n.id);
          } else {
            this.notifications.unshift(n);
            this.updateBadges();
            Toast.info(n.content, n.title || 'New Notification');
          }
          this.onChange?.();
        }
      )
      .subscribe();
  }

  unsubscribe() {
    const supabase = getSupabase();
    if (supabase && this.channel) {
      supabase.removeChannel(this.channel);
      this.channel = null;
    }
  }
}

export const Notifications = new NotificationService();
