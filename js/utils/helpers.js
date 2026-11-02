/**
 * PULSE STUDIO OS — General Utility Helpers
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
 * Format currency values (e.g. $12,500.00)
 */
export function formatCurrency(amount, currency = 'USD') {
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
    '#6366F1', // Indigo
    '#EC4899', // Pink (Branding)
    '#F97316', // Orange (BTL)
    '#10B981', // Emerald (Digital)
    '#A855F7', // Purple (Media)
    '#06B6D4', // Cyan (Web)
    '#F59E0B'  // Amber (Admin)
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
