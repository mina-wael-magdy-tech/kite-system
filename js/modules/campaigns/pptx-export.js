/**
 * KITE SYSTEM — export a content plan as a PowerPoint (.pptx)
 * Runs in the browser with PptxGenJS (vendor/pptxgen.bundle.js): one slide per post, in the plan's
 * language and direction (Arabic plans are written right-to-left), with the visuals and clickable links.
 */

import { LABELS, POST_TYPES, formatPlanDate, typeLabel, safeUrl, visualBoxes, planColours } from '../../utils/plan-slide.js';

const W = 10, H = 5.625; // 16:9 in inches

let loading = null;
function loadLibrary() {
  if (window.PptxGenJS) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/pptxgen.bundle.js';
    s.onload = resolve;
    s.onerror = () => { loading = null; reject(new Error('Could not load the PowerPoint exporter')); };
    document.head.appendChild(s);
  });
  return loading;
}

const hex = (c) => String(c || '#e01b28').replace('#', '').toUpperCase();
const isImageAsset = (a) => /^image\//i.test(a.type || '') || /\.(png|jpe?g|gif|webp|avif)$/i.test(a.name || '');

/** Downloads an image, flattens it to a JPEG (max 1600px) so every PowerPoint version can open it. */
async function fetchImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('image download failed');
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return { data: canvas.toDataURL('image/jpeg', 0.88), w: canvas.width, h: canvas.height };
}

/** Downloads an image and crops it to fill a w:h frame (like CSS object-fit: cover). */
async function fetchCropped(url, w, h) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('image download failed');
  const bmp = await createImageBitmap(await res.blob());
  const canvas = document.createElement('canvas');
  const long = 1400, ratio = w / h;
  canvas.width = ratio >= 1 ? long : Math.round(long * ratio);
  canvas.height = ratio >= 1 ? Math.round(long / ratio) : long;
  const s = Math.max(canvas.width / bmp.width, canvas.height / bmp.height);
  const sw = canvas.width / s, sh = canvas.height / s;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.88);
}

/** Largest rectangle with the image's aspect ratio that fits the frame, centred. */
function contain(img, x, y, w, h) {
  const r = Math.min(w / img.w, h / img.h);
  const iw = img.w * r, ih = img.h * r;
  return { x: x + (w - iw) / 2, y: y + (h - ih) / 2, w: iw, h: ih };
}

/**
 * @param {object} args
 * @param {object} args.plan     { title, subtitle, direction, accent, clientName }
 * @param {object|null} args.cover   { url } cover image
 * @param {Array}  args.posts    ordered posts (db rows) each with .visuals = [{ url, name, type }]
 * @param {(msg: string) => void} [args.onProgress]
 */
export async function exportPlanToPptx({ plan, cover, posts, onProgress = () => {} }) {
  await loadLibrary();
  const dir = plan.direction || 'rtl';
  const rtl = dir === 'rtl';
  const L = LABELS[dir] || LABELS.ltr;
  const colours = planColours(plan);
  const accent = hex(colours.accent);
  const font = 'Arial';
  const align = rtl ? 'right' : 'left';
  // PowerPoint reads direction/alignment per run, so multi-part text boxes need it on every part
  const run = (o) => ({ rtlMode: rtl, align, ...o });

  const pptx = new window.PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.title = plan.title;
  pptx.author = 'Kite Design Studio';
  pptx.company = 'Kite Design Studio';

  // ---------------------------------------------------------------- cover
  {
    const s = pptx.addSlide();
    s.background = { color: accent };
    s.addShape(pptx.ShapeType.ellipse, { x: -1.2, y: -1.4, w: 4.4, h: 4.4, fill: { color: hex(colours.accent2), transparency: 35 }, line: { type: 'none' } });
    s.addShape(pptx.ShapeType.ellipse, { x: 7.2, y: 3.2, w: 4.6, h: 4.6, fill: { color: hex(colours.accent3), transparency: 35 }, line: { type: 'none' } });
    if (cover?.url) {
      try {
        onProgress('Cover image…');
        const img = await fetchImage(cover.url);
        const box = contain(img, rtl ? 0.5 : 5.3, 0.8, 4.2, 4.0);
        s.addImage({ data: img.data, ...box, rounding: false });
      } catch { /* the cover simply goes without a picture */ }
    }
    const textX = cover?.url ? (rtl ? 4.9 : 0.6) : 0.9;
    const textW = cover?.url ? 4.6 : 8.2;
    if (plan.clientName) {
      s.addText(plan.clientName, { x: textX, y: 1.2, w: textW, h: 0.4, fontFace: font, fontSize: 14, bold: true, color: 'FFFFFF', align, rtlMode: rtl });
    }
    s.addText(plan.title, { x: textX, y: 1.7, w: textW, h: 1.6, fontFace: font, fontSize: 38, bold: true, color: 'FFFFFF', align, valign: 'middle', rtlMode: rtl, fit: 'shrink' });
    if (plan.subtitle) {
      s.addText(plan.subtitle, { x: textX, y: 3.4, w: textW, h: 0.8, fontFace: font, fontSize: 16, color: 'FFFFFF', align, rtlMode: rtl, fit: 'shrink' });
    }
    s.addText(`${posts.length} ${rtl ? 'منشور' : 'posts'}  ·  Kite Design Studio`, { x: textX, y: 4.6, w: textW, h: 0.4, fontFace: font, fontSize: 11, color: 'FFFFFF', align, rtlMode: rtl });
  }

  // ---------------------------------------------------------------- one slide per post
  let n = 0;
  for (const post of posts) {
    n += 1;
    onProgress(`Slide ${n} of ${posts.length}…`);
    const s = pptx.addSlide();
    s.background = { color: 'FFFFFF' };
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 0.12, fill: { color: accent }, line: { type: 'none' } });
    s.slideNumber = { x: rtl ? 0.3 : 9.2, y: 5.25, fontFace: font, fontSize: 9, color: '8B97A6' };

    // visuals (left half for LTR, right half for RTL — the same side as on the web)
    const vx = rtl ? 5.4 : 0.4, vw = 4.2;
    // the same boxes the team arranged on the slide (positions in % of the picture panel), lowest layer first
    const vy = 0.45, vh = 4.6;
    const placed = visualBoxes(post.visuals || []).filter(({ v }) => isImageAsset(v)).slice(0, 10).sort((a, b) => a.box.z - b.box.z);
    s.addShape(pptx.ShapeType.roundRect, { x: vx, y: vy, w: vw, h: vh, rectRadius: 0.12, fill: { color: 'F2F4F8' }, line: { type: 'none' } });
    let drawn = 0;
    for (const { v, box } of placed) {
      const bx = vx + (box.x / 100) * vw, by = vy + (box.y / 100) * vh, bw = (box.w / 100) * vw, bh = (box.h / 100) * vh;
      try {
        if (box.fit === 'contain') {
          const img = await fetchImage(v.url);
          s.addImage({ data: img.data, ...contain(img, bx, by, bw, bh) });
        } else {
          s.addImage({ data: await fetchCropped(v.url, bw, bh), x: bx, y: by, w: bw, h: bh });
        }
        drawn++;
      } catch { /* skip an image that cannot be read */ }
    }
    if (!drawn) {
      const names = (post.visuals || []).map(v => v.name).filter(Boolean);
      s.addText(names.length ? names.join('\n') : (rtl ? 'الصورة قريباً' : 'Visual coming soon'),
        { x: vx, y: 0.45, w: vw, h: 4.6, align: 'center', valign: 'middle', fontFace: font, fontSize: 12, color: '8B97A6' });
    }

    // text
    const tx = rtl ? 0.4 : 4.8, tw2 = 4.8;
    const meta = POST_TYPES[post.content_type] || POST_TYPES.other;
    const dateText = formatPlanDate(post.post_date, dir) + (post.post_time ? `  ·  ${String(post.post_time).slice(0, 5)}` : '');
    if (dateText.trim()) {
      s.addText(dateText, { x: tx, y: 0.4, w: tw2, h: 0.3, fontFace: font, fontSize: 10.5, bold: true, color: accent, align, rtlMode: rtl });
    }
    s.addText(`${meta.icon} ${typeLabel(post.content_type, dir)}${post.platform ? '  ·  ' + post.platform : ''}`,
      { x: tx, y: 0.7, w: tw2, h: 0.28, fontFace: font, fontSize: 10, color: '5B6B7C', align, rtlMode: rtl });
    s.addText(post.title || '', { x: tx, y: 1.0, w: tw2, h: 0.75, fontFace: font, fontSize: 20, bold: true, color: '14202E', align, valign: 'top', rtlMode: rtl, fit: 'shrink' });

    const sections = [[L.pillar, post.pillar], [L.objective, post.objective], [L.idea, post.idea]].filter(([, v]) => v);
    const totalChars = sections.reduce((a, [, v]) => a + v.length, 0) + (post.caption || '').length;
    const body = totalChars > 700 ? 8.5 : totalChars > 420 ? 9.5 : 10.5;
    const runs = [];
    sections.forEach(([label, value]) => {
      runs.push({ text: label, options: run({ bold: true, color: accent, fontSize: body, breakLine: true }) });
      runs.push({ text: value, options: run({ color: '2C3A4A', fontSize: body, breakLine: true, paraSpaceAfter: 5 }) });
    });
    if (runs.length) {
      s.addText(runs, { x: tx, y: 1.75, w: tw2, h: post.caption ? 1.75 : 2.6, fontFace: font, align, valign: 'top', rtlMode: rtl, fit: 'shrink', margin: 0 });
    }
    if (post.caption) {
      const cy = runs.length ? 3.55 : 1.8;
      s.addShape(pptx.ShapeType.roundRect, { x: tx, y: cy, w: tw2, h: 1.15, rectRadius: 0.08, fill: { color: 'F6F8FB' }, line: { type: 'none' } });
      s.addText([
        { text: L.caption, options: run({ bold: true, color: accent, fontSize: body, breakLine: true }) },
        { text: post.caption, options: run({ color: '2C3A4A', fontSize: body - 0.5 }) }
      ], { x: tx + 0.1, y: cy + 0.03, w: tw2 - 0.2, h: 1.1, fontFace: font, align, valign: 'top', rtlMode: rtl, fit: 'shrink', margin: 2 });
    }

    const links = (post.links || []).map(l => ({ label: l.label, href: safeUrl(l.url) })).filter(l => l.href).slice(0, 4);
    if (links.length) {
      s.addText(links.map((l, i) => ({
        text: l.label || l.href,
        options: run({ hyperlink: { url: l.href }, color: '1D6E91', underline: { style: 'sng' }, fontSize: 9.5, breakLine: i < links.length - 1 })
      })), { x: tx, y: 4.75, w: tw2, h: 0.5, fontFace: font, align, valign: 'top', rtlMode: rtl, fit: 'shrink', margin: 0 });
    }
  }

  const safeName = (plan.title || 'content-plan').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'content-plan';
  onProgress('Saving…');
  await pptx.writeFile({ fileName: `${safeName}.pptx` });
}
