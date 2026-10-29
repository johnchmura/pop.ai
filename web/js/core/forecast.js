// Future course offerings (the CS department's tentative schedule).
// Source format (CSV): "Course,S27,F27,S28,F28" then rows like "CS 100,,Y,,Y".
// Course cells may carry extra text: "CS 415  Int. HumanComputer Interaction", "CS 442 (now CSP442)".

import { normalizeCode } from './prereq.js';

const SEASONS = { S: 'Spring', F: 'Fall', SU: 'Summer', U: 'Summer', W: 'Winter' };
const SEASON_ORDER = { Spring: 1, Summer: 2, Fall: 3, Winter: 4 };

/** "S27" -> { key: 'S27', label: 'Spring 2027', season: 'Spring', year: 2027, order: 20271 } */
export function termFromKey(key) {
  const m = /^\s*(SU|S|F|U|W)\s*'?(\d{2}|\d{4})\s*$/i.exec(String(key || ''));
  if (!m) return null;
  const season = SEASONS[m[1].toUpperCase()];
  const year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  return { key: `${m[1].toUpperCase()}${String(year).slice(2)}`, label: `${season} ${year}`, season, year, order: year * 10 + SEASON_ORDER[season] };
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Parse the forecast CSV. Returns { terms, courses: {code: [termKeys]}, notes: {code: text}, warnings }. */
export function parseForecastCsv(text) {
  const lines = String(text || '').replace(/^﻿/, '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
  const warnings = [];
  if (!lines.length) return { terms: [], courses: {}, notes: {}, warnings: ['The file is empty.'] };
  const header = splitCsvLine(lines[0]);
  const cols = header.map((h, i) => ({ i, term: termFromKey(h) })).filter((c) => c.term);
  if (!cols.length) warnings.push('No term columns like S27 or F27 were found in the header row.');
  const courses = {};
  const notes = {};
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const raw = cells[0] || '';
    if (!raw) continue;
    const m = /^\s*([A-Za-z]{2,4})\s*(\d{3})\b\s*(.*)$/.exec(raw);
    const code = m ? normalizeCode(`${m[1]} ${m[2]}`) : '';
    if (!code) { warnings.push(`Skipped row: "${raw}"`); continue; }
    const extra = (m[3] || '').trim();
    if (extra) notes[code] = extra.replace(/^\((.*)\)$/, '$1').replace(/\s+/g, ' ');
    courses[code] = cols.filter((c) => /^(y|yes|x|✓|1)$/i.test(cells[c.i] || '')).map((c) => c.term.key);
  }
  const terms = cols.map((c) => c.term).sort((a, b) => a.order - b.order);
  return { terms, courses, notes, warnings };
}

/**
 * Is `code` expected in `termKey`?
 * Returns true / false for courses on the forecast, or null when the forecast does not cover the course.
 */
export function offeredIn(forecast, code, termKey) {
  if (!forecast) return null;
  const list = forecast.courses[code];
  if (!list) return null;
  return list.includes(termKey);
}

/** Labels like ["Spring 2027", "Fall 2027"] for a course. */
export function offeringLabels(forecast, code) {
  const list = forecast?.courses?.[code];
  if (!list) return null;
  const byKey = new Map(forecast.terms.map((t) => [t.key, t.label]));
  return list.map((k) => byKey.get(k) || k);
}
