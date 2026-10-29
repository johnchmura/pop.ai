// Small DOM and text helpers shared by the UI.

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** localStorage that never throws (private windows, blocked storage). */
export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`advisor:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(`advisor:${key}`, JSON.stringify(value)); } catch { /* storage off */ }
  },
};

/** Subject -> color family used by schedule blocks, saved items, and graph nodes. */
const FAMILIES = ['blue', 'green', 'violet', 'amber', 'rose', 'teal'];
const FIXED = { CS: 'lime', MATH: 'sky', ARCH: 'blue' };
export function colorFamily(subject) {
  if (FIXED[subject]) return FIXED[subject];
  let h = 0;
  for (const ch of String(subject)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FAMILIES[2 + (h % (FAMILIES.length - 2))];
}

const CODE_IN_TEXT = /\b(?:CS|MATH|ECE|CSSP|STAT|BUS|PSYC|ITM|COM)\s?\d{3}\b/g;

/**
 * Escape text and turn course codes into buttons that run a search.
 * `known` decides which codes become links.
 */
export function linkCodes(text, known) {
  return esc(text).replace(CODE_IN_TEXT, (m) => {
    const code = m.replace(/^([A-Z]+)\s?(\d{3})$/, '$1 $2');
    return known(code) ? `<button type="button" class="code-link" data-code="${code}">${m}</button>` : m;
  });
}

/**
 * Tiny, safe Markdown for chat answers: paragraphs, - and 1. lists, **bold**, _italic_ / *italic*,
 * `code`, ### headings, and plain https links. Everything is escaped first.
 */
export function renderMarkdown(src, known) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const html = [];
  let list = null; // 'ul' | 'ol'
  let para = [];

  const inline = (text) => {
    let s = esc(text);
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
    s = s.replace(/https?:\/\/[^\s<)"']+[^\s<)"'.,;:!?]/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    s = s.replace(CODE_IN_TEXT, (m, offset, whole) => {
      // skip codes inside a link we just made
      const before = whole.slice(0, offset);
      if (before.lastIndexOf('<a ') > before.lastIndexOf('</a>')) return m;
      const code = m.replace(/^([A-Z]+)\s?(\d{3})$/, '$1 $2');
      return known(code) ? `<button type="button" class="code-link" data-code="${code}">${m}</button>` : m;
    });
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
    return s;
  };
  const flushPara = () => {
    if (para.length) html.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };

  for (const line of lines) {
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const h = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) { closeList(); html.push(`<${kind}>`); list = kind; }
      html.push(`<li>${inline((ul || ol)[1])}</li>`);
    } else if (h) {
      flushPara(); closeList();
      html.push(`<p class="md-h">${inline(h[1])}</p>`);
    } else if (!line.trim()) {
      flushPara(); closeList();
    } else {
      closeList();
      para.push(line);
    }
  }
  flushPara(); closeList();
  return html.join('');
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
