// Semester planner: turns what is left in a degree audit into a term-by-term plan.
// Uses prerequisite trees (data/catalog.json) and the CS department's tentative
// future offerings (data/forecast.json). No DOM code here.

import { evaluate, courseLeaves } from './prereq.js';
import { offeredIn } from './forecast.js';
import { creditsFor, titleFor } from './audit.js';

const subject = (code) => code.split(' ')[0];
const level = (code) => Number(code.split(' ')[1][0]) * 100;

/** Courses that need to be taken, built from the audit's remaining requirements. */
export function neededItems(audit, program, index, { exclude = new Set(), electiveCount } = {}) {
  const items = [];
  const taken = new Set([...exclude]);
  for (const g of audit.groups) for (const c of g.courses) taken.add(c.code);
  const add = (item) => { items.push(item); if (item.code) taken.add(item.code); };
  // Courses named in the prerequisites of required courses we still need
  // (so a choice like the communication elective can also open CS 485).
  const wantedLeaves = new Set();
  const wantedFor = new Map(); // leaf code -> required courses that need it
  const want = (code) => {
    for (const leaf of courseLeaves(index.get(code)?.prereq)) {
      wantedLeaves.add(leaf.code);
      if (!wantedFor.has(leaf.code)) wantedFor.set(leaf.code, []);
      if (!wantedFor.get(leaf.code).includes(code)) wantedFor.get(leaf.code).push(code);
    }
  };
  for (const g of audit.groups) {
    for (const slot of g.slots || []) for (const code of slot.missing || []) want(code);
    // saved (planned) courses still need their prerequisites too
    for (const c of g.courses) if (c.status === 'planned') want(c.code);
  }
  const groupDef = (id) => program.groups.find((g) => g.id === id);

  for (const g of audit.groups) {
    if (g.status !== 'remaining') continue;
    const def = groupDef(g.id);
    if (g.type === 'all') {
      for (const slot of g.slots) {
        if (slot.status !== 'remaining') continue;
        // a choice between courses: plan one, and list the rest as options
        if (slot.options.length > 1 && slot.missing.length === slot.chosen.length && slot.options.every((o) => o.length === 1)) {
          const codes = slot.options.map((o) => o[0]).filter((code) => !taken.has(code));
          const shown = codes.filter((code) => index.has(code));
          const list = shown.length ? shown : codes;
          const needed = list.find((c) => wantedLeaves.has(c));
          if (needed) {
            // another required course needs this one first, so plan it
            add({ code: needed, title: titleFor(needed, index, program), credits: creditsFor(needed, index, program), kind: 'choice', group: g.id, groupName: g.name, alternatives: list.filter((c) => c !== needed), why: wantedFor.get(needed)?.length ? `Also opens ${wantedFor.get(needed).join(', ')}` : '' });
          } else if (list.length) {
            // do not pick a course for the student: list every option
            add({ code: null, label: g.name, hint: `One of ${list.join(', ')}`, credits: creditsFor(list[0], index, program), kind: 'placeholder', group: g.id, groupName: g.name, examples: list });
          }
          continue;
        }
        for (const code of slot.missing) {
          if (taken.has(code)) continue;
          add({ code, title: titleFor(code, index, program), credits: creditsFor(code, index, program), kind: 'required', group: g.id, groupName: g.name });
        }
      }
    } else if (g.type === 'pick') {
      const from = def.from || {};
      let left = def.count ? def.count - g.courses.length : g.creditsLeft;
      if (from.codes) {
        // choose one listed course: prefer one in the catalog (we know its prerequisites)
        const options = from.codes.filter((c) => !taken.has(c));
        const known = options.filter((c) => index.has(c));
        const wanted = options.filter((c) => wantedLeaves.has(c));
        if (options.length > 1 && !options.some((c) => wantedLeaves.has(c))) {
          // several courses can fill it: list them all instead of picking one
          const list = known.length ? known : options;
          const each = creditsFor(list[0], index, program);
          let n = def.count ? def.count - g.courses.length : Math.ceil(left / each);
          while (n-- > 0 && list.length) {
            add({ code: null, label: g.name, hint: `One of ${list.join(', ')}`, credits: each, kind: 'placeholder', group: g.id, groupName: g.name, examples: list });
          }
          left = 0;
        }
        while (left > 0 && options.length) {
          const code = options.find((c) => wantedLeaves.has(c) && index.has(c)) || (known.length ? known[0] : (wanted.length ? wanted[0] : options[0]));
          known.splice(0, known.length, ...known.filter((c) => c !== code));
          wanted.splice(0, wanted.length, ...wanted.filter((c) => c !== code));
          options.splice(options.indexOf(code), 1);
          if (index.has(code) || wantedLeaves.has(code)) {
            const why = !index.has(code) && wantedFor.get(code)?.length ? `Also opens ${wantedFor.get(code).join(', ')}` : '';
            add({ code, title: titleFor(code, index, program), credits: creditsFor(code, index, program), kind: 'choice', group: g.id, groupName: g.name, alternatives: from.codes.filter((c) => c !== code && index.has(c)), why });
            left -= def.count ? 1 : creditsFor(code, index, program);
          } else {
            add({ code: null, label: `${g.name}`, hint: `One of ${from.codes.join(', ')}`, credits: def.credits, kind: 'placeholder', group: g.id, groupName: g.name, examples: from.codes.filter((c) => index.has(c)) });
            left = 0;
          }
        }
      } else if (g.id === 'cs-electives' || (from.subjects?.length === 1 && from.subjects[0] === 'CS')) {
        // suggest CS electives we can plan: in the catalog, on the forecast, no "permission" rules
        const cands = index.list.filter((c) => c.subject === 'CS' && level(c.code) >= (from.minLevel || 0)
          && !from.exclude?.includes(c.code) && !from.capCodes?.includes(c.code) && !c.bridge && !taken.has(c.code)
          && !(c.prereq && courseLeaves(c.prereq).length === 0) // only a text rule like "Instructor permission"
          && Number(c.credits) >= 3 // skip variable-credit topics and 1-credit seminars
          && (index.forecast?.courses?.[c.code]?.length ?? 0) > 0);
        cands.sort((a, b) => (index.forecast.courses[b.code].length - index.forecast.courses[a.code].length) || Number(a.number) - Number(b.number));
        let n = electiveCount ?? Infinity;
        for (const c of cands) {
          if (left <= 0 || n <= 0) break;
          const credits = creditsFor(c.code, index, program);
          add({ code: c.code, title: c.title, credits, kind: 'elective', group: g.id, groupName: g.name });
          left -= credits; n--;
        }
        while (left > 0) {
          add({ code: null, label: 'CS elective', hint: 'Any CS course at the 300 level or above (not CS 401 or 402)', credits: Math.min(3, left), kind: 'placeholder', group: g.id, groupName: g.name });
          left -= 3;
        }
      } else {
        const per = g.id === 'ipro' ? 3 : Math.min(3, left);
        while (left > 0) {
          const credits = Math.min(per, left);
          add({ code: null, label: g.id === 'ipro' ? 'IPRO' : g.name, hint: def.note || '', credits, kind: 'placeholder', group: g.id, groupName: g.name });
          left -= credits;
        }
      }
    } else if (g.type === 'hss') {
      for (const part of g.parts) {
        const missing = part.need - part.have.length;
        const labels = {
          hum100: 'HUM 100-level course',
          h200: 'Humanities (H) course, 200+',
          s: 'Social science (S) course',
          'hs-extra': 'Humanities, social science, or COM course',
        };
        for (let i = 0; i < missing; i++) {
          add({ code: null, label: labels[part.id] || part.label, hint: part.label, credits: 3, kind: 'placeholder', group: g.id, groupName: g.name });
        }
        if (part.problem && missing <= 0) {
          add({ code: null, label: 'Social science (S) course, 200+ or another field', hint: part.problem, credits: 3, kind: 'placeholder', group: g.id, groupName: g.name });
        }
      }
    } else if (g.type === 'free') {
      let left = g.creditsLeft;
      while (left > 0) {
        const credits = Math.min(3, left);
        add({ code: null, label: 'Free elective', hint: 'Any course', credits, kind: 'placeholder', group: g.id, groupName: g.name });
        left -= credits;
      }
    }
  }
  return items;
}

/** How long the chain of needed courses that depends on each item is (longer = take sooner). */
function chainHeights(items, index) {
  const codes = new Set(items.filter((i) => i.code).map((i) => i.code));
  const children = new Map([...codes].map((c) => [c, []]));
  for (const code of codes) {
    const course = index.get(code);
    for (const leaf of courseLeaves(course?.prereq)) if (codes.has(leaf.code) && leaf.code !== code) children.get(leaf.code).push(code);
  }
  const memo = new Map();
  const h = (code, depth = 0) => {
    if (memo.has(code)) return memo.get(code);
    if (depth > codes.size) return 0;
    const v = 1 + Math.max(0, ...children.get(code).map((c) => h(c, depth + 1)));
    memo.set(code, v);
    return v;
  };
  return new Map([...codes].map((c) => [c, h(c)]));
}

// electives and IPRO: spread over the terms (one or two a term) instead of piling up at the end
const FLEX = new Set(['elective', 'placeholder']);
const isFlex = (it) => FLEX.has(it.kind);
const MAX_TERMS = 12; // stop extending the plan after this many terms

/** The term after `term` (fall and spring only): Spring 2028 -> Fall 2028 -> Spring 2029. */
export function nextTerm(term) {
  const spring = /^S\d/.test(term.key) && !/^SU/.test(term.key);
  const year = Number(term.label.split(' ')[1]);
  return spring ? { key: `F${String(year).slice(2)}`, label: `Fall ${year}` } : { key: `S${String(year + 1).slice(2)}`, label: `Spring ${year + 1}` };
}

/**
 * Is a course offered in a term? Terms on the forecast use it. Later terms (past the forecast)
 * use the last forecast term of the same season.
 */
function offeredAt(forecast, code, term) {
  if (!forecast?.terms?.length || forecast.terms.some((t) => t.key === term.key)) return offeredIn(forecast, code, term.key);
  const season = term.key.replace(/\d+$/, '');
  const same = forecast.terms.filter((t) => t.key.replace(/\d+$/, '') === season).pop();
  return same ? offeredIn(forecast, code, same.key) : null;
}

/**
 * Put pending items into terms. Each item: { code, credits, kind, priority, ... }.
 * The plan grows past the given terms (up to MAX_TERMS) until everything fits, so the last
 * term moves when the credit limit changes.
 */
function placeItems(pending, { index, program, termList, extend, done, grades, maxCredits, locked }) {
  const forecast = index.forecast;
  const finished = new Set(done);
  const plan = [];
  const terms = termList.slice();
  const unplaced = () => pending.filter((p) => !p.placed);
  for (let ti = 0; ti < terms.length; ti++) {
    const term = terms[ti];
    const chosen = [];
    let credits = 0;
    const thisTerm = new Set();
    const lockedHere = new Set(locked[term.key] || []);
    for (const code of lockedHere) {
      if (thisTerm.has(code) || finished.has(code)) continue;
      const it = { code, title: titleFor(code, index, program), credits: creditsFor(code, index, program), kind: 'saved', placed: term.key };
      const course = index.get(code);
      if (course && evaluate(course.prereq, { completed: finished, current: lockedHere, grades, textRules: 'plan' }) !== 'met') {
        it.warning = 'Prerequisites are not finished before this term.';
      }
      chosen.push(it);
      credits += it.credits;
      thisTerm.add(code);
      for (const p of pending) if (p.code === code) p.placed = term.key;
    }
    const ready = (it) => {
      if (it.placed) return false;
      if (!it.code) return true;
      const offered = offeredAt(forecast, it.code, term);
      if (offered === false) return false;
      if (offered === null && (subject(it.code) === 'CS' || subject(it.code) === 'CSP') && forecast) return false;
      const course = index.get(it.code);
      if (!course) return true; // e.g. PHYS 123: no prerequisite data in this app
      return evaluate(course.prereq, { completed: finished, current: thisTerm, grades, textRules: 'plan' }) === 'met';
    };
    // how many electives / IPRO this term: an even share of what is left (at least one when any is left)
    const left = unplaced();
    const flexLeft = left.filter(isFlex).length;
    const creditsLeft = left.reduce((n, p) => n + p.credits, 0);
    const termsLeft = Math.max(1, Math.ceil(creditsLeft / Math.max(1, maxCredits)));
    const quota = flexLeft ? Math.max(1, Math.ceil(flexLeft / termsLeft)) : 0;
    const flexIn = () => chosen.filter(isFlex).length;
    const place = (it) => {
      it.placed = term.key;
      chosen.push(it);
      credits += it.credits;
      if (it.code) thisTerm.add(it.code);
    };
    // pass 1: required courses up to the room left after this term's electives; electives up to the quota
    // pass 2: fill what is still free with anything that is ready
    for (const pass of [1, 2]) {
      let placedSomething = true;
      while (placedSomething) {
        placedSomething = false;
        // mix the kinds of electives in a term: one CS elective, one IPRO, one Core course, not three of a kind
        const same = (it) => (isFlex(it) ? chosen.filter((c) => isFlex(c) && c.group === it.group).length * 40 : 0);
        const list = pending.filter(ready).sort((a, b) => (b.priority - same(b)) - (a.priority - same(a)) || (a.code || '~').localeCompare(b.code || '~'));
        for (const it of list) {
          if (credits + it.credits > maxCredits) continue;
          if (pass === 1) {
            if (isFlex(it) && flexIn() >= quota) continue;
            const room = maxCredits - 3 * Math.max(0, quota - flexIn());
            if (!isFlex(it) && credits + it.credits > room) continue;
          }
          place(it);
          placedSomething = true;
          break; // re-check readiness (same-term corequisites)
        }
      }
    }
    for (const code of thisTerm) finished.add(code);
    plan.push({ key: term.key, label: term.label, items: chosen, credits });
    // more terms while something is left that can still be placed
    if (ti === terms.length - 1 && extend && unplaced().length && terms.length < MAX_TERMS && chosen.length) terms.push(nextTerm(term));
  }
  // empty terms at the end (finished early) are dropped
  while (plan.length && !plan[plan.length - 1].items.length) plan.pop();
  return { plan, finished };
}

/** Why a course could not be placed. */
function laterReason(it, index, finished, grades) {
  const forecast = index.forecast;
  let reason = 'No room in the plan; raise the credit limit.';
  if (it.code) {
    const offeredAny = forecast?.courses?.[it.code];
    if (offeredAny && offeredAny.length === 0) reason = 'Not on the department forecast for these terms.';
    else if (!offeredAny && (subject(it.code) === 'CS' || subject(it.code) === 'CSP')) reason = 'Not on the department forecast.';
    else {
      const course = index.get(it.code);
      if (course && evaluate(course.prereq, { completed: finished, grades, textRules: 'plan' }) !== 'met') reason = 'Prerequisites are not done by the last planned term.';
    }
  }
  return reason;
}

/**
 * Build a plan.
 *   audit, program, index: from auditDegree / data files
 *   done:   Set of codes finished before the first planned term (completed + in progress + saved)
 *   grades: Map code -> grade (for minimum-grade rules)
 *   maxCredits: per term (default 15)
 *   terms:  terms to use (default: the forecast terms, then more terms until everything fits)
 *   locked: { termKey: [codes] } courses already chosen for a term (the saved sections for the
 *           schedule term). They go in that term first and count toward its credits.
 * Returns { terms: [{ key, label, items, credits }], later: [items with reasons], items }.
 */
export function planSemesters(audit, program, index, { done = new Set(), grades = new Map(), maxCredits = 15, terms, locked = {} } = {}) {
  const termList = terms || index.forecast?.terms || [];
  const items = neededItems(audit, program, index, { exclude: done });
  const heights = chainHeights(items, index);
  const priority = (it) => {
    const base = { required: 100, choice: 70, elective: 50, placeholder: 30 }[it.kind] || 0;
    const height = it.code ? (heights.get(it.code) || 1) : 0;
    // spread placeholders: IPRO and Core Curriculum courses a bit ahead of free electives
    const ph = it.kind === 'placeholder' ? ({ ipro: 6, hss: 5, 'science-elective': 4, 'comm-elective': 4, 'cs-electives': 3, free: 0 }[it.group] || 2) : 0;
    return base + height * 12 + ph;
  };
  const pending = items.map((it, i) => ({ ...it, id: i, priority: priority(it) }));
  const { plan, finished } = placeItems(pending, { index, program, termList, extend: !terms, done, grades, maxCredits, locked });
  const later = pending.filter((it) => !it.placed).map((it) => ({ ...it, reason: laterReason(it, index, finished, grades) }));
  addReasons(plan, pending, index);
  return { terms: plan, later, items: pending };
}

/**
 * Re-spread an existing plan (the advisor's) over terms for a new credit limit, keeping its courses
 * and their order. Saved sections stay in their term. Returns a plan view (describePlan shape).
 */
export function repackPlan(view, { index, program, done = new Set(), grades = new Map(), maxCredits = 15, locked = {} }) {
  const flat = [...(view.terms || []).flatMap((t) => t.items), ...(view.later || [])].filter((it) => it.kind !== 'saved');
  const pending = flat.map((it, i) => ({ ...it, credits: Number(it.credits) || 3, priority: 1000 - i, placed: undefined }));
  const termList = index.forecast?.terms?.length ? index.forecast.terms : (view.terms || []).map((t) => ({ key: t.key, label: t.label }));
  const { plan, finished } = placeItems(pending, { index, program, termList, extend: true, done, grades, maxCredits, locked });
  const strip = ({ placed, priority, id, ...rest }) => rest;
  const terms = plan.map((t) => ({ key: t.key, label: t.label, credits: t.credits, items: t.items.map((it) => (it.kind === 'saved' ? { code: it.code, label: '', title: it.title || '', credits: it.credits, kind: 'saved', requirement: 'Saved section', reason: '', warning: it.warning || '', options: [] } : strip(it))) }));
  const later = pending.filter((it) => !it.placed).map((it) => ({ ...strip(it), reason: laterReason(it, index, finished, grades) }));
  const used = terms.filter((t) => t.items.length);
  return { ...view, terms, later, graduation: !later.length && used.length ? used[used.length - 1].label : '' };
}

/** Short "why" text for each placed course, in plain words. */
function addReasons(plan, pending, index) {
  const forecast = index.forecast;
  const needs = new Map(); // code -> later needed courses that list it as a prerequisite
  for (const it of pending) {
    if (!it.code) continue;
    for (const leaf of courseLeaves(index.get(it.code)?.prereq)) {
      if (!needs.has(leaf.code)) needs.set(leaf.code, []);
      if (!needs.get(leaf.code).includes(it.code)) needs.get(leaf.code).push(it.code);
    }
  }
  const rare = (code) => {
    const keys = forecast?.courses?.[code];
    if (!keys || keys.length > 2 || !keys.length) return '';
    const labels = keys.map((k) => forecast.terms.find((t) => t.key === k)?.label || k);
    return keys.length === 1 ? `Only offered ${labels[0]} in the forecast.` : `Only offered ${labels.join(' and ')} in the forecast.`;
  };
  for (const term of plan) {
    for (const it of term.items) {
      const opens = it.code ? (needs.get(it.code) || []).filter((c) => c !== it.code) : [];
      const parts = [];
      if (it.kind === 'saved') parts.push('You saved a section for this term.');
      else if (it.kind === 'required') parts.push(`Required for ${it.groupName}.`);
      else if (it.kind === 'choice') parts.push(`Fills the ${it.groupName}.${it.why ? ` ${it.why}.` : ''}`);
      else if (it.kind === 'elective') parts.push('Suggested CS elective. Swap in any CS 300+ course you like.');
      else if (it.hint) parts.push(it.hint);
      if (opens.length) parts.push(`Needed before ${opens.join(', ')}.`);
      if (it.code) { const r = rare(it.code); if (r) parts.push(r); }
      it.reason = parts.join(' ');
      it.requirement = it.groupName || (it.kind === 'saved' ? 'Saved section' : '');
    }
  }
}

/** Plain summary of a rule-based plan, in the same shape the advisor's plan uses. */
export function describePlan(plan, audit, { maxCredits = 15 } = {}) {
  const used = plan.terms.filter((t) => t.items.length);
  const last = used[used.length - 1];
  const graduation = !plan.later.length && last ? last.label : '';
  const left = audit.totals.remaining + audit.totals.planned;
  let summary;
  if (!used.length && !plan.later.length) summary = 'Everything is done or in progress.';
  else if (graduation) summary = `You have about ${left} credits left. At up to ${maxCredits} credits a term, this plan finishes in ${graduation}.`;
  else summary = `You have about ${left} credits left. Some courses do not fit in the forecast terms (see "Not placed yet").`;
  return {
    source: 'rules',
    summary,
    graduation,
    tips: [],
    assumptions: ['Electives are examples. Swap in courses you like that fill the same requirement.', 'Non-CS courses are assumed to run every term.'],
    terms: plan.terms.map((t) => ({ key: t.key, label: t.label, credits: t.credits, items: t.items.map((it) => ({
      code: it.code || null, label: it.label || '', title: it.title || '', credits: it.credits, kind: it.kind,
      requirement: it.requirement || '', reason: it.reason || '', warning: it.warning || '',
      options: it.alternatives || it.examples || [],
    })) })),
    later: plan.later.map((it) => ({ code: it.code || null, label: it.label || '', title: it.title || '', credits: it.credits, kind: it.kind, requirement: it.groupName || '', reason: it.reason })),
  };
}

/** The forecast term that matches the app's schedule semester (for example "S27" for "Spring 2027"), or ''. */
export function scheduleTermKey(index) {
  return index.forecast?.terms?.find((t) => t.label === index.semester)?.key || '';
}

/**
 * done / locked options for planSemesters from what the student has.
 * Saved sections belong to the schedule term when that term is in the plan; otherwise they count as done.
 */
export function planInputs(index, { completed, inProgress, saved }) {
  const key = scheduleTermKey(index);
  const savedList = [...saved].filter((c) => !completed.has(c) && !inProgress.has(c));
  if (key) return { done: new Set([...completed, ...inProgress]), locked: { [key]: savedList } };
  return { done: new Set([...completed, ...inProgress, ...savedList]), locked: {} };
}
