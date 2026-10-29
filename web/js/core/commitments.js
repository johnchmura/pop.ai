// Time commitments: work, commute, sports, family. The student lists them once.
// The app then marks sections that clash with them and tells the chat advisor.
// No DOM code here; tests use it too.
//
// A commitment: { id, label, days: 'MTWRF', start: 14, end: 17.5 }  (hours, 24-hour clock)

import { parseRange, parseClock, DAY_LETTERS, DAY_LABELS, formatHour } from './schedule.js';

const MAX = 20;
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Clean one commitment from user input. Returns null when it is not usable. */
export function cleanCommitment(raw) {
  const days = [...new Set(String(raw?.days || '').toUpperCase().split('').filter((d) => DAY_LETTERS.includes(d)))]
    .sort((a, b) => DAY_LETTERS.indexOf(a) - DAY_LETTERS.indexOf(b)).join('');
  const start = Number(raw?.start);
  const end = Number(raw?.end);
  if (!days || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 24 || end <= start) return null;
  return { id: String(raw.id || `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`), label: clip(raw.label, 40) || 'Busy', days, start, end };
}

export const cleanCommitments = (list) => (Array.isArray(list) ? list.map(cleanCommitment).filter(Boolean).slice(0, MAX) : []);

/** "14:30" -> 14.5 (from an <input type="time">). NaN when empty. */
export function hoursFromInput(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  return m ? Number(m[1]) + Number(m[2]) / 60 : NaN;
}

/** Grid blocks for the commitments (same shape as schedule blocks, with kind 'busy'). */
export function commitmentBlocks(list) {
  const blocks = [];
  for (const c of list) {
    for (const letter of c.days) {
      const day = DAY_LETTERS.indexOf(letter);
      if (day >= 0) blocks.push({ key: c.id, label: c.label, kind: 'busy', day, start: c.start, end: c.end });
    }
  }
  return blocks;
}

/** Commitments that overlap a section's meetings. Returns [{ label, day, start, end }]. */
export function sectionClashes(section, list) {
  const out = [];
  for (const m of section?.meetings || []) {
    const range = parseRange(m.time);
    if (!range) continue;
    for (const letter of String(m.days || '').toUpperCase()) {
      const day = DAY_LETTERS.indexOf(letter);
      if (day < 0) continue;
      for (const c of list) {
        if (!c.days.includes(letter)) continue;
        if (range.start < c.end && c.start < range.end) out.push({ label: c.label, day, start: Math.max(range.start, c.start), end: Math.min(range.end, c.end) });
      }
    }
  }
  return out;
}

/** True when the course has no section at all, or at least one section with no clash. */
export function courseFits(course, list) {
  if (!list.length || !course.sections?.length) return true;
  return course.sections.some((s) => !sectionClashes(s, list).length);
}

/** Short day text: "MWF" -> "Mon Wed Fri". */
export const dayWords = (days) => [...days].map((l) => DAY_LABELS[DAY_LETTERS.indexOf(l)]).map((d) => d[0] + d.slice(1).toLowerCase()).join(' ');

/** One plain line per commitment (Degree/Chat context and the list in the UI). */
export const describeCommitment = (c) => `${c.label}: ${dayWords(c.days)}, ${formatHour(c.start)}-${formatHour(c.end)}`;

// ----- memory: the chat advisor saves commitments from what the student says -----
//   ```advisor-memory
//   [{"op":"add","label":"Work","days":"MW","start":"15:00","end":"19:00"},{"op":"remove","label":"Work"},{"op":"clear"}]
//   ```
const MEMORY_FENCE = /```advisor-memory[ \t]*\n?([\s\S]*?)(?:```|$)/;

/** Split a chat answer into its text and the memory operations. Works on partial (streaming) text. */
export function parseMemory(content) {
  const text = String(content || '');
  const m = MEMORY_FENCE.exec(text);
  if (!m) return { text, ops: [] };
  const shown = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  let ops = [];
  try {
    const parsed = JSON.parse(m[1]);
    if (Array.isArray(parsed)) ops = parsed.filter((o) => o && typeof o === 'object').slice(0, 10);
  } catch { /* partial or invalid */ }
  return { text: shown, ops };
}

const clock = (v) => (typeof v === 'number' ? v : parseClock(v));

/** Apply operations to a list. Returns { busy, notes } (notes are plain lines for the student). */
export function applyMemoryOps(list, ops) {
  let busy = [...list];
  const notes = [];
  for (const op of ops || []) {
    if (op.op === 'clear') {
      if (busy.length) { busy = []; notes.push('Cleared all time commitments'); }
    } else if (op.op === 'remove') {
      const want = clip(op.label, 40).toLowerCase();
      const keep = busy.filter((c) => c.label.toLowerCase() !== want);
      if (keep.length !== busy.length) { busy = keep; notes.push(`Removed ${clip(op.label, 40)}`); }
    } else if (op.op === 'add') {
      const c = cleanCommitment({ label: op.label, days: op.days, start: clock(op.start), end: clock(op.end) });
      if (!c) continue;
      // same name replaces the old entry, so "my work hours changed" works
      busy = [...busy.filter((x) => x.label.toLowerCase() !== c.label.toLowerCase()), c].slice(-MAX);
      notes.push(describeCommitment(c));
    }
  }
  return { busy, notes };
}
