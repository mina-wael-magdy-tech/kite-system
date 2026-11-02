/**
 * KITE SYSTEM — Notification Service
 * Manages persisted notifications, unread badges, and Supabase Realtime alerts.
 */

import { getSupabase } from '../supabase-client.js';
import { Toast } from './toast-service.js';

class NotificationService {
  constructor() {
    this.notifications = [];
    this.channel = null;
  }

  async loadUserNotifications(userId) {
    const supabase = getSupabase();
    if (!supabase || !userId) return [];

    try {
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(30);

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

    // Unread count on the installed app icon (supported browsers only)
    try {
      if (navigator.setAppBadge) { unread > 0 ? navigator.setAppBadge(unread) : navigator.clearAppBadge(); }
    } catch { /* optional */ }

    const badge = document.getElementById('notifBadge');
    if (badge) {
      badge.textContent = unread > 0 ? String(unread) : '';
      badge.style.display = unread > 0 ? 'inline-block' : 'none';
    }
  }

  async markAsRead(notificationId) {
    const supabase = getSupabase();
    if (!supabase) return;

    try {
      await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('id', notificationId);

      const item = this.notifications.find(n => n.id === notificationId);
      if (item) item.is_read = true;
      this.updateBadges();
    } catch (err) {
      console.warn('Could not mark notification read:', err);
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

  subscribeRealtime(userId) {
    const supabase = getSupabase();
    if (!supabase || !userId) return;

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
          const newNotif = payload.new;
          this.notifications.unshift(newNotif);
          this.updateBadges();
          Toast.info(newNotif.content, newNotif.title || 'New Notification');
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
