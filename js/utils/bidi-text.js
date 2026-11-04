/**
 * KITE SYSTEM — Arabic / English text for PDFs (pdf-lib)
 *  - Letter shaping (joining forms, ligatures) is done by fontkit inside pdf-lib.
 *  - This file does the Unicode bidirectional algorithm: reordering mixed Arabic / English / numbers,
 *    bracket mirroring, keeping numbers and codes left-to-right as one piece, and word wrapping.
 * Needs window.KitePdf (vendor/pdf-bundle.js).
 */

const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«' };
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const LRI = '⁦', PDI = '⁩';
// latin words / numbers joined by - / . , : @ + stay one left-to-right unit (invoice numbers, tax ids, dates, IBANs, "Label: 123")
const TOKEN = /[0-9٠-٩A-Za-z]+(?:[-/.,:@+][0-9٠-٩A-Za-z]+)*%?/;
const HAS_DIGIT = /[0-9٠-٩]/;
const SEQ = new RegExp(`${TOKEN.source}(?:(?: |: )${TOKEN.source})*:?`, 'g');

export const hasArabic = (s) => ARABIC.test(s);
const reverse = (s) => [...s].reverse().join('');

function isolateNumbers(text) {
  return text.replace(SEQ, (m) => (HAS_DIGIT.test(m) ? `${LRI}${m}${PDI}` : m));
}

/** Visually ordered runs [{ text, rtl }], ready to be drawn left to right. */
export function visualRuns(text, baseDir) {
  const bidi = window.KitePdf.bidi;
  const dir = baseDir || (hasArabic(text) ? 'rtl' : 'ltr');
  if (dir === 'ltr' && !hasArabic(text)) return [{ text, rtl: false }];
  const src = isolateNumbers(String(text));
  const chars = [...src];
  const { levels } = bidi.getEmbeddingLevels(src, dir);
  const runs = [];
  let start = 0;
  for (let i = 1; i <= chars.length; i++) {
    if (i === chars.length || levels[i] !== levels[start]) { runs.push({ s: start, e: i, level: levels[start] }); start = i; }
  }
  // Unicode rule L2: from the highest level down to the lowest odd level, reverse every sequence at that level or higher
  const order = runs.map((_, i) => i);
  const max = Math.max(...runs.map(r => r.level));
  const minOdd = Math.min(...runs.filter(r => r.level % 2).map(r => r.level), Infinity);
  for (let level = max; level >= minOdd && level > 0; level--) {
    let i = 0;
    while (i < order.length) {
      if (runs[order[i]].level >= level) {
        let j = i; while (j < order.length && runs[order[j]].level >= level) j++;
        order.splice(i, j - i, ...order.slice(i, j).reverse()); i = j;
      } else i++;
    }
  }
  return order.map((idx) => {
    const r = runs[idx];
    const rtl = r.level % 2 === 1;
    let t = '';
    for (let k = r.s; k < r.e; k++) {
      const c = chars[k];
      if (c === LRI || c === PDI) continue;
      t += rtl && MIRROR[c] ? MIRROR[c] : c;
    }
    return { text: t, rtl };
  }).filter(r => r.text.length);
}

/**
 * What to hand to pdf-lib so the glyphs land in the wanted visual order: fontkit lays a string out right-to-left
 * (reversing it) whenever it contains Arabic-script characters (Arabic digits included), otherwise left-to-right.
 */
function drawable(run) {
  return hasArabic(run.text) === run.rtl ? run.text : reverse(run.text);
}

export function measure(font, size, text, baseDir) {
  return visualRuns(text, baseDir).reduce((w, r) => w + font.widthOfTextAtSize(drawable(r), size), 0);
}

/** Draws one line; align = 'left' | 'right' | 'center' relative to x. Returns the width. */
export function drawBidi(page, font, text, { x, y, size = 11, color, align = 'left', baseDir }) {
  const parts = visualRuns(text, baseDir).map(r => { const t = drawable(r); return { t, w: font.widthOfTextAtSize(t, size) }; });
  const total = parts.reduce((a, p) => a + p.w, 0);
  let cx = align === 'right' ? x - total : align === 'center' ? x - total / 2 : x;
  for (const p of parts) { page.drawText(p.t, { x: cx, y, size, font, color }); cx += p.w; }
  return total;
}

/** Word-wrap logical text to maxWidth; draw each returned line separately with drawBidi. */
export function wrap(font, size, text, maxWidth, baseDir) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && measure(font, size, next, baseDir) > maxWidth) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}
