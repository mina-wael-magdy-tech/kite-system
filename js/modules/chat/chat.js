/**
 * KITE SYSTEM — Module J: Communication & Role Chat
 * Slack-style studio channels, group chats, direct messages & instant task handoffs.
 * Admins / CEO / general managers create and manage channels; everything updates live.
 */

import { getSupabase } from '../../supabase-client.js';
import { Toast } from '../../services/toast-service.js';
import { Api } from '../../services/api.js';
import { Permissions } from '../../permissions/permission-service.js';
import { formDialog, confirmDialog } from '../../ui/dialogs.js';
import { escapeHTML, formatRelativeTime } from '../../utils/helpers.js';

const MESSAGE_SELECT = '*, sender:profiles!messages_sender_id_fkey(id, full_name, avatar_url)';

export class ChatModule {
  constructor(app) {
    this.app = app;
    this.channels = [];
    this.activeChannelId = null;
    this.messages = [];
    this.employees = [];
    this.unread = {};
    this.realtimeSub = null;
    this.listTimer = null;
  }

  async render(container) {
    this.teardownRealtime();
    container.innerHTML = `
      <div class="page-container animate-fade-in" style="height: calc(100vh - 120px); display: flex; flex-direction: column;">
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-3);">
          <div>
            <h1 class="font-display font-bold text-xl text-white">Studio Channels & Role Handoffs</h1>
            <p class="text-xs text-muted">Collaborate with any role & dispatch deliverables directly in chat.</p>
          </div>
          <span class="badge badge-emerald" id="chatLiveBadge">Connecting…</span>
        </div>

        <div class="chat-layout" style="flex: 1; min-height: 0;">
          <!-- Left: Channels & DMs -->
          <div class="chat-sidebar">
            <div style="padding: var(--space-3-5); border-bottom: 1px solid var(--border-subtle); background: var(--studio-950); display: flex; align-items: center; justify-content: space-between; gap: var(--space-2);">
              <div>
                <div class="font-display font-bold text-xs text-white">Collaboration Rooms</div>
                <div class="text-2xs text-muted">Channels, groups & direct messages</div>
              </div>
              <div style="display: flex; gap: 4px;">
                <button type="button" class="card-act" id="btnNewDm" title="New direct message" aria-label="New direct message" style="opacity:1;"><i data-lucide="message-circle"></i></button>
                ${Permissions.isAdmin() ? '<button type="button" class="card-act" id="btnNewChannel" title="Create channel" aria-label="Create channel" style="opacity:1;"><i data-lucide="plus"></i></button>' : ''}
              </div>
            </div>

            <div id="chatChannelsList" style="flex: 1; overflow-y: auto; padding: var(--space-2); display: flex; flex-direction: column; gap: var(--space-1);"></div>
          </div>

          <!-- Right: Active chat -->
          <div class="chat-window">
            <div id="chatActiveHeader" style="padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border-subtle); background: var(--studio-950); display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap;">
              <div>
                <div class="font-bold text-sm text-white" id="activeChannelTitle">Channels</div>
                <div class="text-2xs text-muted" id="activeChannelDesc"></div>
              </div>

              <div style="display: flex; gap: var(--space-2); flex-wrap: wrap; justify-content: flex-end;">
                <span id="chatAdminActions" style="display: none; gap: var(--space-2);"></span>
                <button type="button" class="btn btn-secondary btn-sm" id="btnToggleHandoffBar">
                  <i data-lucide="zap"></i> + Dispatch Task Card
                </button>
              </div>
            </div>

            <!-- Instant Task Handoff Bar -->
            <div id="chatHandoffBar" class="glass-panel" style="display: none; padding: var(--space-3); margin: var(--space-3); background: rgba(99, 102, 241, 0.1); border-color: var(--color-primary-border); flex-direction: column; gap: var(--space-2);">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span class="text-xs font-bold text-primary">⚡ Instant Task Handoff in Chat</span>
                <button type="button" id="btnCancelHandoff" class="text-2xs text-muted">&times; Cancel</button>
              </div>

              <div style="display: grid; grid-template-columns: 2fr 1fr; gap: var(--space-2);">
                <input id="quickTaskTitle" type="text" placeholder="Deliverable name (e.g. Export SVG Logo Kit)..." class="form-control" style="height: 32px;" />
                <select id="quickTaskAssignee" class="form-control" style="height: 32px;"></select>
              </div>

              <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
                <button type="button" id="btnDispatchChatTask" class="btn btn-primary btn-sm">Dispatch Task Card →</button>
              </div>
            </div>

            <div class="chat-feed" id="chatFeed">
              <div class="empty-state" style="border:none; padding: 40px 0;">
                <div class="empty-state-icon animate-spin">⟳</div>
                <div class="empty-state-title">Loading messages...</div>
              </div>
            </div>

            <form id="chatMessageForm" style="padding: var(--space-3); border-top: 1px solid var(--border-subtle); background: var(--studio-950); display: flex; gap: var(--space-2);">
              <input type="text" id="chatInput" required autocomplete="off" maxlength="4000"
                placeholder="Write a message to collaborate or hand off deliverables..."
                class="form-control" style="height: 38px;" />
              <button type="submit" class="btn btn-primary btn-sm" style="height: 38px; padding: 0 var(--space-4);">Send</button>
            </form>
          </div>
        </div>
      </div>
    `;

    this.attachEventListeners();
    await this.loadChatData();
    this.subscribeRealtime();
  }

  attachEventListeners() {
    const handoffBar = document.getElementById('chatHandoffBar');
    document.getElementById('btnToggleHandoffBar')?.addEventListener('click', () => {
      handoffBar.style.display = handoffBar.style.display === 'flex' ? 'none' : 'flex';
    });
    document.getElementById('btnCancelHandoff')?.addEventListener('click', () => { handoffBar.style.display = 'none'; });
    document.getElementById('btnDispatchChatTask')?.addEventListener('click', () => this.handleDispatchTaskFromChat());
    document.getElementById('btnNewChannel')?.addEventListener('click', () => this.openCreateChannel());
    document.getElementById('btnNewDm')?.addEventListener('click', () => this.openNewDm());
    document.getElementById('chatMessageForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.handleSendMessage();
    });
  }

  // ------------------------------------------------------------ data

  async loadChatData(selectId = null) {
    const supabase = getSupabase();
    if (!supabase) return;

    try {
      const { data: convos } = await supabase
        .from('conversations')
        .select('*, conversation_members(user_id)')
        .order('created_at', { ascending: true });
      this.channels = convos || [];

      if (!this.employees.length) {
        const { data: emps } = await supabase.from('profiles')
          .select('id, full_name, job_title, employment_status, department_id, departments!profiles_department_id_fkey(name)');
        this.employees = emps || [];
        const select = document.getElementById('quickTaskAssignee');
        if (select) {
          select.innerHTML = this.employees.map(e => `
            <option value="${e.id}" data-dept="${e.department_id || ''}">
              To: ${escapeHTML(e.full_name)} (${escapeHTML(e.departments?.name || 'Studio')})
            </option>`).join('');
        }
      }

      const visible = this.visibleChannels();
      const wanted = selectId || this.activeChannelId;
      const previous = this.activeChannelId;
      this.activeChannelId = visible.some(c => c.id === wanted) ? wanted : (visible[0]?.id || null);
      if (this.activeChannelId) delete this.unread[this.activeChannelId];

      this.renderChannelsList();
      this.renderHeader();

      if (!this.activeChannelId) {
        this.messages = [];
        const feed = document.getElementById('chatFeed');
        if (feed) feed.innerHTML = `<div class="empty-state" style="border:none;"><div class="empty-state-title">No channels yet</div><div class="empty-state-desc">${Permissions.isAdmin() ? 'Create the first channel with the + button.' : 'Ask an administrator to add you to a channel, or start a direct message.'}</div></div>`;
        return;
      }
      // avoid flashing the feed when only the sidebar changed
      if (this.activeChannelId !== previous || !this.messages.length || selectId) {
        await this.loadMessages(this.activeChannelId);
      }
    } catch (err) {
      console.warn('Chat load error:', err);
    }
  }

  visibleChannels() {
    const isAdmin = Permissions.isAdmin();
    return this.channels.filter(c => isAdmin || !c.is_archived);
  }

  personName(id) {
    return this.employees.find(e => e.id === id)?.full_name || 'Specialist';
  }

  channelLabel(ch) {
    if (ch.type === 'direct') {
      const otherId = (ch.conversation_members || []).map(m => m.user_id).find(id => id !== this.app.currentUser.id);
      return this.personName(otherId || this.app.currentUser.id);
    }
    return ch.name || 'Untitled';
  }

  async loadMessages(channelId) {
    const supabase = getSupabase();
    if (!supabase) return;
    try {
      const { data: msgs } = await supabase
        .from('messages')
        .select(MESSAGE_SELECT)
        .eq('conversation_id', channelId)
        .order('created_at', { ascending: true })
        .limit(200);
      if (channelId !== this.activeChannelId) return; // user switched away meanwhile
      this.messages = msgs || [];
      this.renderMessagesFeed();
    } catch (err) {
      console.warn('Messages error:', err);
      this.renderMessagesFeed();
    }
  }

  // ------------------------------------------------------------ realtime

  subscribeRealtime() {
    const supabase = getSupabase();
    if (!supabase) return;
    this.teardownRealtime();

    this.realtimeSub = supabase
      .channel(`kite-chat-${this.app.currentUser.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, (p) => this.onMessageChange(p))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, () => this.scheduleListRefresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_members' }, () => this.scheduleListRefresh())
      .subscribe((status) => {
        const badge = document.getElementById('chatLiveBadge');
        if (!badge) return;
        const live = status === 'SUBSCRIBED';
        badge.textContent = live ? 'Live Realtime' : (status === 'CONNECTING' || status === 'JOINING' ? 'Connecting…' : 'Reconnecting…');
        badge.className = `badge ${live ? 'badge-emerald' : 'badge-amber'}`;
      });
  }

  teardownRealtime() {
    const supabase = getSupabase();
    if (this.realtimeSub && supabase) supabase.removeChannel(this.realtimeSub);
    this.realtimeSub = null;
    clearTimeout(this.listTimer);
  }

  /** Channel / membership changes: refresh the sidebar shortly (batches bursts of events). */
  scheduleListRefresh() {
    clearTimeout(this.listTimer);
    this.listTimer = setTimeout(() => {
      if (document.getElementById('chatChannelsList')) this.loadChatData();
    }, 300);
  }

  async onMessageChange(payload) {
    if (!document.getElementById('chatFeed')) return;
    const { eventType } = payload;

    if (eventType === 'DELETE') {
      const id = payload.old?.id;
      if (id && this.messages.some(m => m.id === id)) {
        this.messages = this.messages.filter(m => m.id !== id);
        this.renderMessagesFeed(true);
      }
      return;
    }

    const row = payload.new;
    if (!row) return;

    if (row.conversation_id !== this.activeChannelId) {
      // activity in another conversation: unread badge + a heads-up for new messages
      if (eventType === 'INSERT' && row.sender_id !== this.app.currentUser.id) {
        this.unread[row.conversation_id] = (this.unread[row.conversation_id] || 0) + 1;
        this.renderChannelsList();
        const ch = this.channels.find(c => c.id === row.conversation_id);
        if (ch) Toast.info(`New message in ${this.channelLabel(ch)}`, 'Chat');
      }
      return;
    }

    if (eventType === 'INSERT') {
      if (this.messages.some(m => m.id === row.id)) return; // already added by the sender path
      await this.appendMessage(row.id);
    } else if (eventType === 'UPDATE') {
      const idx = this.messages.findIndex(m => m.id === row.id);
      if (idx >= 0) {
        this.messages[idx] = { ...this.messages[idx], ...row, sender: this.messages[idx].sender };
        this.renderMessagesFeed(true);
      }
    }
  }

  async appendMessage(id) {
    const { data } = await getSupabase().from('messages').select(MESSAGE_SELECT).eq('id', id).maybeSingle();
    if (!data || data.conversation_id !== this.activeChannelId || this.messages.some(m => m.id === data.id)) return;
    this.messages.push(data);
    this.renderMessagesFeed();
  }

  // ------------------------------------------------------------ sidebar & header

  renderChannelsList() {
    const container = document.getElementById('chatChannelsList');
    if (!container) return;

    const list = this.visibleChannels();
    const channels = list.filter(c => c.type !== 'direct');
    const dms = list.filter(c => c.type === 'direct');

    const item = (ch) => {
      const active = ch.id === this.activeChannelId;
      const icon = ch.type === 'direct' ? 'user' : (ch.is_public ? 'hash' : 'lock');
      const n = this.unread[ch.id];
      return `
        <button type="button" class="nav-item ${active ? 'active' : ''}" style="width: 100%; text-align: left;" data-channel-id="${ch.id}">
          <i data-lucide="${icon}"></i>
          <span class="truncate" style="${n ? 'font-weight: 700;' : ''}">${escapeHTML(this.channelLabel(ch))}${ch.is_archived ? ' <span class="text-dim">(archived)</span>' : ''}</span>
          ${n ? `<span class="badge badge-brand" style="margin-left: auto;">${n}</span>` : ''}
        </button>`;
    };
    const section = (title, items, empty) => `
      <div class="text-2xs text-dim font-bold" style="padding: var(--space-2) var(--space-2) 2px; text-transform: uppercase; letter-spacing: 0.05em;">${title}</div>
      ${items.length ? items.map(item).join('') : `<div class="text-2xs text-dim" style="padding: 2px var(--space-2);">${empty}</div>`}`;

    container.innerHTML =
      section('Channels', channels, Permissions.isAdmin() ? 'None yet — use +' : 'No channels yet') +
      section('Direct messages', dms, 'Use the message icon to start one');

    container.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', async () => {
        this.activeChannelId = btn.getAttribute('data-channel-id');
        delete this.unread[this.activeChannelId];
        this.renderChannelsList();
        this.renderHeader();
        await this.loadMessages(this.activeChannelId);
      });
    });

    if (window.lucide) window.lucide.createIcons();
  }

  renderHeader() {
    const ch = this.channels.find(c => c.id === this.activeChannelId);
    const title = document.getElementById('activeChannelTitle');
    const desc = document.getElementById('activeChannelDesc');
    const actions = document.getElementById('chatAdminActions');
    const form = document.getElementById('chatMessageForm');
    if (!title) return;

    if (!ch) {
      title.textContent = 'Channels';
      desc.textContent = '';
      if (actions) actions.style.display = 'none';
      return;
    }

    const prefix = ch.type === 'direct' ? '' : (ch.is_public ? '# ' : '🔒 ');
    title.textContent = prefix + this.channelLabel(ch);
    const count = (ch.conversation_members || []).length;
    desc.textContent = ch.type === 'direct'
      ? 'Direct message'
      : `${ch.description ? ch.description + ' · ' : ''}${ch.is_public ? 'Open channel' : 'Private'} · ${count} member${count === 1 ? '' : 's'}`;

    if (form) form.style.display = ch.is_archived ? 'none' : 'flex';

    if (actions) {
      const canManage = Permissions.isAdmin() && ch.type !== 'direct';
      actions.style.display = canManage ? 'inline-flex' : 'none';
      actions.innerHTML = canManage ? `
        <button type="button" class="btn btn-secondary btn-sm" id="btnManageChannel"><i data-lucide="settings"></i> Manage</button>
        <button type="button" class="btn btn-secondary btn-sm" id="btnArchiveChannel">${ch.is_archived ? 'Restore' : 'Archive'}</button>
      ` : '';
      document.getElementById('btnManageChannel')?.addEventListener('click', () => this.openManageChannel(ch.id));
      document.getElementById('btnArchiveChannel')?.addEventListener('click', () => this.toggleArchive(ch.id));
    }
    if (window.lucide) window.lucide.createIcons();
  }

  // ------------------------------------------------------------ admin actions

  peopleOptions() {
    return this.employees
      .filter(e => e.employment_status === 'active')
      .map(e => ({ value: e.id, label: e.full_name || e.id }));
  }

  openCreateChannel() {
    formDialog({
      title: 'Create channel',
      subtitle: 'Open channels are visible to all staff; private ones only to the people you add.',
      submitLabel: 'Create channel',
      fields: [
        { name: 'name', label: 'Channel name', required: true, maxlength: 60, placeholder: 'e.g. creative-handoffs' },
        { name: 'description', label: 'Description', maxlength: 300 },
        { name: 'visibility', label: 'Visibility', type: 'select', value: 'private', options: [
          { value: 'private', label: 'Private — invited people only' }, { value: 'public', label: 'Open — all staff can join & read' }] },
        { name: 'memberIds', label: 'Members', type: 'checkboxes', value: [], options: this.peopleOptions().filter(o => o.value !== this.app.currentUser.id) }
      ],
      onSubmit: async (v) => {
        const { id } = await Api.createChannel({ name: v.name, description: v.description, isPublic: v.visibility === 'public', memberIds: v.memberIds });
        Toast.success(`${v.name} created`, 'Channel created');
        await this.loadChatData(id);
      }
    });
  }

  openManageChannel(id) {
    const ch = this.channels.find(c => c.id === id);
    if (!ch) return;
    formDialog({
      title: `Manage ${ch.name}`,
      submitLabel: 'Save changes',
      fields: [
        { name: 'name', label: 'Channel name', required: true, maxlength: 60, value: ch.name || '' },
        { name: 'description', label: 'Description', maxlength: 300, value: ch.description || '' },
        { name: 'visibility', label: 'Visibility', type: 'select', value: ch.is_public ? 'public' : 'private', options: [
          { value: 'private', label: 'Private — members only' }, { value: 'public', label: 'Open — all staff can join & read' }] },
        { name: 'memberIds', label: 'Members', type: 'checkboxes', value: (ch.conversation_members || []).map(m => m.user_id), options: this.peopleOptions() }
      ],
      deleteLabel: 'Delete channel',
      deleteMessage: `"${ch.name}" and all of its messages will be permanently deleted.`,
      onDelete: async () => {
        await Api.deleteChannel(id);
        Toast.success('Channel deleted', 'Deleted');
        this.activeChannelId = null;
        await this.loadChatData();
      },
      onSubmit: async (v) => {
        await Api.updateChannel({ id, name: v.name, description: v.description, isPublic: v.visibility === 'public' });
        await Api.setChannelMembers(id, v.memberIds);
        Toast.success('Channel updated', 'Saved');
        await this.loadChatData(id);
      }
    });
  }

  async toggleArchive(id) {
    const ch = this.channels.find(c => c.id === id);
    if (!ch) return;
    const archiving = !ch.is_archived;
    const ok = await confirmDialog({
      title: archiving ? 'Archive this channel?' : 'Restore this channel?',
      message: archiving ? 'Nobody can post in it any more. Messages are kept and an admin can restore it.' : 'People will be able to post again.',
      confirmLabel: archiving ? 'Archive' : 'Restore'
    });
    if (!ok) return;
    try {
      await Api.archiveChannel(id, archiving);
      await this.loadChatData(id);
    } catch (err) {
      Toast.error(err.message || 'Could not update channel', 'Error');
    }
  }

  openNewDm() {
    const me = this.app.currentUser.id;
    formDialog({
      title: 'New direct message',
      submitLabel: 'Open chat',
      fields: [
        { name: 'userId', label: 'Send a message to', type: 'select', required: true, options: this.peopleOptions().filter(o => o.value !== me) }
      ],
      onSubmit: async (v) => {
        const { id } = await Api.startDirectMessage(v.userId);
        await this.loadChatData(id);
      }
    });
  }

  // ------------------------------------------------------------ messages

  renderMessagesFeed(keepScroll = false) {
    const feed = document.getElementById('chatFeed');
    if (!feed) return;

    if (this.messages.length === 0) {
      feed.innerHTML = `
        <div class="empty-state" style="border:none; padding: 40px 0;">
          <div class="empty-state-icon">💬</div>
          <div class="empty-state-title">No messages yet</div>
          <div class="empty-state-desc">Say hello or dispatch a task handoff to your creative peers.</div>
        </div>
      `;
      return;
    }

    const wasAtBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    const prevTop = feed.scrollTop;
    const isAdmin = Permissions.isAdmin();

    feed.innerHTML = this.messages.map(m => {
      const isMe = m.sender_id === this.app.currentUser.id;
      const canEdit = isMe && m.message_type === 'text';
      const canDelete = isMe || isAdmin;

      return `
        <div class="chat-msg ${isMe ? 'msg-outgoing' : 'msg-incoming'}">
          <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 3px; font-size: 11px;">
            <span class="font-bold text-white">${escapeHTML(m.sender?.full_name || 'Specialist')}</span>
            <span class="text-dim font-mono">${formatRelativeTime(m.created_at)}${m.is_edited ? ' · edited' : ''}</span>
            ${(canEdit || canDelete) ? `<span class="card-actions" style="margin: 0 0 0 auto;">
              ${canEdit ? `<button type="button" class="card-act msg-act-edit" data-id="${m.id}" title="Edit message" aria-label="Edit message"><i data-lucide="pencil"></i></button>` : ''}
              ${canDelete ? `<button type="button" class="card-act card-act-delete msg-act-delete" data-id="${m.id}" title="Delete message" aria-label="Delete message"><i data-lucide="trash-2"></i></button>` : ''}
            </span>` : ''}
          </div>

          <div class="chat-msg-bubble">
            ${escapeHTML(m.content)}

            ${m.message_type === 'task_handoff' && m.metadata?.task_title ? `
              <div class="chat-task-card">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <span class="badge badge-indigo font-mono">TASK HANDOFF</span>
                  <span class="badge badge-amber">Action Required</span>
                </div>
                <div class="font-bold text-white text-xs" style="margin-top: 4px;">
                  ${escapeHTML(m.metadata.task_title)}
                </div>
                <div class="text-2xs text-muted">
                  Assigned to: <strong>${escapeHTML(m.metadata.assignee_name || 'Specialist')}</strong>
                </div>
              </div>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');

    feed.querySelectorAll('.chat-msg').forEach(el => {
      el.addEventListener('mouseenter', () => { const a = el.querySelector('.card-actions'); if (a) a.style.opacity = 1; });
      el.addEventListener('mouseleave', () => { const a = el.querySelector('.card-actions'); if (a) a.style.opacity = 0; });
    });
    feed.querySelectorAll('.msg-act-edit').forEach(b => b.addEventListener('click', () => this.editMessage(b.dataset.id)));
    feed.querySelectorAll('.msg-act-delete').forEach(b => b.addEventListener('click', () => this.deleteMessage(b.dataset.id)));
    if (window.lucide) window.lucide.createIcons();

    // new messages scroll into view; edits/deletes while reading history keep position
    feed.scrollTop = (!keepScroll || wasAtBottom) ? feed.scrollHeight : prevTop;
  }

  editMessage(id) {
    const m = this.messages.find(x => x.id === id);
    if (!m) return;
    formDialog({
      title: 'Edit message',
      fields: [{ name: 'content', label: 'Message', type: 'textarea', required: true, rows: 4, value: m.content, maxlength: 4000 }],
      onSubmit: async (v) => {
        await Api.editMessage(id, v.content);
      }
    });
  }

  async deleteMessage(id) {
    const ok = await confirmDialog({ title: 'Delete this message?', message: 'It will be removed for everyone in this conversation.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await Api.deleteMessage(id);
      this.messages = this.messages.filter(m => m.id !== id); // instant locally; realtime updates everyone else
      this.renderMessagesFeed(true);
    } catch (err) {
      Toast.error(err.message || 'Could not delete message', 'Error');
    }
  }

  async handleSendMessage() {
    const input = document.getElementById('chatInput');
    const text = input?.value.trim();
    if (!text || !this.activeChannelId) return;

    input.value = '';
    try {
      const { data, error } = await getSupabase().from('messages').insert({
        conversation_id: this.activeChannelId,
        sender_id: this.app.currentUser.id,
        content: text,
        message_type: 'text'
      }).select(MESSAGE_SELECT).single();
      if (error) throw error;
      // show immediately; the realtime echo is ignored because the id is already present
      if (!this.messages.some(m => m.id === data.id)) {
        this.messages.push(data);
        this.renderMessagesFeed();
      }
    } catch (err) {
      console.error('Send error:', err);
      input.value = text;
      Toast.error('Failed to post message', 'Chat Error');
    }
  }

  async handleDispatchTaskFromChat() {
    const titleInput = document.getElementById('quickTaskTitle');
    const assigneeSelect = document.getElementById('quickTaskAssignee');

    const title = titleInput?.value.trim();
    if (!title) {
      Toast.warning('Please enter a deliverable title', 'Required');
      return;
    }

    const assignedTo = assigneeSelect.value;
    const assigneeName = assigneeSelect.selectedOptions[0]?.text.split('(')[0].replace('To: ', '').trim();

    titleInput.value = '';
    document.getElementById('chatHandoffBar').style.display = 'none';

    try {
      const d = new Date();
      d.setDate(d.getDate() + 4);

      const { task: newTask } = await Api.createTask({
        title,
        assignedTo,
        priority: 'high',
        dueDate: d.toISOString().split('T')[0],
        description: `Dispatched directly in studio chat by ${this.app.currentProfile.full_name}.`
      });

      const { data } = await getSupabase().from('messages').insert({
        conversation_id: this.activeChannelId,
        sender_id: this.app.currentUser.id,
        content: `⚡ Dispatched new deliverable to ${assigneeName}: "${title}"`,
        message_type: 'task_handoff',
        metadata: {
          task_id: newTask.id,
          task_number: newTask.task_number,
          task_title: title,
          assignee_name: assigneeName
        }
      }).select(MESSAGE_SELECT).single();

      Toast.success('Deliverable card posted to channel!', 'Handoff Dispatched');
      if (data && !this.messages.some(m => m.id === data.id)) {
        this.messages.push(data);
        this.renderMessagesFeed();
      }
    } catch (err) {
      console.error('Handoff error:', err);
      Toast.error(err.message || 'Handoff failed', 'Error');
    }
  }
}
