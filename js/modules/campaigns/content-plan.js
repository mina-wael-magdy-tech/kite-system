/**
 * KITE SYSTEM — Content plans (feed calendars)
 *
 *  ContentPlansSection  list + create, shown on the Campaigns page
 *  ContentPlanEditor    the slide-by-slide editor the department works in
 *
 * One slide per post: date, format, pillar, objective, idea, caption, visuals, links and the person who
 * publishes it. The same slides are shown to the client through a private link, and the whole plan can
 * be downloaded as a PowerPoint when it is finished.
 */

import { getSupabase } from '../../supabase-client.js';
import { CONFIG } from '../../config.js';
import { Api } from '../../services/api.js';
import { Toast } from '../../services/toast-service.js';
import { Realtime } from '../../services/realtime-service.js';
import { Permissions } from '../../permissions/permission-service.js';
import { formDialog, confirmDialog, htmlDialog, closeDialog } from '../../ui/dialogs.js';
import { escapeHTML, formatRelativeTime, getInitials } from '../../utils/helpers.js';
import {
  POST_TYPES, POST_STATUSES, PLAN_STATUSES, slideHTML, coverHTML, bindSlides, safeUrl, formatPlanDate,
  LAYOUT_PRESETS, presetBoxes, visualBoxes
} from '../../utils/plan-slide.js';
import { exportPlanToPptx } from './pptx-export.js';

const BADGE = { gray: 'badge-slate', blue: 'badge-sky', amber: 'badge-amber', green: 'badge-emerald', rose: 'badge-rose' };
const badge = (map, key) => `<span class="badge ${BADGE[map[key]?.tone] || 'badge-slate'}">${escapeHTML(map[key]?.label || key)}</span>`;
const ACCENTS = [
  { value: '#e01b28', label: 'Kite red' }, { value: '#d79f3e', label: 'Amber' },
  { value: '#12abe3', label: 'Sky blue' }, { value: '#2c3a4a', label: 'Charcoal' }, { value: '#0d7a53', label: 'Green' }
];
const MAX_VISUAL_BYTES = 50 * 1024 * 1024;
const PLATFORMS = ['Instagram', 'Facebook', 'TikTok', 'LinkedIn', 'YouTube', 'X (Twitter)', 'Snapchat'];

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const extOf = (n = '') => (n.split('.').pop() || '').toLowerCase();

async function departmentOptions(app) {
  const { data } = await getSupabase().from('departments').select('id, name').order('name', { ascending: true });
  const mine = new Set((Permissions.departments || []).map(d => d.id));
  const all = data || [];
  const list = Permissions.isAdmin() ? all : all.filter(d => mine.has(d.id));
  return list.length ? list : all;
}

export function canEditPlan(app, plan) {
  return Permissions.isAdmin() || plan.created_by === app.currentUser.id
    || (!!plan.department_id && (Permissions.departments || []).some(d => d.id === plan.department_id));
}

// =====================================================================================================
// LIST
// =====================================================================================================
export class ContentPlansSection {
  constructor(app) { this.app = app; this.plans = []; }

  html() {
    return `
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-3); margin-top: var(--space-2);">
        <div>
          <h2 class="font-display font-bold text-lg text-white">Content Plans &amp; Feed Calendars</h2>
          <p class="text-xs text-muted" style="margin-top: 2px;">Plan every post, share it with the client for page-by-page notes, schedule the publishing and download it as a PowerPoint.</p>
        </div>
        <button type="button" class="btn btn-primary btn-sm" id="btnNewPlan"><i data-lucide="plus"></i> New content plan</button>
      </div>
      <div id="plansContainer" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--space-4);"></div>`;
  }

  async mount() {
    document.getElementById('btnNewPlan')?.addEventListener('click', () => this.openCreate());
    await this.load();
    Realtime.watch(['content_plans', 'content_posts', 'content_feedback'], () => this.load());
  }

  async load() {
    const { data, error } = await getSupabase().from('content_plans')
      .select('id, title, subtitle, status, direction, accent, campaign_id, department_id, created_by, created_at, clients(name, company_name), campaigns(name), departments(name), content_posts(id, post_date, status), content_feedback(id, resolved, kind)')
      .order('created_at', { ascending: false });
    if (error) console.warn('Content plans fetch error:', error.message);
    this.plans = data || [];
    this.render();
  }

  render() {
    const box = document.getElementById('plansContainer');
    if (!box) return;
    if (!this.plans.length) {
      box.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <div class="empty-state-icon">🗓️</div>
          <div class="empty-state-title">No content plans yet</div>
          <div class="empty-state-desc">Create one to design a month of posts, send it to the client and track publishing.</div>
        </div>`;
      return;
    }
    const today = ymd(new Date());
    box.innerHTML = this.plans.map(p => {
      const posts = p.content_posts || [];
      const next = posts.filter(x => x.post_date && x.post_date >= today && x.status !== 'published').map(x => x.post_date).sort()[0];
      const published = posts.filter(x => x.status === 'published').length;
      const open = (p.content_feedback || []).filter(f => !f.resolved && f.kind !== 'approve' && f.kind !== 'approve_all').length;
      const who = p.clients?.company_name || p.clients?.name || p.campaigns?.name || 'Internal';
      return `
      <div class="card entity-card cpe-plan-card" style="border-top: 4px solid ${escapeHTML(p.accent)};">
        <div class="card-header">
          <div style="min-width: 0;">
            <span class="badge badge-indigo font-bold">${escapeHTML(who)}</span>
            <div class="card-title" style="margin-top: 6px;" title="${escapeHTML(p.title)}">${escapeHTML(p.title)}</div>
          </div>
          ${badge(PLAN_STATUSES, p.status)}
        </div>
        <div class="card-body" style="display: flex; flex-direction: column; gap: var(--space-2);">
          ${p.subtitle ? `<p class="text-xs text-muted line-clamp-2">${escapeHTML(p.subtitle)}</p>` : ''}
          <div style="display: flex; flex-wrap: wrap; gap: 6px;">
            <span class="badge badge-slate">${posts.length} posts</span>
            <span class="badge badge-emerald">${published} published</span>
            ${p.departments?.name ? `<span class="badge badge-sky">${escapeHTML(p.departments.name)}</span>` : ''}
            ${open ? `<span class="badge badge-amber">${open} client note${open > 1 ? 's' : ''}</span>` : ''}
          </div>
          <span class="text-2xs text-dim">${next ? `Next post: ${escapeHTML(formatPlanDate(next, 'ltr'))}` : 'No upcoming posts'}</span>
        </div>
        <div class="card-footer">
          <a href="#campaigns?plan=${escapeHTML(p.id)}" class="btn btn-primary btn-sm" style="width: 100%;">Open plan →</a>
        </div>
      </div>`;
    }).join('');
  }

  async openCreate(campaignId = null) {
    const supabase = getSupabase();
    const [{ data: clients }, { data: camps }, depts] = await Promise.all([
      supabase.from('clients').select('id, company_name').order('company_name', { ascending: true }),
      supabase.from('campaigns').select('id, name, client_id').order('created_at', { ascending: false }),
      departmentOptions(this.app)
    ]);
    const camp = (camps || []).find(c => c.id === campaignId);
    formDialog({
      title: 'New content plan',
      subtitle: 'A deck with one slide per post. You can edit everything afterwards.',
      submitLabel: 'Create plan',
      fields: [
        { name: 'title', label: 'Plan name', required: true, maxlength: 160, placeholder: 'e.g. Feed calendar — October' },
        { name: 'subtitle', label: 'Subtitle', maxlength: 200, placeholder: 'e.g. Instagram & Facebook · 28 posts' },
        { name: 'client_id', label: 'Client', type: 'select', half: true, value: camp?.client_id || '',
          options: [{ value: '', label: 'No client' }, ...(clients || []).map(c => ({ value: c.id, label: c.company_name }))] },
        { name: 'campaign_id', label: 'Campaign', type: 'select', half: true, value: campaignId || '',
          options: [{ value: '', label: 'Not linked' }, ...(camps || []).map(c => ({ value: c.id, label: c.name }))] },
        { name: 'department_id', label: 'Team that edits it', type: 'select', half: true, value: depts[0]?.id || '',
          options: depts.map(d => ({ value: d.id, label: d.name })) },
        { name: 'direction', label: 'Language', type: 'select', half: true, value: 'rtl',
          options: [{ value: 'rtl', label: 'Arabic (right-to-left)' }, { value: 'ltr', label: 'English (left-to-right)' }] },
        { name: 'accent', label: 'Colour', type: 'select', half: true, value: '#e01b28', options: ACCENTS }
      ],
      onSubmit: async (v) => {
        const { data, error } = await supabase.from('content_plans').insert({
          title: v.title, subtitle: v.subtitle, client_id: v.client_id, campaign_id: v.campaign_id,
          department_id: v.department_id, direction: v.direction, accent: v.accent, created_by: this.app.currentUser.id
        }).select('id').single();
        if (error) throw new Error(error.message);
        Toast.success('Content plan created', 'Saved');
        window.location.hash = `#campaigns?plan=${data.id}`;
      }
    });
  }
}

// =====================================================================================================
// EDITOR
// =====================================================================================================
export class ContentPlanEditor {
  constructor(app) {
    this.app = app;
    this.plan = null; this.posts = []; this.assets = []; this.feedback = []; this.people = [];
    this.selected = 'cover';
    this.urls = new Map();          // storage path -> signed url
    this.pending = {};              // unsaved field changes for the selected post
    this.saveTimer = null;
    this.fbScope = 'page';
    this.canEdit = false;
    this.selVis = null;             // the picture selected on the slide
    this.dragging = false;
  }

  get supabase() { return getSupabase(); }
  get me() { return this.app.currentUser.id; }
  get post() { return this.posts.find(p => p.id === this.selected) || null; }

  // ---------------------------------------------------------------- load
  async render(container, planId, focusPostId) {
    this.container = container;
    this.planId = planId;
    container.innerHTML = `<div class="empty-state" style="border:none; padding: 48px 0;"><div class="empty-state-icon animate-spin">⟳</div><div class="empty-state-title">Opening content plan...</div></div>`;
    const ok = await this.load(true);
    if (!ok) return;
    if (focusPostId && this.posts.some(p => p.id === focusPostId)) this.selected = focusPostId;
    else if (this.posts.length) this.selected = this.posts[0].id;
    this.shell();
    this.drawAll();
    Realtime.watch(['content_plans', 'content_posts', 'content_post_assets', 'content_feedback'], async () => {
      if (this.dragging) return; // never redraw under a picture the user is holding
      await this.load(false);
      this.drawRail(); this.drawPreview(); this.drawAssets(); this.drawFeedback(); this.drawHeader();
    });
  }

  async load(first) {
    const sb = this.supabase;
    const [plan, posts, assets, feedback, people] = await Promise.all([
      sb.from('content_plans').select('*, clients(name, company_name), campaigns(name), departments(name)').eq('id', this.planId).maybeSingle(),
      sb.from('content_posts').select('*').eq('plan_id', this.planId).order('position', { ascending: true }),
      sb.from('content_post_assets').select('*').eq('plan_id', this.planId).order('position', { ascending: true }),
      sb.from('content_feedback').select('*').eq('plan_id', this.planId).order('created_at', { ascending: false }),
      first ? sb.from('profiles').select('id, full_name').eq('employment_status', 'active').order('full_name', { ascending: true }) : Promise.resolve({ data: this.people })
    ]);
    if (!plan.data) {
      if (first) {
        this.container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🗓️</div><div class="empty-state-title">Content plan not found</div>
          <div class="empty-state-desc">It may have been deleted, or you may not have access.</div><a href="#campaigns" class="btn btn-secondary btn-sm">Back to campaigns</a></div>`;
      }
      return false;
    }
    this.plan = plan.data;
    this.posts = posts.data || [];
    this.assets = assets.data || [];
    this.feedback = feedback.data || [];
    this.people = people.data || [];
    this.canEdit = canEditPlan(this.app, this.plan);
    if (this.selected !== 'cover' && !this.posts.some(p => p.id === this.selected)) this.selected = this.posts[0]?.id || 'cover';
    await this.signUrls();
    return true;
  }

  async signUrls() {
    const need = this.assets.map(a => a.storage_path).filter(p => !this.urls.has(p));
    if (!need.length) return;
    const { data } = await this.supabase.storage.from(CONFIG.STORAGE_BUCKETS.STUDIO_ASSETS).createSignedUrls(need, 3600);
    (data || []).forEach(r => { if (r.signedUrl) this.urls.set(r.path, r.signedUrl); });
  }

  visualsOf(postId) {
    return this.assets.filter(a => (a.post_id || null) === (postId || null))
      .map(a => ({ id: a.id, url: this.urls.get(a.storage_path), name: a.file_name, type: a.file_type, path: a.storage_path, layout: a.layout }))
      .filter(v => v.url);
  }

  planForSlides() {
    const c = this.plan.clients;
    return { ...this.plan, clientName: c?.company_name || c?.name || null };
  }

  // ---------------------------------------------------------------- shell
  shell() {
    this.container.innerHTML = `
      <div class="page-container animate-fade-in">
        <div class="cpe-bar">
          <div class="cpe-title-row">
            <a href="#campaigns" class="btn btn-ghost btn-sm" aria-label="Back to campaigns"><i data-lucide="chevron-left"></i> Campaigns</a>
            <h1 class="font-display font-bold text-xl text-white" id="cpeTitle"></h1>
            <span id="cpePlanStatus"></span>
            <span class="cpe-saved" id="cpeSaved"></span>
          </div>
          <div class="cpe-bar-actions" id="cpeActions"></div>
        </div>
        <div class="cpe-layout">
          <aside class="cpe-rail">
            <div class="cpe-rail-list" id="cpeRail"></div>
            <button type="button" class="btn btn-secondary btn-sm" id="cpeAddPost" style="width:100%;"><i data-lucide="plus"></i> Add post</button>
          </aside>
          <section class="cpe-main" id="cpeMain">
            <div class="cps-stage" id="cpePreview"></div>
            <div class="card" id="cpeFormCard"><div id="cpeForm"></div></div>
            <div class="card" id="cpeAssetsCard"></div>
            <div class="card" id="cpeFeedbackCard"></div>
          </section>
        </div>
      </div>`;
    bindSlides(document.getElementById('cpePreview'));
    document.getElementById('cpeAddPost')?.addEventListener('click', () => this.addPost());
    document.getElementById('cpeRail')?.addEventListener('click', (e) => {
      const it = e.target.closest('[data-sel]');
      if (it) this.select(it.dataset.sel);
    });
  }

  drawAll() {
    this.drawHeader(); this.drawRail(); this.drawPreview(); this.drawForm(); this.drawAssets(); this.drawFeedback();
    if (window.lucide) window.lucide.createIcons();
  }

  // ---------------------------------------------------------------- header
  drawHeader() {
    const t = document.getElementById('cpeTitle'); if (!t) return;
    t.textContent = this.plan.title;
    document.getElementById('cpePlanStatus').innerHTML = badge(PLAN_STATUSES, this.plan.status);
    const openFb = this.feedback.filter(f => !f.resolved && (f.kind === 'change' || f.kind === 'note')).length;
    const bar = document.getElementById('cpeActions');
    bar.innerHTML = `
      ${this.canEdit ? `<button type="button" class="btn btn-secondary btn-sm" data-do="settings"><i data-lucide="settings"></i> Plan settings</button>` : ''}
      <button type="button" class="btn btn-secondary btn-sm" data-do="pptx"><i data-lucide="download"></i> Download PPTX</button>
      ${this.canEdit ? `<button type="button" class="btn btn-primary btn-sm" data-do="share"><i data-lucide="share-2"></i> Share with client${openFb ? ` · ${openFb} note${openFb > 1 ? 's' : ''}` : ''}</button>` : ''}`;
    bar.querySelectorAll('[data-do]').forEach(b => b.addEventListener('click', () => this[`do_${b.dataset.do}`](b)));
    if (window.lucide) window.lucide.createIcons();
  }

  // ---------------------------------------------------------------- rail
  drawRail() {
    const rail = document.getElementById('cpeRail'); if (!rail) return;
    const today = ymd(new Date());
    const personName = (id) => this.people.find(p => p.id === id)?.full_name;
    rail.innerHTML = `
      <button type="button" class="cpe-item ${this.selected === 'cover' ? 'active' : ''}" data-sel="cover">
        <span class="cpe-no">★</span>
        <span class="cpe-item-main"><span class="cpe-item-title" style="display:block;">Cover</span><span class="cpe-item-sub">${escapeHTML(this.plan.title)}</span></span>
      </button>
      ${this.posts.map((p, i) => {
        const late = p.post_date && p.post_date < today && p.status !== 'published';
        const pub = personName(p.publisher_id);
        return `
        <button type="button" class="cpe-item ${this.selected === p.id ? 'active' : ''}" data-sel="${escapeHTML(p.id)}" ${this.canEdit ? 'draggable="true"' : ''}>
          <span class="cpe-no">${i + 1}</span>
          <span class="cpe-item-main">
            <span class="cpe-item-title" style="display:block;">${escapeHTML(p.title)}</span>
            <span class="cpe-item-sub">
              <span class="cpe-dot ${escapeHTML(p.status)}"></span>
              ${p.post_date ? `<span ${late ? 'style="color: var(--kite-red-700); font-weight: 700;"' : ''}>${escapeHTML(p.post_date.slice(5))}</span>` : '<span>no date</span>'}
              <span>${(POST_TYPES[p.content_type] || POST_TYPES.other).icon}</span>
              ${pub ? `<span title="${escapeHTML(pub)}">· ${escapeHTML(getInitials(pub))}</span>` : ''}
            </span>
          </span>
        </button>`;
      }).join('')}`;

    if (this.canEdit) {
      let dragId = null;
      rail.querySelectorAll('[draggable="true"]').forEach(el => {
        el.addEventListener('dragstart', (e) => { dragId = el.dataset.sel; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); });
        el.addEventListener('dragover', (e) => { if (dragId) { e.preventDefault(); el.classList.add('drag-over'); } });
        el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
        el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('drag-over'); if (dragId && dragId !== el.dataset.sel) this.moveBefore(dragId, el.dataset.sel); dragId = null; });
      });
    }
  }

  async moveBefore(id, beforeId) {
    const list = this.posts.filter(p => p.id !== id);
    const moving = this.posts.find(p => p.id === id);
    const at = list.findIndex(p => p.id === beforeId);
    list.splice(at, 0, moving);
    await this.saveOrder(list);
  }

  async saveOrder(list) {
    this.posts = list.map((p, i) => ({ ...p, position: i }));
    this.drawRail();
    const results = await Promise.all(this.posts.map(p => this.supabase.from('content_posts').update({ position: p.position }).eq('id', p.id)));
    if (results.some(r => r.error)) Toast.error('Could not save the new order', 'Reorder failed');
  }

  select(id) {
    this.flush();
    this.selected = id;
    this.selVis = null;
    this.drawRail(); this.drawPreview(); this.drawForm(); this.drawAssets(); this.drawFeedback();
    if (window.lucide) window.lucide.createIcons();
    if (window.innerWidth < 980) document.getElementById('cpePreview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------------------------------------------------------------- preview
  drawPreview() {
    const box = document.getElementById('cpePreview'); if (!box) return;
    const plan = this.planForSlides();
    if (this.selected === 'cover') {
      box.innerHTML = coverHTML({ plan, cover: this.visualsOf(null)[0], total: this.posts.length });
      return;
    }
    const post = this.post; if (!post) { box.innerHTML = ''; return; }
    const draft = { ...post, ...this.pending };
    const idx = this.posts.findIndex(p => p.id === post.id);
    box.innerHTML = slideHTML({ plan, post: draft, visuals: this.visualsOf(post.id), page: idx + 2, pages: this.posts.length + 1 });
    if (this.canEdit) this.armCanvas(box, post.id);
  }

  // ---------------------------------------------------------------- picture canvas (drag, resize, drop)
  /** Current boxes of the selected post's pictures, keyed by asset id. */
  boxesOf(postId) {
    return new Map(visualBoxes(this.visualsOf(postId)).map(({ v, box }) => [v.id, { ...box }]));
  }

  /** Saves boxes for the given asset ids (id -> box). */
  async saveBoxes(map) {
    const jobs = [];
    for (const [id, box] of map) {
      const a = this.assets.find(x => x.id === id); if (!a) continue;
      a.layout = box;
      jobs.push(this.supabase.from('content_post_assets').update({ layout: box }).eq('id', id));
    }
    const res = await Promise.all(jobs);
    const bad = res.find(r => r.error);
    if (bad) Toast.error(/layout/.test(bad.error.message) ? 'Run migration 011_visual_layout.sql in Supabase to save picture positions.' : bad.error.message, 'Could not save the layout');
  }

  armCanvas(stage, postId) {
    const vis = stage.querySelector('.cps-visual');
    if (!vis) return;
    const dir = this.plan.direction === 'rtl';
    vis.dataset.drop = dir ? 'أفلت الصور هنا' : 'Drop pictures here';

    // drop files straight onto the slide
    vis.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); vis.classList.add('cpe-over'); } });
    vis.addEventListener('dragleave', (e) => { if (!vis.contains(e.relatedTarget)) vis.classList.remove('cpe-over'); });
    vis.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault(); vis.classList.remove('cpe-over');
      this.upload([...e.dataTransfer.files], 'post');
    });

    const canvas = vis.querySelector('.cps-canvas');
    if (!canvas) return;
    stage.classList.add('cpe-canvas-on');
    const items = [...canvas.querySelectorAll('.cps-item')];
    const mark = () => items.forEach(el => {
      const on = el.dataset.id === this.selVis;
      el.classList.toggle('sel', on);
      el.querySelectorAll('.cpe-h').forEach(h => h.remove());
      if (on) ['nw', 'ne', 'sw', 'se'].forEach(h => el.insertAdjacentHTML('beforeend', `<i class="cpe-h" data-h="${h}"></i>`));
    });
    mark();

    canvas.addEventListener('pointerdown', (e) => {
      const el = e.target.closest('.cps-item'); if (!el || e.button > 0) return;
      e.preventDefault();
      const id = el.dataset.id, handle = e.target.closest('.cpe-h')?.dataset.h || null;
      if (this.selVis !== id) { this.selVis = id; mark(); }

      const rect = canvas.getBoundingClientRect();
      const all = this.boxesOf(postId);          // every picture gets a saved box the moment you touch one
      const start = { ...all.get(id) };
      const others = [...all].filter(([k]) => k !== id).map(([, b]) => b);
      const lines = { x: [0, 50, 100], y: [0, 50, 100] };
      others.forEach(b => { lines.x.push(b.x, b.x + b.w, b.x + b.w / 2); lines.y.push(b.y, b.y + b.h, b.y + b.h / 2); });
      const snap = (v, axis) => { const hit = lines[axis].find(l => Math.abs(l - v) < 1.2); return hit ?? v; };
      const guideX = document.createElement('i'); guideX.className = 'cpe-guide v';
      const guideY = document.createElement('i'); guideY.className = 'cpe-guide h';
      const x0 = e.clientX, y0 = e.clientY;
      this.dragging = true; el.classList.add('dragging');
      try { canvas.setPointerCapture(e.pointerId); } catch { /* old browsers */ }

      const apply = (b) => { el.style.left = b.x + '%'; el.style.top = b.y + '%'; el.style.width = b.w + '%'; el.style.height = b.h + '%'; };
      const move = (ev) => {
        const dx = ((ev.clientX - x0) / rect.width) * 100, dy = ((ev.clientY - y0) / rect.height) * 100;
        const b = { ...start };
        let gx = null, gy = null;
        if (!handle) {
          let nx = start.x + dx, ny = start.y + dy;
          // snap any of left / middle / right (and top / middle / bottom) to the slide edges or the other pictures
          for (const off of [0, b.w / 2, b.w]) { const s = snap(nx + off, 'x'); if (s !== nx + off) { nx = s - off; gx = s; break; } }
          for (const off of [0, b.h / 2, b.h]) { const s = snap(ny + off, 'y'); if (s !== ny + off) { ny = s - off; gy = s; break; } }
          b.x = Math.min(100 - b.w, Math.max(0, nx)); b.y = Math.min(100 - b.h, Math.max(0, ny));
        } else {
          let l = start.x, t = start.y, r = start.x + start.w, btm = start.y + start.h;
          if (handle.includes('w')) l = snap(Math.min(r - 6, Math.max(0, start.x + dx)), 'x');
          if (handle.includes('e')) r = snap(Math.max(l + 6, Math.min(100, r + dx)), 'x');
          if (handle.includes('n')) t = snap(Math.min(btm - 6, Math.max(0, start.y + dy)), 'y');
          if (handle.includes('s')) btm = snap(Math.max(t + 6, Math.min(100, btm + dy)), 'y');
          if (ev.shiftKey) { // keep the picture's proportions (in real pixels, not %)
            const ratio = (start.w * rect.width) / (start.h * rect.height);
            const wPx = (r - l) * rect.width; const hPx = wPx / ratio;
            const nh = (hPx / rect.height) * 100;
            if (handle.includes('n')) t = btm - nh; else btm = t + nh;
            if (t < 0 || btm > 100) { t = start.y; btm = start.y + start.h; l = start.x; r = start.x + start.w; }
          }
          b.x = l; b.y = t; b.w = r - l; b.h = btm - t;
        }
        Object.keys(b).forEach(k => { if (typeof b[k] === 'number') b[k] = Math.round(b[k] * 10) / 10; });
        apply(b); el._box = b;
        guideX.remove(); guideY.remove();
        if (gx != null) { guideX.style.left = gx + '%'; canvas.appendChild(guideX); }
        if (gy != null) { guideY.style.top = gy + '%'; canvas.appendChild(guideY); }
      };
      const up = async () => {
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
        canvas.removeEventListener('pointercancel', up);
        guideX.remove(); guideY.remove(); el.classList.remove('dragging');
        const moved = el._box && JSON.stringify(el._box) !== JSON.stringify(start);
        if (moved) all.set(id, el._box);
        const needSave = moved;
        el._box = null;
        this.drawAssets();
        if (needSave) await this.saveBoxes(all);
        this.dragging = false;
      };
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
      canvas.addEventListener('pointercancel', up);
    });

    // click on empty slide area clears the selection
    vis.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.cps-item')) return;
      if (this.selVis) { this.selVis = null; mark(); this.drawAssets(); }
    });
  }

  /** Arrangement buttons and the controls for the selected picture. */
  layoutBarHTML(list) {
    const sel = list.find(v => v.id === this.selVis);
    const box = sel ? this.boxesOf(this.selected).get(sel.id) : null;
    return `
      <div class="cpe-layout-bar">
        <div class="cpe-seg" role="group" aria-label="Arrange pictures">
          ${Object.entries(LAYOUT_PRESETS).map(([k, p]) => `<button type="button" data-preset="${k}" title="${p.label}">${p.icon} ${p.label}</button>`).join('')}
        </div>
        ${sel && box ? `
          <div class="cpe-seg" role="group" aria-label="Picture fit">
            <button type="button" data-fit="cover" class="${box.fit === 'cover' ? 'on' : ''}" title="Fill the box (crops the edges)">Fill</button>
            <button type="button" data-fit="contain" class="${box.fit === 'contain' ? 'on' : ''}" title="Show the whole picture">Fit</button>
          </div>
          <div class="cpe-seg"><button type="button" data-z="1" title="Bring to front">⬆ Front</button><button type="button" data-z="-1" title="Send to back">⬇ Back</button></div>
          <label class="cpe-sizer">Size <input type="range" id="cpeSize" min="10" max="100" step="1" value="${Math.round(box.w)}"> <span id="cpeSizeVal">${Math.round(box.w)}%</span></label>`
        : '<span class="text-2xs text-dim">Click a picture on the slide to move it, resize it from its corners, or change its fit. Hold Shift while resizing to keep its shape.</span>'}
      </div>`;
  }

  bindLayoutBar(card, list) {
    const postId = this.selected;
    const redraw = () => { this.drawPreview(); this.drawAssets(); };
    card.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', async () => {
      const boxes = presetBoxes(list.length, b.dataset.preset);
      const map = new Map(list.map((v, i) => [v.id, boxes[i]]));
      if (b.dataset.preset === 'auto') { // automatic again: forget the hand-made positions
        list.forEach(v => { const a = this.assets.find(x => x.id === v.id); if (a) a.layout = null; });
        await Promise.all(list.map(v => this.supabase.from('content_post_assets').update({ layout: null }).eq('id', v.id)));
      } else await this.saveBoxes(map);
      redraw();
    }));
    const change = async (fn) => {
      const all = this.boxesOf(postId), b = all.get(this.selVis); if (!b) return;
      fn(b, all); await this.saveBoxes(all); redraw();
    };
    card.querySelectorAll('[data-fit]').forEach(b => b.addEventListener('click', () => change((box) => { box.fit = b.dataset.fit; })));
    card.querySelectorAll('[data-z]').forEach(b => b.addEventListener('click', () => change((box, all) => {
      const zs = [...all.values()].map(x => x.z);
      box.z = Number(b.dataset.z) > 0 ? Math.max(...zs) + 1 : Math.min(...zs) - 1;
      const min = Math.min(...[...all.values()].map(x => x.z)); // z must stay >= 0
      if (min < 0) all.forEach(x => { x.z -= min; });
    })));
    const size = card.querySelector('#cpeSize');
    size?.addEventListener('input', () => { // live: scale around the picture's centre, keep its shape
      const all = this.boxesOf(postId), b = all.get(this.selVis); if (!b) return;
      const w = Number(size.value), h = Math.min(100, b.h * (w / b.w));
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      b.w = w; b.h = Math.round(h * 10) / 10;
      b.x = Math.round(Math.min(100 - b.w, Math.max(0, cx - b.w / 2)) * 10) / 10;
      b.y = Math.round(Math.min(100 - b.h, Math.max(0, cy - b.h / 2)) * 10) / 10;
      const el = document.querySelector(`#cpePreview .cps-item[data-id="${this.selVis}"]`);
      if (el) { el.style.left = b.x + '%'; el.style.top = b.y + '%'; el.style.width = b.w + '%'; el.style.height = b.h + '%'; }
      document.getElementById('cpeSizeVal').textContent = w + '%';
      size._box = b;
    });
    size?.addEventListener('change', async () => {
      if (!size._box) return;
      const all = this.boxesOf(postId); all.set(this.selVis, size._box);
      await this.saveBoxes(all); redraw();
    });
  }

  // ---------------------------------------------------------------- form
  drawForm() {
    const host = document.getElementById('cpeForm'); if (!host) return;
    const dis = this.canEdit ? '' : 'disabled';
    const dir = this.plan.direction === 'rtl' ? 'rtl' : 'ltr';

    if (this.selected === 'cover') {
      host.innerHTML = `
        <div class="cpe-form">
          <div class="cpe-section-title">Cover slide</div>
          <div class="form-group full"><label class="form-label">Plan title</label><input class="form-control" data-plan="title" value="${escapeHTML(this.plan.title)}" maxlength="160" ${dis} dir="${dir}"></div>
          <div class="form-group full"><label class="form-label">Subtitle</label><input class="form-control" data-plan="subtitle" value="${escapeHTML(this.plan.subtitle || '')}" maxlength="200" ${dis} dir="${dir}"></div>
          <p class="text-2xs text-dim full">Add a cover picture below (the first one is used). The client name comes from the plan settings.</p>
        </div>`;
      host.querySelectorAll('[data-plan]').forEach(el => el.addEventListener('input', () => this.queuePlan(el.dataset.plan, el.value)));
      return;
    }

    const p = this.post;
    if (!p) { host.innerHTML = `<div class="empty-state" style="border:none;"><div class="empty-state-title">No posts yet</div><div class="empty-state-desc">Add the first post from the list.</div></div>`; return; }
    const isPublisher = p.publisher_id === this.me;
    const statusDis = (this.canEdit || isPublisher) ? '' : 'disabled';
    const idx = this.posts.findIndex(x => x.id === p.id);
    const links = Array.isArray(p.links) ? p.links : [];

    host.innerHTML = `
      <div class="cpe-form">
        <div class="cpe-section-title" style="display:flex; justify-content:space-between; align-items:center;">
          <span>Post ${idx + 1} of ${this.posts.length}</span>
          ${this.canEdit ? `<span style="display:flex; gap:6px;">
            <button type="button" class="btn btn-ghost btn-sm" data-act="up" ${idx === 0 ? 'disabled' : ''} aria-label="Move up"><i data-lucide="arrow-up"></i></button>
            <button type="button" class="btn btn-ghost btn-sm" data-act="down" ${idx === this.posts.length - 1 ? 'disabled' : ''} aria-label="Move down"><i data-lucide="arrow-down"></i></button>
            <button type="button" class="btn btn-ghost btn-sm" data-act="dup" aria-label="Duplicate"><i data-lucide="copy"></i></button>
            <button type="button" class="btn btn-danger btn-sm" data-act="del" aria-label="Delete post"><i data-lucide="trash-2"></i></button>
          </span>` : ''}
        </div>
        <div class="form-group full"><label class="form-label">Post title</label>
          <input class="form-control" data-f="title" value="${escapeHTML(p.title)}" maxlength="200" ${dis} dir="${dir}"></div>

        <div class="form-group"><label class="form-label">Publish date</label>
          <input type="date" class="form-control" data-f="post_date" value="${escapeHTML(p.post_date || '')}" ${dis}></div>
        <div class="form-group"><label class="form-label">Time</label>
          <input type="time" class="form-control" data-f="post_time" value="${escapeHTML((p.post_time || '').slice(0, 5))}" ${dis}></div>

        <div class="form-group"><label class="form-label">Format</label>
          <select class="form-control" data-f="content_type" ${dis}>${Object.entries(POST_TYPES).map(([k, v]) => `<option value="${k}" ${p.content_type === k ? 'selected' : ''}>${v.icon} ${v.en}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">Platform</label>
          <input class="form-control" data-f="platform" list="cpePlatforms" value="${escapeHTML(p.platform || '')}" maxlength="60" ${dis}>
          <datalist id="cpePlatforms">${PLATFORMS.map(x => `<option value="${escapeHTML(x)}"></option>`).join('')}</datalist></div>

        <div class="form-group full"><label class="form-label">${dir === 'rtl' ? 'المحور — Pillar' : 'Pillar'}</label>
          <input class="form-control" data-f="pillar" value="${escapeHTML(p.pillar || '')}" maxlength="120" ${dis} dir="${dir}"></div>
        <div class="form-group full"><label class="form-label">${dir === 'rtl' ? 'الهدف — Objective' : 'Objective'}</label>
          <textarea class="form-control" data-f="objective" rows="2" maxlength="1200" ${dis} dir="${dir}">${escapeHTML(p.objective || '')}</textarea></div>
        <div class="form-group full"><label class="form-label">${dir === 'rtl' ? 'الفكرة — Idea' : 'Idea'}</label>
          <textarea class="form-control" data-f="idea" rows="4" maxlength="3000" ${dis} dir="${dir}">${escapeHTML(p.idea || '')}</textarea></div>
        <div class="form-group full"><label class="form-label">${dir === 'rtl' ? 'الكابشن — Caption' : 'Caption'}</label>
          <textarea class="form-control" data-f="caption" rows="5" maxlength="4000" ${dis} dir="${dir}">${escapeHTML(p.caption || '')}</textarea></div>

        <div class="cpe-section-title">Links (Drive, Figma, reference videos…)</div>
        <div class="full" id="cpeLinks">
          ${links.map((l, i) => `
          <div class="cpe-link-row" data-i="${i}">
            <input class="form-control" data-link="label" placeholder="Label" value="${escapeHTML(l.label || '')}" maxlength="80" ${dis}>
            <input class="form-control" data-link="url" placeholder="https://…" value="${escapeHTML(l.url || '')}" maxlength="500" ${dis}>
            ${this.canEdit ? `<button type="button" class="btn btn-ghost btn-sm" data-rm="${i}" aria-label="Remove link"><i data-lucide="x"></i></button>` : ''}
          </div>`).join('')}
          ${this.canEdit ? `<button type="button" class="btn btn-secondary btn-sm" id="cpeAddLink"><i data-lucide="link"></i> Add link</button>` : ''}
        </div>

        <div class="cpe-section-title">Publishing</div>
        <div class="form-group"><label class="form-label">Who publishes it</label>
          <select class="form-control" id="cpePublisher" ${dis}>
            <option value="">Not assigned</option>
            ${this.people.map(x => `<option value="${escapeHTML(x.id)}" ${p.publisher_id === x.id ? 'selected' : ''}>${escapeHTML(x.full_name)}</option>`).join('')}
          </select></div>
        <div class="form-group"><label class="form-label">Status</label>
          <select class="form-control" data-f="status" ${statusDis}>${Object.entries(POST_STATUSES).map(([k, v]) => `<option value="${k}" ${p.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
        <div class="full" style="display:flex; gap:var(--space-2); flex-wrap:wrap; align-items:center;">
          ${p.status === 'published'
            ? `<span class="badge badge-emerald">Published ${p.published_at ? escapeHTML(formatRelativeTime(p.published_at)) : ''}</span>
               ${p.published_url && safeUrl(p.published_url) ? `<a class="btn btn-secondary btn-sm" href="${escapeHTML(safeUrl(p.published_url))}" target="_blank" rel="noopener noreferrer">View live post ↗</a>` : ''}`
            : `${(this.canEdit || isPublisher) ? `<button type="button" class="btn btn-primary btn-sm" id="cpeMarkPublished"><i data-lucide="send"></i> Mark as published</button>` : ''}`}
          <span class="text-2xs text-dim">The publisher is notified when assigned or when the date changes, and again on the day.</span>
        </div>
      </div>`;

    // text-like fields autosave
    host.querySelectorAll('[data-f]').forEach(el => {
      const evt = (el.tagName === 'SELECT' || el.type === 'date' || el.type === 'time') ? 'change' : 'input';
      el.addEventListener(evt, () => this.queue(el.dataset.f, el.value));
    });
    host.querySelectorAll('#cpeLinks [data-link]').forEach(el => el.addEventListener('input', () => this.queueLinks()));
    host.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => this.removeLink(Number(b.dataset.rm))));
    host.querySelector('#cpeAddLink')?.addEventListener('click', () => this.addLink());
    host.querySelector('#cpePublisher')?.addEventListener('change', (e) => this.assign(e.target.value || null));
    host.querySelector('#cpeMarkPublished')?.addEventListener('click', () => this.markPublished());
    host.querySelector('[data-act="up"]')?.addEventListener('click', () => this.shift(-1));
    host.querySelector('[data-act="down"]')?.addEventListener('click', () => this.shift(1));
    host.querySelector('[data-act="dup"]')?.addEventListener('click', () => this.duplicatePost());
    host.querySelector('[data-act="del"]')?.addEventListener('click', () => this.deletePost());
  }

  // ---------------------------------------------------------------- autosave
  setSaved(state, text) {
    const el = document.getElementById('cpeSaved'); if (!el) return;
    el.className = `cpe-saved ${state}`; el.textContent = text;
  }

  queue(field, value) {
    const p = this.post; if (!p) return;
    const v = value === '' ? null : value;
    this.pending[field] = (field === 'title' && !v) ? 'Untitled post' : v;
    this.setSaved('', 'Editing…');
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.drawPreview(), 150);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 700);
    if (field === 'title') { const row = document.querySelector(`[data-sel="${p.id}"] .cpe-item-title`); if (row) row.textContent = value || 'Untitled post'; }
  }

  queueLinks() {
    const rows = [...document.querySelectorAll('#cpeLinks .cpe-link-row')];
    this.queue('links', rows.map(r => ({
      label: r.querySelector('[data-link="label"]').value.trim(),
      url: r.querySelector('[data-link="url"]').value.trim()
    })).filter(l => l.url || l.label));
    // an empty list is stored as [] (not null)
    if (this.pending.links === null) this.pending.links = [];
  }

  addLink() {
    const p = this.post; if (!p) return;
    const links = [...(Array.isArray(p.links) ? p.links : []), { label: '', url: '' }];
    p.links = links;
    this.drawForm(); if (window.lucide) window.lucide.createIcons();
    document.querySelectorAll('#cpeLinks [data-link="label"]')[links.length - 1]?.focus();
  }

  removeLink(i) {
    const p = this.post; if (!p) return;
    const links = (Array.isArray(p.links) ? p.links : []).filter((_, k) => k !== i);
    p.links = links;
    this.pending.links = links;
    this.drawForm(); this.drawPreview(); if (window.lucide) window.lucide.createIcons();
    this.flush();
  }

  queuePlan(field, value) {
    this.plan[field] = value;
    clearTimeout(this.planTimer);
    this.setSaved('', 'Editing…');
    this.planTimer = setTimeout(async () => {
      const patch = { title: this.plan.title.trim() || 'Untitled plan', subtitle: (this.plan.subtitle || '').trim() || null };
      const { error } = await this.supabase.from('content_plans').update(patch).eq('id', this.plan.id);
      this.setSaved(error ? 'err' : 'ok', error ? 'Not saved' : 'Saved');
      this.drawHeader(); this.drawPreview();
    }, 700);
  }

  async flush() {
    clearTimeout(this.saveTimer);
    const p = this.post;
    const patch = this.pending; this.pending = {};
    if (!p || !Object.keys(patch).length) return;

    // links: keep only valid http(s) addresses
    if (patch.links) patch.links = patch.links.filter(l => safeUrl(l.url)).map(l => ({ label: l.label || '', url: safeUrl(l.url) }));
    Object.assign(p, patch);
    const { error } = await this.supabase.from('content_posts').update(patch).eq('id', p.id);
    if (error) { this.setSaved('err', 'Not saved'); Toast.error(error.message, 'Could not save'); return; }
    this.setSaved('ok', 'Saved');
    this.drawRail();
    if ('post_date' in patch || 'post_time' in patch) Api.contentPostChanged(p.id).catch(() => {});
  }

  // ---------------------------------------------------------------- post actions
  async addPost(copyFrom = null) {
    await this.flush();
    const last = this.posts[this.posts.length - 1];
    let date = copyFrom?.post_date || null;
    if (!date) {
      const d = last?.post_date ? new Date(last.post_date + 'T00:00:00') : new Date();
      d.setDate(d.getDate() + (last?.post_date ? 2 : 0));
      date = ymd(d);
    }
    const row = {
      plan_id: this.plan.id, position: this.posts.length, created_by: this.me, post_date: date,
      title: copyFrom ? `${copyFrom.title} (copy)` : 'New post',
      content_type: copyFrom?.content_type || 'static', platform: copyFrom?.platform || last?.platform || null,
      pillar: copyFrom?.pillar || null, objective: copyFrom?.objective || null, idea: copyFrom?.idea || null,
      caption: copyFrom?.caption || null, links: copyFrom?.links || [], post_time: copyFrom?.post_time || null
    };
    const { data, error } = await this.supabase.from('content_posts').insert(row).select('*').single();
    if (error) { Toast.error(error.message, 'Could not add the post'); return; }
    this.posts.push(data);
    this.select(data.id);
  }

  duplicatePost() { const p = this.post; if (p) this.addPost(p); }

  async shift(delta) {
    await this.flush();
    const i = this.posts.findIndex(p => p.id === this.selected);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.posts.length) return;
    const list = [...this.posts];
    [list[i], list[j]] = [list[j], list[i]];
    await this.saveOrder(list);
    this.drawForm(); this.drawPreview(); if (window.lucide) window.lucide.createIcons();
  }

  async deletePost() {
    const p = this.post; if (!p) return;
    const ok = await confirmDialog({ title: 'Delete this post?', message: `"${p.title}" and its visuals will be removed from the plan.`, confirmLabel: 'Delete post', danger: true });
    if (!ok) return;
    const paths = this.assets.filter(a => a.post_id === p.id).map(a => a.storage_path);
    const { error } = await this.supabase.from('content_posts').delete().eq('id', p.id);
    if (error) { Toast.error(error.message, 'Delete refused'); return; }
    if (paths.length) await this.supabase.storage.from(CONFIG.STORAGE_BUCKETS.STUDIO_ASSETS).remove(paths);
    this.posts = this.posts.filter(x => x.id !== p.id);
    this.assets = this.assets.filter(a => a.post_id !== p.id);
    this.pending = {};
    this.selected = this.posts[0]?.id || 'cover';
    this.drawAll();
    Toast.success('Post deleted', 'Deleted');
  }

  async assign(publisherId) {
    const p = this.post; if (!p) return;
    await this.flush();
    try {
      await Api.assignPublisher(p.id, publisherId);
      p.publisher_id = publisherId;
      this.drawRail();
      const name = this.people.find(x => x.id === publisherId)?.full_name;
      Toast.success(publisherId ? `${name} was notified` : 'Publisher removed', 'Publisher');
    } catch (err) {
      Toast.error(err.message, 'Could not assign');
      this.drawForm(); if (window.lucide) window.lucide.createIcons();
    }
  }

  markPublished() {
    const p = this.post; if (!p) return;
    formDialog({
      title: 'Mark as published',
      subtitle: `"${p.title}" is live on the client's account.`,
      submitLabel: 'Mark published',
      fields: [{ name: 'url', label: 'Link to the live post (optional)', placeholder: 'https://instagram.com/p/…', maxlength: 500 }],
      onSubmit: async (v) => {
        await this.flush();
        await Api.publishPost(p.id, v.url);
        Object.assign(p, { status: 'published', published_url: v.url, published_at: new Date().toISOString() });
        this.drawAll();
        Toast.success('Post marked as published', 'Published');
      }
    });
  }

  // ---------------------------------------------------------------- visuals
  drawAssets() {
    const card = document.getElementById('cpeAssetsCard'); if (!card) return;
    const isCover = this.selected === 'cover';
    const list = this.visualsOf(isCover ? null : this.selected);
    const target = isCover ? 'cover' : 'post';
    if (!isCover && !this.post) { card.innerHTML = ''; return; }
    card.innerHTML = `
      <div class="card-header"><div class="card-title">${isCover ? 'Cover picture' : 'Visuals'}</div><span class="badge badge-slate">${list.length}</span></div>
      <div class="card-body" style="display:flex; flex-direction:column; gap:var(--space-3);">
        ${!isCover && this.canEdit && list.length ? this.layoutBarHTML(list) : ''}
        ${list.length ? `<div class="cpe-assets">${list.map(v => `
          <div class="cpe-asset${v.id === this.selVis && !isCover ? ' sel' : ''}" data-pick="${escapeHTML(v.id)}">
            ${/^image\//.test(v.type) ? `<img src="${escapeHTML(v.url)}" alt="${escapeHTML(v.name)}" loading="lazy">`
              : /^video\//.test(v.type) ? `<video src="${escapeHTML(v.url)}" muted preload="metadata"></video>`
              : `<div class="file"><span>📎</span>${escapeHTML(v.name)}</div>`}
            ${this.canEdit ? `<button type="button" data-del="${escapeHTML(v.id)}" aria-label="Remove">×</button>` : ''}
          </div>`).join('')}</div>` : ''}
        ${this.canEdit ? `
        <div class="cpe-drop" id="cpeDrop" tabindex="0">
          <i data-lucide="upload-cloud"></i> Drop ${isCover ? 'a picture' : 'images or videos'} here — or straight onto the slide — or click to choose
          <div class="text-2xs text-dim">Up to 50 MB each.${isCover ? '' : ' New pictures are arranged in a grid until you move one.'}</div>
        </div>
        <input type="file" id="cpeFile" ${isCover ? '' : 'multiple'} accept="image/*,video/mp4,video/quicktime,video/webm" style="display:none;">` : (list.length ? '' : '<p class="text-xs text-muted">No visuals yet.</p>')}
      </div>`;
    if (window.lucide) window.lucide.createIcons();

    card.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); this.removeAsset(b.dataset.del); }));
    if (!isCover && this.canEdit) {
      card.querySelectorAll('[data-pick]').forEach(el => el.addEventListener('click', () => {
        this.selVis = this.selVis === el.dataset.pick ? null : el.dataset.pick;
        this.drawPreview(); this.drawAssets();
      }));
      this.bindLayoutBar(card, list);
    }
    const drop = card.querySelector('#cpeDrop'), input = card.querySelector('#cpeFile');
    if (!drop) return;
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => this.upload([...e.dataTransfer.files], target));
    input.addEventListener('change', () => { this.upload([...input.files], target); input.value = ''; });
  }

  async upload(files, target) {
    if (!files.length) return;
    const postId = target === 'cover' ? null : this.selected;
    const bucket = CONFIG.STORAGE_BUCKETS.STUDIO_ASSETS;
    let done = 0;
    const base = this.assets.filter(a => (a.post_id || null) === postId).length;

    if (target === 'cover') {
      // one cover picture: replace the old one
      const old = this.assets.filter(a => !a.post_id);
      for (const a of old) await this.removeAsset(a.id, true);
      files = files.slice(0, 1);
    }

    for (const file of files) {
      if (file.size > MAX_VISUAL_BYTES) { Toast.error(`${file.name} is larger than 50 MB`, 'Too large'); continue; }
      if (!/^(image|video)\//.test(file.type)) { Toast.error(`${file.name}: only images and videos can be added here`, 'Unsupported file'); continue; }
      const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-100);
      const path = `${this.me}/plans/${this.plan.id}/${crypto.randomUUID()}-${safe}`;
      const { error: upErr } = await this.supabase.storage.from(bucket).upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) { Toast.error(`${file.name}: ${upErr.message}`, 'Upload failed'); continue; }
      const row = {
        plan_id: this.plan.id, post_id: postId, storage_path: path, file_name: file.name,
        file_type: file.type || extOf(file.name), file_size: file.size, position: base + done, uploaded_by: this.me
      };
      // once pictures were arranged by hand, a new one lands in the middle on top instead of reshuffling the slide
      if (postId && this.assets.some(a => a.post_id === postId && a.layout)) {
        const z = Math.max(0, ...this.assets.filter(a => a.post_id === postId && a.layout).map(a => a.layout.z || 0)) + 1;
        row.layout = { x: 25, y: 25, w: 50, h: 50, fit: 'cover', z };
      }
      const { data, error } = await this.supabase.from('content_post_assets').insert(row).select('*').single();
      if (error) { await this.supabase.storage.from(bucket).remove([path]); Toast.error(`${file.name}: ${error.message}`, 'Upload failed'); continue; }
      this.assets.push(data); done++;
    }
    if (done) {
      await this.signUrls();
      this.drawAssets(); this.drawPreview();
      Toast.success(`${done} visual${done > 1 ? 's' : ''} added`, 'Uploaded');
    }
  }

  async removeAsset(id, silent = false) {
    const a = this.assets.find(x => x.id === id); if (!a) return;
    const { error } = await this.supabase.from('content_post_assets').delete().eq('id', id);
    if (error) { Toast.error(error.message, 'Delete refused'); return; }
    await this.supabase.storage.from(CONFIG.STORAGE_BUCKETS.STUDIO_ASSETS).remove([a.storage_path]);
    this.assets = this.assets.filter(x => x.id !== id);
    if (!silent) { this.drawAssets(); this.drawPreview(); }
  }

  // ---------------------------------------------------------------- client feedback
  drawFeedback() {
    const card = document.getElementById('cpeFeedbackCard'); if (!card) return;
    const postId = this.selected === 'cover' ? null : this.selected;
    const scoped = this.fbScope === 'page';
    const list = this.feedback.filter(f => !scoped || (f.post_id || null) === postId);
    const open = this.feedback.filter(f => !f.resolved && (f.kind === 'change' || f.kind === 'note')).length;
    const pageOf = (f) => f.slide_no ? `Page ${f.slide_no}${f.slide_title ? ` · ${f.slide_title}` : ''}` : 'Whole plan';
    card.innerHTML = `
      <div class="card-header">
        <div class="card-title">Client feedback ${open ? `<span class="badge badge-amber">${open} open</span>` : ''}</div>
        <div class="glass-panel-subtle" style="display:inline-flex; padding:2px; border-radius:var(--radius-lg);">
          <button type="button" class="btn btn-ghost btn-sm ${scoped ? 'active' : ''}" data-scope="page">This page</button>
          <button type="button" class="btn btn-ghost btn-sm ${scoped ? '' : 'active'}" data-scope="all">All pages</button>
        </div>
      </div>
      <div class="card-body cpe-feedback">
        ${list.length ? list.map(f => `
          <div class="cpe-fb ${f.kind === 'change' ? 'change' : ''} ${f.resolved ? 'resolved' : ''}">
            <div style="flex:1; min-width:0;">
              <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
                <strong class="text-xs">${escapeHTML(f.author_name)}</strong>
                <span class="badge ${f.kind === 'change' ? 'badge-amber' : f.kind === 'note' ? 'badge-sky' : 'badge-emerald'}">${{ change: 'Edit requested', note: 'Note', approve: 'Approved page', approve_all: 'Approved plan' }[f.kind]}</span>
                <button type="button" class="btn btn-ghost btn-sm" data-goto="${escapeHTML(f.post_id || 'cover')}" style="padding:0 6px;">${escapeHTML(pageOf(f))}</button>
                <span class="text-2xs text-dim">${escapeHTML(formatRelativeTime(f.created_at))}</span>
              </div>
              ${f.message ? `<p>${escapeHTML(f.message)}</p>` : ''}
            </div>
            ${this.canEdit && (f.kind === 'change' || f.kind === 'note') ? `<button type="button" class="btn btn-secondary btn-sm" data-resolve="${escapeHTML(f.id)}" data-state="${f.resolved ? '0' : '1'}">${f.resolved ? 'Reopen' : 'Mark done'}</button>` : ''}
          </div>`).join('')
          : `<p class="text-xs text-muted">${scoped ? 'No notes on this page yet.' : 'The client has not left any notes yet. Share the plan to collect them.'}</p>`}
      </div>`;
    card.querySelectorAll('[data-scope]').forEach(b => b.addEventListener('click', () => { this.fbScope = b.dataset.scope; this.drawFeedback(); }));
    card.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => this.select(b.dataset.goto)));
    card.querySelectorAll('[data-resolve]').forEach(b => b.addEventListener('click', async () => {
      const done = b.dataset.state === '1';
      const { error } = await this.supabase.from('content_feedback')
        .update({ resolved: done, resolved_by: done ? this.me : null, resolved_at: done ? new Date().toISOString() : null }).eq('id', b.dataset.resolve);
      if (error) Toast.error(error.message, 'Could not update');
    }));
  }

  // ---------------------------------------------------------------- header actions
  do_settings() {
    const pl = this.plan;
    (async () => {
      const supabase = this.supabase;
      const [{ data: clients }, { data: camps }, depts] = await Promise.all([
        supabase.from('clients').select('id, company_name').order('company_name', { ascending: true }),
        supabase.from('campaigns').select('id, name').order('created_at', { ascending: false }),
        departmentOptions(this.app)
      ]);
      formDialog({
        title: 'Plan settings', subtitle: 'Client, team, language and colour of this content plan.',
        fields: [
          { name: 'client_id', label: 'Client', type: 'select', half: true, value: pl.client_id || '', options: [{ value: '', label: 'No client' }, ...(clients || []).map(c => ({ value: c.id, label: c.company_name }))] },
          { name: 'campaign_id', label: 'Campaign', type: 'select', half: true, value: pl.campaign_id || '', options: [{ value: '', label: 'Not linked' }, ...(camps || []).map(c => ({ value: c.id, label: c.name }))] },
          { name: 'department_id', label: 'Team that edits it', type: 'select', half: true, value: pl.department_id || '', options: depts.map(d => ({ value: d.id, label: d.name })) },
          { name: 'direction', label: 'Language', type: 'select', half: true, value: pl.direction, options: [{ value: 'rtl', label: 'Arabic (right-to-left)' }, { value: 'ltr', label: 'English (left-to-right)' }] },
          { name: 'accent', label: 'Colour', type: 'select', half: true, value: pl.accent, options: ACCENTS.some(a => a.value === pl.accent) ? ACCENTS : [{ value: pl.accent, label: pl.accent }, ...ACCENTS] },
          { name: 'status', label: 'Status', type: 'select', half: true, value: pl.status, options: Object.entries(PLAN_STATUSES).map(([k, v]) => ({ value: k, label: v.label })) }
        ],
        onDelete: Permissions.isAdmin() || pl.created_by === this.me ? async () => {
          // files first: the storage rule needs the plan to still exist
          const paths = this.assets.map(a => a.storage_path);
          if (paths.length) await supabase.storage.from(CONFIG.STORAGE_BUCKETS.STUDIO_ASSETS).remove(paths);
          const { error } = await supabase.from('content_plans').delete().eq('id', pl.id);
          if (error) throw new Error(error.message);
          Toast.success('Content plan deleted', 'Deleted');
          window.location.hash = '#campaigns';
        } : undefined,
        deleteLabel: 'Delete plan', deleteMessage: 'The plan, all its posts, visuals and client notes will be removed. The client link stops working.',
        onSubmit: async (v) => {
          const { error } = await supabase.from('content_plans').update(v).eq('id', pl.id);
          if (error) throw new Error(error.message);
          await this.load(false);
          this.drawAll();
          Toast.success('Plan updated', 'Saved');
        }
      });
    })();
  }

  async do_pptx(btn) {
    await this.flush();
    const original = btn.innerHTML;
    btn.disabled = true;
    try {
      await this.signUrls();
      const posts = this.posts.map(p => ({ ...p, visuals: this.visualsOf(p.id) }));
      await exportPlanToPptx({
        plan: this.planForSlides(), cover: this.visualsOf(null)[0], posts,
        onProgress: (m) => { btn.textContent = m; }
      });
      Toast.success('The PowerPoint was downloaded', 'Download ready');
    } catch (err) {
      console.error('PPTX export failed:', err);
      Toast.error(err.message || 'Could not build the PowerPoint', 'Export failed');
    } finally {
      btn.disabled = false; btn.innerHTML = original;
      if (window.lucide) window.lucide.createIcons();
    }
  }

  async do_share() {
    await this.flush();
    let share;
    try { share = (await Api.getPlanShare(this.plan.id)).share; }
    catch (err) { Toast.error(err.message, 'Could not load the link'); return; }
    this.openShareDialog(share);
  }

  openShareDialog(share) {
    const link = share ? `${window.location.origin}/preview.html#${share.token}` : '';
    const active = !!(share && share.enabled && (!share.expiresAt || new Date(share.expiresAt) > new Date()));
    const d = htmlDialog({
      title: 'Share with the client',
      maxWidth: '560px',
      buttonLabel: 'Done',
      html: `
        <p class="text-xs text-muted" style="line-height:1.6; margin-bottom: var(--space-3);">
          The client opens a private page showing the plan as slides. On every page they can approve it, ask for an edit or leave a note — you are notified straight away and see which page it was about.
        </p>
        ${active ? `
          <div class="cpe-share-link">
            <input class="form-control" id="cpeLinkField" readonly value="${escapeHTML(link)}">
            <button type="button" class="btn btn-primary btn-sm" id="cpeCopy">Copy</button>
          </div>
          <p class="text-2xs text-dim" style="margin-top:6px;">${share.expiresAt ? `Expires ${escapeHTML(new Date(share.expiresAt).toLocaleDateString())}` : 'The link does not expire.'} Anyone with the link can view the plan.</p>
          <div style="display:flex; flex-wrap:wrap; gap:var(--space-2); margin-top: var(--space-3);">
            <a class="btn btn-secondary btn-sm" href="${escapeHTML(link)}" target="_blank" rel="noopener noreferrer">Open client view ↗</a>
            <a class="btn btn-secondary btn-sm" href="https://wa.me/?text=${encodeURIComponent(`${this.plan.title}\n${link}`)}" target="_blank" rel="noopener noreferrer">Send on WhatsApp</a>
            <button type="button" class="btn btn-ghost btn-sm" id="cpeRegen">New link (old one stops)</button>
            <button type="button" class="btn btn-danger btn-sm" id="cpeStop">Stop sharing</button>
          </div>`
        : `
          <div class="form-group">
            <label class="form-label" for="cpeDays">Link validity</label>
            <select id="cpeDays" class="form-control">
              <option value="0">No expiry</option><option value="7">7 days</option><option value="14">14 days</option><option value="30" selected>30 days</option><option value="90">90 days</option>
            </select>
          </div>
          <button type="button" class="btn btn-primary btn-sm" id="cpeStart" style="margin-top: var(--space-3);">Create the client link</button>`}
      `
    });
    const reopen = (s) => { closeDialog(); this.openShareDialog(s); this.load(false).then(() => this.drawHeader()); };
    d.querySelector('#cpeCopy')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link); Toast.success('Link copied', 'Copied'); }
      catch { d.querySelector('#cpeLinkField')?.select(); Toast.info('Press Ctrl+C to copy the link', 'Copy'); }
    });
    d.querySelector('#cpeStart')?.addEventListener('click', async () => {
      try { reopen((await Api.enablePlanShare(this.plan.id, { days: Number(d.querySelector('#cpeDays').value) })).share); }
      catch (e) { Toast.error(e.message, 'Could not create the link'); }
    });
    d.querySelector('#cpeRegen')?.addEventListener('click', async () => {
      try { reopen((await Api.enablePlanShare(this.plan.id, { regenerate: true, days: share.expiresAt ? 30 : 0 })).share); }
      catch (e) { Toast.error(e.message, 'Could not renew the link'); }
    });
    d.querySelector('#cpeStop')?.addEventListener('click', async () => {
      try { reopen((await Api.disablePlanShare(this.plan.id)).share); Toast.success('The client link no longer works', 'Sharing stopped'); }
      catch (e) { Toast.error(e.message, 'Could not stop sharing'); }
    });
  }
}
