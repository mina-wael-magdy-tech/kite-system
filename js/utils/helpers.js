/**
 * KITE SYSTEM — General Utility Helpers
 * Safe HTML escaping, formatting, debouncing, and UI helpers.
 */

/**
 * Robust HTML sanitizer to prevent XSS in dynamic rendering
 */
export function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Debounce function for smooth search & filtering
 */
export function debounce(fn, delayMs = 300) {
  let timeoutId;
  return function (...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), delayMs);
  };
}

/**
 * Throttle function
 */
export function throttle(fn, limitMs = 200) {
  let inThrottle;
  return function (...args) {
    if (!inThrottle) {
      fn.apply(this, args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limitMs);
    }
  };
}

/**
 * Format ISO date string to human-readable
 */
export function formatDate(dateStr, includeTime = false) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;

    const options = {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    };

    if (includeTime) {
      options.hour = '2-digit';
      options.minute = '2-digit';
    }

    return d.toLocaleDateString(undefined, options);
  } catch (e) {
    return dateStr;
  }
}

/**
 * Format relative time (e.g. "5 minutes ago", "Yesterday")
 */
export function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const now = new Date();
  const past = new Date(dateStr);
  const diffSec = Math.floor((now - past) / 1000);

  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 172800) return 'Yesterday';
  return formatDate(dateStr);
}

/**
 * Format currency values (e.g. EGP 12,500)
 */
export function formatCurrency(amount, currency = 'EGP') {
  const num = Number(amount) || 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(num);
}

/**
 * Extract 2-letter initials from name (e.g. "Salma Hassan" -> "SH")
 */
export function getInitials(name = '') {
  if (!name) return 'PS';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Deterministic accent color for avatars & department badges
 */
export function getAccentHex(str = '') {
  const colors = [
    '#E01B28', // Kite red
    '#E24D47', // Coral (Branding)
    '#D79F3E', // Ochre (BTL)
    '#22C58B', // Green
    '#50B9E3', // Blue (Media)
    '#98D6EA', // Pale blue (Web)
    '#FBBA48'  // Amber (Admin)
  ];
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

/**
 * Truncate long text cleanly
 */
export function truncate(str, maxLen = 60) {
  if (!str || str.length <= maxLen) return str || '';
  return str.slice(0, maxLen) + '...';
}
