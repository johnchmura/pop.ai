// Builds the text Claude sees: the COURSE DATA block (same for every request, so it is cached)
// and the STUDENT CONTEXT block (changes per request).

import { extractCodes, evaluate, missingParts, treeToText, normalizeCode } from './prereq.js';
import { ancestors, creditNumber } from './catalog.js';
import { buildBlocks, findConflicts, DAY_LABELS, formatHour } from './schedule.js';
import { cleanRecords, bestAttempts } from './transcript.js';
import { auditDegree } from './audit.js';
import { cleanCommitments, describeCommitment, sectionClashes } from './commitments.js';
import { planSemesters, planInputs } from './planner.js';

/** One section as a short line: "CRN 20031 Lecture: MW 11:25 AM - 12:40 PM, Stuart Building 111, Matthew Bauer; 12 seats open". */
function compactSection(s) {
  const meetings = s.meetings.map((m) => {
    const when = m.days && m.time && m.time !== 'TBA' ? `${m.days} ${m.time}` : 'no set time (online or TBA)';
    const where = m.where && m.where !== 'TBA' && m.where !== '-' ? `, ${m.where}` : '';
    const who = m.instructors?.length ? `, ${m.instructors.join(', ')}` : '';
    return `${when}${where}${who}`;
  }).join(' / ');
  const type = `${s.scheduleType || 'Section'}${s.bucket && s.bucket !== 'Class' ? ` (${s.bucket})` : ''}`;
  const seats = s.available === '' || s.available == null ? '' : `; ${s.available} seats open`;
  return `CRN ${s.crn} ${type}: ${meetings || 'no set time'}${seats}`;
}

/** The whole catalog + sections as text. Small enough (about 50 courses) to send in full. */
/** One program's requirement groups, as text lines for Claude. */
export function programLines(prog) {
  const lines = [`DEGREE PROGRAM ${prog.name} (${prog.catalogYear} catalog, ${prog.totalCredits} credits). Requirement groups:`];
  for (const g of prog.groups) {
    let rule = '';
    if (g.slots) rule = g.slots.map((slot) => slot.map((o) => o.join(' + ')).join(' or ')).join('; ');
    else if (g.from?.codes) rule = `${g.count ? `${g.count} course` : `${g.credits} credits`} from ${g.from.codes.join(', ')}`;
    else if (g.from?.subjects) rule = `${g.credits} credits from ${g.from.subjects.join('/')}${g.from.minLevel ? ` ${g.from.minLevel}+` : ''}${g.from.exclude ? ` except ${g.from.exclude.join(', ')}` : ''}`;
    lines.push(`- ${g.name} (${g.credits} cr): ${rule}${g.note ? ` ${g.note}` : ''}`);
  }
  for (const t of prog.tracks || []) lines.push(`  Optional ${t.kind}: ${t.name}${t.codes?.length ? ` (${t.codes.join(', ')})` : ''}${t.note ? `. ${t.note}` : ''}`);
  for (const n of prog.notes || []) lines.push(`  Note: ${n}`);
  return lines;
}

export function courseDataBlock(index, programs = []) {
  const lines = [];
  lines.push('COURSE DATA');
  lines.push(`Catalog source: ${index.source}`);
  lines.push(`Semester for sections: ${index.semester}${index.termCode ? ` (term code ${index.termCode})` : ''}`);
  lines.push(index.sample
    ? 'SECTIONS ARE SAMPLE DATA: CRNs, times, rooms, seats, and instructor names are made up for the demo. Say this when you mention them.'
    : 'Sections were imported from the live IIT Course Status Report through Pop. Seats may have changed since import.');
  if (index.forecast) {
    lines.push(`Future offerings: ${index.forecast.source} Terms covered: ${index.forecast.terms.map((t) => t.label).join(', ')}. "futureTerms" lists the terms a course is expected; an empty list means not planned in those terms. Always call this tentative.`);
  }
  lines.push('One JSON object per course:');
  // Graduate and law courses that are not in the catalog file are listed by name only (below),
  // so real section data for every IIT course does not make this text too long.
  const gradStubs = index.list.filter((c) => c.stub && c.level >= 500);
  for (const c of index.list) {
    if (c.stub && c.level >= 500) continue;
    const row = {
      code: c.code,
      title: c.title,
      credits: c.credits,
      department: c.department,
    };
    if (c.satisfies) row.satisfies = c.satisfies;
    if (c.bridge) row.graduateBridge = true;
    if (c.stub) row.note = 'Not in the app catalog file. Only section data is known.';
    row.description = c.description;
    row.prereqText = c.prereqText || 'None';
    row.prereq = c.prereq;
    if (c.note) row.note = c.note;
    row.unlocks = c.dependents.map((d) => d.code + (d.concurrent ? '*' : ''));
    row.sections = c.sections.map(compactSection);
    if (c.futureTerms) row.futureTerms = c.futureTerms;
    if (c.forecastNote) row.forecastNote = c.forecastNote;
    lines.push(JSON.stringify(row));
  }
  if (gradStubs.length) {
    lines.push(`Graduate and professional courses with sections in ${index.semester} (not in the catalog file; ask the student to search the app for times): ${gradStubs.map((c) => `${c.code}${c.title ? ` ${c.title}` : ''}`).join('; ')}.`);
  }
  if (index.forecast) {
    const labels = new Map(index.forecast.terms.map((t) => [t.key, t.label]));
    const only = Object.entries(index.forecast.courses).filter(([code]) => !index.has(code));
    if (only.length) {
      lines.push('Courses on the future-offerings forecast that are not in this catalog (graduate and CSP courses; titles and prerequisites unknown unless noted):');
      lines.push(only.map(([code, keys]) => `${code}${index.forecast.notes?.[code] ? ` (${index.forecast.notes[code]})` : ''}: ${keys.length ? keys.map((k) => labels.get(k)).join(', ') : 'not planned'}`).join('; '));
    }
  }
  // The default program (the first) is spelled out. The others are a short list: the student's own
  // program is added to STUDENT CONTEXT, so the shared, cached text stays small.
  if (programs[0]) lines.push(...programLines(programs[0]));
  if (programs.length > 1) {
    lines.push(`Other undergraduate programs in the app (requirement details are added to STUDENT CONTEXT for the student's own program): ${programs.slice(1).map((p) => `${p.name} (${p.totalCredits} cr)`).join('; ')}.`);
  }
  const ext = [...index.external.keys()].sort();
  if (ext.length) {
    lines.push(`Course codes named in prerequisites but not in this catalog (details unknown): ${ext.join(', ')}`);
  }
  return lines.join('\n');
}

function cleanCodes(list, index, max = 80) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list.slice(0, max)) {
    const code = normalizeCode(raw);
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

/** The plan the student sees, as [{ term, items: ["CS 450", "[Humanities course]"] }]. */
function cleanPlanSummary(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 8).map((t) => ({
    term: String(t?.term || '').slice(0, 20),
    items: (Array.isArray(t?.items) ? t.items : []).slice(0, 10).map((x) => String(x).slice(0, 120)),
  })).filter((t) => t.term && t.items.length);
}

/** Changes the student applied on the Degree tab (adviser exceptions, waivers, added courses, notes). */
function cleanChanges(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw.slice(0, 30)) {
    if (!c || !['apply', 'waive', 'add-course', 'note'].includes(c.kind)) continue;
    out.push({
      kind: c.kind,
      code: normalizeCode(c.code) || '',
      group: String(c.group || '').slice(0, 100),
      text: String(c.text || '').slice(0, 300),
      reason: String(c.reason || '').slice(0, 200),
      grade: String(c.grade || '').slice(0, 3),
      term: String(c.term || '').slice(0, 30),
    });
  }
  return out;
}

/** Validate and normalize the client's context object. */
export function readClientContext(raw, index) {
  const ctx = raw && typeof raw === 'object' ? raw : {};
  const savedCrns = Array.isArray(ctx.savedCrns)
    ? [...new Set(ctx.savedCrns.slice(0, 40).map((c) => String(c).trim()).filter((c) => index.crnMap.has(c)))]
    : [];
  const manual = cleanCodes(ctx.completed, index);
  const transcript = cleanRecords(ctx.transcript);
  const best = bestAttempts(transcript);
  const fromTranscript = best.filter((r) => r.status === 'completed').map((r) => r.code);
  const inProgress = best.filter((r) => r.status === 'in-progress').map((r) => r.code);
  const grades = new Map(best.filter((r) => r.grade).map((r) => [r.code, r.grade]));
  const changes = cleanChanges(ctx.changes);
  return {
    query: typeof ctx.query === 'string' ? ctx.query.slice(0, 300) : '',
    manualCompleted: manual,
    completed: [...new Set([...manual, ...fromTranscript])],
    inProgress,
    grades,
    transcript,
    changes,
    waivers: changes.filter((c) => c.kind === 'waive').map((c) => ({ group: c.group, reason: c.reason })),
    programId: typeof ctx.programId === 'string' ? ctx.programId.slice(0, 40) : '',
    maxCredits: Math.min(21, Math.max(6, Number(ctx.maxCredits) || 15)),
    plan: cleanPlanSummary(ctx.plan),
    planSource: ctx.planSource === 'claude' ? 'claude' : 'rules',
    savedCrns,
    busy: cleanCommitments(ctx.busy),
    prefs: Array.isArray(ctx.prefs) ? ctx.prefs.filter((x) => typeof x === 'string').slice(-25).map((x) => x.slice(0, 160)) : [],
    focus: cleanCodes(ctx.focus, index, 10),
    screen: Array.isArray(ctx.screen) ? ctx.screen.filter((x) => typeof x === 'string').slice(0, 20).map((x) => x.slice(0, 600)) : [],
  };
}

/** Codes the student is asking about: from the message, then the search focus. */
export function relevantCodes(index, message, ctx) {
  const codes = extractCodes(message, index.courses);
  // bare numbers like "331" when they match exactly one course
  const nums = String(message || '').match(/(?<![A-Za-z\d])\d{3}(?!\d)/g) || [];
  for (const n of nums) {
    let hits = index.list.filter((c) => c.number === n);
    // "331" can match several subjects (CS 331, PHIL 331). Prefer the main CS and MATH courses.
    if (hits.length > 1) {
      for (const subject of ['CS', 'MATH']) {
        const own = hits.filter((c) => c.subject === subject);
        if (own.length === 1) { hits = own; break; }
      }
    }
    if (hits.length === 1 && !codes.includes(hits[0].code)) codes.push(hits[0].code);
  }
  for (const c of ctx.focus) if (!codes.includes(c) && index.has(c)) codes.push(c);
  return codes.slice(0, 8);
}

export function savedItems(index, ctx) {
  return ctx.savedCrns.map((crn) => {
    const s = index.crnMap.get(crn);
    return { key: crn, label: s.course, colorKey: s.course, section: s };
  });
}

export function scheduleFacts(index, ctx) {
  const items = savedItems(index, ctx);
  const { blocks } = buildBlocks(items);
  const conflicts = findConflicts(blocks).map((c) => {
    const a = index.crnMap.get(c.a);
    const b = index.crnMap.get(c.b);
    return `${a.course} (CRN ${a.crn}) and ${b.course} (CRN ${b.crn}) overlap on ${DAY_LABELS[c.day]} ${formatHour(c.start)}–${formatHour(c.end)}`;
  });
  const courses = [...new Set(items.map((i) => i.label))];
  const credits = courses.reduce((sum, code) => sum + creditNumber(index.get(code)), 0);
  return { items, conflicts, courses, credits };
}

/** Plain-language eligibility for one course. */
export function eligibility(index, code, ctx, plannedCourses) {
  const course = index.get(code);
  if (!course) return null;
  if (!ctx.completed.length) return { status: 'unknown-history', missing: [] };
  // courses in progress now will be finished before the next term, so they count here
  const state = { completed: new Set([...ctx.completed, ...(ctx.inProgress || [])]), current: new Set(plannedCourses), grades: ctx.grades };
  return { status: evaluate(course.prereq, state), missing: missingParts(course.prereq, state) };
}

/** Audit + rule-based plan for this student, or null when there is no transcript. */
export function degreeContext(index, ctx, programs) {
  if (!ctx.transcript.length) return null;
  const program = programs.find((p) => p.id === ctx.programId) || programs[0];
  if (!program) return null;
  const sched = scheduleFacts(index, ctx);
  const planned = sched.courses.filter((c) => !ctx.completed.includes(c) && !ctx.inProgress.includes(c));
  const audit = auditDegree(program, ctx.transcript, { index, planned, waivers: ctx.waivers });
  const inputs = planInputs(index, { completed: new Set(ctx.completed), inProgress: new Set(ctx.inProgress), saved: planned });
  const plan = planSemesters(audit, program, index, { ...inputs, grades: ctx.grades, maxCredits: ctx.maxCredits });
  return { program, audit, plan, inputs, planned };
}

/** Degree progress text from the transcript records (empty when there is no transcript). */
export function degreeBlock(index, ctx, programs) {
  const d = degreeContext(index, ctx, programs);
  if (!d) return [];
  const { program, audit, plan } = d;
  const lines = [];
  const t = audit.totals;
  if (program !== programs[0]) lines.push(...programLines(program));
  lines.push(`DEGREE PROGRESS (from the student's uploaded unofficial transcript, checked against ${program.name}, ${program.catalogYear} catalog):`);
  lines.push(`Credits applied: ${t.done} done, ${t.inProgress} in progress, ${t.planned} planned (saved sections), ${t.remaining} still needed, of ${t.required}.`);
  const best = bestAttempts(ctx.transcript);
  const fmt = (r) => `${r.code}${r.grade ? ` (${r.grade})` : ''}`;
  lines.push(`Completed: ${best.filter((r) => r.status === 'completed').map(fmt).join(', ') || 'none'}`);
  lines.push(`In progress now: ${ctx.inProgress.join(', ') || 'none'}`);
  const failed = ctx.transcript.filter((r) => r.status === 'not-counted').map(fmt);
  if (failed.length) lines.push(`Attempts that do not count (W, F, I, and similar): ${failed.join(', ')}`);
  if (ctx.changes?.length) {
    lines.push('Changes the student applied on the Degree tab (adviser exceptions, waivers, added courses). Treat them as true:');
    for (const c of ctx.changes) {
      lines.push(`  - ${c.kind === 'apply' ? `${c.code} counts toward ${c.group}` : c.kind === 'waive' ? `${c.group} is marked as met` : c.kind === 'add-course' ? `${c.code} added${c.grade ? ` (${c.grade})` : ''}${c.group ? ` toward ${c.group}` : ''}` : `Note: ${c.text}`}${c.reason ? ` (${c.reason})` : ''}`);
    }
  }
  for (const g of audit.groups) {
    const minor = g.minorSubject ? ` (minor in ${g.minorSubject}, found from the student's ${g.minorSubject} courses${g.sharedCode ? `; shares ${g.sharedCode} with another requirement, the one course a minor may share, so a free elective makes up its credits` : ''})` : '';
    lines.push(`- ${g.name}${minor}: ${g.status}, ${g.done + g.inProgress + g.planned}/${g.credits} credits${g.courses.length ? ` [${g.courses.map((c) => c.code).join(', ')}]` : ''}${g.remaining.length ? `. Still needed: ${g.remaining.join('; ')}` : ''}`);
  }
  const gaps = audit.groups.filter((g) => g.creditGap);
  if (gaps.length) {
    lines.push('Requirements met by their courses with fewer credits than listed (no extra credits needed; mention this if the student asks about credits):');
    for (const g of gaps) lines.push(`  - ${g.name}: met, ${g.creditGap} credit${g.creditGap === 1 ? '' : 's'} under the listed total (for example a 3-credit AP or transfer course for a 4-credit course)`);
  }
  if (plan.outliers?.length) {
    lines.push('Small leftovers the plan leaves out (not real courses; mention them briefly when the plan or what is left comes up, and say why they happen, for example a 2-credit or transfer course that left a 1-credit gap; suggest confirming with the adviser):');
    for (const o of plan.outliers) lines.push(`  - ${o.group}: ${o.credits} credit${o.credits === 1 ? '' : 's'} short`);
  }
  if (ctx.plan?.length) {
    lines.push(`Plan the student sees now on the Degree tab (${ctx.planSource === 'claude' ? 'your earlier recommendation' : 'the app\'s rule-based plan'}):`);
    for (const term of ctx.plan) lines.push(`  ${term.term}: ${term.items.join(', ')}`);
  } else if (plan.terms.some((term) => term.items.length)) {
    lines.push(`Draft plan the app built (max ${ctx.maxCredits} credits per term, using prerequisites and the tentative forecast; electives are suggestions):`);
    for (const term of plan.terms) {
      if (!term.items.length) continue;
      lines.push(`  ${term.label} (${term.credits} cr): ${term.items.map((i) => (i.code ? `${i.code}${i.kind === 'elective' ? ' [suggested CS elective]' : i.kind === 'choice' ? ` [${i.groupName}]` : i.kind === 'saved' ? ` [saved section${i.warning ? ', prerequisites not finished before this term' : ''}]` : ''}` : `[${i.label}]`)).join(', ')}`);
    }
    if (plan.later.length) lines.push(`  Not placed: ${plan.later.map((i) => `${i.code || i.label} (${i.reason})`).join('; ')}`);
  }
  for (const n of program.notes || []) lines.push(`Note: ${n}`);
  return lines;
}

export function studentContextBlock(index, message, ctx, programs = []) {
  const lines = ['STUDENT CONTEXT (from the app, this request only)'];
  lines.push(`Search box: ${ctx.query ? JSON.stringify(ctx.query) : '(empty)'}`);
  if (ctx.prefs?.length) {
    lines.push('What the student told you before (saved notes; they stay when the chat is deleted, so use them):');
    for (const p of ctx.prefs) lines.push(`- ${p}`);
  }
  if (ctx.screen?.length) {
    lines.push('App screen and settings (what the student sees and has set right now):');
    for (const l of ctx.screen) lines.push(`- ${l}`);
  }
  lines.push(`Completed courses (entered by the student): ${(ctx.manualCompleted || ctx.completed).length ? (ctx.manualCompleted || ctx.completed).join(', ') : 'not entered'}`);

  const sched = scheduleFacts(index, ctx);
  if (sched.items.length) {
    lines.push(`Saved sections for ${index.semester}:`);
    for (const it of sched.items) {
      const s = it.section;
      const course = index.get(s.course);
      lines.push(`- ${s.course} ${course?.title || ''}, CRN ${s.crn}, ${s.scheduleType}: ${s.meetings.map((m) => `${m.days} ${m.time} in ${m.where}`).join('; ')}`);
    }
    lines.push(`Planned credits: ${sched.credits}`);
    lines.push(sched.conflicts.length ? `Time conflicts: ${sched.conflicts.join('; ')}` : 'Time conflicts: none');
  } else {
    lines.push('Saved sections: none');
  }

  if (ctx.busy?.length) {
    lines.push('Time commitments the student listed (they cannot take classes then):');
    for (const c of ctx.busy) lines.push(`- ${describeCommitment(c)}`);
    for (const it of sched.items) {
      const hits = sectionClashes(it.section, ctx.busy);
      if (hits.length) lines.push(`  Saved section ${it.section.course} (CRN ${it.section.crn}) clashes with: ${[...new Set(hits.map((h) => h.label))].join(', ')}`);
    }
  } else {
    lines.push('Time commitments: none listed. If timing matters, ask about work, commute, and other fixed hours.');
  }

  lines.push(...degreeBlock(index, ctx, programs));

  const codes = relevantCodes(index, message, ctx);
  if (codes.length) {
    lines.push('Courses in this question, with checks the app ran:');
    for (const code of codes) {
      const course = index.get(code);
      if (!course) continue;
      const chain = [...ancestors(index, code, (c) => index.has(c) && !index.get(c).bridge)];
      lines.push(`- ${code} ${course.title}. Rule: ${treeToText(course.prereq)}.`);
      if (ctx.busy?.length && course.sections.length) {
        const fit = course.sections.filter((s) => !sectionClashes(s, ctx.busy).length);
        lines.push(`  Sections that fit the student's commitments: ${fit.length ? fit.map((s) => `CRN ${s.crn}`).join(', ') : 'none'} (of ${course.sections.length}).`);
      }
      if (chain.length) lines.push(`  Full prerequisite chain (all options, no bridge courses): ${chain.join(', ')}`);
      const others = sched.courses.filter((c) => c !== code);
      const el = eligibility(index, code, ctx, others);
      if (course.futureTerms) lines.push(`  Forecast (tentative): ${course.futureTerms.length ? course.futureTerms.join(', ') : 'not planned in the forecast terms'}`);
      if (el.status === 'unknown-history') lines.push('  Eligibility: unknown (no completed courses entered).');
      else if (el.status === 'met') lines.push(`  Eligibility: prerequisites met${ctx.inProgress?.length ? ' (counting courses in progress as finished)' : ''}${others.length ? ' (counting saved courses for concurrent rules)' : ''}.${ctx.grades?.size ? ' Minimum grades checked against transcript grades.' : ' Minimum grades not checked.'}`);
      else if (el.status === 'unknown') lines.push(`  Eligibility: needs a rule the app cannot check: ${el.missing.join('; ')}`);
      else lines.push(`  Eligibility: NOT met. Still missing: ${el.missing.join('; ')}`);
    }
  }
  return lines.join('\n');
}
