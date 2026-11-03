/**
 * KITE SYSTEM — client preview (public page, no login)
 * The client flips through the plan as slides and, on every page, approves it, asks for an edit or leaves a note.
 * Everything goes through the `client-preview` edge function with the private token in the link (#token).
 */

import { escapeHTML, formatRelativeTime } from '../utils/helpers.js';
import { slideHTML, coverHTML, bindSlides, formatPlanDate, typeLabel, colourStyle, planColours } from '../utils/plan-slide.js';

const root = document.getElementById('pvRoot');
const token = decodeURIComponent(window.location.hash.replace(/^#/, '')).trim();
const NAME_KEY = 'kite-preview-name';

const T = {
  rtl: {
    page: 'صفحة', of: 'من', next: 'التالي', prev: 'السابق', overview: 'كل الصفحات', feedback: 'ملاحظاتك',
    yourName: 'اسمك', namePh: 'اكتب اسمك', note: 'ملاحظتك على هذه الصفحة', notePh: 'اكتب أي تعديل أو ملاحظة…',
    approve: '✓ أوافق على الصفحة', edit: '✎ أطلب تعديل', send: 'أرسل ملاحظة', before: 'ملاحظات سابقة على هذه الصفحة',
    none: 'لا توجد ملاحظات على هذه الصفحة بعد.', needName: 'من فضلك اكتب اسمك أولاً', needNote: 'اكتب ملاحظتك أولاً',
    sentApprove: 'تمت الموافقة على الصفحة ✓', sentEdit: 'وصل طلب التعديل للفريق', sentNote: 'وصلت ملاحظتك للفريق',
    finalTitle: 'دورك الآن', finalText: 'راجع الصفحات وأرسل ملاحظاتك على كل صفحة، وعندما تكون جاهزاً وافق على الخطة كاملة.',
    approvedPages: 'صفحات موافق عليها', editPages: 'طلبات تعديل', approveAll: 'أوافق على الخطة كاملة',
    approvedAll: 'شكراً لك! تمت الموافقة على الخطة ', approvedAllText: 'سيبدأ الفريق في التنفيذ والنشر حسب الجدول.',
    confirmAll: 'هل تريد الموافقة على الخطة كاملة؟', resolved: 'تم التعامل معها ✓', team: 'فريق كايت', clientNote: 'ملاحظة العميل',
    expired: 'هذا الرابط غير متاح', expiredText: 'قد يكون الرابط انتهى أو تم إيقافه. اطلب من الاستوديو رابطاً جديداً.', fab: 'ملاحظاتك', posts: 'منشور', close: 'إغلاق', status: 'تمت الموافقة على الخطة'
  },
  ltr: {
    page: 'Page', of: 'of', next: 'Next', prev: 'Back', overview: 'All pages', feedback: 'Your feedback',
    yourName: 'Your name', namePh: 'Type your name', note: 'Your note on this page', notePh: 'Write any edit or comment…',
    approve: '✓ Approve this page', edit: '✎ Request an edit', send: 'Send a note', before: 'Earlier notes on this page',
    none: 'No notes on this page yet.', needName: 'Please type your name first', needNote: 'Please write your note first',
    sentApprove: 'Page approved ✓', sentEdit: 'Edit request sent to the team', sentNote: 'Your note was sent to the team',
    finalTitle: 'Your turn', finalText: 'Go through the pages and leave notes on any page. When you are happy, approve the whole plan.',
    approvedPages: 'pages approved', editPages: 'edit requests', approveAll: 'Approve the whole plan',
    approvedAll: 'Thank you! The plan is approved ', approvedAllText: 'The team will start producing and publishing on schedule.',
    confirmAll: 'Approve the whole plan?', resolved: 'Handled ✓', team: 'Kite team', clientNote: 'Client note',
    expired: 'This link is not available', expiredText: 'It may have expired or been switched off. Ask the studio for a new link.', fab: 'Feedback', posts: 'posts', close: 'Close', status: 'Plan approved'
  }
};

const state = { data: null, index: 0, view: 'slides', panelOpen: false, dir: 'ltr' };
const tr = (k) => T[state.dir][k];

async function call(action, payload = {}) {
  const base = (window.ENV_SUPABASE_URL || '').replace(/\/$/, '');
  const res = await fetch(`${base}/functions/v1/client-preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: window.ENV_SUPABASE_ANON_KEY || '' },
    body: JSON.stringify({ action, token, ...payload })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error || 'Something went wrong. Please try again.');
  return body;
}

function message(title, text) {
  root.className = 'pv-message';
  root.innerHTML = `<img src="assets/logo-vertical-dark.png" alt="Kite Design Studio" width="84" height="90"><h1>${escapeHTML(title)}</h1><p>${escapeHTML(text)}</p>`;
}

function toast(text, isError = false) {
  const el = document.createElement('div');
  el.className = `pv-toast ${isError ? 'err' : ''}`;
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ------------------------------------------------------------------ pages
const pages = () => [{ type: 'cover' }, ...state.data.posts.map(p => ({ type: 'post', post: p })), { type: 'final' }];
const feedbackFor = (pageNo) => state.data.feedback.filter(f => f.slideNo === pageNo);
function pageState(pageNo) {
  const list = feedbackFor(pageNo).filter(f => !f.resolved);
  if (list.some(f => f.kind === 'change')) return 'ed';
  if (list.some(f => f.kind === 'approve')) return 'ok';
  return '';
}

function planForSlides() {
  const d = state.data.plan;
  return { title: d.title, subtitle: d.subtitle, direction: d.direction, accent: d.accent, accent2: d.accent2, accent3: d.accent3, clientName: d.clientName };
}

// ------------------------------------------------------------------ rendering
function render() {
  const { plan } = state.data;
  { const c = planColours(plan); const r = document.documentElement.style; r.setProperty('--pv-a1', c.accent); r.setProperty('--pv-a2', c.accent2); r.setProperty('--pv-a3', c.accent3); }
  const list = pages();
  const total = list.length;
  const pageNo = state.index + 1;

  root.className = '';
  root.innerHTML = `
    <div class="pv" dir="${state.dir}">
      <header class="pv-top">
        <img src="assets/logo-vertical-dark.png" alt="Kite Design Studio">
        <div class="pv-top-title"><strong>${escapeHTML(plan.title)}</strong><small>${escapeHTML(plan.clientName || '')}${plan.status === 'approved' ? ` · ✓ ${escapeHTML(tr('status'))}` : ''}</small></div>
        <button type="button" class="pv-btn" id="pvOverview">▦ <span class="lbl">${escapeHTML(tr('overview'))}</span></button>
      </header>
      <div class="pv-progress"><i style="width:${(pageNo / total) * 100}%"></i></div>
      ${state.view === 'grid' ? gridHTML(list) : workHTML(list, pageNo, total)}
      ${state.view === 'grid' ? '' : `<nav class="pv-dots" aria-label="Pages">${list.map((p, i) => `<button type="button" class="pv-dot ${i === state.index ? 'on' : pageState(i + 1)}" data-go="${i}" aria-label="${escapeHTML(tr('page'))} ${i + 1}"></button>`).join('')}</nav>`}
    </div>`;

  document.getElementById('pvOverview').addEventListener('click', () => { state.view = state.view === 'grid' ? 'slides' : 'grid'; render(); });
  root.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => go(Number(b.dataset.go), true)));
  if (state.view === 'grid') { root.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => { state.view = 'slides'; go(Number(b.dataset.open), true); })); return; }

  bindSlides(root.querySelector('.pv-slide'));
  document.getElementById('pvPrev')?.addEventListener('click', () => go(state.index - 1));
  document.getElementById('pvNext')?.addEventListener('click', () => go(state.index + 1));
  document.getElementById('pvFab')?.addEventListener('click', () => { state.panelOpen = true; document.getElementById('pvPanel').classList.add('open'); });
  document.getElementById('pvPanelClose')?.addEventListener('click', () => { state.panelOpen = false; document.getElementById('pvPanel').classList.remove('open'); });
  bindPanel();
  bindFinal();
}

function workHTML(list, pageNo, total) {
  const cur = list[state.index];
  const rtl = state.dir === 'rtl';
  let slide;
  if (cur.type === 'cover') slide = coverHTML({ plan: planForSlides(), cover: state.data.cover, total: state.data.posts.length });
  else if (cur.type === 'post') slide = slideHTML({ plan: planForSlides(), post: cur.post, visuals: cur.post.visuals, page: pageNo, pages: total });
  else slide = finalHTML();

  return `
    <main class="pv-work">
      <div class="pv-stage">
        <button type="button" class="pv-nav" id="pvPrev" aria-label="${escapeHTML(tr('prev'))}" ${state.index === 0 ? 'disabled' : ''}>‹</button>
        <div class="pv-slide cps-stage" style="--pv-from:${state.lastDir === -1 ? '-28px' : '28px'}">${slide}</div>
        <button type="button" class="pv-nav" id="pvNext" aria-label="${escapeHTML(tr('next'))}" ${state.index >= total - 1 ? 'disabled' : ''}>›</button>
      </div>
      ${cur.type === 'final' ? '' : panelHTML(cur, pageNo)}
    </main>
    ${cur.type === 'final' ? '' : `<button type="button" class="pv-btn primary pv-fab" id="pvFab">${escapeHTML(tr('fab'))}</button>`}`;
}

function panelHTML(cur, pageNo) {
  const notes = feedbackFor(pageNo);
  const savedName = localStorage.getItem(NAME_KEY) || '';
  return `
    <aside class="pv-panel ${state.panelOpen ? 'open' : ''}" id="pvPanel" dir="${state.dir}">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
        <div><h3>${escapeHTML(tr('feedback'))}</h3><small>${escapeHTML(tr('page'))} ${pageNo}${cur.post ? ` · ${escapeHTML(cur.post.title)}` : ''}</small></div>
        <button type="button" class="pv-btn" id="pvPanelClose" style="color:#1d2733; border-color:#d4dce6; background:#f4f7fa; padding:6px 12px;">✕</button>
      </div>
      <div><label for="pvName">${escapeHTML(tr('yourName'))}</label><input id="pvName" maxlength="80" autocomplete="name" placeholder="${escapeHTML(tr('namePh'))}" value="${escapeHTML(savedName)}"></div>
      <div><label for="pvMsg">${escapeHTML(tr('note'))}</label><textarea id="pvMsg" maxlength="1000" placeholder="${escapeHTML(tr('notePh'))}"></textarea></div>
      <div class="pv-actions">
        <button type="button" class="pv-btn good" data-send="approve">${escapeHTML(tr('approve'))}</button>
        <button type="button" class="pv-btn warn" data-send="change">${escapeHTML(tr('edit'))}</button>
        <button type="button" class="pv-btn primary wide" data-send="note">${escapeHTML(tr('send'))}</button>
      </div>
      <div style="display:flex; flex-direction:column; gap:8px;">
        <small>${escapeHTML(tr('before'))}</small>
        ${notes.length ? notes.map(n => `
          <div class="pv-note ${n.kind === 'change' ? 'change' : n.kind === 'approve' ? 'approve' : ''}">
            <b>${escapeHTML(n.author)}</b>${n.kind === 'change' ? ' ✎' : n.kind === 'approve' ? ' ✓' : ''}
            ${n.message ? `<p>${escapeHTML(n.message)}</p>` : ''}
            <span>${escapeHTML(formatRelativeTime(n.at))}${n.resolved ? ` · ${escapeHTML(tr('resolved'))}` : ''}</span>
          </div>`).join('') : `<small>${escapeHTML(tr('none'))}</small>`}
      </div>
    </aside>`;
}

function finalHTML() {
  const all = state.data.feedback;
  const approved = new Set(all.filter(f => f.kind === 'approve' && !f.resolved).map(f => f.slideNo)).size;
  const edits = all.filter(f => f.kind === 'change' && !f.resolved).length;
  const done = state.data.plan.status === 'approved';
  return `
    <div class="pv-final" dir="${state.dir}">
      <div class="big">${done ? '✓' : ''}</div>
      <h2>${escapeHTML(done ? tr('approvedAll') : tr('finalTitle'))}</h2>
      <p>${escapeHTML(done ? tr('approvedAllText') : tr('finalText'))}</p>
      <div class="stats"><div class="stat"><b>${approved}</b>${escapeHTML(tr('approvedPages'))}</div><div class="stat"><b>${edits}</b>${escapeHTML(tr('editPages'))}</div></div>
      ${done ? '' : `
        <div style="width:min(320px,100%); text-align:start;"><label for="pvFinalName" style="font-size:12px; font-weight:700;">${escapeHTML(tr('yourName'))}</label>
          <input id="pvFinalName" maxlength="80" placeholder="${escapeHTML(tr('namePh'))}" value="${escapeHTML(localStorage.getItem(NAME_KEY) || '')}" style="width:100%; box-sizing:border-box; padding:10px 12px; border-radius:12px; border:1px solid #d4dce6; font:inherit;"></div>
        <button type="button" class="pv-btn good" id="pvApproveAll">${escapeHTML(tr('approveAll'))}</button>`}
    </div>`;
}

function gridHTML(list) {
  const plan = planForSlides();
  const dir = state.dir;
  return `
    <main class="pv-grid" style="${colourStyle(plan)}">
      ${list.map((p, i) => {
        if (p.type === 'final') return '';
        const st = pageState(i + 1);
        const tag = st === 'ok' ? `<span class="tag ok">✓</span>` : st === 'ed' ? `<span class="tag ed">✎</span>` : '';
        if (p.type === 'cover') return `<button type="button" class="pv-card" data-open="${i}"><span class="d">${escapeHTML(tr('page'))} 1</span><span class="t">${escapeHTML(plan.title)}</span><span class="m">${state.data.posts.length} ${escapeHTML(tr('posts'))} ${tag}</span></button>`;
        const img = p.post.visuals.find(v => /^image\//.test(v.type || ''));
        return `<button type="button" class="pv-card" data-open="${i}" dir="${dir}">
          ${img ? `<img src="${escapeHTML(img.url)}" alt="" loading="lazy">` : ''}
          <span class="d">${escapeHTML(formatPlanDate(p.post.date, dir) || `${tr('page')} ${i + 1}`)}</span>
          <span class="t">${escapeHTML(p.post.title)}</span>
          <span class="m"><span class="tag">${escapeHTML(typeLabel(p.post.type, dir))}</span>${tag}</span></button>`;
      }).join('')}
    </main>`;
}

// ------------------------------------------------------------------ actions
function go(i, jump = false) {
  const total = pages().length;
  const next = Math.min(Math.max(i, 0), total - 1);
  if (next === state.index && !jump) return;
  state.lastDir = next < state.index ? -1 : 1;
  state.index = next;
  state.panelOpen = false;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function bindPanel() {
  document.querySelectorAll('[data-send]').forEach(btn => btn.addEventListener('click', async () => {
    const kind = btn.dataset.send;
    const name = document.getElementById('pvName').value.trim();
    const msg = document.getElementById('pvMsg').value.trim();
    if (name.length < 2) { toast(tr('needName'), true); document.getElementById('pvName').focus(); return; }
    if (kind !== 'approve' && msg.length < 2) { toast(tr('needNote'), true); document.getElementById('pvMsg').focus(); return; }
    localStorage.setItem(NAME_KEY, name);

    const cur = pages()[state.index];
    document.querySelectorAll('[data-send]').forEach(b => { b.disabled = true; });
    try {
      await call('feedback', { name, kind, message: msg || null, slideNo: state.index + 1, postId: cur.post?.id || null });
      state.data.feedback.push({ id: `local-${Date.now()}`, postId: cur.post?.id || null, slideNo: state.index + 1, author: name, kind, message: msg || null, resolved: false, at: new Date().toISOString() });
      if (kind === 'change') state.data.plan.status = 'changes_requested';
      toast(tr(kind === 'approve' ? 'sentApprove' : kind === 'change' ? 'sentEdit' : 'sentNote'));
      state.panelOpen = false;
      render();
    } catch (err) {
      toast(err.message, true);
      document.querySelectorAll('[data-send]').forEach(b => { b.disabled = false; });
    }
  }));
}

function bindFinal() {
  document.getElementById('pvApproveAll')?.addEventListener('click', async (e) => {
    const name = document.getElementById('pvFinalName').value.trim();
    if (name.length < 2) { toast(tr('needName'), true); return; }
    if (!window.confirm(tr('confirmAll'))) return;
    localStorage.setItem(NAME_KEY, name);
    e.target.disabled = true;
    try {
      await call('approve_all', { name });
      state.data.plan.status = 'approved';
      state.data.feedback.push({ id: `local-${Date.now()}`, postId: null, slideNo: null, author: name, kind: 'approve_all', message: null, resolved: false, at: new Date().toISOString() });
      render();
    } catch (err) { toast(err.message, true); e.target.disabled = false; }
  });
}

document.addEventListener('keydown', (e) => {
  if (!state.data || state.view !== 'slides' || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  const rtl = state.dir === 'rtl';
  if (e.key === 'ArrowRight') go(state.index + (rtl ? -1 : 1));
  if (e.key === 'ArrowLeft') go(state.index + (rtl ? 1 : -1));
});

// swipe on phones
let touchX = null;
document.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
document.addEventListener('touchend', (e) => {
  if (touchX === null || !state.data || state.view !== 'slides') return;
  if (e.target.closest('.pv-panel, video, .cps-thumbs')) { touchX = null; return; }
  const dx = e.changedTouches[0].clientX - touchX; touchX = null;
  if (Math.abs(dx) < 70) return;
  const rtl = state.dir === 'rtl';
  go(state.index + ((dx < 0) !== rtl ? 1 : -1));
}, { passive: true });

// ------------------------------------------------------------------ start
(async function init() {
  if (!token || token.length < 20) { message(T.ltr.expired, T.ltr.expiredText); return; }
  try {
    const data = await call('get');
    state.data = data;
    state.dir = data.plan.direction === 'rtl' ? 'rtl' : 'ltr';
    document.documentElement.lang = state.dir === 'rtl' ? 'ar' : 'en';
    document.title = `${data.plan.title} — Kite Design Studio`;
    render();
  } catch (err) {
    message(T.ltr.expired, err.message || T.ltr.expiredText);
  }
})();
