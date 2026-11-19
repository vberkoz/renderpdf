/**
 * Shared Formatting & Sanitization Utilities for Admin Users module
 */

/**
 * Escapes HTML characters to prevent XSS.
 * @param {string|number} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Formats an integer count with comma separators.
 * @param {number} count
 * @returns {string}
 */
export function formatCount(count) {
  const num = Number(count) || 0;
  return num.toLocaleString('en-US');
}

/**
 * Formats a timestamp or ISO string into readable UTC format.
 * @param {string|number} val
 * @returns {string}
 */
export function formatDate(val) {
  if (!val) return '—';
  try {
    const d = typeof val === 'number' ? new Date(val > 1e11 ? val : val * 1000) : new Date(val);
    if (isNaN(d.getTime())) return String(val);
    return (
      d.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'UTC',
      }) + ' UTC'
    );
  } catch {
    return String(val);
  }
}

/**
 * Formats byte size into human-readable representation.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const num = Number(bytes);
  if (!num || isNaN(num) || num <= 0) return '—';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / (1024 * 1024)).toFixed(1)} MB`;
}
