import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildIndex } from '../js/core/catalog.js';
import { parseTranscriptText, linesFromPdfItems, bestAttempts, cleanRecords, gradeStatus, textToLines } from '../js/core/transcript.js';
import { auditDegree } from '../js/core/audit.js';
import { planSemesters } from '../js/core/planner.js';
import { parseForecastCsv, termFromKey, offeredIn } from '../js/core/forecast.js';
import { evaluate, meetsMinGrade } from '../js/core/prereq.js';
import { readClientContext, studentContextBlock, courseDataBlock } from '../js/core/context.js';

const j = (f) => JSON.parse(readFileSync(new URL(`./${f}`, import.meta.url)));
const forecast = j('data/forecast.json');
const index = buildIndex(j('data/catalog.json'), j('data/sample-sections.json'), forecast);
const { programs } = j('data/programs.json');
const program = programs[0];
const titles = new Map(index.list.map((c) => [c.code, c.title]));
const sampleText = readFileSync(new URL('../samples/sample-transcript.txt', import.meta.url), 'utf8');
const sample = parseTranscriptText(sampleText, { catalogTitles: titles });

test('forecast CSV parsing', () => {
  assert.deepEqual(termFromKey('S27'), { key: 'S27', label: 'Spring 2027', season: 'Spring', year: 2027, order: 20271 });
  assert.equal(termFromKey('F28').label, 'Fall 2028');
  const csv = readFileSync(new URL('./data/source/future-cs-offerings.csv', import.meta.url), 'utf8');
  const f = parseForecastCsv(csv);
  assert.deepEqual(f.terms.map((t) => t.key), ['S27', 'F27', 'S28', 'F28']);
  assert.deepEqual(f.courses['CS 100'], ['F27', 'F28']);
  assert.deepEqual(f.courses['CS 443'], ['F28']);
  assert.deepEqual(f.courses['CS 442'], []);
  assert.equal(f.notes['CS 442'], 'now CSP442');
  assert.deepEqual(f.courses['CSP 595'], ['F27', 'F28']); // "CSP595 ..." with no space
  assert.deepEqual(f.courses['CS 415'], ['S27', 'F27', 'F28']);
  assert.equal(offeredIn(forecast, 'CS 481', 'F27'), false);
  assert.equal(offeredIn(forecast, 'CS 481', 'S27'), true);
  assert.equal(offeredIn(forecast, 'MATH 251', 'S27'), null);
  assert.deepEqual(index.get('CS 470').futureTerms, ['Spring 2028']);
  const quoted = parseForecastCsv('Course,"S27",F27\n"CS 331",Y,y\nnot a course,Y,\n');
  assert.deepEqual(quoted.courses['CS 331'], ['S27', 'F27']);
  assert.equal(quoted.warnings.length, 1);
});

test('transcript: sample text', () => {
  const { courses, warnings } = sample;
  assert.equal(courses.length, 27);
  assert.deepEqual(warnings, []);
  const find = (code, term) => courses.find((c) => c.code === code && (!term || c.term === term));
  assert.deepEqual(
    { ...find('CS 115') },
    { code: 'CS 115', title: 'Object-Oriented Programming I', credits: 2, grade: 'A', term: 'Fall 2024', status: 'completed', transfer: false, repeatExcluded: false },
  );
  assert.equal(find('MATH 151').transfer, true);
  assert.equal(find('MATH 151').grade, 'TR');
  assert.equal(find('MATH 251', 'Spring 2025').repeatExcluded, true);
  assert.equal(find('IPRO 497', 'Spring 2025').status, 'not-counted');
  assert.equal(find('CS 425').status, 'in-progress');
  assert.equal(find('CS 425').term, 'Fall 2026');
  // best attempt: the B in Fall 2025 beats the excluded D
  const best = bestAttempts(courses);
  assert.equal(best.find((c) => c.code === 'MATH 251').grade, 'B');
  assert.equal(best.filter((c) => c.code === 'IPRO 497').length, 1); // W attempt dropped, in-progress kept
});

test('transcript: tricky rows', () => {
  const t = (s) => parseTranscriptText(s, { catalogTitles: titles }).courses;
  // "Calculus I" with no grade in the in-progress list
  let rows = t('COURSES IN PROGRESS\nTerm: Spring 2027\nMATH 151 UG Calculus I 5.000');
  assert.equal(rows[0].title, 'Calculus I');
  assert.equal(rows[0].grade, '');
  assert.equal(rows[0].status, 'in-progress');
  // grade after credits, codes without a space, Incomplete grade
  rows = t('Fall 2025\nCS331 Data Structures and Algorithms 3.000 A\nHUM 102 Industrial Culture I 3.000 0.000');
  assert.equal(rows[0].code, 'CS 331');
  assert.equal(rows[0].grade, 'A');
  assert.equal(rows[1].grade, 'I');
  assert.equal(rows[1].status, 'not-counted');
  // HTML table
  rows = t('<table><tr><td>Term: Spring 2026</td></tr><tr><td>CS</td><td>351</td><td>UG</td><td>Systems Programming</td><td>B</td><td>3.000</td><td>9.000</td></tr></table>');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, 'CS 351');
  assert.equal(rows[0].term, 'Spring 2026');
  assert.equal(rows[0].grade, 'B');
  // addresses and GPA lines are not courses
  assert.equal(t('10 W 35th Street, Chicago, IL 60616\nGPA 3.50\nTotal Credits 121').length, 0);
  assert.equal(gradeStatus('W'), 'not-counted');
  assert.equal(gradeStatus('P'), 'completed');
  assert.equal(gradeStatus(''), 'in-progress');
  assert.equal(textToLines('a<br>b').length, 2);
});

test('transcript: PDF text items become lines', () => {
  const item = (str, x, y, w = str.length * 5) => ({ str, transform: [1, 0, 0, 1, x, y], width: w });
  const text = linesFromPdfItems([
    item('Term: Fall 2025', 40, 700),
    item('CS', 40, 680), item('331', 80, 680), item('UG', 115, 680), item('Data Structures and Algorithms', 140, 680),
    item('A', 400, 680), item('3.000', 445, 680), item('12.000', 500, 680.8),
  ]);
  assert.equal(text.split('\n').length, 2);
  const rows = parseTranscriptText(text).courses;
  assert.equal(rows[0].code, 'CS 331');
  assert.equal(rows[0].title, 'Data Structures and Algorithms');
  assert.equal(rows[0].credits, 3);
});

test('transcript: cleanRecords drops junk', () => {
  const out = cleanRecords([{ code: 'cs331', credits: '3', grade: 'a' }, { code: 'nope' }, null, { code: 'MATH 151', credits: 99 }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].code, 'CS 331');
  assert.equal(out[0].grade, 'A');
  assert.equal(out[0].status, 'completed');
  assert.equal(out[1].credits, null);
});

test('minimum grades in prerequisite checks', () => {
  assert.equal(meetsMinGrade('D', 'C'), false);
  assert.equal(meetsMinGrade('C', 'C'), true);
  assert.equal(meetsMinGrade('TR', 'C'), true);
  const cs116 = index.get('CS 116').prereq; // CS 115 with min. grade of C
  assert.equal(evaluate(cs116, { completed: new Set(['CS 115']), grades: new Map([['CS 115', 'D']]) }), 'unmet');
  assert.equal(evaluate(cs116, { completed: new Set(['CS 115']), grades: new Map([['CS 115', 'B']]) }), 'met');
  // planning mode: "Graduate standing" waits, placement rules pass
  assert.equal(evaluate(index.get('MATH 474').prereq, { textRules: 'plan' }), 'unmet');
  assert.equal(evaluate(index.get('MATH 151').prereq, { textRules: 'plan' }), 'met');
});

test('program data adds up', () => {
  assert.equal(program.groups.reduce((s, g) => s + g.credits, 0), 121);
  assert.equal(program.totalCredits, 121);
});

test('degree audit on the sample transcript', () => {
  const audit = auditDegree(program, sample.courses, { index });
  const g = (id) => audit.groups.find((x) => x.id === id);
  assert.equal(audit.totals.required, 121);
  assert.equal(audit.totals.done, 64);
  assert.equal(audit.totals.inProgress, 15);
  assert.equal(g('cs-core').status, 'remaining');
  assert.deepEqual(g('cs-core').remaining, ['CS 440', 'CS 450', 'CS 485', 'CS 487']);
  assert.equal(g('math-core').status, 'in-progress');
  assert.equal(g('science-core').status, 'done');
  assert.equal(g('science-elective').status, 'done');
  assert.ok(g('cs-electives').courses.some((c) => c.code === 'CS 340'));
  assert.equal(g('cs-electives').creditsLeft, 9);
  assert.ok(g('free').courses.some((c) => c.code === 'COM 101'));
  const hss = g('hss');
  assert.equal(hss.parts.find((p) => p.id === 'hum100').have[0], 'HUM 104');
  assert.equal(hss.parts.find((p) => p.id === 's').have.length, 2);
});

test('audit: CS 201 counts for CS 115 + CS 116, and IPRO repeats add up', () => {
  const recs = cleanRecords([
    { code: 'CS 201', credits: 4, grade: 'A' },
    { code: 'IPRO 497', credits: 3, grade: 'A', term: 'Fall 2025' },
    { code: 'IPRO 497', credits: 3, grade: 'B', term: 'Spring 2026' },
  ]);
  const audit = auditDegree(program, recs, { index });
  const core = audit.groups.find((x) => x.id === 'cs-core');
  assert.equal(core.slots[1].status, 'done');
  assert.deepEqual(core.slots[1].chosen, ['CS 201']);
  assert.equal(audit.groups.find((x) => x.id === 'ipro').status, 'done');
});

test('audit: planned (saved) courses show as planned', () => {
  const audit = auditDegree(program, sample.courses, { index, planned: ['CS 440'] });
  const core = audit.groups.find((x) => x.id === 'cs-core');
  assert.ok(core.courses.some((c) => c.code === 'CS 440' && c.status === 'planned'));
  assert.equal(audit.totals.planned, 3);
});

test('semester plan respects prerequisites and the forecast', () => {
  const audit = auditDegree(program, sample.courses, { index });
  const best = bestAttempts(sample.courses);
  const done = new Set(best.filter((r) => r.status !== 'not-counted').map((r) => r.code));
  const plan = planSemesters(audit, program, index, { done, grades: new Map(best.map((r) => [r.code, r.grade])), maxCredits: 15 });
  const termOf = new Map();
  plan.terms.forEach((t, i) => t.items.forEach((it) => it.code && termOf.set(it.code, i)));
  // every required course is placed
  for (const c of ['CS 440', 'CS 450', 'CS 485', 'CS 487']) assert.ok(termOf.has(c), c);
  // CS 485 needs a COM course from its list first; the plan picks COM 425 (also the communication elective)
  assert.ok(termOf.get('COM 425') < termOf.get('CS 485'));
  // nothing over the credit limit
  for (const t of plan.terms) assert.ok(t.credits <= 15, `${t.label} ${t.credits}`);
  // each planned CS course is on the forecast for that term
  plan.terms.forEach((t) => t.items.forEach((it) => {
    if (it.code?.startsWith('CS ')) assert.equal(offeredIn(forecast, it.code, t.key), true, `${it.code} in ${t.key}`);
  }));
  // prerequisites come in an earlier term
  plan.terms.forEach((t, i) => t.items.forEach((it) => {
    const course = it.code && index.get(it.code);
    if (!course) return;
    const before = new Set([...done, ...[...termOf].filter(([, ti]) => ti < i).map(([c]) => c)]);
    const same = new Set([...termOf].filter(([, ti]) => ti === i).map(([c]) => c));
    assert.equal(evaluate(course.prereq, { completed: before, current: same, textRules: 'plan' }), 'met', it.code);
  }));
  // whole degree fits in the four forecast terms
  assert.equal(plan.later.length, 0);
  // MATH 252 is 4 credits for a 3-credit elective, so the plan can run one credit over
  const total = plan.terms.reduce((s, t) => s + t.credits, 0);
  assert.ok(total >= audit.totals.remaining && total <= audit.totals.remaining + 1, String(total));
});

test('plan for a first-year student starts with the intro sequence', () => {
  const audit = auditDegree(program, [], { index });
  const plan = planSemesters(audit, program, index, { maxCredits: 16 });
  const first = plan.terms[0].items.map((i) => i.code).filter(Boolean);
  assert.ok(first.includes('CS 115') || first.includes('CS 100'));
  assert.ok(first.includes('MATH 151'));
  assert.ok(!first.includes('CS 331'));
  assert.ok(plan.later.length > 0); // a full degree does not fit in four terms
  assert.ok(plan.later.every((i) => i.reason));
});

test('chat context includes degree progress', () => {
  const ctx = readClientContext({ transcript: sample.courses, programId: 'bs-cs', maxCredits: 15 }, index);
  assert.ok(ctx.completed.includes('CS 331'));
  assert.ok(ctx.inProgress.includes('CS 425'));
  const block = studentContextBlock(index, 'what should I take next semester?', ctx, programs);
  assert.match(block, /DEGREE PROGRESS/);
  assert.match(block, /Credits applied: 64 done, 15 in progress/);
  assert.match(block, /Spring 2027 \(15 cr\): CS 450/);
  const data = courseDataBlock(index, programs);
  assert.match(data, /DEGREE PROGRAM B\.S\. in Computer Science/);
  assert.match(data, /"futureTerms":\["Spring 2027","Fall 2027","Spring 2028","Fall 2028"\]/);
  assert.match(data, /CS 525: Spring 2027, Fall 2027/);
  // in-progress MATH 474 counts for CS 480 next term
  const elig = studentContextBlock(index, 'can I take CS 480?', ctx, programs);
  assert.match(elig, /CS 480 Introduction to Artificial Intelligence[\s\S]*Eligibility: prerequisites met/);
});

test('Spring 2027 is the schedule term: saved sections fill that term of the plan', async () => {
  const { planInputs, scheduleTermKey } = await import('../js/core/planner.js');
  assert.equal(index.semester, 'Spring 2027');
  assert.equal(scheduleTermKey(index), 'S27');
  // every CS course with sample sections is on the forecast for Spring 2027
  for (const c of index.list) if (c.subject === 'CS' && c.sections.length) assert.equal(offeredIn(forecast, c.code, 'S27'), true, c.code);
  const audit = auditDegree(program, sample.courses, { index, planned: ['CS 440', 'CS 485'] });
  const best = bestAttempts(sample.courses);
  const completed = new Set(best.filter((r) => r.status === 'completed').map((r) => r.code));
  const inProgress = new Set(best.filter((r) => r.status === 'in-progress').map((r) => r.code));
  const inputs = planInputs(index, { completed, inProgress, saved: ['CS 440', 'CS 485'] });
  assert.deepEqual(inputs.locked, { S27: ['CS 440', 'CS 485'] });
  const plan = planSemesters(audit, program, index, { ...inputs, grades: new Map(), maxCredits: 15 });
  const s27 = plan.terms[0];
  assert.equal(s27.key, 'S27');
  const saved = s27.items.filter((i) => i.kind === 'saved').map((i) => i.code);
  assert.deepEqual(saved, ['CS 440', 'CS 485']);
  // CS 485 needs a COM course first; the plan flags it
  assert.match(s27.items.find((i) => i.code === 'CS 485').warning, /Prerequisites/);
  assert.ok(s27.credits <= 15);
  assert.ok(!plan.terms.slice(1).some((t) => t.items.some((i) => i.code === 'CS 440')));
});

test('plan check: the rule-based plan passes, broken plans are caught', async () => {
  const { checkPlan, normalizePlan, groupForRequirement } = await import('../js/core/plan-check.js');
  const { describePlan } = await import('../js/core/planner.js');
  const audit = auditDegree(program, sample.courses, { index });
  const best = bestAttempts(sample.courses);
  const done = new Set(best.filter((r) => r.status !== 'not-counted').map((r) => r.code));
  const grades = new Map(best.map((r) => [r.code, r.grade]));
  const rule = describePlan(planSemesters(audit, program, index, { done, grades }), audit);
  assert.equal(rule.graduation, 'Spring 2028');
  assert.ok(rule.terms[0].items.every((i) => i.reason));
  const ok = checkPlan(rule, { index, program, records: sample.courses, done, grades });
  assert.deepEqual(ok.issues, []);

  const { terms } = normalizePlan({ terms: [
    { term: 'Spring 2027', courses: [{ code: 'cs331', credits: 3 }, { code: 'CS 443', credits: 3 }, { code: 'CS 440' }] },
    { term: 'F27', courses: [{ code: 'CS 440' }, { code: null, label: 'Free elective', credits: 20 }] },
  ] }, { index, program, audit });
  assert.equal(terms[1].label, 'Fall 2027');
  assert.equal(terms[1].items[1].credits, 3); // 20 credits is not sane, so the default is used
  const bad = checkPlan({ terms }, { index, program, records: sample.courses, done, grades, maxCredits: 6 });
  const msgs = bad.issues.map((x) => `${x.code || ''} ${x.message}`).join('\n');
  assert.match(msgs, /CS 331 CS 331 is already done/);
  assert.match(msgs, /CS 443 Not on the forecast for Spring 2027 \(planned for Fall 2028\)/);
  assert.match(msgs, /CS 440 CS 440 is in the plan twice/);
  assert.match(msgs, /Spring 2027 has 9 credits, over your limit of 6/);
  assert.equal(bad.ok, false);

  assert.equal(groupForRequirement('Humanities and Social Sciences', program), 'hss');
  assert.equal(groupForRequirement('IPRO', program), 'ipro');
  assert.equal(groupForRequirement('Computer Science Electives', program), 'cs-electives');
  assert.equal(groupForRequirement('Free elective', program), 'free');
});
