/**
 * Support Chat Markdown formatting and label helpers.
 */

// Canned response snippets for quick operator replies
export const CANNED_RESPONSES = {
  docs: 'You can explore our full API documentation, parameter references, and language examples at https://renderpdf.vberkoz.com/docs/api/.',
  enterprise:
    'RenderPDF offers dedicated enterprise concurrency, 99.99% custom SLA terms, and tailored volume pricing for scale exceeding 50,000 PDFs/month. Would you like to schedule a quick call, or should I email our enterprise agreement details?',
  margins:
    'You can configure page margins, format, and orientation in your render request payload (print backgrounds are enabled automatically):\n```json\n{\n  "version": "1",\n  "source": { "type": "html", "content": "<h1>Hello</h1>" },\n  "options": {\n    "format": "A4",\n    "margin": "18mm",\n    "landscape": false\n  }\n}\n```',
  security:
    'RenderPDF supports AES-256 PDF encryption. You can set `options.password` for the open password, `options.ownerPassword` for administrative access, and `options.permissions` to "print", "all", or "none" to restrict printing and copying.',
  investigating:
    'Thank you for reporting this issue. Our engineering team has received the transcript and is investigating the rendering logs. We will follow up shortly.',
};

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
 * Lightweight safe markdown parser for transcript display.
 * @param {string} text
 * @returns {string}
 */
export function renderChatMarkdown(text) {
  if (!text) return '';
  const safeText = escapeHtml(text);

  const codeBlocks = [];
  let formatted = safeText.replace(/```(?:[a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g, function (_, code) {
    const id = '___CODEBLOCK_' + codeBlocks.length + '___';
    codeBlocks.push('<pre><code>' + code.trim() + '</code></pre>');
    return id;
  });

  formatted = formatted.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  formatted = formatted.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  formatted = formatted.replace(/(?:^|\n)[*-]\s+(.+)/g, '<br>&bull; $1');
  formatted = formatted.replace(/\n/g, '<br>');

  codeBlocks.forEach(function (block, index) {
    formatted = formatted.replace('___CODEBLOCK_' + index + '___', block);
  });

  return formatted;
}

/**
 * Formats a timestamp into human-readable relative time or short date.
 * @param {string|number} val
 * @returns {string}
 */
export function formatTimestamp(val) {
  if (!val) return '—';
  try {
    const d = typeof val === 'number' ? new Date(val > 1e11 ? val : val * 1000) : new Date(val);
    if (isNaN(d.getTime())) return String(val);

    const now = Date.now();
    const diffMs = now - d.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHours = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSec < 60) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch {
    return String(val);
  }
}

/**
 * Formats escalation reason key into a human-friendly label.
 * @param {string} reason
 * @returns {string}
 */
export function formatEscalationReason(reason) {
  switch (reason) {
    case 'high_value_lead':
      return 'Enterprise Lead';
    case 'complex_bug':
      return 'Bug Report';
    case 'billing_issue':
      return 'Billing Inquiry';
    case 'explicit_request':
      return 'Human Requested';
    default:
      return reason ? reason.replace(/_/g, ' ') : 'Escalated';
  }
}
