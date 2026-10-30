import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectProgram, headerMajors } from '../js/core/detect.js';
import { parseTranscriptText } from '../js/core/transcript.js';
import { auditDegree } from '../js/core/audit.js';
import { buildIndex } from '../js/core/catalog.js';

const j = (f) => JSON.parse(readFileSync(new URL(`./${f}`, import.meta.url)));
const { programs } = j('data/programs.json');
const index = buildIndex(j('data/catalog.json'), j('data/sample-sections.json'), j('data/forecast.json'));
const sampleText = readFileSync(new URL('../samples/sample-transcript.txt', import.meta.url), 'utf8');
const sample = parseTranscriptText(sampleText);

test('every program has unique ids, a college, and groups that add up to the total', () => {
  assert.ok(programs.length >= 45);
  assert.equal(new Set(programs.map((p) => p.id)).size, programs.length);
  for (const p of programs) {
    assert.ok(p.college, `${p.id} has a college`);
    assert.equal(p.groups.reduce((s, g) => s + g.credits, 0), p.totalCredits, `${p.id} total`);
    for (const g of p.groups) assert.ok(['all', 'pick', 'hss', 'free'].includes(g.type), `${p.id}/${g.id} type`);
  }
});

test('every program can be audited without errors', () => {
  for (const p of programs) {
    const audit = auditDegree(p, sample.courses, { index, planned: [] });
    assert.equal(audit.totals.required, p.totalCredits, p.id);
    assert.ok(audit.totals.done >= 0 && audit.totals.remaining >= 0, p.id);
  }
});

test('detection reads the major from the transcript header', () => {
  assert.deepEqual(headerMajors('Major and Department: Mechanical Engineering, Mechanical Engineering\nCS 115'), ['Mechanical Engineering', 'Mechanical Engineering']);
  const found = detectProgram(sample.courses, programs, { headerText: sampleText });
  assert.equal(found.programId, 'bs-cs');
  assert.equal(found.confidence, 'high');
  const me = detectProgram([], programs, { headerText: 'Major: Mechanical Engineering' });
  assert.equal(me.programId, 'bs-mechanical-engineering');
  const fromClaude = detectProgram([], programs, { majors: ['Civil Engineering'] });
  assert.equal(fromClaude.programId, 'bs-civil-engineering');
});

test('detection falls back to courses, with lower confidence', () => {
  const found = detectProgram(sample.courses, programs, {});
  assert.ok(found);
  assert.notEqual(found.confidence, 'high');
  assert.ok(['bs-cs', 'bs-computer-information-systems'].includes(found.programId));
  assert.equal(detectProgram([], programs, {}), null);
});

test('a Degree Works audit is read with grades, in-progress rows, and adviser exceptions', async () => {
  const { parseTranscriptText: parse } = await import('../js/core/transcript.js');
  const dw = `Ellucian Degree Works
Major in Artificial Intelligence BS INCOMPLETE
Course Title Grade Credits Term
Data Mining or Machine Learning CS 584 Machine Learning NG (3) Fall 2026
Object-Oriented Programming I, II CS 115 Object-Oriented Programming I TR 1.5 Spring 2024
Satisfied by: CS104 - INTRO TO JAVA - Delaware County Communty Coll
Artificial Intelligence Breadth Electives I PHIL 381 AI Ethics A 3 Spring 2025
Exception by: Smith, Gabrielle R On: 11/07/2024 Apply Here: Apply PHIL 381 here.
Calculus II MATH 152 Calculus II C 5 Spring 2024
Insufficient Credits applied: 0 Classes applied: 1
CS 425 Database Organization D 0 Fall 2024 (R)
Still needed: 1 Class in CS 512`;
  const r = parse(dw);
  const by = (c) => r.courses.find((x) => x.code === c);
  assert.equal(by('CS 584').status, 'in-progress');
  assert.equal(by('CS 115').status, 'completed');
  assert.equal(by('CS 115').transfer, true);
  assert.equal(by('CS 425').status, 'not-counted');
  assert.equal(r.courses.some((x) => x.code === 'CS 104'), false);
  assert.match(by('PHIL 381').appliesTo, /Breadth/);
  const ai = programs.find((p) => p.id === 'bs-artificial-intelligence');
  const audit = auditDegree(ai, r.courses, { index, planned: [] });
  assert.equal(audit.groups.find((g) => g.id === 'ai-breadth-course').status, 'done');
});

test('a transfer HUM elective fills the 100-level slot, so only a 200+ humanities course is left', () => {
  const ai = programs.find((p) => p.id === 'bs-artificial-intelligence');
  const rec = (code, grade, status = 'completed') => ({ code, title: '', credits: 3, grade, term: 'Fall 2024', status, transfer: grade === 'TR' });
  const audit = auditDegree(ai, [rec('HUM 200', 'TR'), rec('HUM 380', 'A'), rec('ECON 211', 'B'), rec('ECON 311', 'B'), rec('SOC 303', 'A'), rec('COM 421', 'TR')], { index, planned: [] });
  const hss = audit.groups.find((g) => g.type === 'hss');
  assert.ok(!hss.remaining.some((r) => /100-level/.test(r)));
  assert.ok(hss.remaining.some((r) => /Two \(H\)/.test(r)));
});

test('a 0-credit lab row does not hide the 4-credit course (PHYS 123)', () => {
  const ai = programs.find((p) => p.id === 'bs-artificial-intelligence');
  const rec = (code, credits, term = 'Spring 2025') => ({ code, title: '', credits, grade: 'C', term, status: 'completed', transfer: false });
  for (const order of [[rec('PHYS 123', 0), rec('PHYS 123', 4)], [rec('PHYS 123', 4), rec('PHYS 123', 0)]]) {
    const audit = auditDegree(ai, [...order, rec('PHYS 221', 4, 'Summer 2026')], { index, planned: [] });
    const sci = audit.groups.find((g) => g.id === 'science-requirements');
    assert.equal(sci.status, 'done');
  }
});

test('chat changes: parse, check, apply, undo, and waive', async () => {
  const { parseProposals, resolveProposal, applyChange, undoChange, waiversOf } = await import('../js/core/changes.js');
  const ai = programs.find((p) => p.id === 'bs-artificial-intelligence');
  const block = '[{"type":"apply","course":"phil381","requirement":"AI Breadth Course","why":"exception"},{"type":"waive","requirement":"Minor Requirement"},{"type":"add-course","course":"PHYS 221","grade":"TR","term":"Summer 2026"},{"type":"apply","course":"CS 1","requirement":"Nope"}]';
  const answer = `I found two approvals.\n\n\`\`\`degree-changes\n${block}\n\`\`\``;
  const parsed = parseProposals(answer);
  assert.equal(parsed.text, 'I found two approvals.');
  assert.equal(parsed.proposals.length, 4);
  // partial streaming text hides the block and finds nothing yet
  const partial = parseProposals('Working on it.\n\n```degree-changes\n[{"type":"app');
  assert.equal(partial.text, 'Working on it.');
  assert.equal(partial.proposals.length, 0);

  const items = parsed.proposals.map((p) => resolveProposal(p, ai, index));
  assert.deepEqual(items.map((x) => x.ok), [true, true, true, false]);
  assert.equal(items[0].change.group, 'AI Breadth Course');
  assert.equal(items[1].change.group, 'Minor Requirement');

  // apply: PHIL 381 counts toward breadth, the minor is waived, PHYS 221 is added
  let t = { courses: [{ code: 'PHIL 381', title: 'AI Ethics', credits: 3, grade: 'A', term: 'Spring 2025', status: 'completed', transfer: false }], programId: ai.id };
  for (const x of items.filter((y) => y.ok)) t = applyChange(t, x.change);
  assert.equal(t.changes.length, 3);
  assert.ok(t.courses.some((c) => c.code === 'PHYS 221' && c.transfer));
  const audit = auditDegree(ai, t.courses, { index, waivers: waiversOf(t) });
  assert.equal(audit.groups.find((g) => g.id === 'ai-breadth-course').status, 'done');
  const minor = audit.groups.find((g) => /minor/i.test(g.name));
  assert.equal(minor.status, 'done');
  assert.ok(minor.waived !== undefined);

  // undo puts everything back
  for (const c of [...t.changes]) t = undoChange(t, c.id);
  assert.equal(t.changes.length, 0);
  assert.equal(t.courses.length, 1);
  assert.equal(t.courses[0].appliesTo, undefined);
});

test('the server reads changes from the chat context', async () => {
  const { readClientContext, studentContextBlock } = await import('../js/core/context.js');
  const ctx = readClientContext({
    transcript: sample.courses, programId: 'bs-cs',
    changes: [{ kind: 'waive', group: 'Free Electives', reason: 'dean approved' }, { kind: 'bogus' }, { kind: 'note', text: 'hello' }],
  }, index);
  assert.equal(ctx.changes.length, 2);
  assert.deepEqual(ctx.waivers, [{ group: 'Free Electives', reason: 'dean approved' }]);
  const block = studentContextBlock(index, 'what is left?', ctx, programs);
  assert.match(block, /Changes the student applied/);
  assert.match(block, /Free Electives is marked as met \(dean approved\)/);
});

test('a minor is found from the courses and counted automatically (three ECON courses for an AI major)', async () => {
  const { neededItems } = await import('../js/core/planner.js');
  const ai = programs.find((p) => p.id === 'bs-artificial-intelligence');
  const rec = (code, grade, status = 'completed') => ({ code, title: '', credits: 3, grade, term: 'Fall 2025', status, transfer: false });
  const records = [rec('ECON 211', 'A'), rec('ECON 251', '', 'in-progress'), rec('ECON 311', 'B'), rec('HUM 200', 'A'), rec('SOC 303', 'A')];
  const audit = auditDegree(ai, records, { index, planned: [] });
  const minor = audit.groups.find((g) => g.id === 'minor-requirement');
  assert.equal(minor.minorSubject, 'ECON');
  // one rule: the minor shares at most ONE course with another requirement
  const hss = audit.groups.find((g) => g.type === 'hss');
  const shared = minor.courses.filter((c) => hss.courses.some((h) => h.code === c.code));
  assert.equal(shared.length, 1, `shared: ${shared.map((c) => c.code)}`);
  assert.equal(minor.creditsLeft, 15 - minor.courses.reduce((n, c) => n + c.credits, 0));
  // the shared course's credits are made up with a free elective
  const makeup = audit.groups.find((g) => g.type === 'free');
  assert.ok(makeup && makeup.credits === shared[0].credits && /also counts toward the minor/.test(makeup.note));
  const earned = records.filter((r) => r.status === 'completed').reduce((n, r) => n + r.credits, 0);
  assert.ok(audit.totals.done <= earned, `${audit.totals.done} <= ${earned}`);
  // the plan names the minor's subject; no 1-credit slots
  const items = neededItems(audit, ai, index);
  assert.ok(items.some((i) => i.label === 'ECON minor course'));
  assert.ok(items.every((i) => i.code || i.credits >= 2));
});

test('a requirement met by its courses needs no extra credits (3-credit AP for a 4-credit physics course)', async () => {
  const { neededItems } = await import('../js/core/planner.js');
  const cs = programs.find((p) => p.id === 'bs-cs');
  const rec = (code, credits, grade) => ({ code, title: '', credits, grade, term: 'Fall 2024', status: 'completed', transfer: grade === 'TR' });
  const audit = auditDegree(cs, [rec('PHYS 123', 3, 'TR'), rec('PHYS 221', 4, 'A')], { index, planned: [] });
  const sci = audit.groups.find((g) => g.id === 'science-core');
  assert.equal(sci.status, 'done');
  assert.equal(sci.creditsLeft, 0);
  assert.equal(sci.creditGap, 1);
  assert.ok(!neededItems(audit, cs, index).some((i) => i.group === 'science-core'));
  // the 1 credit is not added to what is left of the degree
  const full = auditDegree(cs, [rec('PHYS 123', 4, 'TR'), rec('PHYS 221', 4, 'A')], { index, planned: [] });
  assert.equal(audit.totals.remaining, full.totals.remaining);
});
