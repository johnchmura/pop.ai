// Suggested courses for open plan slots ("Humanities (H) course, 200+", "Psychology Electives", ...).
// A suggestion is a real catalog course that fits the requirement, is not taken or planned yet,
// has its prerequisites done before that term, and is offered then (CS: the department forecast).
// Suggestions never change the plan or the audit. They are only shown next to the open slot.
// No DOM code here; the server and tests use it too.

import { evaluate, courseLeaves } from './prereq.js';
import { offeredIn } from './forecast.js';
import { groupForRequirement } from './plan-check.js';
import { REPEATABLE } from './transcript.js';
import { interestScore, focusInterests, programInterests } from './interests.js';

const MAX_PER_SLOT = 3;
const subjectOf = (code) => code.split(' ')[0];
const numberOf = (code) => parseInt(code.split(' ')[1], 10) || 0;
const levelOf = (code) => Math.floor(numberOf(code) / 100) * 100;

// courses that are not normal classes (one-off research, internships, and similar)
const NOT_A_CLASS = /independent|special problems|special topics|research|thesis|internship|co-?op\b|practicum|directed|practical experience|study abroad|undergraduate project|honors|colloquium|short course|seminar|bridge to|introduction to the profession|intro to the profession/i;
// text prerequisites that a student cannot plan around
const NEEDS_SIGNOFF = /permission|consent|approv|graduate standing|admission|admitted|enrolled in|declared|major/i;

const H_SUBJECTS = ['HUM', 'HIST', 'LIT', 'PHIL', 'AAH'];
const S_SUBJECTS = ['PSYC', 'SOC', 'PS', 'ECON', 'SSCI'];
const N_SUBJECTS = ['BIOL', 'CHEM', 'PHYS', 'MS', 'FDSN', 'ENVE', 'ASTR', 'GEOL'];
// the usual first natural science courses, shown first for a science slot
const SCIENCE_FIRST = ['BIOL 107', 'BIOL 115', 'CHEM 122', 'PHYS 120', 'BIOL 114', 'FDSN 201', 'PHYS 114', 'PHYS 123', 'BIOL 109', 'BIOL 117', 'CHEM 123'];
const isHS = (c) => (H_SUBJECTS.includes(c.subject) && hasAttr(c, 'H')) || (S_SUBJECTS.includes(c.subject) && hasAttr(c, 'S'));

/** Which part of the Core Curriculum humanities and social science group an open slot is for. */
export function hssPartFor(label) {
  const t = String(label || '').toLowerCase();
  const hum = /humanit|\(h\)/.test(t);
  const soc = /social|\(s\)/.test(t);
  if ((hum && soc) || /\bcom\b/.test(t)) return 'hs-extra';
  if (soc) return 's';
  if (/100/.test(t)) return 'hum100';
  if (hum) return 'h200';
  return '';
}

function hasAttr(course, letter) {
  return new RegExp(`\\(${letter}\\)`).test(course.satisfies || '');
}

/** A rule a course must match: { subjects, minLevel, minNumber, codes, exclude, attr, test }. */
function specFor(group, part, hssGroup) {
  if (!group) return null;
  if (group.type === 'hss') {
    const H = group.hSubjects || hssGroup?.hSubjects || H_SUBJECTS;
    const S = group.sSubjects || hssGroup?.sSubjects || S_SUBJECTS;
    if (part === 'hum100') return { subjects: ['HUM'], maxLevel: 100, core: true };
    if (part === 'h200') return { subjects: H, minLevel: 200, attr: 'H', core: true };
    if (part === 's') return { subjects: S, minLevel: 200, attr: 'S', spreadFields: true, core: true };
    if (part === 'hs-extra') {
      return {
        test: (c) => (H.includes(c.subject) && hasAttr(c, 'H')) || (S.includes(c.subject) && hasAttr(c, 'S'))
          || (c.subject === 'COM' && c.code !== 'COM 101' && c.code !== 'COM 111'),
        minLevel: 200,
        core: true,
      };
    }
    return null;
  }
  if (group.type !== 'pick') return null;
  const from = group.from || {};
  const base = from.codes?.length ? { codes: from.codes } : from.subjects?.length ? from : group.suggest;
  if (!base) return null;
  const spec = { ...base, exclude: [...(from.exclude || []), ...(base.exclude || [])] };
  // IPRO: the project courses, not the one-time introduction
  if (spec.subjects?.length === 1 && spec.subjects[0] === 'IPRO') { spec.codes = ['IPRO 497', 'IPRO 397']; spec.core = true; }
  // Core Curriculum pieces inside "pick" groups (other programs) use the catalog attributes too
  const subs = spec.subjects || [];
  if (subs.length && subs.every((s) => H_SUBJECTS.includes(s))) { spec.attr = spec.attr || 'H'; spec.core = true; }
  else if (subs.length && subs.every((s) => S_SUBJECTS.includes(s)) && /social/i.test(group.name)) { spec.attr = spec.attr || 'S'; spec.core = true; }
  else if (subs.some((s) => H_SUBJECTS.includes(s)) && subs.some((s) => S_SUBJECTS.includes(s))) {
    // a mixed humanities and social science group
    const com = subs.includes('COM');
    spec.test = (c) => isHS(c) || (com && c.subject === 'COM' && c.code !== 'COM 101' && c.code !== 'COM 111');
    spec.core = true;
  }
  if (subs.length && subs.every((s) => N_SUBJECTS.includes(s))) { spec.prefer = SCIENCE_FIRST; spec.core = true; }
  return spec;
}

function fits(course, spec) {
  const code = course.code;
  if (spec.exclude?.includes(code)) return false;
  if (spec.codes) return spec.codes.includes(code);
  if (spec.test && !spec.test(course)) return false;
  if (spec.subjects && !spec.subjects.includes(course.subject)) return false;
  if (spec.minLevel && levelOf(code) < spec.minLevel) return false;
  if (spec.maxLevel && levelOf(code) > spec.maxLevel) return false;
  if (spec.minNumber && numberOf(code) < spec.minNumber) return false;
  if (spec.attr && !hasAttr(course, spec.attr)) return false;
  return true;
}

/** Courses that cannot be planned (permission only, graduate standing, and similar). */
function needsSignoff(course) {
  const walk = (node) => {
    if (!node) return false;
    if (node.type === 'text') return NEEDS_SIGNOFF.test(node.text);
    if (node.type === 'course') return false;
    // an "or" only blocks when every branch blocks; an "and" blocks when any part blocks
    const parts = node.children.map(walk);
    return node.type === 'or' ? parts.every(Boolean) : parts.some(Boolean);
  };
  return walk(course.prereq);
}

/**
 * Find courses for one open slot.
 *   spec:     from specFor
 *   credits:  the slot's credits
 *   termKey:  forecast key of the term the slot is in ('' for "not placed yet")
 *   finished: codes done before that term
 *   current:  codes in that term
 *   blocked:  codes that must not be suggested (taken, planned, required elsewhere)
 *   usedHere: codes already suggested for other slots (tried last)
 *   fields:   subjects the student already has for a "two or more fields" rule
 */
function pickFor(index, spec, { credits, termKey, termLabel, finished, current, grades, blocked, usedHere, fields, home, interests, major }) {
  const forecast = index.forecast;
  const out = [];
  for (const c of index.list) {
    if (blocked.has(c.code) || !fits(c, spec)) continue;
    const listedHere = spec.codes?.includes(c.code);
    if (c.bridge || (!listedHere && NOT_A_CLASS.test(c.title || ''))) continue;
    const cr = Number(c.credits);
    if (!Number.isFinite(cr) || cr <= 0) continue; // variable credit
    // fills the slot: up to one credit over, and exactly 1 for a 1-credit slot (usually a lab)
    if (cr < credits || cr > credits + (credits >= 2 ? 1 : 0)) continue;
    if (levelOf(c.code) >= 500 && !(spec.minLevel >= 500)) continue; // graduate courses
    if (needsSignoff(c)) continue;
    if (c.prereq && evaluate(c.prereq, { completed: finished, current, grades, textRules: 'plan' }) !== 'met') continue;
    // CS courses run only when the department forecast lists them; other subjects are assumed to run every term
    const offered = termKey ? offeredIn(forecast, c.code, termKey) : null;
    if (offered === false) continue;
    if (offered === null && termKey && (c.subject === 'CS' || c.subject === 'CSP') && forecast) continue;
    // only courses that are really offered: the schedule semester needs sections; later terms need the
    // department forecast or sections now (a course with neither is not being offered)
    if (termLabel && termLabel === index.semester) { if (!c.sections?.length) continue; }
    else if (offered !== true && !c.sections?.length) continue;
    out.push(c);
  }
  const listed = spec.codes || [];
  const prefer = spec.prefer || [];
  // what the student said counts most, then the student's major
  const chat = new Map(out.map((c) => [c.code, interestScore(c, interests) * 10 + interestScore(c, major)]));
  out.sort((a, b) => {
    // listed order first (for example IPRO 497 before IPRO 397)
    const la = listed.indexOf(a.code); const lb = listed.indexOf(b.code);
    if (la !== lb) return (la < 0 ? 99 : la) - (lb < 0 ? 99 : lb);
    // what the student talked about in the chat
    const ia = chat.get(a.code); const ib = chat.get(b.code);
    if (ia !== ib) return ib - ia;
    // the usual courses for this kind of slot
    const pa = prefer.includes(a.code) ? 0 : 1; const pb = prefer.includes(b.code) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    // not suggested for another slot yet
    const ua = usedHere.has(a.code) ? 1 : 0; const ub = usedHere.has(b.code) ? 1 : 0;
    if (ua !== ub) return ua - ub;
    if (pa === 0 && pb === 0) return prefer.indexOf(a.code) - prefer.indexOf(b.code);
    // major electives: the program's own department first (MMAE for mechanical engineering)
    if (!spec.core) {
      const ha = a.subject === home ? 0 : 1; const hb = b.subject === home ? 0 : 1;
      if (ha !== hb) return ha - hb;
    }
    // a new field when the rule wants two or more fields
    if (spec.spreadFields) {
      const fa = fields.has(a.subject) ? 1 : 0; const fb = fields.has(b.subject) ? 1 : 0;
      if (fa !== fb) return fa - fb;
    }
    // same credits as the slot
    const ca = Number(a.credits) === credits ? 0 : 1; const cb = Number(b.credits) === credits ? 0 : 1;
    if (ca !== cb) return ca - cb;
    // Core Curriculum: open courses first. Major electives: courses that build on what the student took.
    const na = courseLeaves(a.prereq).length; const nb = courseLeaves(b.prereq).length;
    if (na !== nb) return spec.core ? na - nb : nb - na;
    return numberOf(a.code) - numberOf(b.code) || a.code.localeCompare(b.code);
  });
  // take the best three; skip a second listing of the same class (cross-listed numbers share a title)
  const chosen = [];
  const titles = new Set();
  const take = (c) => {
    const t = String(c.title || '').toLowerCase();
    if (chosen.length >= MAX_PER_SLOT || chosen.includes(c) || (t && titles.has(t))) return;
    chosen.push(c);
    if (t) titles.add(t);
  };
  // show different fields first when the rule wants two or more fields
  if (spec.spreadFields) for (const c of out) if (!chosen.some((x) => x.subject === c.subject)) take(c);
  for (const c of out) take(c);
  if (spec.spreadFields) chosen.sort((a, b) => out.indexOf(a) - out.indexOf(b));
  return chosen.map((c) => c.code);
}

/**
 * Is a course offered in a plan term? The schedule semester needs sections. Later terms need the CS
 * department forecast, or sections now (IIT does not publish later schedules for other subjects).
 */
export function isOffered(index, code, termKey, termLabel) {
  const c = index.get?.(code);
  if (!c) return false;
  if (termLabel === index.semester) return c.sections.length > 0;
  const f = termKey ? offeredIn(index.forecast, code, termKey) : null;
  if (f === false) return false;
  return f === true || c.sections.length > 0;
}

/** The program group an open slot belongs to. */
function groupForItem(item, program) {
  const req = item.requirement || item.groupName || '';
  const exact = program.groups.find((g) => g.name === req || g.id === item.group);
  if (exact) return exact;
  const id = groupForRequirement(req || item.label, program);
  const byId = id && program.groups.find((g) => g.id === id);
  if (byId) return byId;
  const t = `${req} ${item.label || ''}`.toLowerCase();
  if (/humanit|social|\(h\)|\(s\)/.test(t)) return program.groups.find((g) => g.type === 'hss') || null;
  if (/ipro|interprofessional/.test(t)) return program.groups.find((g) => g.type === 'pick' && g.from?.subjects?.includes('IPRO')) || null;
  return null;
}

/**
 * Add `suggestions` (course codes) to the open slots of a plan view (the shape describePlan returns,
 * also used for the advisor's plan). Terms must be in time order. Changes the view in place.
 *   ctx: { index, program, audit, done (Set), grades (Map), interests (from chatInterests) }
 * Courses that match the chat come first (item.chatMatches), then courses related to the major (item.majorMatches).
 */
export function addSuggestions(view, { index, program, audit, done = new Set(), grades = new Map(), interests = null, majorKnown = true }) {
  if (!view?.terms) return view;
  interests = interests && focusInterests(interests, index.list);
  // no declared or detected major: no major stars
  const major = majorKnown ? focusInterests(programInterests(program), index.list) : null;
  const matches = (it, codes) => {
    const score = (c, i) => { const course = index.get?.(c); return course ? interestScore(course, i) : 0; };
    it.chatMatches = codes.filter((c) => score(c, interests) > 0);
    // a star for the major only outside the major's own department (History of AI for an AI major,
    // not every PSYC course for a psychology major)
    it.majorMatches = major ? codes.filter((c) => !it.chatMatches.includes(c) && subjectOf(c) !== home && score(c, major) > 0) : [];
  };
  const hssGroup = program.groups.find((g) => g.type === 'hss');
  // never suggest a course the student has, has planned, or must take anyway
  const blocked = new Set(done);
  for (const g of audit?.groups || []) for (const c of g.courses) blocked.add(c.code);
  for (const g of program.groups) for (const slot of g.slots || []) for (const option of slot) option.forEach((c) => blocked.add(c));
  const all = [...view.terms.flatMap((t) => t.items), ...(view.later || [])];
  for (const it of all) if (it.code) blocked.add(it.code);
  // courses that count again when repeated (IPRO 497) stay available
  for (const code of REPEATABLE) blocked.delete(code);
  // fields the student already has toward the social science rule
  const fields = new Set();
  const hssAudit = audit?.groups?.find((g) => g.type === 'hss');
  for (const p of hssAudit?.parts || []) if (p.id === 's') p.have.forEach((c) => fields.add(subjectOf(c)));

  // the program's own department: the subject with the most required courses
  const counts = new Map();
  for (const g of program.groups) for (const slot of g.slots || []) for (const code of slot[0] || []) counts.set(subjectOf(code), (counts.get(subjectOf(code)) || 0) + 1);
  const home = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || '';

  const usedHere = new Set();
  const finished = new Set(done);
  const run = (items, termKey, termLabel = '') => {
    const current = new Set(items.filter((i) => i.code).map((i) => i.code));
    for (const it of items) {
      it.suggestions = [];
      it.chatMatches = [];
      it.majorMatches = [];
      // option lists ("Pick one", "Or") keep only courses that are offered that term
      if (it.options?.length && termLabel) it.options = it.options.filter((c) => isOffered(index, c, termKey, termLabel));
      if (!it.code && it.options?.length) {
        // a slot that lists its options: the ones from the chat go first, then the ones related to the major
        const score = (c) => { const course = index.get?.(c); return course ? interestScore(course, interests) * 10 + interestScore(course, major) : 0; };
        it.options = [...it.options].sort((a, b) => score(b) - score(a));
        matches(it, it.options);
      }
      if (it.code || it.options?.length) continue; // a real course, or a slot that already lists its options
      const group = groupForItem(it, program);
      if (!group || group.type === 'free') continue;
      const part = group.type === 'hss' ? hssPartFor(it.label) : '';
      const minor = it.minorSubject || (/^([A-Z]{2,4}) minor course$/.exec(it.label || '') || [])[1];
      const spec = minor ? { subjects: [minor], minLevel: 200 } : specFor(group, part, hssGroup);
      if (!spec) continue;
      const credits = Number(it.credits) || 3;
      it.suggestions = pickFor(index, spec, { credits, termKey, termLabel, finished, current, grades, blocked, usedHere, fields, home, interests, major });
      matches(it, it.suggestions);
      it.suggestions.forEach((c) => usedHere.add(c));
    }
    for (const c of current) finished.add(c);
  };
  for (const term of view.terms) run(term.items, term.key || '', term.label || '');
  if (view.later?.length) run(view.later, '');
  return view;
}
