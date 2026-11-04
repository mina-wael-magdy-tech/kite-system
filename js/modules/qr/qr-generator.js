/**
 * KITE SYSTEM — QR Code Generator
 * Paste a link (for example one an employee sends you) and get a scannable QR code to preview,
 * download (PNG / SVG) or copy. Everything happens in the browser: links are never sent anywhere.
 * Only http(s) links are accepted, so a QR code made here can never open a script or a file.
 */

import qrcode, { stringToBytes } from '../../../vendor/qrcode/qrcode.mjs';
import { Toast } from '../../services/toast-service.js';
import { escapeHTML, formatRelativeTime } from '../../utils/helpers.js';

qrcode.stringToBytes = stringToBytes;   // links with non-English characters encode correctly

const COLORS = [
  { id: 'black', label: 'Black', hex: '#111827' },
  { id: 'red', label: 'Kite red', hex: '#c2101c' },
  { id: 'navy', label: 'Navy', hex: '#16324f' }
];
const SIZES = [512, 768, 1024];
const RECENT_KEY = 'kite.qr.recent';
const MAX_RECENT = 8;
const MAX_LEN = 1200;
const FONT = "'Poppins', 'Cairo', 'Tajawal', 'Segoe UI', Tahoma, Arial, sans-serif";

/** Returns a clean https/http URL, or null. A bare "example.com/x" gets https:// added. */
export function normalizeLink(input) {
  let v = String(input || '').trim();
  if (!v) return null;
  if (/[\s<>"]/.test(v) && !/^https?:\/\//i.test(v)) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v.replace(/^\/+/, '');
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return u.href;
  } catch { return null; }
}

function buildMatrix(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return { n, dark: (r, c) => qr.isDark(r, c) };
}

/** Draws the code (and optional caption) on a canvas, `size` pixels wide. */
export function drawQR(canvas, { text, caption = '', color = '#111827', size = 512 }) {
  const { n, dark } = buildMatrix(text);
  const quiet = 4;
  const cell = Math.max(1, Math.floor(size / (n + quiet * 2)));
  const side = cell * (n + quiet * 2);
  const capSize = Math.round(side * 0.05);
  let lines = [];
  const ctx = canvas.getContext('2d');
  if (caption) {
    ctx.font = `600 ${capSize}px ${FONT}`;
    lines = wrap(ctx, caption, side * 0.9).slice(0, 3);
  }
  const capH = lines.length ? Math.round(capSize * 1.45 * lines.length + capSize * 0.9) : 0;
  canvas.width = side; canvas.height = side + capH;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = color;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (dark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
  if (lines.length) {
    ctx.font = `600 ${capSize}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = '#1d2733';
    lines.forEach((l, i) => ctx.fillText(l, side / 2, side - cell * 1.5 + i * capSize * 1.45));
  }
}

function wrap(ctx, text, max) {
  const out = []; let line = '';
  for (const word of text.split(/\s+/)) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width <= max || !line) line = test; else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out;
}

/** The same code as a crisp, scalable SVG file. */
export function buildSVG({ text, caption = '', color = '#111827' }) {
  const { n, dark } = buildMatrix(text);
  const quiet = 4, total = n + quiet * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!dark(r, c)) { c++; continue; }
      let len = 1; while (c + len < n && dark(r, c + len)) len++;
      d += `M${c + quiet} ${r + quiet}h${len}v1h-${len}z`;
      c += len;
    }
  }
  const esc = (t) => String(t).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
  const cap = caption ? `<text x="${total / 2}" y="${total + 2.2}" font-family="Poppins, Cairo, Arial, sans-serif" font-size="2" font-weight="600" text-anchor="middle" fill="#1d2733">${esc(caption.slice(0, 80))}</text>` : '';
  const h = total + (caption ? 4 : 0);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${h}" shape-rendering="crispEdges"><rect width="${total}" height="${h}" fill="#fff"/><path d="${d}" fill="${color}"/>${cap}</svg>\n`;
}

export class QrModule {
  constructor(app) {
    this.app = app;
    this.color = COLORS[0].hex;
    this.size = SIZES[1];
    this.text = '';
  }

  async render(container) {
    this.root = container;
    container.innerHTML = `
      <div class="page-container animate-fade-in">
        <div>
          <h1 class="font-display font-bold text-xl">QR Code Generator</h1>
          <p class="text-xs text-muted" style="margin-top:2px;">Paste a link and get a QR code you can download or share. Nothing is uploaded; it is made right here in your browser.</p>
        </div>
        <div class="qr-layout">
          <form class="card qr-form" id="qrForm" autocomplete="off" novalidate>
            <div class="form-group">
              <label class="form-label" for="qrLink">Link</label>
              <div class="qr-link-row">
                <input class="form-control" id="qrLink" type="url" inputmode="url" maxlength="${MAX_LEN}" placeholder="https://example.com/page" dir="ltr" spellcheck="false" autocapitalize="off" />
                <button type="button" class="btn btn-secondary btn-sm" id="qrPaste" title="Paste from clipboard"><i data-lucide="clipboard-paste"></i> Paste</button>
              </div>
              <div class="qr-hint" id="qrHint"></div>
            </div>
            <div class="form-group">
              <label class="form-label" for="qrCaption">Label under the code <span class="text-dim">(optional)</span></label>
              <input class="form-control" id="qrCaption" maxlength="80" placeholder="e.g. Scan to see our portfolio" />
            </div>
            <div class="qr-opts">
              <div class="form-group">
                <label class="form-label">Colour</label>
                <div class="cpe-seg" id="qrColors">${COLORS.map((c, i) => `<button type="button" data-hex="${c.hex}" class="${i ? '' : 'on'}"><i class="qr-swatch" style="background:${c.hex}"></i>${c.label}</button>`).join('')}</div>
              </div>
              <div class="form-group">
                <label class="form-label">Download size</label>
                <div class="cpe-seg" id="qrSizes">${SIZES.map(s => `<button type="button" data-size="${s}" class="${s === this.size ? 'on' : ''}">${s}px</button>`).join('')}</div>
              </div>
            </div>
          </form>

          <div class="qr-side">
            <div class="card qr-preview">
              <div class="qr-stage" id="qrStage">
                <div class="qr-empty" id="qrEmpty"><i data-lucide="qr-code"></i><span>Your QR code will appear here</span></div>
                <canvas id="qrCanvas" hidden aria-label="QR code preview"></canvas>
              </div>
              <div class="qr-actions">
                <button type="button" class="btn btn-primary" id="qrPng" disabled><i data-lucide="download"></i> PNG</button>
                <button type="button" class="btn btn-secondary" id="qrSvg" disabled><i data-lucide="file-code-2"></i> SVG</button>
                <button type="button" class="btn btn-secondary" id="qrCopyImg" disabled><i data-lucide="copy"></i> Copy image</button>
              </div>
              <button type="button" class="btn btn-ghost btn-sm" id="qrCopyLink" disabled><i data-lucide="link"></i> Copy link</button>
              <p class="text-2xs text-dim" style="margin:0;text-align:center;">Test it with your phone camera before printing.</p>
            </div>
            <div class="card qr-recent" id="qrRecentCard" hidden>
              <div class="qr-recent-head"><b class="text-sm">Recent</b><button type="button" class="btn btn-ghost btn-sm" id="qrClear">Clear</button></div>
              <div id="qrRecent"></div>
            </div>
          </div>
        </div>
      </div>`;

    const $ = (id) => document.getElementById(id);
    $('qrLink').addEventListener('input', () => this.update());
    $('qrCaption').addEventListener('input', () => this.update(false));
    $('qrForm').addEventListener('submit', (e) => { e.preventDefault(); this.update(true, true); });
    $('qrPaste').addEventListener('click', async () => {
      try {
        const t = await navigator.clipboard.readText();
        if (t) { $('qrLink').value = t.trim(); this.update(true, true); }
      } catch { Toast.info('Long-press the box and choose Paste.', 'Clipboard blocked'); }
    });
    $('qrColors').addEventListener('click', (e) => {
      const b = e.target.closest('[data-hex]'); if (!b) return;
      this.color = b.dataset.hex;
      $('qrColors').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      this.draw();
    });
    $('qrSizes').addEventListener('click', (e) => {
      const b = e.target.closest('[data-size]'); if (!b) return;
      this.size = Number(b.dataset.size);
      $('qrSizes').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    });
    $('qrPng').addEventListener('click', () => this.downloadPNG());
    $('qrSvg').addEventListener('click', () => this.downloadSVG());
    $('qrCopyImg').addEventListener('click', () => this.copyImage());
    $('qrCopyLink').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(this.text); Toast.success('Link copied', 'Copied'); } catch { Toast.error('Could not copy', 'Copy'); }
    });
    $('qrClear').addEventListener('click', () => { this.saveRecent([]); this.renderRecent(); });
    $('qrRecent').addEventListener('click', (e) => {
      const use = e.target.closest('[data-use]'); const del = e.target.closest('[data-del]');
      const list = this.recent();
      if (del) { list.splice(Number(del.dataset.del), 1); this.saveRecent(list); this.renderRecent(); return; }
      if (use) {
        const it = list[Number(use.dataset.use)]; if (!it) return;
        $('qrLink').value = it.url; $('qrCaption').value = it.caption || '';
        this.update(false);
      }
    });

    this.renderRecent();
    if (window.lucide) window.lucide.createIcons();
    $('qrLink').focus({ preventScroll: true });
  }

  /** Re-generates the code from the inputs. `save` stores it in "Recent" (on paste / Enter). */
  update(save = false, strict = false) {
    const raw = document.getElementById('qrLink').value;
    const hint = document.getElementById('qrHint');
    const link = normalizeLink(raw);
    if (!raw.trim()) { this.text = ''; hint.textContent = ''; hint.className = 'qr-hint'; this.draw(); return; }
    if (!link) {
      this.text = '';
      hint.textContent = strict ? 'That does not look like a web link. It must start with http:// or https://' : '';
      hint.className = 'qr-hint err';
      this.draw();
      return;
    }
    if (link.length > MAX_LEN) { this.text = ''; hint.textContent = 'This link is too long for a reliable QR code.'; hint.className = 'qr-hint err'; this.draw(); return; }
    this.text = link;
    hint.textContent = link !== raw.trim() ? `Using ${link}` : '';
    hint.className = 'qr-hint';
    this.draw();
    if (save) this.remember();
  }

  caption() { return document.getElementById('qrCaption')?.value.trim() || ''; }

  draw() {
    const canvas = document.getElementById('qrCanvas'); if (!canvas) return;
    const has = !!this.text;
    canvas.hidden = !has;
    document.getElementById('qrEmpty').hidden = has;
    ['qrPng', 'qrSvg', 'qrCopyImg', 'qrCopyLink'].forEach(id => { document.getElementById(id).disabled = !has; });
    if (!has) return;
    try { drawQR(canvas, { text: this.text, caption: this.caption(), color: this.color, size: 520 }); }
    catch (err) { console.warn('QR error', err); Toast.error('This link is too long to turn into a QR code.', 'QR'); }
  }

  fileName(ext) {
    let host = 'link';
    try { host = new URL(this.text).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '-'); } catch { /* keep default */ }
    return `qr-${host}.${ext}`;
  }

  save(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  pngBlob() {
    const c = document.createElement('canvas');
    drawQR(c, { text: this.text, caption: this.caption(), color: this.color, size: this.size });
    return new Promise((res) => c.toBlob(res, 'image/png'));
  }

  async downloadPNG() {
    if (!this.text) return;
    this.remember();
    const blob = await this.pngBlob();
    if (blob) this.save(blob, this.fileName('png'));
  }

  downloadSVG() {
    if (!this.text) return;
    this.remember();
    this.save(new Blob([buildSVG({ text: this.text, caption: this.caption(), color: this.color })], { type: 'image/svg+xml' }), this.fileName('svg'));
  }

  async copyImage() {
    if (!this.text) return;
    try {
      if (!window.ClipboardItem) throw new Error('unsupported');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': this.pngBlob() })]);
      Toast.success('QR code copied. Paste it into a chat or document.', 'Copied');
    } catch { Toast.info('Copying images is not supported here. Use the PNG button instead.', 'Copy'); }
  }

  // ------------------------------------------------------------ recent (this browser only)

  recent() {
    try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  saveRecent(list) { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT))); } catch { /* private mode */ } }

  remember() {
    if (!this.text) return;
    const list = this.recent().filter(x => x.url !== this.text);
    list.unshift({ url: this.text, caption: this.caption(), t: new Date().toISOString() });
    this.saveRecent(list);
    this.renderRecent();
  }

  renderRecent() {
    const card = document.getElementById('qrRecentCard'); const box = document.getElementById('qrRecent');
    if (!card || !box) return;
    const list = this.recent();
    card.hidden = !list.length;
    box.innerHTML = list.map((it, i) => `
      <div class="qr-recent-item">
        <button type="button" class="qr-recent-use" data-use="${i}" title="Use this link again">
          <span class="qr-recent-url" dir="ltr">${escapeHTML(it.url)}</span>
          <small>${it.caption ? escapeHTML(it.caption) + ' · ' : ''}${escapeHTML(formatRelativeTime(it.t))}</small>
        </button>
        <button type="button" class="card-act" data-del="${i}" aria-label="Remove"><i data-lucide="x"></i></button>
      </div>`).join('');
    if (window.lucide) window.lucide.createIcons();
  }
}
