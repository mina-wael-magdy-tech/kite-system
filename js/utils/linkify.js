/**
 * KITE SYSTEM — safe rich text for briefs and notes
 * Escapes everything first, then turns http(s) URLs into links and keeps line breaks.
 * Only http/https links are created, always with rel="noopener noreferrer" and target="_blank".
 */

import { escapeHTML } from './helpers.js';

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

export function linkify(text = '') {
  const safe = escapeHTML(String(text));
  return safe
    .replace(URL_RE, (raw) => {
      // keep trailing punctuation out of the link
      const m = raw.match(/[).,;:!?]+$/);
      const tail = m ? m[0] : '';
      const url = tail ? raw.slice(0, -tail.length) : raw;
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color: var(--kite-red-700); text-decoration: underline; word-break: break-all;">${url}</a>${tail}`;
    })
    .replace(/\r?\n/g, '<br>');
}
