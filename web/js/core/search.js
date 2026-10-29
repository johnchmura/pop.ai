// Instant course search. The matching and scoring follow pop.ai (src/search.js):
// every query word must match the start of a word somewhere in the course text,
// and matches in the course code and title score higher.
// Added here: commas split a query into parts that are OR-ed together,
// so "CS 331, MATH 251, MATH 474" returns all three courses.

import { normalizeCode } from './prereq.js';
import { sectionText, dayWords } from './catalog.js';

const PUNCT = /[`~!@#$%^&*()=\[\]{}|;"<>?,.:'/\\+]/g;

function escapeRegex(s) {
  return s.replace(/[\^$\\*+\[\]().?|{}\-]/g, '\\$&');
}

/** Turn one query part into keywords. Returns [] for an empty part. */
export function keywordsFor(part) {
  let words = String(part || '').toLowerCase().replace(PUNCT, ' ').split(/\s+/).filter(Boolean);
  // "cs331" -> "cs" + "331" (like pop.ai's "cs53" rule)
  words = words.flatMap((w) => {
    const m = /^([a-z]+)(\d+[a-z]?)$/.exec(w);
    return m ? [m[1], m[2]] : [w];
  });
  // drop words that are a prefix of another word, and duplicates
  const unique = [...new Set(words)];
  return unique.filter((w) => !unique.some((o) => o !== w && o.startsWith(w)));
}

function compile(keywords) {
  if (!keywords.length) return null;
  const alt = keywords
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|');
  return {
    words: keywords,
    startsWith: new RegExp(`\\b(${alt})`, 'gi'),
    equals: new RegExp(`^(${alt})$`, 'i'),
  };
}

/** Searchable text for a course. Cached on the course object. */
export function courseSearchText(course, opts) {
  const key = `${opts.searchDescriptions ? 1 : 0}${opts.searchSections ? 1 : 0}`;
  course._searchText = course._searchText || {};
  if (course._searchText[key]) return course._searchText[key];
  let text = `${course.code}: ${course.title}`;
  text += ` ${course.department} ${course.satisfies || ''}`;
  if (opts.searchDescriptions) text += ` ${course.description || ''}`;
  if (opts.searchSections && course.futureTerms?.length) text += ` ${course.futureTerms.join(' ')}`;
  if (opts.searchSections && course.sections.length) {
    const semesters = new Set(course.sections.map((s) => s.semester));
    text += ` ${[...semesters].join(' ')}`;
    for (const s of course.sections) {
      text += ` ${sectionText(s)}`;
      for (const m of s.meetings) text += ` ${dayWords(m.days).join(' ')}`;
    }
  }
  course._searchText[key] = text;
  return text;
}

function scoreCourse(course, rx, opts) {
  const text = courseSearchText(course, opts);
  const nameLen = course.code.length;
  const titleEnd = nameLen + 2 + (course.title || '').length;
  const wordScores = new Map();
  let matchesName = 0;
  let matchesTitle = 0;
  rx.startsWith.lastIndex = 0;
  let m;
  while ((m = rx.startsWith.exec(text))) {
    const frag = m[1].toLowerCase();
    const at = m.index;
    if (at < nameLen) matchesName++;
    else if (at < titleEnd) matchesTitle = 1;
    const next = text[at + frag.length];
    const wholeWord = next === undefined || /[\s\\/.,:;")\-]/.test(next);
    const wordScore = 1 + (wholeWord ? 1 + (at < nameLen ? 1 : 0) : 0);
    wordScores.set(frag, Math.max(wordScores.get(frag) || 0, wordScore));
  }
  // every keyword must match somewhere
  const matched = rx.words.filter((w) => wordScores.has(w));
  if (matched.length < rx.words.length) return 0;
  let score = 0;
  for (const v of wordScores.values()) score += v;
  return score * (1 + 1.5 * matchesName + 0.5 * (matchesTitle > matchesName ? 1 : 0));
}

/**
 * Search the index.
 * opts: { searchDescriptions, searchSections, filter(course) -> bool, require(course) -> bool }
 * filter() can be bypassed by an exact code or CRN; require() never is.
 * Returns { results: [{ course, score, part }], focus: [codes typed exactly], keywords: [...] }.
 */
export function search(index, query, opts = {}) {
  const o = { searchDescriptions: true, searchSections: true, filter: () => true, require: () => true, ...opts };
  const parts = String(query || '').split(/[,;]+/).map((p) => p.trim()).filter(Boolean);
  const best = new Map();
  const focus = [];
  const allKeywords = new Set();

  parts.forEach((part, partIndex) => {
    // CRN: exact match only
    const crn = part.replace(/\s+/g, '');
    if (/^\d{5}$/.test(crn) && index.crnMap.has(crn)) {
      const course = index.courses.get(index.crnMap.get(crn).course);
      allKeywords.add(crn);
      if (course) add(course, 1e6, partIndex, crn);
      return;
    }
    // exact course code: always first for this part
    const code = normalizeCode(part);
    if (code && index.courses.has(code)) {
      if (!focus.includes(code)) focus.push(code);
      add(index.courses.get(code), 1e5, partIndex);
    }
    const kws = keywordsFor(part);
    kws.forEach((k) => allKeywords.add(k));
    const rx = compile(kws);
    if (!rx) return;
    for (const course of index.list) {
      const s = scoreCourse(course, rx, o);
      if (s > 0) add(course, s, partIndex);
    }
  });

  function add(course, score, part, crn) {
    if (!o.require(course)) return;
    if (!o.filter(course) && !(focus.includes(course.code) || crn)) return;
    const prev = best.get(course.code);
    if (!prev || score > prev.score || (score === prev.score && part < prev.part)) {
      best.set(course.code, { course, score, part, crn: crn || prev?.crn || '' });
    }
  }

  const results = [...best.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.part !== b.part) return a.part - b.part;
    return a.course.code.localeCompare(b.course.code, 'en', { numeric: true });
  });
  // Exact codes keep the order they were typed in.
  results.sort((a, b) => {
    const ai = focus.indexOf(a.course.code);
    const bi = focus.indexOf(b.course.code);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return { results, focus, keywords: [...allKeywords] };
}

/**
 * Split text into [{ text, match }] pieces for highlighting.
 * Works on plain text; the caller escapes each piece.
 */
export function highlightPieces(text, keywords) {
  const src = String(text || '');
  const rx = compile(keywords || []);
  if (!rx || !src) return [{ text: src, match: false }];
  const out = [];
  let last = 0;
  rx.startsWith.lastIndex = 0;
  let m;
  while ((m = rx.startsWith.exec(src))) {
    if (m[0].length === 0) { rx.startsWith.lastIndex++; continue; }
    if (m.index > last) out.push({ text: src.slice(last, m.index), match: false });
    out.push({ text: m[0], match: true });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ text: src.slice(last), match: false });
  return out;
}
