// Checks a semester plan (from the advisor LLM or edited by hand) against the app's rules:
// prerequisites, the department forecast, credit limits, repeats, and degree coverage.
// No DOM code here; the server and tests use it too.

import { evaluate, missingParts, normalizeCode } from './prereq.js';
import { offeredIn } from './forecast.js';
import { auditDegree, creditsFor, titleFor } from './audit.js';
import { REPEATABLE } from './transcript.js';

const subject = (code) => code.split(' ')[0];

/** Which requirement group a free-text requirement name points to. */
export function groupForRequirement(text, program) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  const exact = program.groups.find((g) => g.name.toLowerCase() === t || g.id === t);
  if (exact) return exact.id;
  if (/humanit|social|\(h\)|\(s\)|hss|core curriculum/.test(t)) return 'hss';
  if (/ipro|interprofessional/.test(t)) return 'ipro';
  if (/communication|\bcom\b/.test(t)) return 'comm-elective';
  if (/science elective|natural science|\(n\)/.test(t)) return 'science-elective';
  if (/math/.test(t) && /elective/.test(t)) return 'math-elective';
  if (/(cs|computer science) elective/.test(t)) return 'cs-electives';
  if (/free/.test(t)) return 'free';
  const partial = program.groups.find((g) => t.includes(g.name.toLowerCase()) || g.name.toLowerCase().includes(t));
  return partial ? partial.id : null;
}

/**
 * Turn raw plan JSON (from Claude) into clean terms the app can show and check.
 * Only terms on the forecast are kept, in forecast order.
 */
export function normalizePlan(raw, { index, program, audit, saved = [] }) {
  const terms = index.forecast?.terms || [];
  const byLabel = new Map(terms.map((t) => [t.label.toLowerCase(), t]));
  const byKey = new Map(terms.map((t) => [t.key.toLowerCase(), t]));
  const requiredLeft = new Set();
  for (const g of audit.groups) for (const slot of g.slots || []) for (const c of slot.missing || []) requiredLeft.add(c);
  const savedSet = new Set(saved);
  const out = [];
  const dropped = [];
  for (const rt of Array.isArray(raw?.terms) ? raw.terms.slice(0, 12) : []) {
    const name = String(rt?.term || rt?.label || '').trim().toLowerCase();
    const term = byLabel.get(name) || byKey.get(name);
    if (!term) { if (name) dropped.push(rt.term || rt.label); continue; }
    const items = [];
    for (const ri of Array.isArray(rt.courses) ? rt.courses.slice(0, 10) : []) {
      if (!ri || typeof ri !== 'object') continue;
      const code = normalizeCode(ri.code) || null;
      const requirement = String(ri.requirement || '').slice(0, 80);
      let credits = Number(ri.credits);
      if (!Number.isFinite(credits) || credits <= 0 || credits > 12) credits = code ? creditsFor(code, index, program) : 3;
      let kind = 'choice';
      if (!code) kind = 'placeholder';
      else if (savedSet.has(code)) kind = 'saved';
      else if (requiredLeft.has(code)) kind = 'required';
      else if (subject(code) === 'CS' && /elective/i.test(requirement)) kind = 'elective';
      items.push({
        code,
        label: code ? '' : String(ri.label || ri.title || requirement || 'Elective').slice(0, 80),
        title: code ? (titleFor(code, index, program) || String(ri.title || '').slice(0, 100)) : '',
        credits,
        kind,
        requirement,
        reason: String(ri.reason || '').slice(0, 240),
        options: !code && Array.isArray(ri.options) ? ri.options.map((o) => normalizeCode(o)).filter((o) => o && index?.has?.(o)).slice(0, 20) : [],
      });
    }
    const existing = out.find((t) => t.key === term.key);
    if (existing) existing.items.push(...items);
    else out.push({ key: term.key, label: term.label, items });
  }
  out.sort((a, b) => terms.findIndex((t) => t.key === a.key) - terms.findIndex((t) => t.key === b.key));
  for (const t of out) t.credits = t.items.reduce((s, i) => s + i.credits, 0);
  return { terms: out, droppedTerms: dropped };
}

/**
 * Check a plan. `plan.terms` items: { code, credits, requirement }.
 *   done:   Set of courses finished (or in progress) before the first plan term
 *   records: transcript records (for the coverage audit)
 * Returns { issues: [{ term, code, level, message }], ok } and adds item.issues to each item.
 */
export function checkPlan(plan, { index, program, records = [], done = new Set(), grades = new Map(), maxCredits = 15, waivers = [] }) {
  const issues = [];
  const forecast = index.forecast;
  const finished = new Set(done);
  const seen = new Set();
  const add = (term, item, level, message) => {
    issues.push({ term: term.label, code: item?.code || null, level, message });
    if (item) (item.issues = item.issues || []).push({ level, message });
  };

  for (const term of plan.terms) {
    const thisTerm = new Set(term.items.filter((i) => i.code).map((i) => i.code));
    for (const item of term.items) {
      item.issues = [];
      if (!item.code) continue;
      const code = item.code;
      if (done.has(code) && !REPEATABLE.has(code)) add(term, item, 'error', `${code} is already done or in progress.`);
      if (seen.has(code) && !REPEATABLE.has(code)) add(term, item, 'error', `${code} is in the plan twice.`);
      seen.add(code);
      const offered = offeredIn(forecast, code, term.key);
      if (offered === false) {
        const when = forecast.courses[code].map((k) => forecast.terms.find((t) => t.key === k)?.label || k);
        add(term, item, 'error', `Not on the forecast for ${term.label}${when.length ? ` (planned for ${when.join(', ')})` : ' or any planned term'}.`);
      } else if (offered === null && ['CS', 'CSP'].includes(subject(code)) && forecast) {
        add(term, item, 'warn', 'Not on the department forecast. Check that it runs this term.');
      }
      const course = index.get(code);
      if (course) {
        const state = { completed: finished, current: thisTerm, grades, textRules: 'plan' };
        if (evaluate(course.prereq, state) !== 'met') {
          add(term, item, 'error', `Prerequisite not done first: ${missingParts(course.prereq, state).join('; ')}.`);
        }
      } else if (!program.titles?.[code] && !forecast?.courses?.[code]) {
        add(term, item, 'warn', 'Not in this app’s catalog, so its prerequisites were not checked.');
      }
    }
    if (term.credits > maxCredits) add(term, null, 'warn', `${term.label} has ${term.credits} credits, over your limit of ${maxCredits}.`);
    for (const c of thisTerm) finished.add(c);
  }

  // coverage: what is still missing after this plan?
  const planned = plan.terms.flatMap((t) => t.items.filter((i) => i.code).map((i) => i.code));
  const after = auditDegree(program, records, { index, planned, waivers });
  const placeholderCredits = new Map();
  for (const t of plan.terms) {
    for (const i of t.items) {
      if (i.code) continue;
      const g = groupForRequirement(i.requirement || i.label, program) || 'free';
      placeholderCredits.set(g, (placeholderCredits.get(g) || 0) + i.credits);
    }
  }
  const gaps = [];
  for (const g of after.groups) {
    if (g.status !== 'remaining') continue;
    if (g.type === 'all') {
      gaps.push(`${g.name}: ${g.remaining.join('; ')}`);
      continue;
    }
    const need = g.type === 'hss'
      ? g.parts.reduce((s, p) => s + Math.max(0, p.need - p.have.length) * 3, 0) || 3
      : g.creditsLeft || 3;
    const have = placeholderCredits.get(g.id) || 0;
    if (have < need) gaps.push(`${g.name}: about ${need - have} more credit${need - have === 1 ? '' : 's'}`);
  }
  for (const gap of gaps) issues.push({ term: null, code: null, level: 'warn', message: `Not covered by the plan: ${gap}.` });

  return { issues, ok: !issues.some((i) => i.level === 'error'), gaps };
}
