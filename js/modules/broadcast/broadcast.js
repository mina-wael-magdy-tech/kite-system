/**
 * KITE SYSTEM — Announcements
 * The owner / CEO writes a message and sends it to everyone, a department, a role or chosen people.
 * It arrives as an in-app notification and (when push is on) on their phones.
 * The server (Edge Function `broadcast`) re-checks that the sender really is owner / CEO.
 */

import { getSupabase } from '../../supabase-client.js';
import { Permissions } from '../../permissions/permission-service.js';
import { Toast } from '../../services/toast-service.js';
import { Api } from '../../services/api.js';
import { escapeHTML, formatRelativeTime } from '../../utils/helpers.js';

export const SENDER_ROLES = ['owner', 'ceo', 'super_admin'];
export const canBroadcast = () => SENDER_ROLES.some(r => Permissions.hasRole(r));

const PAGES = [
  ['', 'No link'], ['#dashboard', 'Dashboard'], ['#tasks', 'Tasks'], ['#calendar', 'Calendar'], ['#chat', 'Chat'],
  ['#hr', 'HR & Attendance'], ['#documents', 'Documents'], ['#clients', 'Clients']
];

export class BroadcastModule {
  constructor(app) { this.app = app; this.audience = 'all'; this.sending = false; }

  async render(container) {
    this.root = container;
    if (!canBroadcast()) {
      container.innerHTML = `<div class="page-container"><div class="empty-state"><div class="empty-state-icon"><i data-lucide="lock"></i></div>
        <div class="empty-state-title">Owner and CEO only</div><div class="empty-state-desc">Only the owner or CEO can send announcements.</div></div></div>`;
      return;
    }
    container.innerHTML = `
      <div class="page-container animate-fade-in">
        <div>
          <h1 class="font-display font-bold text-xl">Announcements</h1>
          <p class="text-xs text-muted" style="margin-top:2px;">Send a notification to your team. It appears in their bell and as a phone alert.</p>
        </div>
        <div class="bc-layout">
          <form class="card bc-form" id="bcForm" autocomplete="off">
            <div class="form-group"><label class="form-label" for="bcTitle">Title <span class="text-dim" id="bcTitleN">0/80</span></label>
              <input class="form-control" id="bcTitle" maxlength="80" placeholder="e.g. Office closed on Thursday" required></div>
            <div class="form-group"><label class="form-label" for="bcMsg">Message <span class="text-dim" id="bcMsgN">0/600</span></label>
              <textarea class="form-control" id="bcMsg" rows="5" maxlength="600" placeholder="Write the announcement…" required></textarea></div>
            <div class="form-group"><label class="form-label">Send to</label>
              <div class="cpe-seg bc-seg" id="bcAud">
                <button type="button" data-aud="all" class="on">Everyone</button>
                <button type="button" data-aud="department">Departments</button>
                <button type="button" data-aud="role">Roles</button>
                <button type="button" data-aud="people">People</button>
              </div>
              <div class="bc-picks" id="bcPicks"></div>
            </div>
            <div class="form-group"><label class="form-label" for="bcLink">Open this page when tapped</label>
              <select class="form-control" id="bcLink">${PAGES.map(([v, l]) => `<option value="${v}">${escapeHTML(l)}</option>`).join('')}</select></div>
            <div class="bc-actions">
              <span class="text-xs text-muted" id="bcCount"></span>
              <button class="btn btn-primary" type="submit" id="bcSend"><i data-lucide="send"></i> Send announcement</button>
            </div>
          </form>
          <div class="bc-side">
            <div class="card bc-preview"><div class="text-2xs text-dim">Preview</div>
              <div class="bc-note"><b id="bcPvTitle">Title</b><p id="bcPvMsg">Your message appears here.</p><span>just now</span></div></div>
            <div class="card bc-history"><div class="card-header"><div class="card-title">Recently sent</div></div>
              <div class="card-body" id="bcHistory"><div class="text-xs text-muted">Loading…</div></div></div>
          </div>
        </div>
      </div>`;
    if (window.lucide) window.lucide.createIcons();
    this.bind();
    await this.loadLists();
    this.paintPicks();
    this.loadHistory();
  }

  async loadLists() {
    const sb = getSupabase();
    const [d, r, p] = await Promise.all([
      sb.from('departments').select('id, name').eq('is_active', true).order('name'),
      sb.from('roles').select('name, display_name').eq('is_active', true).order('priority'),
      sb.from('profiles').select('id, full_name, job_title').eq('employment_status', 'active').order('full_name')
    ]);
    this.departments = d.data || [];
    this.roles = (r.data || []).filter(x => x.name !== 'client');
    this.people = p.data || [];
  }

  bind() {
    const $ = (id) => document.getElementById(id);
    const sync = () => {
      $('bcTitleN').textContent = `${$('bcTitle').value.length}/80`;
      $('bcMsgN').textContent = `${$('bcMsg').value.length}/600`;
      $('bcPvTitle').textContent = $('bcTitle').value.trim() || 'Title';
      $('bcPvMsg').textContent = $('bcMsg').value.trim() || 'Your message appears here.';
    };
    $('bcTitle').addEventListener('input', sync);
    $('bcMsg').addEventListener('input', sync);
    $('bcAud').addEventListener('click', (e) => {
      const b = e.target.closest('[data-aud]'); if (!b) return;
      this.audience = b.dataset.aud;
      $('bcAud').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      this.paintPicks();
    });
    $('bcPicks').addEventListener('change', () => this.updateCount());
    $('bcForm').addEventListener('submit', (e) => { e.preventDefault(); this.send(); });
  }

  paintPicks() {
    const box = document.getElementById('bcPicks');
    if (!box) return;
    const list = (name, items) => `<div class="bc-list">${items.length ? items.map(i => `
      <label class="bc-pick"><input type="checkbox" name="${name}" value="${escapeHTML(i.value)}"><span>${escapeHTML(i.label)}${i.sub ? `<small>${escapeHTML(i.sub)}</small>` : ''}</span></label>`).join('')
      : '<span class="text-xs text-muted">Nothing to choose from yet.</span>'}</div>`;
    if (this.audience === 'all') box.innerHTML = '<div class="text-xs text-muted">Every active employee (you are not included).</div>';
    else if (this.audience === 'department') box.innerHTML = list('dept', (this.departments || []).map(d => ({ value: d.id, label: d.name })));
    else if (this.audience === 'role') box.innerHTML = list('role', (this.roles || []).map(r => ({ value: r.name, label: r.display_name || r.name })));
    else box.innerHTML = list('person', (this.people || []).map(p => ({ value: p.id, label: p.full_name, sub: p.job_title })));
    this.updateCount();
  }

  selected(name) { return [...document.querySelectorAll(`#bcPicks input[name="${name}"]:checked`)].map(i => i.value); }

  updateCount() {
    const n = { all: null, department: this.selected('dept').length, role: this.selected('role').length, people: this.selected('person').length }[this.audience];
    const el = document.getElementById('bcCount');
    if (el) el.textContent = n === null ? 'Goes to the whole team' : `${n} selected`;
  }

  async send() {
    if (this.sending) return;
    const title = document.getElementById('bcTitle').value.trim();
    const message = document.getElementById('bcMsg').value.trim();
    const link = document.getElementById('bcLink').value;
    const payload = { title, message, audience: this.audience, link: link || undefined };
    if (this.audience === 'department') payload.departmentIds = this.selected('dept');
    if (this.audience === 'role') payload.roles = this.selected('role');
    if (this.audience === 'people') payload.userIds = this.selected('person');
    if (this.audience !== 'all' && !(payload.departmentIds?.length || payload.roles?.length || payload.userIds?.length)) {
      Toast.error('Choose who should get it.', 'Announcement'); return;
    }
    if (!window.confirm(`Send "${title}" to ${this.audience === 'all' ? 'the whole team' : 'the selected people'}? It cannot be recalled.`)) return;

    const btn = document.getElementById('bcSend');
    this.sending = true; btn.disabled = true;
    try {
      const res = await Api.broadcast({ action: 'send', ...payload });
      Toast.success(`Sent to ${res.recipients} ${res.recipients === 1 ? 'person' : 'people'}.`, 'Announcement');
      document.getElementById('bcForm').reset();
      this.audience = 'all';
      document.querySelectorAll('#bcAud button').forEach(x => x.classList.toggle('on', x.dataset.aud === 'all'));
      this.paintPicks();
      document.getElementById('bcTitle').dispatchEvent(new Event('input'));
      document.getElementById('bcMsg').dispatchEvent(new Event('input'));
      this.loadHistory();
    } catch (err) {
      Toast.error(err.message || 'Could not send', 'Announcement');
    } finally { this.sending = false; btn.disabled = false; }
  }

  async loadHistory() {
    const box = document.getElementById('bcHistory');
    if (!box) return;
    try {
      const res = await Api.broadcast({ action: 'history' });
      const items = res.items || [];
      box.innerHTML = items.length ? items.map(i => `
        <div class="bc-hist"><div class="bc-hist-top"><b>${escapeHTML(i.title)}</b><span>${escapeHTML(formatRelativeTime(i.created_at))}</span></div>
          <p>${escapeHTML(i.message)}</p>
          <small>To ${escapeHTML(i.audience_label || i.audience_type)} · ${i.recipient_count} ${i.recipient_count === 1 ? 'person' : 'people'}${i.sender?.full_name ? ` · by ${escapeHTML(i.sender.full_name)}` : ''}</small></div>`).join('')
        : '<div class="text-xs text-muted">Nothing sent yet.</div>';
    } catch (err) {
      box.innerHTML = `<div class="text-xs text-muted">${escapeHTML(err.message || 'History unavailable')}</div>`;
    }
  }
}
