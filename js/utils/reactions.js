/**
 * KITE SYSTEM — chat reaction markup (the exact HTML chat.js renders).
 * Kept in its own module so it can be tested without a browser. Every value that can come from another person
 * (the emoji, the names of who reacted, the message id) goes through escapeHTML, in attributes and in text.
 */
import { escapeHTML } from './helpers.js';

/** One reaction chip under a message. `r` = { emoji, count, mine, names[] }. */
export function reactionButtonHTML(messageId, r) {
  return `<button type="button" class="slk-react ${r.mine ? 'mine' : ''}" data-react="${escapeHTML(messageId)}" data-emoji="${escapeHTML(r.emoji)}" title="${escapeHTML((r.names || []).join(', '))}">${escapeHTML(r.emoji)} ${Number(r.count) || 0}</button>`;
}

/** The quick-reaction picker buttons. */
export function quickEmojiHTML(list) {
  return list.map(e => `<button type="button" data-e="${escapeHTML(e)}">${escapeHTML(e)}</button>`).join('');
}
