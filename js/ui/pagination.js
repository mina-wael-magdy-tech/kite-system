/**
 * KITE SYSTEM — Pagination
 *
 * Two ways to page a list, both drawn by the same pager:
 *   fetchPage()   asks the database for one page. Use it for tables that keep growing.
 *   pageSlice()   cuts a list already in memory. Use it where totals or filters need every row.
 */

import { escapeHTML } from '../utils/helpers.js';

export const PAGE_SIZE = { table: 25, cards: 24, projects: 12, board: 20, drive: 60, messages: 50 };

export const pageCount = (total, size) => Math.max(1, Math.ceil(total / size));
export const clampPage = (page, total, size) => Math.min(Math.max(1, page), pageCount(total, size));

/** One page of a list already in memory. `page` comes back corrected if the list has since shrunk. */
export function pageSlice(list, page, size) {
  const safe = clampPage(page, list.length, size);
  return { rows: list.slice((safe - 1) * size, safe * size), page: safe, total: list.length };
}

/**
 * One page from the database, with the total.
 * @param build returns a NEW filtered, ordered query each call, selected with { count: 'exact' }
 * Past the end (rows were deleted while someone sat on the last page) the database answers 416,
 * so this finds the new last page instead of showing an error.
 */
export async function fetchPage(build, page, size) {
  const read = (p) => build().range((p - 1) * size, p * size - 1);
  let res = await read(page);
  let at = page;
  if (page > 1 && (res.status === 416 || res.error?.code === 'PGRST103')) {
    res = await read(1);
    at = 1;
    const last = res.error ? 1 : pageCount(res.count ?? 0, size);
    if (last > 1) { res = await read(last); at = last; }
  }
  return { rows: res.data || [], total: res.count ?? 0, page: at, error: res.error || null };
}

/**
 * The `.or()` text that searches several columns for a term the user typed.
 * The term is quoted so commas and brackets can't change the filter. "*" is the wildcard in this
 * syntax and can't be escaped, so it is dropped.
 */
export function searchFilter(columns, term) {
  const clean = String(term ?? '').replace(/\*/g, ' ').trim();
  if (!clean) return '';
  const quoted = clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return columns.map((c) => `${c}.ilike."*${quoted}*"`).join(',');
}

/** Which page numbers to show: always the first, the last and those around the current one. */
export function pageNumbers(page, pages) {
  const wanted = new Set([1, pages, page - 1, page, page + 1]);
  const list = [...wanted].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out = [];
  list.forEach((n, i) => {
    const gap = i ? n - list[i - 1] : 0;
    if (gap === 2) out.push(n - 1);       // a gap of one page: show it, a "…" would take the same room
    else if (gap > 2) out.push(null);
    out.push(n);
  });
  return out;
}

export function pagerHTML({ page, total, size, label = 'items' }) {
  if (total <= size) return '';
  const pages = pageCount(total, size);
  const from = (page - 1) * size + 1;
  const to = Math.min(page * size, total);
  const arrow = (target, icon, name, off) =>
    `<button type="button" class="pager-btn" data-page="${target}" aria-label="${name}" ${off ? 'disabled' : ''}><i data-lucide="${icon}"></i></button>`;
  const numbers = pageNumbers(page, pages).map((n) => (n === null
    ? '<span class="pager-gap">…</span>'
    : `<button type="button" class="pager-btn${n === page ? ' is-current' : ''}" data-page="${n}" aria-label="Page ${n}" ${n === page ? 'aria-current="page"' : ''}>${n}</button>`)).join('');
  return `<nav class="pager" aria-label="Pages">
    <span class="pager-info">${from}–${to} of ${total} ${escapeHTML(label)}</span>
    <div class="pager-btns">${arrow(page - 1, 'chevron-left', 'Previous page', page <= 1)}${numbers}${arrow(page + 1, 'chevron-right', 'Next page', page >= pages)}</div>
  </nav>`;
}

/**
 * Draws the pager into `el` and calls onPage(n) when one is picked. Nothing is drawn when everything
 * fits on one page. `top` is what to scroll back to, so a new page starts at its first row.
 */
export function mountPager(el, { page, total, size, label, onPage, top }) {
  if (!el) return;
  el.innerHTML = pagerHTML({ page, total, size, label });
  el.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', async () => {
    await onPage(Number(b.dataset.page));
    top?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }));
  window.lucide?.createIcons();
}
