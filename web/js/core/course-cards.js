// Courses the advisor recommends, as a fenced JSON block the chat turns into cards.
//
//   ```advisor-courses
//   [{"code":"CS 331","why":"Next after CS 201"}]
//   ```
//
// No DOM code here; tests use it too.

import { normalizeCode } from './prereq.js';

const FENCE = /```advisor-courses[ \t]*\n?([\s\S]*?)(?:```|$)/;
const MAX = 8;
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Split a chat answer into its text and the recommended courses. Works on partial (streaming) text too. */
export function parseCourseCards(content) {
  const text = String(content || '');
  const m = FENCE.exec(text);
  if (!m) return { text, courses: [] };
  const shown = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  let courses = [];
  try {
    const parsed = JSON.parse(m[1]);
    if (Array.isArray(parsed)) {
      const seen = new Set();
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const code = normalizeCode(item.code);
        if (!code || seen.has(code)) continue;
        seen.add(code);
        courses.push({ code, why: clip(item.why, 180) });
        if (courses.length >= MAX) break;
      }
    }
  } catch { /* partial or invalid: show nothing */ }
  return { text: shown, courses };
}
