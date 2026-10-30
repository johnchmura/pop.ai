// Degree audit: matches a student's courses to a program's requirement groups.
// Each course counts once. Groups are filled in program order, so required courses
// are used first and leftover credit falls through to electives and free electives.
// No DOM code here; the server and tests use it too.

import { bestAttempts, REPEATABLE } from './transcript.js';

const STATUS_RANK = { completed: 3, 'in-progress': 2, planned: 1 };
const level = (code) => Number(code.split(' ')[1][0]) * 100;
const subject = (code) => code.split(' ')[0];

/** Credits for a course: transcript value, then catalog, then program, then 3. */
export function creditsFor(code, index, program, fromRecord) {
  if (fromRecord != null && Number.isFinite(fromRecord) && fromRecord > 0) return fromRecord;
  const c = index?.get(code);
  const n = Number(c?.credits);
  if (Number.isFinite(n) && n > 0) return n;
  if (program?.credits?.[code]) return program.credits[code];
  return 3;
}

export function titleFor(code, index, program) {
  return index?.get(code)?.title || program?.titles?.[code] || '';
}

/**
 * Build the pool of countable courses.
 *   records:  transcript records (any number of attempts)
 *   planned:  course codes the student has saved for the current term (counted as "planned")
 */
export function buildPool(records, { index, program, planned = [] } = {}) {
  const pool = [];
  for (const rec of bestAttempts(records || [])) {
    if (rec.status !== 'completed' && rec.status !== 'in-progress') continue;
    const credits = creditsFor(rec.code, index, program, rec.credits);
    if (rec.status === 'completed' && rec.credits === 0) continue;
    pool.push({ code: rec.code, credits, status: rec.status, grade: rec.grade || '', used: null, transfer: !!rec.transfer, appliesTo: rec.appliesTo || '' });
  }
  for (const code of planned) {
    if (pool.some((p) => p.code === code && p.status !== 'completed') || (pool.some((p) => p.code === code) && !REPEATABLE.has(code))) continue;
    pool.push({ code, credits: creditsFor(code, index, program), status: 'planned', grade: '', used: null });
  }
  return pool;
}

function byStatus(a, b) {
  return (STATUS_RANK[b.status] - STATUS_RANK[a.status]) || (b.credits - a.credits) || a.code.localeCompare(b.code);
}

function sumBy(items, status) {
  return items.filter((i) => i.status === status).reduce((s, i) => s + i.credits, 0);
}

function groupStatus(required, done, ip, planned) {
  if (done >= required) return 'done';
  if (done + ip >= required) return 'in-progress';
  if (done + ip + planned >= required) return 'planned';
  return 'remaining';
}

function matches(code, from) {
  if (from.alsoCodes?.includes(code)) return true;
  if (from.exclude?.includes(code)) return false;
  if (from.codes) return from.codes.includes(code);
  if (from.subjects && !from.subjects.includes(subject(code))) return false;
  if (from.minLevel && level(code) < from.minLevel) return false;
  return true;
}


// ----- adviser exceptions ("Apply PHIL 381 here") -----
const LABEL_STOP = new Set(['elective', 'electives', 'course', 'courses', 'requirement', 'requirements', 'and', 'the', 'of', 'for', 'or', 'i', 'ii', 'a', 'an', 'in']);
const labelWords = (text) => String(text || '').toLowerCase().replace(/artificial intelligence/g, 'ai').replace(/[^a-z0-9 ]+/g, ' ')
  .split(/\s+/).filter((w) => w && !LABEL_STOP.has(w));

/** The group a Degree Works requirement label points to (or null). */
export function groupForLabel(label, program) {
  const want = new Set(labelWords(label));
  if (!want.size) return null;
  let best = null;
  let tie = false;
  for (const g of program.groups) {
    const words = new Set(labelWords(g.name));
    const score = [...want].filter((w) => words.has(w)).length / Math.max(1, want.size, words.size);
    if (score <= 0) continue;
    if (!best || score > best.score) { best = { g, score }; tie = false; } else if (score === best.score) tie = true;
  }
  return best && !tie && best.score >= 0.5 ? best.g : null;
}

// ---------- group handlers ----------

function auditAll(group, pool) {
  const used = [];
  const slots = group.slots.map((options) => {
    // pick the option with the most courses on hand (ties: best status, then first listed)
    let best = null;
    options.forEach((option, oi) => {
      const found = option.map((code) => pool.filter((p) => !p.used && p.code === code).sort(byStatus)[0] || null);
      const have = found.filter(Boolean);
      const score = (have.length === option.length ? 1000 : 0) + have.length * 10
        + have.reduce((s, p) => s + STATUS_RANK[p.status], 0) - oi * 0.01;
      if (!best || score > best.score) best = { option, found, score, oi };
    });
    const have = best.found.filter(Boolean);
    if (have.length === 0) best = { option: options[0], found: options[0].map(() => null), oi: 0 };
    best.found.forEach((p) => { if (p) { p.used = group.id; used.push(p); } });
    const missing = best.option.filter((_, i) => !best.found[i]);
    const statuses = best.found.filter(Boolean).map((p) => p.status);
    let status = 'remaining';
    if (!missing.length) status = statuses.includes('planned') ? 'planned' : statuses.includes('in-progress') ? 'in-progress' : 'done';
    return { options, chosen: best.option, missing, status };
  });
  return { used, slots };
}

function auditPick(group, pool) {
  const from = group.from || {};
  const cands = pool.filter((p) => !p.used && matches(p.code, from)).sort(byStatus);
  const used = [];
  let total = 0;
  let capped = 0;
  for (const p of cands) {
    if (group.count ? used.length >= group.count : total >= group.credits) break;
    if (from.capCodes?.includes(p.code)) {
      if (capped + p.credits > (from.capCredits ?? Infinity)) continue;
      capped += p.credits;
    }
    p.used = group.id;
    used.push(p);
    total += p.credits;
  }
  return { used };
}

function choose3Social(cands) {
  // best 3 social science courses: valid (2+ at 200+, 2+ fields) first, then best status
  let best = { items: cands.slice(0, 3), score: -1 };
  const n = Math.min(cands.length, 14);
  const pick = (start, chosen) => {
    if (chosen.length === 3 || (chosen.length && chosen.length === n)) {
      const upper = chosen.filter((p) => level(p.code) >= 200).length;
      const fields = new Set(chosen.map((p) => subject(p.code))).size;
      const valid = chosen.length === 3 && upper >= 2 && fields >= 2;
      const score = (valid ? 1000 : 0) + Math.min(upper, 2) * 50 + Math.min(fields, 2) * 50 + chosen.reduce((s, p) => s + STATUS_RANK[p.status], 0) + chosen.length * 100;
      if (score > best.score) best = { items: [...chosen], score };
      if (chosen.length === 3) return;
    }
    for (let i = start; i < n; i++) pick(i + 1, [...chosen, cands[i]]);
  };
  if (cands.length) pick(0, []);
  else best.items = [];
  return best.items;
}

function auditHss(group, pool) {
  const H = new Set(group.hSubjects);
  const S = new Set(group.sSubjects);
  const free = () => pool.filter((p) => !p.used);
  const take = (list) => { list.forEach((p) => { p.used = group.id; }); return list; };
  const parts = [];

  // a transfer HUM elective (for example HUM 200) fills the 100-level slot when there is no HUM 1xx course
  let hum100 = free().filter((p) => subject(p.code) === 'HUM' && level(p.code) === 100).sort(byStatus).slice(0, 1);
  if (!hum100.length) hum100 = free().filter((p) => subject(p.code) === 'HUM' && (p.transfer || p.grade === 'TR')).sort(byStatus).slice(0, 1);
  take(hum100);
  parts.push({ id: 'hum100', label: 'One HUM 100-level course', need: 1, have: hum100 });

  const h200 = take(free().filter((p) => H.has(subject(p.code)) && level(p.code) >= 200).sort(byStatus).slice(0, 2));
  parts.push({ id: 'h200', label: 'Two (H) humanities courses at the 200 level or above', need: 2, have: h200 });

  const social = take(choose3Social(free().filter((p) => S.has(subject(p.code))).sort(byStatus)));
  const upper = social.filter((p) => level(p.code) >= 200).length;
  const fields = new Set(social.map((p) => subject(p.code))).size;
  const sValid = social.length === 3 && upper >= 2 && fields >= 2;
  parts.push({
    id: 's', label: 'Three (S) social science courses: two at 200+, from two or more fields', need: 3, have: social,
    problem: social.length === 3 && !sValid ? (upper < 2 ? 'Needs two at the 200 level or above.' : 'Needs courses from two or more fields.') : '',
  });

  const extra = take(free().filter((p) => H.has(subject(p.code)) || S.has(subject(p.code))
    || (subject(p.code) === 'COM' && p.code !== 'COM 101' && p.code !== 'COM 111')).sort(byStatus).slice(0, 1));
  parts.push({ id: 'hs-extra', label: 'One more (H), (S), or COM course (not COM 101 or COM 111)', need: 1, have: extra });

  return { used: [...hum100, ...h200, ...social, ...extra], parts };
}

function auditFree(group, pool) {
  const cands = pool.filter((p) => !p.used).sort(byStatus);
  const used = [];
  let total = 0;
  for (const p of cands) {
    if (total >= group.credits) break;
    p.used = group.id;
    used.push(p);
    total += p.credits;
  }
  return { used };
}

/** Text for what is still needed in a group. */
function remainingText(group, result, creditsLeft, index) {
  // only list courses the app has a page for; if none are known, list them all
  const known = (code) => !index || index.has(code);
  if (group.type === 'all') {
    return result.slots.filter((s) => s.status === 'remaining').map((s) => {
      if (s.options.length > 1 && s.missing.length === s.chosen.length) {
        const shown = s.options.filter((o) => o.every(known));
        return (shown.length ? shown : s.options).map((o) => o.join(' and ')).join(', or ');
      }
      return s.missing.join(' and ');
    });
  }
  if (group.type === 'hss') {
    return result.parts.filter((p) => p.have.length < p.need || p.problem).map((p) => (p.problem
      ? `${p.label} — ${p.problem}`
      : `${p.label}${p.need > 1 ? ` (${p.need - p.have.length} more)` : ''}`));
  }
  if (creditsLeft <= 0 && (!group.count || result.used.length >= group.count)) return [];
  if (group.type === 'free') return [`${creditsLeft} more credit${creditsLeft === 1 ? '' : 's'} of any course`];
  const from = group.from || {};
  if (group.count) return [`${group.count - result.used.length} course from: ${(from.codes.some(known) ? from.codes.filter(known) : from.codes).join(', ')}`];
  const listed = from.codes ? (from.codes.some(known) ? from.codes.filter(known) : from.codes) : null;
  // an open elective group (no course list and no subjects): the catalog note says what counts
  if (!listed && !from.subjects?.length) return [`${creditsLeft} more credit${creditsLeft === 1 ? '' : 's'}${group.note ? `: ${group.note}` : ''}`];
  const where = listed ? listed.join(', ') : `${from.subjects.join(', ')}${from.minLevel ? ` at the ${from.minLevel} level or above` : ''}`;
  return [`${creditsLeft} more credit${creditsLeft === 1 ? '' : 's'} from ${where}`];
}

/** A minor group the catalog leaves open ("Fifteen credits in an area outside computer science"). */
const isOpenMinor = (g) => g.type === 'pick' && /minor/i.test(g.name) && !g.from?.codes?.length && !g.from?.subjects?.length;

/**
 * The minor's subject, found from the courses: the subject with the most courses outside the
 * major's own requirements (three ECON courses -> an ECON minor). Needs at least two courses.
 */
export function detectMinorSubject(program, pool) {
  const major = new Set();
  for (const g of program.groups) {
    for (const slot of g.slots || []) for (const option of slot) for (const c of option) major.add(subject(c));
    for (const c of g.from?.codes || []) major.add(subject(c));
    for (const sub of g.from?.subjects || []) major.add(sub);
  }
  const counts = new Map();
  for (const p of pool) {
    const sub = subject(p.code);
    if (major.has(sub) || sub === 'IPRO') continue;
    const c = counts.get(sub) || { n: 0, credits: 0 };
    counts.set(sub, { n: c.n + 1, credits: c.credits + p.credits });
  }
  // most courses first; on a tie, the subject outside the Core Curriculum humanities (a real minor, not core courses)
  const core = new Set(['HUM', 'COM']);
  const best = [...counts].sort((a, b) => b[1].n - a[1].n || (core.has(a[0]) - core.has(b[0])) || b[1].credits - a[1].credits)[0];
  return best && best[1].n >= 2 ? best[0] : '';
}

/**
 * Run the audit.
 * Returns { program, groups: [...], totals, extra (courses that did not fit), notCounted }.
 */
export function auditDegree(program, records, { index, planned = [], waivers = [] } = {}) {
  // requirements the student marked as met (adviser waiver or substitution)
  const waived = new Map();
  for (const w of waivers) {
    const g = program.groups.find((x) => x.name.toLowerCase() === String(w.group || '').toLowerCase()) || groupForLabel(w.group, program);
    if (g) waived.set(g.id, w.reason || 'Marked as met');
  }
  const pool = buildPool(records, { index, program, planned });
  // a course the adviser applied to a requirement counts there, even if the catalog list does not name it
  const forcedBy = new Map();
  for (const p of pool) {
    if (!p.appliesTo) continue;
    const g = groupForLabel(p.appliesTo, program) || (/^minor requirement$/i.test(p.appliesTo) ? program.groups.find((x) => /minor/i.test(x.name)) : null);
    if (g) { p.force = g.id; (forcedBy.get(g.id) || forcedBy.set(g.id, []).get(g.id)).push(p.code); }
  }
  // One rule for every program: a minor may share ONE course with another requirement (for example
  // an ECON course that is also a social science course for an Economics minor). The credits of that
  // shared course still have to be earned, so a free elective of the same size is added.
  // Order: major and Core Curriculum groups first, then the minor, then free electives.
  const late = (g) => (isOpenMinor(g) && !(forcedBy.get(g.id) || []).length ? 1 : g.type === 'free' ? 2 : 0);
  const order = program.groups.map((g, i) => ({ g, i })).sort((a, b) => late(a.g) - late(b.g) || a.i - b.i);
  let sharedCredits = 0; // credits of the course the minor shares, made up with a free elective
  let sharedCode = '';
  const results = new Map();
  for (const { g: group0 } of order) {
    if (group0.type === 'free' && sharedCredits && !program.groups.some((x) => x !== group0 && x.type === 'free' && results.has(x.id))) {
      results.set(group0.id, evalGroup({ ...group0, credits: group0.credits + sharedCredits, note: `${group0.note ? `${group0.note} ` : ''}Includes ${sharedCredits} credits for ${sharedCode}, which also counts toward the minor.` }));
    } else {
      results.set(group0.id, evalGroup(group0));
    }
  }
  const groups = program.groups.map((g) => results.get(g.id));
  // no free elective group in this program: add one for the shared course's credits
  if (sharedCredits && !program.groups.some((g) => g.type === 'free')) {
    groups.push(evalGroup({ id: 'free-shared', name: 'Free Elective', type: 'free', credits: sharedCredits, note: `Makes up the credits of ${sharedCode}, which also counts toward the minor.` }));
  }

  function evalGroup(group0) {
    let result;
    const forced = forcedBy.get(group0.id) || [];
    let group = group0;
    if (forced.length) {
      if (group0.type === 'all') group = { ...group0, slots: group0.slots.map((o) => (o.length > 1 ? [...o, ...forced.map((c) => [c])] : o)) };
      else if (group0.type === 'pick') group = { ...group0, from: { ...(group0.from || {}), alsoCodes: forced } };
    }
    // courses that were applied to another group are not available here
    const view = pool.filter((p) => !p.force || p.force === group.id);
    let minorSubject = '';
    let double = null;
    if (isOpenMinor(group) && !forced.length) {
      minorSubject = detectMinorSubject(program, pool);
      if (minorSubject) {
        // the minor's subject courses no other requirement uses, then at most ONE shared course
        const used = [];
        let total = 0;
        const mine = pool.filter((x) => subject(x.code) === minorSubject).sort(byStatus);
        for (const p of mine.filter((x) => !x.used)) {
          if (total >= group.credits) break;
          p.used = group.id;
          used.push(p);
          total += p.credits;
        }
        const share = total < group.credits ? mine.find((x) => x.used && x.used !== group.id) : null;
        double = { completed: 0, 'in-progress': 0, planned: 0 };
        if (share) {
          used.push(share);
          total += share.credits;
          double[share.status] += share.credits;
          sharedCredits = share.credits;
          sharedCode = share.code;
        }
        result = { used };
      }
    }
    if (result) { /* the minor, above */ }
    else if (group.type === 'all') result = auditAll(group, view);
    else if (group.type === 'pick') result = auditPick(group, view);
    else if (group.type === 'hss') result = auditHss(group, view);
    else result = auditFree(group, view);

    let done = sumBy(result.used, 'completed');
    let ip = sumBy(result.used, 'in-progress');
    let pl = sumBy(result.used, 'planned');
    let status = groupStatus(group.credits, done, ip, pl);
    // "all" and "hss" groups are about specific courses, not only credits
    if (group.type === 'all') {
      const st = result.slots.map((s) => s.status);
      status = st.includes('remaining') ? 'remaining' : st.includes('planned') ? 'planned' : st.includes('in-progress') ? 'in-progress' : 'done';
    }
    if (group.type === 'hss') {
      const complete = result.parts.every((p) => p.have.length >= p.need && !p.problem);
      if (!complete) status = 'remaining';
    }
    if (group.count) {
      const n = result.used.length;
      if (n < group.count) status = 'remaining';
    }
    // a requirement met by its courses is met, even when a course is worth fewer credits than the
    // catalog lists (a 3-credit AP or transfer course for a 4-credit PHYS 123): no extra credits
    let creditGap = 0;
    const byCourses = group.type === 'all' || group.type === 'hss' || !!group.count;
    if (byCourses && status !== 'remaining' && done + ip + pl < group.credits) {
      creditGap = group.credits - done - ip - pl;
      if (status === 'done') done += creditGap; else if (status === 'in-progress') ip += creditGap; else pl += creditGap;
    }
    const creditsLeft = Math.max(0, group.credits - done - ip - pl);
    if (waived.has(group.id)) {
      return {
        id: group.id, name: group.name, type: group.type, note: group.note || '', credits: group.credits,
        done: group.credits, inProgress: 0, planned: 0, status: 'done', creditsLeft: 0,
        courses: result.used.map((p) => ({ code: p.code, credits: p.credits, status: p.status, grade: p.grade, title: titleFor(p.code, index, program) })),
        remaining: [], waived: waived.get(group.id), slots: result.slots || null, parts: null,
      };
    }
    return {
      id: group.id,
      name: group.name,
      type: group.type,
      note: group.note || '',
      credits: group.credits,
      done, inProgress: ip, planned: pl,
      status,
      creditsLeft,
      courses: result.used.map((p) => ({ code: p.code, credits: p.credits, status: p.status, grade: p.grade, title: titleFor(p.code, index, program) })),
      remaining: status === 'done' || status === 'in-progress' || status === 'planned' ? [] : remainingText(group, result, creditsLeft, index),
      slots: result.slots || null,
      parts: result.parts ? result.parts.map((p) => ({ id: p.id, label: p.label, need: p.need, have: p.have.map((h) => h.code), problem: p.problem || '' })) : null,
      minorSubject,
      double,
      creditGap,
      sharedCode: minorSubject && double && (double.completed || double['in-progress'] || double.planned) ? sharedCode : '',
    };
  }

  const applied = (status) => groups.reduce((s, g) => {
    const capped = Math.min(g.credits, g.done + (status !== 'completed' ? g.inProgress : 0) + (status === 'planned' ? g.planned : 0));
    // a course counted in two groups (the minor) adds its credits once
    const d = g.double ? g.double.completed + (status !== 'completed' ? g.double['in-progress'] : 0) + (status === 'planned' ? g.double.planned : 0) : 0;
    return s + capped - Math.min(capped, d);
  }, 0);
  const done = applied('completed');
  const withIp = applied('in-progress');
  const withPlanned = applied('planned');

  return {
    program: { id: program.id, name: program.name, catalogYear: program.catalogYear, totalCredits: program.totalCredits, source: program.source, notes: program.notes || [] },
    groups,
    totals: {
      required: program.totalCredits,
      done,
      inProgress: withIp - done,
      planned: withPlanned - withIp,
      remaining: Math.max(0, program.totalCredits - withPlanned),
      earned: pool.filter((p) => p.status === 'completed').reduce((s, p) => s + p.credits, 0),
    },
    extra: pool.filter((p) => !p.used).map((p) => ({ code: p.code, credits: p.credits, status: p.status })),
  };
}
