/**
 * KITE SYSTEM — Module J: Communication & Role Chat
 * Studio channels, direct messages & instant creative task handoffs.
 */

import { getSupabase } from '../../supabase-client.js';
import { Toast } from '../../services/toast-service.js';
import { Api } from '../../services/api.js';
import { escapeHTML, formatRelativeTime, getInitials, getAccentHex } from '../../utils/helpers.js';

export class ChatModule {
  constructor(app) {
    this.app = app;
    this.channels = [];
    this.activeChannelId = null;
    this.messages = [];
    this.employees = [];
    this.realtimeSub = null;
  }

  async render(container) {
    container.innerHTML = `
      <div class="page-container animate-fade-in" style="height: calc(100vh - 120px); display: flex; flex-direction: column;">
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-3);">
          <div>
            <h1 class="font-display font-bold text-xl text-white">Studio Channels & Role Handoffs</h1>
            <p class="text-xs text-muted">Collaborate with any role & dispatch deliverables directly in chat.</p>
          </div>
          <span class="badge badge-emerald">Live Realtime</span>
        </div>

        <div class="chat-layout" style="flex: 1; min-height: 0;">
          <!-- Left: Channels & DMs List -->
          <div class="chat-sidebar">
            <div style="padding: var(--space-3-5); border-bottom: 1px solid var(--border-subtle); background: var(--studio-950);">
              <div class="font-display font-bold text-xs text-white">Collaboration Rooms</div>
              <div class="text-2xs text-muted">Cross-role creative channels</div>
            </div>

            <div id="chatChannelsList" style="flex: 1; overflow-y: auto; padding: var(--space-2); display: flex; flex-direction: column; gap: var(--space-1);">
              <!-- Populated dynamically -->
            </div>
          </div>

          <!-- Right: Active Chat Window -->
          <div class="chat-window">
            <!-- Header -->
            <div id="chatActiveHeader" style="padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border-subtle); background: var(--studio-950); display: flex; align-items: center; justify-content: space-between;">
              <div>
                <div class="font-bold text-sm text-white" id="activeChannelTitle">#creative-handoffs</div>
                <div class="text-2xs text-muted" id="activeChannelDesc">Cross-department deliverables & asset handoffs</div>
              </div>

              <button type="button" class="btn btn-secondary btn-sm" id="btnToggleHandoffBar">
                <i data-lucide="zap"></i> + Dispatch Task Card
              </button>
            </div>

            <!-- Instant Task Handoff Bar -->
            <div id="chatHandoffBar" class="glass-panel" style="display: none; padding: var(--space-3); margin: var(--space-3); background: rgba(99, 102, 241, 0.1); border-color: var(--color-primary-border); flex-direction: column; gap: var(--space-2);">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span class="text-xs font-bold text-primary">⚡ Instant Task Handoff in Chat</span>
                <button type="button" id="btnCancelHandoff" class="text-2xs text-muted">&times; Cancel</button>
              </div>

              <div style="display: grid; grid-template-columns: 2fr 1fr; gap: var(--space-2);">
                <input id="quickTaskTitle" type="text" placeholder="Deliverable name (e.g. Export SVG Logo Kit)..." class="form-control" style="height: 32px;" />
                <select id="quickTaskAssignee" class="form-control" style="height: 32px;">
                  <!-- Populated by JS -->
                </select>
              </div>

              <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
                <button type="button" id="btnDispatchChatTask" class="btn btn-primary btn-sm">Dispatch Task Card →</button>
              </div>
            </div>

            <!-- Feed -->
            <div class="chat-feed" id="chatFeed">
              <div class="empty-state" style="border:none; padding: 40px 0;">
                <div class="empty-state-icon animate-spin">⟳</div>
                <div class="empty-state-title">Loading messages...</div>
              </div>
            </div>

            <!-- Composer Form -->
            <form id="chatMessageForm" style="padding: var(--space-3); border-top: 1px solid var(--border-subtle); background: var(--studio-950); display: flex; gap: var(--space-2);">
              <input 
                type="text" 
                id="chatInput" 
                required 
                placeholder="Write a message to collaborate or hand off deliverables..." 
                class="form-control" 
                style="height: 38px;"
              />
              <button type="submit" class="btn btn-primary btn-sm" style="height: 38px; padding: 0 var(--space-4);">
                Send
              </button>
            </form>
          </div>
        </div>
      </div>
    `;

    this.attachEventListeners();
    await this.loadChatData();
  }

  attachEventListeners() {
    const handoffBar = document.getElementById('chatHandoffBar');
    document.getElementById('btnToggleHandoffBar')?.addEventListener('click', () => {
      const isVisible = handoffBar.style.display === 'flex';
      handoffBar.style.display = isVisible ? 'none' : 'flex';
    });

    document.getElementById('btnCancelHandoff')?.addEventListener('click', () => {
      handoffBar.style.display = 'none';
    });

    document.getElementById('btnDispatchChatTask')?.addEventListener('click', async () => {
      await this.handleDispatchTaskFromChat();
    });

    document.getElementById('chatMessageForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.handleSendMessage();
    });
  }

  async loadChatData() {
    const supabase = getSupabase();
    if (!supabase) return;

    try {
      // 1. Fetch conversations
      const { data: convos } = await supabase.from('conversations').select('*').order('created_at', { ascending: true });
      this.channels = convos && convos.length > 0 ? convos : [
        { id: '33333333-3333-3333-3333-333333333301', name: '#creative-handoffs', description: 'Cross-department task handoffs & asset deliveries' },
        { id: '33333333-3333-3333-3333-333333333302', name: '#studio-general', description: 'Daily standups, studio announcements & creative alignment' },
        { id: '33333333-3333-3333-3333-333333333303', name: '#client-briefs', description: 'Manager & Admin campaign briefs and milestone reviews' }
      ];

      this.activeChannelId = this.channels[0].id;

      // 2. Fetch employees for handoff dropdown
      const { data: emps } = await supabase.from('profiles').select('id, full_name, job_title, department_id, departments!profiles_department_id_fkey(name)');
      this.employees = emps || [];

      const select = document.getElementById('quickTaskAssignee');
      if (select) {
        select.innerHTML = this.employees.map(e => `
          <option value="${e.id}" data-dept="${e.department_id || ''}">
            To: ${escapeHTML(e.full_name)} (${e.departments?.name || 'Studio'})
          </option>
        `).join('');
      }

      this.renderChannelsList();
      await this.loadMessages(this.activeChannelId);
      this.subscribeToChannel(this.activeChannelId);
    } catch (err) {
      console.warn('Chat load error:', err);
    }
  }

  renderChannelsList() {
    const container = document.getElementById('chatChannelsList');
    if (!container) return;

    container.innerHTML = this.channels.map(ch => {
      const active = ch.id === this.activeChannelId;
      return `
        <button 
          type="button" 
          class="nav-item ${active ? 'active' : ''}" 
          style="width: 100%; text-align: left;"
          data-channel-id="${ch.id}"
        >
          <i data-lucide="hash"></i>
          <span class="truncate">${escapeHTML(ch.name)}</span>
        </button>
      `;
    }).join('');

    container.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-channel-id');
        this.activeChannelId = id;
        this.renderChannelsList();
        const ch = this.channels.find(c => c.id === id);
        if (ch) {
          document.getElementById('activeChannelTitle').textContent = ch.name;
          document.getElementById('activeChannelDesc').textContent = ch.description || '';
        }
        await this.loadMessages(id);
        this.subscribeToChannel(id);
      });
    });

    if (window.lucide) window.lucide.createIcons();
  }

  async loadMessages(channelId) {
    const supabase = getSupabase();
    if (!supabase) return;

    try {
      const { data: msgs, error } = await supabase
        .from('messages')
        .select(`
          *,
          sender:profiles!messages_sender_id_fkey(id, full_name, avatar_url)
        `)
        .eq('conversation_id', channelId)
        .order('created_at', { ascending: true })
        .limit(50);

      this.messages = msgs || [];
      this.renderMessagesFeed();
    } catch (err) {
      console.warn('Messages error:', err);
      this.renderMessagesFeed();
    }
  }

  renderMessagesFeed() {
    const feed = document.getElementById('chatFeed');
    if (!feed) return;

    if (this.messages.length === 0) {
      feed.innerHTML = `
        <div class="empty-state" style="border:none; padding: 40px 0;">
          <div class="empty-state-icon">💬</div>
          <div class="empty-state-title">No messages in room</div>
          <div class="empty-state-desc">Say hello or dispatch a task handoff to your creative peers.</div>
        </div>
      `;
      return;
    }

    feed.innerHTML = this.messages.map(m => {
      const isMe = m.sender_id === this.app.currentUser.id;
      const initials = getInitials(m.sender?.full_name || 'Specialist');
      const accent = getAccentHex(m.sender?.full_name || 'Specialist');

      return `
        <div class="chat-msg ${isMe ? 'msg-outgoing' : 'msg-incoming'}">
          <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 3px; font-size: 11px;">
            <span class="font-bold text-white">${escapeHTML(m.sender?.full_name || 'Specialist')}</span>
            <span class="text-dim font-mono">${formatRelativeTime(m.created_at)}</span>
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

    feed.scrollTop = feed.scrollHeight;
  }

  async handleSendMessage() {
    const input = document.getElementById('chatInput');
    const text = input?.value.trim();
    if (!text) return;

    input.value = '';
    const supabase = getSupabase();

    try {
      const { error } = await supabase.from('messages').insert({
        conversation_id: this.activeChannelId,
        sender_id: this.app.currentUser.id,
        content: text,
        message_type: 'text'
      });

      if (error) throw error;
      await this.loadMessages(this.activeChannelId);
    } catch (err) {
      console.error('Send error:', err);
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

    const supabase = getSupabase();
    try {
      // 1. Create Task in database
      const d = new Date();
      d.setDate(d.getDate() + 4);

      const { task: newTask } = await Api.createTask({
        title,
        assignedTo,
        priority: 'high',
        dueDate: d.toISOString().split('T')[0],
        description: `Dispatched directly in studio chat by ${this.app.currentProfile.full_name}.`
      });

      // 2. Post task handoff card in chat room
      await supabase.from('messages').insert({
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
      });

      Toast.success(`Deliverable card posted to channel!`, 'Handoff Dispatched');
      await this.loadMessages(this.activeChannelId);
    } catch (err) {
      console.error('Handoff error:', err);
      Toast.error(err.message || 'Handoff failed', 'Error');
    }
  }

  subscribeToChannel(channelId) {
    const supabase = getSupabase();
    if (!supabase) return;

    if (this.realtimeSub) {
      supabase.removeChannel(this.realtimeSub);
    }

    this.realtimeSub = supabase
      .channel(`public:messages:${channelId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${channelId}`
        },
        async () => {
          await this.loadMessages(channelId);
        }
      )
      .subscribe();
  }
}
