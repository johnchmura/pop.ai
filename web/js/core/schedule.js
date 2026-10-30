// Weekly schedule layout. Ported from pop.ai (src/schedule.js):
// each meeting becomes a block per day; when blocks overlap on a day,
// the day is split into columns so every block stays visible.
// No DOM code here; the UI draws the result.

export const DAY_LETTERS = 'UMTWRFS'; // pop.ai order: Sunday..Saturday
export const DAY_LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** "10 AM", "11:25 AM", "1:50pm", "13:05" -> hours as a number (11.4167). NaN if it cannot parse. */
export function parseClock(str) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\.?\s*$/i.exec(String(str || ''));
  if (!m) return NaN;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return NaN;
  const ap = m[3] ? m[3].toLowerCase() : '';
  if (ap) {
    if (h < 1 || h > 12) return NaN;
    if (h === 12) h = 0;
    if (ap === 'p') h += 12;
  } else if (h > 23) {
    return NaN;
  }
  return h + min / 60;
}

/** "11:25 AM - 12:40 PM" -> { start, end } or null. */
export function parseRange(time) {
  const parts = String(time || '').split(/\s*[-–]\s*/);
  if (parts.length < 2) return null;
  let start = parseClock(parts[0]);
  const end = parseClock(parts[1]);
  // "1:50 - 3:05 PM": borrow the end's AM/PM when the start has none
  const startHasSuffix = /[ap]\.?\s*m?\.?\s*$/i.test(parts[0]);
  const endSuffix = /([ap])\.?\s*m?\.?\s*$/i.exec(parts[1]);
  if (!startHasSuffix && endSuffix && !Number.isNaN(end)) {
    start = parseClock(`${parts[0]} ${endSuffix[1]}m`);
    if (start >= end) start -= 12;
  }
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  return { start, end };
}

/** "13.5" -> "1:30 PM" (the one time format used everywhere in the app) */
export function formatHour(h, withMinutes = true) {
  const hh = Math.floor(h + 1e-9);
  const mm = Math.round((h - hh) * 60);
  const suffix = hh >= 12 && hh < 24 ? 'PM' : 'AM';
  const h12 = ((hh + 11) % 12) + 1;
  return withMinutes ? `${h12}:${String(mm).padStart(2, '0')} ${suffix}` : `${h12} ${suffix}`;
}

/** A meeting time from the data ("5 PM - 6:15 PM") in the app's format ("5:00 PM–6:15 PM"). */
export function formatRange(time) {
  const r = parseRange(time);
  return r ? `${formatHour(r.start)}–${formatHour(r.end)}` : String(time || '');
}

/**
 * Blocks for a list of { key, label, colorKey, section } items.
 * Each block: { key, label, colorKey, day (0-6), start, end, column, numColumns }.
 * Meetings without real days or times (TBA, Internet) are returned in `unscheduled`.
 */
export function buildBlocks(items) {
  const blocks = [];
  const unscheduled = [];
  for (const item of items) {
    let placed = false;
    for (const meeting of item.section.meetings) {
      const range = parseRange(meeting.time);
      if (!range) continue;
      for (const letter of String(meeting.days || '').toUpperCase()) {
        const day = DAY_LETTERS.indexOf(letter);
        if (day < 0) continue;
        const block = { key: item.key, label: item.label, colorKey: item.colorKey, day, start: range.start, end: range.end, where: meeting.where };
        // some sections repeat the same meeting (pop.ai note about ECON 0510)
        if (!blocks.some((b) => b.key === block.key && b.day === day && b.start === block.start && b.end === block.end)) {
          blocks.push(block);
        }
        placed = true;
      }
    }
    if (!placed) unscheduled.push(item);
  }

  blocks.sort((a, b) => a.start - b.start || a.label.localeCompare(b.label));

  for (let day = 0; day < 7; day++) {
    const today = blocks.filter((b) => b.day === day);
    // max number of blocks running at once (counted at each start point, as in pop.ai)
    let maxOverlap = 0;
    for (const p of today) {
      const overlap = today.filter((b) => p.start >= b.start && p.start < b.end).length;
      maxOverlap = Math.max(maxOverlap, overlap);
    }
    today.forEach((b, i) => {
      b.numColumns = maxOverlap;
      for (b.column = 0; b.column < b.numColumns; b.column++) {
        const clash = today.slice(0, i).some((o) => o.column === b.column && b.start < o.end && o.start < b.end);
        if (!clash) break;
      }
    });
  }
  return { blocks, unscheduled };
}

/** Visible hour range and days, like pop.ai: at least 9am-4pm, weekdays, grown to fit. */
export function gridBounds(blocks, { minStart = 9, minEnd = 16 } = {}) {
  let start = minStart;
  let end = minEnd;
  let weekend = false;
  for (const b of blocks) {
    start = Math.min(start, Math.floor(b.start));
    end = Math.max(end, Math.ceil(b.end));
    if (b.day === 0 || b.day === 6) weekend = true;
  }
  const days = weekend ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5];
  return { start, end, days };
}

/** Pairs of items whose meetings overlap in time on the same day. */
export function findConflicts(blocks) {
  const pairs = new Map();
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i];
      const b = blocks[j];
      if (a.key === b.key || a.day !== b.day) continue;
      if (a.start < b.end && b.start < a.end) {
        const k = [a.key, b.key].sort().join('|');
        if (!pairs.has(k)) pairs.set(k, { a: a.key, b: b.key, day: a.day, start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) });
      }
    }
  }
  return [...pairs.values()];
}
