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

function visualHTML(visuals = []) {
  const media = visuals.filter(v => v.url);
  if (!media.length) {
    return `<div class="cps-visual cps-visual-empty"><span>🖼️</span><small>Visual coming soon</small></div>`;
  }
  const first = media[0];
  const main = isVideo(first)
    ? `<video class="cps-main" src="${escapeHTML(first.url)}" controls playsinline preload="metadata"></video>`
    : isImage(first)
      ? `<img class="cps-main" src="${escapeHTML(first.url)}" alt="${escapeHTML(first.name || '')}" loading="lazy">`
      : `<a class="cps-file" href="${escapeHTML(first.url)}" target="_blank" rel="noopener noreferrer">📎 ${escapeHTML(first.name || 'File')}</a>`;
  const thumbs = media.length > 1 ? `
    <div class="cps-thumbs">${media.map((v, i) => `
      <button type="button" class="cps-thumb ${i === 0 ? 'active' : ''}" data-vis="${i}" aria-label="Visual ${i + 1}">
        ${isImage(v) ? `<img src="${escapeHTML(v.url)}" alt="" loading="lazy">` : `<span>${isVideo(v) ? '▶' : '📎'}</span>`}
      </button>`).join('')}</div>` : '';
  return `<div class="cps-visual" data-media='${escapeHTML(JSON.stringify(media.map(v => ({ url: v.url, name: v.name, type: v.type }))))}'>${main}${thumbs}</div>`;
}

/** Makes the small thumbnails switch the large visual. Call once on any container holding slides. */
export function bindSlides(root) {
  root.addEventListener('click', (e) => {
    const thumb = e.target.closest('.cps-thumb');
    if (!thumb) return;
    const box = thumb.closest('.cps-visual');
    let list = [];
    try { list = JSON.parse(box.dataset.media || '[]'); } catch { return; }
    const v = list[Number(thumb.dataset.vis)];
    if (!v) return;
    const old = box.querySelector('.cps-main, .cps-file');
    const el = isVideo(v)
      ? Object.assign(document.createElement('video'), { className: 'cps-main', src: v.url, controls: true, playsInline: true })
      : isImage(v)
        ? Object.assign(document.createElement('img'), { className: 'cps-main', src: v.url, alt: v.name || '' })
        : Object.assign(document.createElement('a'), { className: 'cps-file', href: v.url, target: '_blank', rel: 'noopener noreferrer', textContent: '📎 ' + (v.name || 'File') });
    old?.replaceWith(el);
    box.querySelectorAll('.cps-thumb').forEach(t => t.classList.toggle('active', t === thumb));
  });
}

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
