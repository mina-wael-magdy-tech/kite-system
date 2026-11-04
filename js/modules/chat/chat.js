/**
 * KITE SYSTEM — Module J: Communication & Role Chat
 * Slack-style studio channels, group chats, direct messages, voice notes, files, reactions,
 * replies, voice/video calls and instant task handoffs.
 *
 * Privacy: you only ever see conversations you are a member of (plus open channels).
 * Admins can manage channels but cannot read other people's private channels or DMs — enforced by
 * row-level security in the database (migration 016), not by this file.
 */

import { getSupabase } from '../../supabase-client.js';
import { CONFIG } from '../../config.js';
import { Toast } from '../../services/toast-service.js';
import { Api } from '../../services/api.js';
import { Calls } from '../../services/call-service.js';
import { Permissions } from '../../permissions/permission-service.js';
import { formDialog, confirmDialog } from '../../ui/dialogs.js';
import { escapeHTML, getInitials, getAccentHex } from '../../utils/helpers.js';
import { linkify } from '../../utils/linkify.js';
import { ASSIGNEE_SELECT, assigneeOptionsHTML, selectedDeptId } from '../../utils/assignees.js';
import { Notifications } from '../../services/notification-service.js';

const MESSAGE_SELECT = '*, sender:profiles!messages_sender_id_fkey(id, full_name, avatar_url)';
const BUCKET = CONFIG.STORAGE_BUCKETS.CHAT_MEDIA;
const QUICK_EMOJI = ['👍', '❤️', '😂', '🎉', '🙏', '👀'];
const MAX_VOICE_SECONDS = 300;
const RASTER_IMAGE = /^image\/(png|jpe?g|webp|gif)$/i;
let channelSeq = 0; // supabase-js returns the SAME channel for a repeated name; every name must be unique

const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDur = (s = 0) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const fmtSize = (b = 0) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
function dayLabel(iso) {
  const d = new Date(iso); const today = new Date();
  const diff = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

export class ChatModule {
  constructor(app) {
    this.app = app;
    this.channels = [];
    this.activeChannelId = null;
    this.messages = [];
    this.reactions = [];       // reactions of the open conversation
    this.employees = [];
    this.unread = {};
    this.realtimeSub = null;
    this.listTimer = null;
    this.replyTo = null;
    this.urlCache = new Map(); // storage path -> { url, exp }
    this.audio = null;         // the one voice note that may play at a time
    this.playingId = null;
    this.rec = null;           // active voice recording
    this.search = '';
  }

  async render(container, query = '') {
    this.teardownRealtime();
    this.stopAudio();
    this.cancelRecording();
    const params = new URLSearchParams(query || '');
    this.activeChannelId = params.get('c') || this.activeChannelId;
    this.pendingCall = params.get('call') ? { id: params.get('call'), kind: params.get('kind') === 'audio' ? 'audio' : 'video', conv: params.get('c') } : null;
    Calls.init(this.app);

    container.innerHTML = `
      <div class="page-container chat-page animate-fade-in" id="chatPage">
        <div class="chat-head" style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-3);">
          <div>
            <h1 class="font-display font-bold text-xl text-white">Studio Channels & Direct Messages</h1>
            <p class="text-xs text-muted">Private by design: you only see conversations you belong to.</p>
          </div>
          <span class="badge badge-emerald" id="chatLiveBadge">Connecting…</span>
        </div>

        <div class="chat-layout" style="flex: 1; min-height: 0;">
          <div class="chat-sidebar">
            <div style="padding: var(--space-3-5); border-bottom: 1px solid var(--border-subtle); background: var(--studio-950); display: flex; align-items: center; justify-content: space-between; gap: var(--space-2);">
              <div>
                <div class="font-display font-bold text-xs text-white">Conversations</div>
                <div class="text-2xs text-muted">Channels, groups & direct messages</div>
              </div>
              <div style="display: flex; gap: 4px;">
                <button type="button" class="card-act" id="btnNewDm" title="New direct message" aria-label="New direct message" style="opacity:1;"><i data-lucide="message-circle"></i></button>
                ${Permissions.isAdmin() ? '<button type="button" class="card-act" id="btnNewChannel" title="Create channel" aria-label="Create channel" style="opacity:1;"><i data-lucide="plus"></i></button>' : ''}
              </div>
            </div>
            <div style="padding: var(--space-2) var(--space-2) 0;">
              <input id="chatSearch" type="search" class="form-control" placeholder="Search conversations…" aria-label="Search conversations" style="height: 32px;" />
            </div>
            <div id="chatChannelsList" style="flex: 1; overflow-y: auto; padding: var(--space-2); display: flex; flex-direction: column; gap: var(--space-1);"></div>
          </div>

          <div class="chat-window">
            <div id="chatActiveHeader" style="padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border-subtle); background: var(--studio-950); display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap;">
              <div style="display: flex; align-items: center; gap: var(--space-2); min-width: 0;">
                <button type="button" class="chat-back card-act" id="btnChatBack" aria-label="Back to conversations" style="opacity:1;"><i data-lucide="chevron-left"></i></button>
                <div style="min-width: 0;">
                  <div class="font-bold text-sm text-white truncate" id="activeChannelTitle">Channels</div>
                  <div class="text-2xs text-muted truncate" id="activeChannelDesc"></div>
                </div>
              </div>
              <div style="display: flex; gap: var(--space-2); flex-wrap: wrap; justify-content: flex-end; align-items: center;">
                <span id="chatCallActions" style="display: none; gap: 4px;">
                  <button type="button" class="card-act" id="btnVoiceCall" title="Start a voice call" aria-label="Start a voice call" style="opacity:1;"><i data-lucide="phone"></i></button>
                  <button type="button" class="card-act" id="btnVideoCall" title="Start a video call" aria-label="Start a video call" style="opacity:1;"><i data-lucide="video"></i></button>
                </span>
                <span id="chatAdminActions" style="display: none; gap: var(--space-2);"></span>
                <button type="button" class="btn btn-secondary btn-sm" id="btnToggleHandoffBar">
                  <i data-lucide="zap"></i> Task card
                </button>
              </div>
            </div>

            <div id="chatHandoffBar" class="glass-panel" style="display: none; padding: var(--space-3); margin: var(--space-3); background: rgba(99, 102, 241, 0.1); border-color: var(--color-primary-border); flex-direction: column; gap: var(--space-2);">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span class="text-xs font-bold text-primary">Instant Task Handoff in Chat</span>
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

            <div class="chat-feed slk-feed" id="chatFeed">
              <div class="empty-state" style="border:none; padding: 40px 0;">
                <div class="empty-state-icon animate-spin">⟳</div>
                <div class="empty-state-title">Loading messages...</div>
              </div>
            </div>

            <div id="chatReplyBar" class="slk-replybar" style="display: none;"></div>

            <form id="chatMessageForm" class="slk-composer" autocomplete="off">
              <input type="file" id="chatFile" hidden />
              <button type="button" class="card-act slk-tool" id="btnAttach" title="Attach a file or photo" aria-label="Attach a file or photo"><i data-lucide="paperclip"></i></button>
              <input type="text" id="chatInput" autocomplete="off" maxlength="4000"
                placeholder="Message…" class="form-control" style="height: 40px;" />
              <button type="button" class="card-act slk-tool" id="btnMic" title="Record a voice note" aria-label="Record a voice note"><i data-lucide="mic"></i></button>
              <button type="submit" class="btn btn-primary btn-sm" id="btnSend" style="height: 40px; padding: 0 var(--space-4);" hidden>Send</button>
            </form>
            <div id="chatRecorder" class="slk-recorder" style="display: none;"></div>
          </div>
        </div>
      </div>
    `;

    this.attachEventListeners();
    const fromLink = params.get('c');
    await this.loadChatData();
    if (fromLink && this.activeChannelId === fromLink) this.setMobileView(true);
    this.subscribeRealtime();

    if (this.pendingCall && this.pendingCall.conv === this.activeChannelId) {
      const ch = this.channels.find(c => c.id === this.activeChannelId);
      Calls.showIncoming({ conversation_id: this.pendingCall.conv, call_id: this.pendingCall.id, kind: this.pendingCall.kind },
        ch ? this.channelLabel(ch) : 'Incoming call', ch && ch.type !== 'direct' ? this.channelLabel(ch) : '');
      this.pendingCall = null;
    }
  }

  attachEventListeners() {
    const handoffBar = document.getElementById('chatHandoffBar');
    document.getElementById('btnToggleHandoffBar')?.addEventListener('click', () => {
      handoffBar.style.display = handoffBar.style.display === 'flex' ? 'none' : 'flex';
    });
    document.getElementById('btnCancelHandoff')?.addEventListener('click', () => { handoffBar.style.display = 'none'; });
    document.getElementById('btnDispatchChatTask')?.addEventListener('click', () => this.handleDispatchTaskFromChat());
    document.getElementById('btnChatBack')?.addEventListener('click', () => this.setMobileView(false));
    document.getElementById('btnNewChannel')?.addEventListener('click', () => this.openCreateChannel());
    document.getElementById('btnNewDm')?.addEventListener('click', () => this.openNewDm());
    document.getElementById('chatMessageForm')?.addEventListener('submit', async (e) => { e.preventDefault(); await this.handleSendMessage(); });

    const input = document.getElementById('chatInput');
    input?.addEventListener('input', () => this.syncComposer());
    document.getElementById('chatSearch')?.addEventListener('input', (e) => { this.search = e.target.value.trim().toLowerCase(); this.renderChannelsList(); });

    document.getElementById('btnAttach')?.addEventListener('click', () => document.getElementById('chatFile')?.click());
    document.getElementById('chatFile')?.addEventListener('change', (e) => {
      const f = e.target.files?.[0]; e.target.value = '';
      if (f) this.sendFile(f);
    });
    document.getElementById('btnMic')?.addEventListener('click', () => this.startRecording());
    document.getElementById('btnVoiceCall')?.addEventListener('click', () => this.callHere('audio'));
    document.getElementById('btnVideoCall')?.addEventListener('click', () => this.callHere('video'));

    // pasting a screenshot sends it as a photo
    input?.addEventListener('paste', (e) => {
      const f = [...(e.clipboardData?.files || [])][0];
      if (f) { e.preventDefault(); this.sendFile(f); }
    });
    // close the emoji popover when clicking elsewhere
    this.onDocClick = (e) => { if (!e.target.closest('.slk-emoji-pop, [data-react-add]')) document.querySelectorAll('.slk-emoji-pop').forEach(p => p.remove()); };
    document.addEventListener('click', this.onDocClick);
  }

  /** Text present → show Send; otherwise show the microphone. */
  syncComposer() {
    const has = !!document.getElementById('chatInput')?.value.trim();
    const send = document.getElementById('btnSend'); const mic = document.getElementById('btnMic');
    if (send) send.hidden = !has;
    if (mic) mic.hidden = has;
  }

  /** Phones show either the conversation list or one conversation (like Slack / WhatsApp). */
  setMobileView(open) {
    document.getElementById('chatPage')?.classList.toggle('chat-open', !!open);
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
        const { data: emps } = await supabase.from('profiles').select(ASSIGNEE_SELECT + ', employment_status');
        this.employees = emps || [];
        const select = document.getElementById('quickTaskAssignee');
        if (select) select.innerHTML = assigneeOptionsHTML(this.employees.filter(e => e.employment_status === 'active'), 'To: ');
      }

      const visible = this.visibleChannels();
      const wanted = selectId || this.activeChannelId;
      const previous = this.activeChannelId;
      this.activeChannelId = visible.some(c => c.id === wanted) ? wanted : (visible[0]?.id || null);
      if (this.activeChannelId) delete this.unread[this.activeChannelId];

      this.renderChannelsList();
      this.renderHeader();
      if (selectId && this.activeChannelId === selectId) this.setMobileView(true);

      if (!this.activeChannelId) {
        this.messages = [];
        this.reactions = [];
        const feed = document.getElementById('chatFeed');
        if (feed) feed.innerHTML = `<div class="empty-state" style="border:none;"><div class="empty-state-title">No conversations yet</div><div class="empty-state-desc">${Permissions.isAdmin() ? 'Create a channel with the + button, or start a direct message.' : 'Ask an administrator to add you to a channel, or start a direct message.'}</div></div>`;
        return;
      }
      if (this.activeChannelId !== previous || !this.messages.length || selectId) {
        await this.loadMessages(this.activeChannelId);
      }
    } catch (err) {
      console.warn('Chat load error:', err);
    }
  }

  visibleChannels() {
    // the database already limits this to conversations you may see; admins no longer get everybody's
    return this.channels.filter(c => !c.is_archived || (c.conversation_members || []).some(m => m.user_id === this.app.currentUser.id) || Permissions.isAdmin());
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
      const [{ data: msgs }, { data: reacts }] = await Promise.all([
        supabase.from('messages').select(MESSAGE_SELECT).eq('conversation_id', channelId)
          .order('created_at', { ascending: false }).limit(200),
        supabase.from('message_reactions').select('id, message_id, user_id, emoji').eq('conversation_id', channelId)
      ]);
      if (channelId !== this.activeChannelId) return; // user switched away meanwhile
      Notifications.activeConversationId = channelId;
      Notifications.markConversationRead(channelId);
      this.messages = (msgs || []).reverse();
      this.reactions = reacts || [];
      this.replyTo = null; this.renderReplyBar();
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
      .channel(`kite-chat-${this.app.currentUser.id}-${++channelSeq}-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, (p) => this.onMessageChange(p))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, (p) => this.onReactionChange(p))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, () => this.scheduleListRefresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_members' }, () => this.scheduleListRefresh())
      .subscribe((status) => {
        const badge = document.getElementById('chatLiveBadge');
        if (!badge) return;
        const live = status === 'SUBSCRIBED';
        badge.textContent = live ? 'Live' : (status === 'CONNECTING' || status === 'JOINING' ? 'Connecting…' : 'Reconnecting…');
        badge.className = `badge ${live ? 'badge-emerald' : 'badge-amber'}`;
        this.setFallbackPolling(!live);
      });
  }

  /** Safety net while the WebSocket is down: refresh the open conversation every few seconds. */
  setFallbackPolling(on) {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (!on) return;
    this.pollTimer = setInterval(() => {
      if (!document.getElementById('chatFeed') || document.hidden || !this.activeChannelId) return;
      this.loadMessages(this.activeChannelId);
    }, 4000);
  }

  teardownRealtime() {
    Notifications.activeConversationId = null;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    const supabase = getSupabase();
    if (this.realtimeSub && supabase) supabase.removeChannel(this.realtimeSub);
    this.realtimeSub = null;
    clearTimeout(this.listTimer);
    if (this.onDocClick) { document.removeEventListener('click', this.onDocClick); this.onDocClick = null; }
  }

  scheduleListRefresh() {
    clearTimeout(this.listTimer);
    this.listTimer = setTimeout(() => {
      if (document.getElementById('chatChannelsList')) this.loadChatData();
    }, 300);
  }

  onReactionChange(payload) {
    if (!document.getElementById('chatFeed')) return;
    const row = payload.eventType === 'DELETE' ? payload.old : payload.new;
    if (!row || (row.conversation_id && row.conversation_id !== this.activeChannelId)) return;
    const same = (r) => r.message_id === row.message_id && r.user_id === row.user_id && r.emoji === row.emoji;
    if (payload.eventType === 'DELETE') this.reactions = this.reactions.filter(r => r.id !== row.id && !same(r));
    else if (!this.reactions.some(same)) this.reactions.push(row);
    this.renderMessagesFeed(true);
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
      if (eventType === 'INSERT' && row.sender_id !== this.app.currentUser.id) {
        this.unread[row.conversation_id] = (this.unread[row.conversation_id] || 0) + 1;
        this.renderChannelsList();
        const ch = this.channels.find(c => c.id === row.conversation_id);
        if (ch) Toast.info(`New message in ${this.channelLabel(ch)}`, 'Chat');
      }
      return;
    }

    if (eventType === 'INSERT') {
      if (this.messages.some(m => m.id === row.id)) return;
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

    const q = this.search;
    const list = this.visibleChannels().filter(c => !q || this.channelLabel(c).toLowerCase().includes(q));
    const channels = list.filter(c => c.type !== 'direct');
    const dms = list.filter(c => c.type === 'direct');

    const item = (ch) => {
      const active = ch.id === this.activeChannelId;
      const n = this.unread[ch.id];
      const label = this.channelLabel(ch);
      const lead = ch.type === 'direct'
        ? `<span class="slk-avatar slk-avatar-sm" style="background:${getAccentHex(label)}">${escapeHTML(getInitials(label))}</span>`
        : `<i data-lucide="${ch.is_public ? 'hash' : 'lock'}"></i>`;
      return `
        <button type="button" class="nav-item ${active ? 'active' : ''}" style="width: 100%; text-align: left;" data-channel-id="${ch.id}">
          ${lead}
          <span class="truncate" style="${n ? 'font-weight: 700;' : ''}">${escapeHTML(label)}${ch.is_archived ? ' <span class="text-dim">(archived)</span>' : ''}</span>
          ${n ? `<span class="badge badge-brand" style="margin-left: auto;">${n}</span>` : ''}
        </button>`;
    };
    const section = (title, items, empty) => `
      <div class="text-2xs text-dim font-bold" style="padding: var(--space-2) var(--space-2) 2px; text-transform: uppercase; letter-spacing: 0.05em;">${title}</div>
      ${items.length ? items.map(item).join('') : `<div class="text-2xs text-dim" style="padding: 2px var(--space-2);">${empty}</div>`}`;

    container.innerHTML =
      section('Channels', channels, q ? 'No match' : (Permissions.isAdmin() ? 'None yet — use +' : 'No channels yet')) +
      section('Direct messages', dms, q ? 'No match' : 'Use the message icon to start one');

    container.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', async () => {
        this.activeChannelId = btn.getAttribute('data-channel-id');
        this.setMobileView(true);
        delete this.unread[this.activeChannelId];
        this.stopAudio();
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
    const callActions = document.getElementById('chatCallActions');
    const form = document.getElementById('chatMessageForm');
    if (!title) return;

    if (!ch) {
      title.textContent = 'Channels';
      desc.textContent = '';
      if (actions) actions.style.display = 'none';
      if (callActions) callActions.style.display = 'none';
      return;
    }

    const prefix = ch.type === 'direct' ? '' : (ch.is_public ? '# ' : '🔒 ');
    title.textContent = prefix + this.channelLabel(ch);
    const count = (ch.conversation_members || []).length;
    desc.textContent = ch.type === 'direct'
      ? 'Private direct message'
      : `${ch.description ? ch.description + ' · ' : ''}${ch.is_public ? 'Open channel' : 'Private channel'} · ${count} member${count === 1 ? '' : 's'}`;

    if (form) form.style.display = ch.is_archived ? 'none' : 'flex';
    if (callActions) callActions.style.display = ch.is_archived ? 'none' : 'inline-flex';

    if (actions) {
      const isMember = (ch.conversation_members || []).some(m => m.user_id === this.app.currentUser.id);
      const canManage = Permissions.isAdmin() && ch.type !== 'direct';
      actions.style.display = canManage ? 'inline-flex' : 'none';
      actions.innerHTML = canManage ? `
        <button type="button" class="btn btn-secondary btn-sm" id="btnManageChannel"><i data-lucide="settings"></i> Manage</button>
        <button type="button" class="btn btn-secondary btn-sm" id="btnArchiveChannel">${ch.is_archived ? 'Restore' : 'Archive'}</button>
      ` : '';
      void isMember;
      document.getElementById('btnManageChannel')?.addEventListener('click', () => this.openManageChannel(ch.id));
      document.getElementById('btnArchiveChannel')?.addEventListener('click', () => this.toggleArchive(ch.id));
    }
    if (window.lucide) window.lucide.createIcons();
  }

  // ------------------------------------------------------------ calls

  callHere(kind) {
    const ch = this.channels.find(c => c.id === this.activeChannelId);
    if (!ch) return;
    Calls.start(ch.id, kind, this.channelLabel(ch));
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

  reactionsFor(messageId) {
    const me = this.app.currentUser.id;
    const map = new Map();
    for (const r of this.reactions) {
      if (r.message_id !== messageId) continue;
      const e = map.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false, names: [] };
      e.count++; e.mine = e.mine || r.user_id === me; e.names.push(r.user_id === me ? 'You' : this.personName(r.user_id));
      map.set(r.emoji, e);
    }
    return [...map.values()];
  }

  mediaHTML(m) {
    const md = m.metadata || {};
    if (m.message_type === 'voice') {
      const peaks = (md.peaks?.length ? md.peaks : Array.from({ length: 32 }, (_, i) => 30 + ((i * 37) % 50)));
      return `<div class="slk-voice" data-voice="${m.id}">
        <button type="button" class="slk-voice-btn" data-voice-play="${m.id}" aria-label="Play voice note"><i data-lucide="${this.playingId === m.id ? 'pause' : 'play'}"></i></button>
        <div class="slk-voice-wave" data-voice-wave="${m.id}">${peaks.map(p => `<i style="height:${Math.max(12, p)}%"></i>`).join('')}</div>
        <span class="slk-voice-time">${fmtDur(md.duration || 0)}</span>
      </div>`;
    }
    if (m.message_type === 'image' && RASTER_IMAGE.test(md.mime || '')) {
      return `<img class="slk-img" alt="${escapeHTML(md.name || 'Photo')}" data-img-path="${escapeHTML(md.path)}" data-open-path="${escapeHTML(md.path)}" />`;
    }
    if (m.message_type === 'file' || m.message_type === 'image') {
      return `<button type="button" class="slk-file" data-file-path="${escapeHTML(md.path)}" data-file-name="${escapeHTML(md.name || 'file')}">
        <i data-lucide="file-down"></i><span><b>${escapeHTML(md.name || 'file')}</b><small>${fmtSize(md.size)}</small></span></button>`;
    }
    return '';
  }

  renderMessagesFeed(keepScroll = false) {
    const feed = document.getElementById('chatFeed');
    if (!feed) return;

    if (this.messages.length === 0) {
      feed.innerHTML = `
        <div class="empty-state" style="border:none; padding: 40px 0;">
          <div class="empty-state-icon"><i data-lucide="message-square"></i></div>
          <div class="empty-state-title">No messages yet</div>
          <div class="empty-state-desc">Say hello, send a voice note, or start a call.</div>
        </div>`;
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    const wasAtBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    const prevTop = feed.scrollTop;
    const me = this.app.currentUser.id;
    const ch = this.channels.find(c => c.id === this.activeChannelId);
    const canModerate = Permissions.isAdmin() && ch && ch.type !== 'direct';

    let lastDay = '', prev = null;
    feed.innerHTML = this.messages.map(m => {
      const isMe = m.sender_id === me;
      const name = m.sender?.full_name || 'Specialist';
      const day = new Date(m.created_at).toDateString();
      const sep = day !== lastDay ? `<div class="slk-day"><span>${dayLabel(m.created_at)}</span></div>` : '';
      const grouped = prev && prev.sender_id === m.sender_id && day === lastDay && (new Date(m.created_at) - new Date(prev.created_at)) < 5 * 60000
        && prev.message_type !== 'call' && m.message_type !== 'call';
      lastDay = day; prev = m;

      const canEdit = isMe && m.message_type === 'text' && !String(m.id).startsWith('tmp-');
      const canDelete = (isMe || canModerate) && !String(m.id).startsWith('tmp-');
      const reply = m.reply_to_id ? this.messages.find(x => x.id === m.reply_to_id) : null;
      const reacts = this.reactionsFor(m.id);

      let body;
      if (m.message_type === 'call') {
        const md = m.metadata || {};
        const fresh = Date.now() - new Date(md.started_at || m.created_at).getTime() < 3 * 3600 * 1000;
        body = `<div class="slk-callcard"><i data-lucide="${md.kind === 'audio' ? 'phone' : 'video'}"></i>
          <span>${escapeHTML(m.content)}</span>
          ${fresh && !String(m.id).startsWith('tmp-') ? `<button type="button" class="btn btn-primary btn-sm" data-join-call="${escapeHTML(md.call_id || '')}" data-kind="${md.kind === 'audio' ? 'audio' : 'video'}">Join</button>` : '<small class="text-dim">ended</small>'}</div>`;
      } else {
        const showText = m.message_type === 'text' || m.message_type === 'task_handoff' || (m.content && !/^(🎤|🖼️|📎) /.test(m.content));
        body = `${showText ? `<div class="slk-text">${linkify(m.content)}</div>` : ''}${this.mediaHTML(m)}
          ${m.message_type === 'task_handoff' && m.metadata?.task_title ? `
            <div class="chat-task-card">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span class="badge badge-indigo font-mono">TASK HANDOFF</span><span class="badge badge-amber">Action Required</span>
              </div>
              <div class="font-bold text-white text-xs" style="margin-top: 4px;">${escapeHTML(m.metadata.task_title)}</div>
              <div class="text-2xs text-muted">Assigned to: <strong>${escapeHTML(m.metadata.assignee_name || 'Specialist')}</strong></div>
            </div>` : ''}`;
      }

      const tmp = String(m.id).startsWith('tmp-');
      return `${sep}
        <div class="slk-msg ${grouped ? 'grouped' : ''} ${tmp ? 'sending' : ''}" data-mid="${m.id}">
          <div class="slk-gutter">${grouped
            ? `<span class="slk-hovertime">${fmtTime(m.created_at)}</span>`
            : `<span class="slk-avatar" style="background:${getAccentHex(name)}">${escapeHTML(getInitials(name))}</span>`}</div>
          <div class="slk-main">
            ${grouped ? '' : `<div class="slk-meta"><b>${escapeHTML(name)}</b><span>${fmtTime(m.created_at)}</span>${m.is_edited ? '<span>(edited)</span>' : ''}</div>`}
            ${reply ? `<div class="slk-quote"><b>${escapeHTML(reply.sender?.full_name || 'Specialist')}</b> ${escapeHTML((reply.content || '').slice(0, 90))}</div>` : (m.reply_to_id ? '<div class="slk-quote">Original message</div>' : '')}
            ${body}
            ${reacts.length || !tmp ? `<div class="slk-reacts">
              ${reacts.map(r => `<button type="button" class="slk-react ${r.mine ? 'mine' : ''}" data-react="${m.id}" data-emoji="${r.emoji}" title="${escapeHTML(r.names.join(', '))}">${r.emoji} ${r.count}</button>`).join('')}
              ${tmp ? '' : `<button type="button" class="slk-react slk-react-add" data-react-add="${m.id}" aria-label="Add reaction"><i data-lucide="smile-plus"></i></button>`}
            </div>` : ''}
          </div>
          ${tmp ? '' : `<div class="slk-actions">
            <button type="button" class="card-act" data-reply="${m.id}" title="Reply" aria-label="Reply"><i data-lucide="corner-up-left"></i></button>
            ${canEdit ? `<button type="button" class="card-act" data-edit="${m.id}" title="Edit" aria-label="Edit message"><i data-lucide="pencil"></i></button>` : ''}
            ${canDelete ? `<button type="button" class="card-act card-act-delete" data-del="${m.id}" title="Delete" aria-label="Delete message"><i data-lucide="trash-2"></i></button>` : ''}
          </div>`}
        </div>`;
    }).join('');

    feed.querySelectorAll('[data-reply]').forEach(b => b.addEventListener('click', () => this.setReply(b.dataset.reply)));
    feed.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => this.editMessage(b.dataset.edit)));
    feed.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => this.deleteMessage(b.dataset.del)));
    feed.querySelectorAll('[data-react]').forEach(b => b.addEventListener('click', () => this.toggleReaction(b.dataset.react, b.dataset.emoji)));
    feed.querySelectorAll('[data-react-add]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); this.openEmojiPicker(b); }));
    feed.querySelectorAll('[data-join-call]').forEach(b => b.addEventListener('click', () => {
      const c = this.channels.find(x => x.id === this.activeChannelId);
      Calls.join(this.activeChannelId, b.dataset.joinCall, b.dataset.kind, c ? this.channelLabel(c) : '');
    }));
    feed.querySelectorAll('[data-voice-play]').forEach(b => b.addEventListener('click', () => this.toggleVoice(b.dataset.voicePlay)));
    feed.querySelectorAll('[data-open-path]').forEach(i => i.addEventListener('click', async () => { const u = await this.signedUrl(i.dataset.openPath); if (u) window.open(u, '_blank', 'noopener'); }));
    feed.querySelectorAll('[data-file-path]').forEach(b => b.addEventListener('click', async () => {
      const u = await this.signedUrl(b.dataset.filePath, b.dataset.fileName);
      if (u) { const a = document.createElement('a'); a.href = u; a.rel = 'noopener'; a.click(); }
    }));
    this.hydrateImages(feed);
    if (window.lucide) window.lucide.createIcons();

    feed.scrollTop = (!keepScroll || wasAtBottom) ? feed.scrollHeight : prevTop;
  }

  // ------------------------------------------------------------ media helpers

  /** Short-lived signed link; the bucket is private, so nobody can open a file without being a member. */
  async signedUrl(path, downloadName) {
    const key = downloadName ? `${path}|${downloadName}` : path;
    const hit = this.urlCache.get(key);
    if (hit && hit.exp > Date.now() + 60_000) return hit.url;
    const { data, error } = await getSupabase().storage.from(BUCKET).createSignedUrl(path, 3600, downloadName ? { download: downloadName } : undefined);
    if (error || !data?.signedUrl) { Toast.error('Could not open this file.', 'Chat'); return null; }
    this.urlCache.set(key, { url: data.signedUrl, exp: Date.now() + 3600_000 });
    return data.signedUrl;
  }

  async hydrateImages(feed) {
    const imgs = [...feed.querySelectorAll('img[data-img-path]')].filter(i => !i.getAttribute('src'));
    await Promise.all(imgs.map(async (img) => {
      const u = await this.signedUrl(img.dataset.imgPath);
      if (u && img.isConnected) img.src = u;
    }));
  }

  async toggleVoice(id) {
    const m = this.messages.find(x => x.id === id);
    if (!m) return;
    if (this.playingId === id && this.audio) { this.stopAudio(); this.renderMessagesFeed(true); return; }
    this.stopAudio();
    const url = await this.signedUrl(m.metadata.path);
    if (!url) return;
    const audio = new Audio(url);
    this.audio = audio; this.playingId = id;
    audio.addEventListener('timeupdate', () => {
      const wave = document.querySelector(`[data-voice-wave="${id}"]`);
      if (!wave || !audio.duration) return;
      const pct = audio.currentTime / audio.duration;
      [...wave.children].forEach((bar, i) => bar.classList.toggle('played', i / wave.children.length < pct));
    });
    audio.addEventListener('ended', () => { this.stopAudio(); this.renderMessagesFeed(true); });
    try { await audio.play(); } catch { this.stopAudio(); }
    this.renderMessagesFeed(true);
  }

  stopAudio() {
    if (this.audio) { this.audio.pause(); this.audio = null; }
    this.playingId = null;
  }

  // ------------------------------------------------------------ reactions & replies

  openEmojiPicker(anchor) {
    document.querySelectorAll('.slk-emoji-pop').forEach(p => p.remove());
    const pop = document.createElement('div');
    pop.className = 'slk-emoji-pop';
    pop.innerHTML = QUICK_EMOJI.map(e => `<button type="button" data-e="${e}">${e}</button>`).join('');
    anchor.parentElement.appendChild(pop);
    pop.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { pop.remove(); this.toggleReaction(anchor.dataset.reactAdd, b.dataset.e); }));
  }

  async toggleReaction(messageId, emoji) {
    const me = this.app.currentUser.id;
    try {
      const { active } = await Api.toggleReaction(messageId, emoji);
      const same = (r) => r.message_id === messageId && r.user_id === me && r.emoji === emoji;
      if (active && !this.reactions.some(same)) this.reactions.push({ id: `local-${Date.now()}`, message_id: messageId, user_id: me, emoji });
      if (!active) this.reactions = this.reactions.filter(r => !same(r));
      this.renderMessagesFeed(true);
    } catch (err) {
      Toast.error(err.message || 'Could not react', 'Chat');
    }
  }

  setReply(id) {
    this.replyTo = this.messages.find(m => m.id === id) || null;
    this.renderReplyBar();
    document.getElementById('chatInput')?.focus();
  }

  renderReplyBar() {
    const bar = document.getElementById('chatReplyBar');
    if (!bar) return;
    if (!this.replyTo) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
    bar.style.display = 'flex';
    bar.innerHTML = `<span>Replying to <b>${escapeHTML(this.replyTo.sender?.full_name || 'Specialist')}</b>: ${escapeHTML((this.replyTo.content || '').slice(0, 80))}</span>
      <button type="button" class="card-act" id="btnCancelReply" aria-label="Cancel reply" style="opacity:1;">&times;</button>`;
    document.getElementById('btnCancelReply')?.addEventListener('click', () => { this.replyTo = null; this.renderReplyBar(); });
  }

  editMessage(id) {
    const m = this.messages.find(x => x.id === id);
    if (!m) return;
    formDialog({
      title: 'Edit message',
      fields: [{ name: 'content', label: 'Message', type: 'textarea', required: true, rows: 4, value: m.content, maxlength: 4000 }],
      onSubmit: async (v) => { await Api.editMessage(id, v.content); }
    });
  }

  async deleteMessage(id) {
    const ok = await confirmDialog({ title: 'Delete this message?', message: 'It will be removed for everyone in this conversation.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await Api.deleteMessage(id);
      this.messages = this.messages.filter(m => m.id !== id);
      this.renderMessagesFeed(true);
    } catch (err) {
      Toast.error(err.message || 'Could not delete message', 'Error');
    }
  }

  // ------------------------------------------------------------ sending

  async handleSendMessage() {
    const input = document.getElementById('chatInput');
    const text = input?.value.trim();
    if (!text || !this.activeChannelId) return;

    input.value = '';
    this.syncComposer();
    const channelId = this.activeChannelId;
    const replyToId = this.replyTo?.id || null;
    this.replyTo = null; this.renderReplyBar();

    const tmp = {
      id: `tmp-${Date.now()}`, conversation_id: channelId, sender_id: this.app.currentUser.id, content: text,
      message_type: 'text', created_at: new Date().toISOString(), reply_to_id: replyToId,
      sender: { id: this.app.currentUser.id, full_name: this.app.currentProfile?.full_name || 'You' }
    };
    this.messages.push(tmp);
    this.renderMessagesFeed();

    try {
      const { message } = await Api.sendMessage(channelId, text, { replyToId });
      this.messages = this.messages.filter(m => m.id !== tmp.id);
      if (channelId === this.activeChannelId && !this.messages.some(m => m.id === message.id)) this.messages.push(message);
      this.renderMessagesFeed(true);
    } catch (err) {
      console.error('Send error:', err);
      this.messages = this.messages.filter(m => m.id !== tmp.id);
      this.renderMessagesFeed(true);
      input.value = text; this.syncComposer();
      Toast.error(err.message || 'Failed to post message', 'Chat Error');
    }
  }

  /** Uploads to the private bucket, then posts the message that points at it. */
  async uploadMedia(blob, name, mime, conv = this.activeChannelId) {
    const ext = (name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
    const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    // <conversation>/<my id without dashes>-<random>.<ext> — the storage policy checks both parts
    const path = `${conv}/${this.app.currentUser.id.replace(/-/g, '')}-${rand}.${ext}`;
    const { error } = await getSupabase().storage.from(BUCKET).upload(path, blob, { contentType: mime, upsert: false });
    if (error) throw new Error(error.message || 'Upload failed');
    return path;
  }

  async sendFile(file) {
    if (!this.activeChannelId) return;
    if (file.size > CONFIG.MAX_TASK_FILE_SIZE_BYTES) { Toast.error('Files can be up to 25 MB.', 'Too large'); return; }
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!CONFIG.ALLOWED_FILE_EXTENSIONS.includes(ext) && !/^image\//.test(file.type)) { Toast.error('This file type is not allowed.', 'Not allowed'); return; }
    const mime = (file.type || 'application/octet-stream').split(';')[0];
    const conv = this.activeChannelId;
    Toast.info(`Sending ${file.name}…`, 'Upload');
    try {
      const path = await this.uploadMedia(file, file.name || `photo.${mime.split('/')[1] || 'png'}`, mime, conv);
      const type = RASTER_IMAGE.test(mime) ? 'image' : 'file';
      const { message } = await Api.sendMessage(conv, '', {
        messageType: type, replyToId: this.replyTo?.id || null,
        metadata: { path, mime, size: file.size, name: file.name || 'photo' }
      });
      this.replyTo = null; this.renderReplyBar();
      if (conv === this.activeChannelId && !this.messages.some(m => m.id === message.id)) { this.messages.push(message); this.renderMessagesFeed(); }
    } catch (err) {
      Toast.error(err.message || 'Could not send the file', 'Upload failed');
    }
  }

  // ------------------------------------------------------------ voice notes

  async startRecording() {
    if (this.rec || !this.activeChannelId) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { Toast.error('Voice notes are not supported on this browser.', 'Voice note'); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { Toast.error('Allow microphone access to record a voice note.', 'Microphone'); return; }

    // Chrome/Android record webm/opus; iPhone Safari records mp4/aac
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported?.(t)) || '';
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    // live level meter → the waveform stored with the message
    const peaks = [];
    let ctx, analyser, meter;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = ctx.createAnalyser(); analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      meter = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let max = 0; for (const v of buf) max = Math.max(max, Math.abs(v - 128));
        peaks.push(Math.min(100, Math.round(max / 128 * 140)));
        this.drawRecorderLevel(peaks[peaks.length - 1]);
      }, 100);
    } catch { /* waveform is optional */ }

    this.rec = { recorder, stream, chunks, mime: recorder.mimeType || mime || 'audio/webm', startedAt: Date.now(), peaks, ctx, meter, conv: this.activeChannelId, send: false };
    recorder.onstop = () => this.finishRecording();
    recorder.start(250);
    this.showRecorder();
    this.rec.limit = setTimeout(() => this.stopRecording(true), MAX_VOICE_SECONDS * 1000);
  }

  showRecorder() {
    const form = document.getElementById('chatMessageForm'); const box = document.getElementById('chatRecorder');
    if (form) form.style.display = 'none';
    if (!box) return;
    box.style.display = 'flex';
    box.innerHTML = `
      <button type="button" class="card-act slk-tool" id="btnRecCancel" aria-label="Discard recording" style="opacity:1;"><i data-lucide="trash-2"></i></button>
      <span class="slk-rec-dot"></span><span id="recTime" class="slk-rec-time">0:00</span>
      <div class="slk-rec-level" id="recLevel"></div>
      <button type="button" class="btn btn-primary btn-sm" id="btnRecSend" style="height: 40px;"><i data-lucide="send"></i> Send</button>`;
    if (window.lucide) window.lucide.createIcons();
    document.getElementById('btnRecCancel')?.addEventListener('click', () => this.cancelRecording());
    document.getElementById('btnRecSend')?.addEventListener('click', () => this.stopRecording(true));
    this.rec.clock = setInterval(() => {
      const el = document.getElementById('recTime');
      if (el && this.rec) el.textContent = fmtDur((Date.now() - this.rec.startedAt) / 1000);
    }, 250);
  }

  drawRecorderLevel(level) {
    const el = document.getElementById('recLevel');
    if (!el) return;
    const bar = document.createElement('i'); bar.style.height = `${Math.max(10, level)}%`;
    el.appendChild(bar);
    while (el.children.length > 40) el.firstChild.remove();
  }

  stopRecording(send) {
    if (!this.rec) return;
    this.rec.send = !!send;
    if (this.rec.recorder.state !== 'inactive') this.rec.recorder.stop();
  }

  cancelRecording() {
    if (!this.rec) return;
    this.rec.send = false;
    if (this.rec.recorder.state !== 'inactive') this.rec.recorder.stop(); else this.cleanupRecording();
  }

  cleanupRecording() {
    const r = this.rec; if (!r) return;
    clearInterval(r.meter); clearInterval(r.clock); clearTimeout(r.limit);
    r.stream.getTracks().forEach(t => t.stop());
    r.ctx?.close?.().catch(() => {});
    this.rec = null;
    const form = document.getElementById('chatMessageForm'); const box = document.getElementById('chatRecorder');
    if (box) { box.style.display = 'none'; box.innerHTML = ''; }
    const ch = this.channels.find(c => c.id === this.activeChannelId);
    if (form) form.style.display = ch?.is_archived ? 'none' : 'flex';
  }

  async finishRecording() {
    const r = this.rec; if (!r) return;
    const duration = (Date.now() - r.startedAt) / 1000;
    const { chunks, mime, peaks, conv, send } = r;
    this.cleanupRecording();
    if (!send || duration < 0.8 || !chunks.length) { if (send) Toast.info('Hold on a little longer to record a voice note.', 'Voice note'); return; }

    const blob = new Blob(chunks, { type: mime });
    const base = mime.split(';')[0];
    const ext = base.includes('mp4') ? 'm4a' : base.includes('ogg') ? 'ogg' : 'webm';
    // squash the level samples into 40 bars for the stored waveform
    const bars = 40; const out = [];
    for (let i = 0; i < bars; i++) {
      const slice = peaks.slice(Math.floor(i * peaks.length / bars), Math.max(Math.floor((i + 1) * peaks.length / bars), Math.floor(i * peaks.length / bars) + 1));
      out.push(slice.length ? Math.max(...slice) : 10);
    }
    try {
      const path = await this.uploadMedia(blob, `voice.${ext}`, base, conv);
      const { message } = await Api.sendMessage(conv, '', {
        messageType: 'voice', replyToId: this.replyTo?.id || null,
        metadata: { path, mime: base, size: blob.size, name: `voice.${ext}`, duration, peaks: out }
      });
      this.replyTo = null; this.renderReplyBar();
      if (conv === this.activeChannelId && !this.messages.some(m => m.id === message.id)) { this.messages.push(message); this.renderMessagesFeed(); }
    } catch (err) {
      Toast.error(err.message || 'Could not send the voice note', 'Voice note');
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
    const deptId = selectedDeptId(assigneeSelect);
    const assigneeName = assigneeSelect.selectedOptions[0]?.text.split('(')[0].replace('To: ', '').trim();

    titleInput.value = '';
    document.getElementById('chatHandoffBar').style.display = 'none';

    try {
      const d = new Date();
      d.setDate(d.getDate() + 4);

      const { task: newTask } = await Api.createTask({
        title,
        assignedTo,
        departmentId: deptId || undefined,
        priority: 'high',
        dueDate: d.toISOString().split('T')[0],
        description: `Dispatched directly in studio chat by ${this.app.currentProfile.full_name}.`
      });

      const { message: data } = await Api.sendMessage(
        this.activeChannelId,
        `Dispatched new deliverable to ${assigneeName}: "${title}"`,
        { messageType: 'task_handoff', metadata: {
          task_id: newTask.id, task_number: newTask.task_number, task_title: title, assignee_name: assigneeName
        } }
      );

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
