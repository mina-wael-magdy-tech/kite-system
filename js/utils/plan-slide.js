/**
 * KITE SYSTEM — content plan slides
 * One renderer used by the editor preview AND the public client page, so what the team designs
 * is exactly what the client sees. Pure functions: everything is escaped, links are http(s) only.
 */

import { escapeHTML } from './helpers.js';

export const POST_TYPES = {
  static:   { en: 'Static',   ar: 'ستاتيك',   icon: '📷' },
  carousel: { en: 'Carousel', ar: 'كاروسيل',  icon: '🖼️' },
  reel:     { en: 'Reel',     ar: 'ريل',      icon: '🎬' },
  story:    { en: 'Story',    ar: 'ستوري',    icon: '⏳' },
  video:    { en: 'Video',    ar: 'فيديو',    icon: '🎥' },
  other:    { en: 'Other',    ar: 'أخرى',     icon: '📌' }
};

export const POST_STATUSES = {
  planned:   { label: 'Planned',      tone: 'gray' },
  designing: { label: 'In design',    tone: 'blue' },
  ready:     { label: 'Ready',        tone: 'amber' },
  approved:  { label: 'Approved',     tone: 'green' },
  published: { label: 'Published',    tone: 'green' }
};

export const PLAN_STATUSES = {
  draft:             { label: 'Draft',             tone: 'gray' },
  in_review:         { label: 'With the client',   tone: 'amber' },
  changes_requested: { label: 'Changes requested', tone: 'rose' },
  approved:          { label: 'Approved',          tone: 'green' }
};

/** Field captions follow the plan language, like the original Arabic decks. */
export const LABELS = {
  rtl: { pillar: 'المحور', objective: 'الهدف', idea: 'الفكرة', caption: 'الكابشن', links: 'الروابط', page: 'صفحة', cover: 'غلاف' },
  ltr: { pillar: 'Pillar', objective: 'Objective', idea: 'Idea', caption: 'Caption', links: 'Links', page: 'Page', cover: 'Cover' }
};

export function safeUrl(url) {
  try {
    const u = new URL(String(url).trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

/** "الجمعة 25 سبتمبر 2026" / "Friday 25 September 2026" (Latin digits in both). */
export function formatPlanDate(date, dir = 'ltr') {
  if (!date) return '';
  const [y, m, d] = String(date).slice(0, 10).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(dir === 'rtl' ? 'ar-EG-u-nu-latn' : 'en-GB',
    { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
}

export function typeLabel(type, dir) {
  const t = POST_TYPES[type] || POST_TYPES.other;
  return dir === 'rtl' ? t.ar : t.en;
}

const isImage = (v) => /^image\//i.test(v.type || '') || /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(v.name || '');
const isVideo = (v) => /^video\//i.test(v.type || '') || /\.(mp4|mov|webm|m4v)$/i.test(v.name || '');

// ---------------------------------------------------------------------------
// Visual layout. Every visual sits in a box measured in % of the picture area:
//   { x, y, w, h, fit: 'cover' | 'contain', z }
// A visual without a saved layout is placed automatically (a tidy grid), so a plain upload always looks fine.
// The same maths feeds the editor, the client page and the PowerPoint export.
// ---------------------------------------------------------------------------
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

/** Clamps a saved layout to something safe to render. Returns null if it is not a layout. */
export function cleanLayout(l) {
  if (!l || typeof l !== 'object') return null;
  const w = num(l.w, 5, 100, 50), h = num(l.h, 5, 100, 50);
  return {
    x: num(l.x, 0, 100 - w, 0), y: num(l.y, 0, 100 - h, 0), w, h,
    fit: l.fit === 'contain' ? 'contain' : 'cover', z: num(l.z, 0, 999, 0)
  };
}

const round1 = (n) => Math.round(n * 10) / 10;

function gridBoxes(n, cols, gap = 1.5) {
  const rows = Math.ceil(n / cols), w = (100 - gap * (cols - 1)) / cols, h = (100 - gap * (rows - 1)) / rows;
  return Array.from({ length: n }, (_, i) => ({
    x: round1((i % cols) * (w + gap)), y: round1(Math.floor(i / cols) * (h + gap)), w: round1(w), h: round1(h), fit: 'cover', z: i
  }));
}

export const LAYOUT_PRESETS = {
  auto:  { label: 'Auto grid',   icon: '▦' },
  cols:  { label: 'Side by side', icon: '▥' },
  rows:  { label: 'Stacked',     icon: '☰' },
  hero:  { label: 'One big + rest', icon: '◧' }
};

/** Boxes for `n` visuals following a preset. */
export function presetBoxes(n, preset = 'auto') {
  if (n <= 0) return [];
  if (n === 1) return [{ x: 0, y: 0, w: 100, h: 100, fit: 'contain', z: 0 }];
  if (preset === 'cols') return gridBoxes(n, n);
  if (preset === 'rows') return gridBoxes(n, 1);
  if (preset === 'hero') {
    const rest = n - 1, g = 1.5, h = (100 - g * (rest - 1)) / rest;
    return [{ x: 0, y: 0, w: 62, h: 100, fit: 'cover', z: 0 },
      ...Array.from({ length: rest }, (_, i) => ({ x: 63.5, y: round1(i * (h + g)), w: 36.5, h: round1(h), fit: 'cover', z: i + 1 }))];
  }
  // auto: 2 stacked (the picture area is nearly square), 3 = hero, 4+ = square-ish grid
  if (n === 2) return gridBoxes(2, 1);
  if (n === 3) return presetBoxes(3, 'hero');
  return gridBoxes(n, Math.ceil(Math.sqrt(n)));
}

/**
 * The final box of every visual: its saved layout, or an automatic one.
 * A visual added after the others were arranged by hand is dropped in as a medium picture on top.
 */
export function visualBoxes(visuals = []) {
  const media = visuals.filter(v => v.url);
  const saved = media.map(v => cleanLayout(v.layout));
  if (saved.every(s => !s)) {
    const auto = presetBoxes(media.length, 'auto');
    return media.map((v, i) => ({ v, box: auto[i] }));
  }
  let top = Math.max(0, ...saved.filter(Boolean).map(s => s.z)) + 1;
  return media.map((v, i) => ({ v, box: saved[i] || { x: 25, y: 25, w: 50, h: 50, fit: 'cover', z: top++ } }));
}

function itemHTML({ v, box }, i) {
  const style = `left:${box.x}%;top:${box.y}%;width:${box.w}%;height:${box.h}%;z-index:${Math.round(box.z) + 1}`;
  const fit = `object-fit:${box.fit}`;
  const body = isVideo(v)
    ? `<video class="cps-main" style="${fit}" src="${escapeHTML(v.url)}" controls playsinline preload="metadata"></video>`
    : isImage(v)
      ? `<img class="cps-main" style="${fit}" src="${escapeHTML(v.url)}" alt="${escapeHTML(v.name || '')}" loading="lazy" draggable="false">`
      : `<a class="cps-file" href="${escapeHTML(v.url)}" target="_blank" rel="noopener noreferrer">📎 ${escapeHTML(v.name || 'File')}</a>`;
  return `<div class="cps-item" data-id="${escapeHTML(v.id || String(i))}" style="${style}">${body}</div>`;
}

function visualHTML(visuals = []) {
  const items = visualBoxes(visuals);
  if (!items.length) {
    return `<div class="cps-visual cps-visual-empty"><span>🖼️</span><small>Visual coming soon</small></div>`;
  }
  return `<div class="cps-visual"><div class="cps-canvas">${items.map(itemHTML).join('')}</div></div>`;
}

/** Kept for the pages that call it; visuals are all shown at once now, so there is nothing to wire. */
export function bindSlides() {}

const field = (label, value) => value ? `
  <section class="cps-field"><h4>${escapeHTML(label)}</h4><p>${escapeHTML(value)}</p></section>` : '';

export function coverHTML({ plan, cover, total = 0 }) {
  const dir = plan.direction || 'rtl';
  return `
  <article class="cps cps-cover" dir="${dir}" style="--cps-accent:${escapeHTML(plan.accent || '#e01b28')}">
    ${cover?.url ? `<img class="cps-cover-img" src="${escapeHTML(cover.url)}" alt="">` : ''}
    <div class="cps-cover-shade"></div>
    <div class="cps-cover-body">
      ${plan.clientName ? `<span class="cps-pill">${escapeHTML(plan.clientName)}</span>` : ''}
      <h1>${escapeHTML(plan.title)}</h1>
      ${plan.subtitle ? `<p>${escapeHTML(plan.subtitle)}</p>` : ''}
      <small>${total} ${dir === 'rtl' ? 'منشور' : 'posts'} · Kite Design Studio</small>
    </div>
  </article>`;
}

export function slideHTML({ plan, post, visuals = [], page = null, pages = null }) {
  const dir = plan.direction || 'rtl';
  const L = LABELS[dir] || LABELS.ltr;
  const meta = POST_TYPES[post.type || post.content_type] || POST_TYPES.other;
  const type = post.type || post.content_type;
  const links = (post.links || []).map(l => ({ label: l.label, href: safeUrl(l.url) })).filter(l => l.href);
  const time = post.time || post.post_time;
  const date = post.date || post.post_date;

  return `
  <article class="cps" dir="${dir}" style="--cps-accent:${escapeHTML(plan.accent || '#e01b28')}">
    ${visualHTML(visuals)}
    <div class="cps-body">
      <div class="cps-top">
        ${date ? `<span class="cps-date">${escapeHTML(formatPlanDate(date, dir))}${time ? ` · ${escapeHTML(String(time).slice(0, 5))}` : ''}</span>` : ''}
        <span class="cps-type">${meta.icon} ${escapeHTML(typeLabel(type, dir))}</span>
        ${post.platform ? `<span class="cps-platform">${escapeHTML(post.platform)}</span>` : ''}
      </div>
      <h2 class="cps-title">${escapeHTML(post.title || '')}</h2>
      <div class="cps-fields">
        ${field(L.pillar, post.pillar)}
        ${field(L.objective, post.objective)}
        ${field(L.idea, post.idea)}
      </div>
      ${post.caption ? `<section class="cps-caption"><h4>${escapeHTML(L.caption)}</h4><p>${escapeHTML(post.caption)}</p></section>` : ''}
      ${links.length ? `<div class="cps-links">${links.map(l => `<a href="${escapeHTML(l.href)}" target="_blank" rel="noopener noreferrer">🔗 ${escapeHTML(l.label || l.href)}</a>`).join('')}</div>` : ''}
    </div>
    ${page ? `<footer class="cps-foot"><span>${escapeHTML(L.page)} ${page}${pages ? ` / ${pages}` : ''}</span><span>Kite</span></footer>` : ''}
  </article>`;
}
