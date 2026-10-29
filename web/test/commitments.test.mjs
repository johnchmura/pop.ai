import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildIndex } from '../js/core/catalog.js';
import { parseMemory, applyMemoryOps, cleanCommitment, cleanCommitments, hoursFromInput, sectionClashes, courseFits, describeCommitment, commitmentBlocks } from '../js/core/commitments.js';
import { readClientContext, studentContextBlock } from '../js/core/context.js';

const j = (f) => JSON.parse(readFileSync(new URL(`./${f}`, import.meta.url)));
const index = buildIndex(j('data/catalog.json'), j('data/sample-sections.json'), j('data/forecast.json'));
const { programs } = j('data/programs.json');

test('commitments: clean input, bad input is dropped', () => {
  const c = cleanCommitment({ label: '  Work  ', days: 'mwfx', start: 15, end: 19 });
  assert.equal(c.days, 'MWF');
  assert.equal(c.label, 'Work');
  assert.equal(cleanCommitment({ days: 'M', start: 10, end: 9 }), null);
  assert.equal(cleanCommitment({ days: '', start: 9, end: 10 }), null);
  assert.equal(cleanCommitments('nope').length, 0);
  assert.equal(hoursFromInput('14:30'), 14.5);
  assert.ok(Number.isNaN(hoursFromInput('')));
  assert.equal(describeCommitment(c), 'Work: Mon Wed Fri, 3:00pm-7:00pm');
  assert.equal(commitmentBlocks([c]).length, 3);
});

test('commitments: sections that overlap are found', () => {
  const sec = { meetings: [{ days: 'MW', time: '10 AM - 11:15 AM' }] };
  assert.equal(sectionClashes(sec, [cleanCommitment({ label: 'Job', days: 'M', start: 11, end: 13 })]).length, 1);
  assert.equal(sectionClashes(sec, [cleanCommitment({ label: 'Job', days: 'T', start: 10, end: 12 })]).length, 0);
  assert.equal(sectionClashes(sec, [cleanCommitment({ label: 'Job', days: 'M', start: 11.25, end: 12 })]).length, 0); // touching is fine
  const course = { sections: [sec] };
  assert.equal(courseFits(course, [cleanCommitment({ days: 'MWF', start: 9, end: 12 })]), false);
  assert.equal(courseFits({ sections: [] }, [cleanCommitment({ days: 'MWF', start: 9, end: 12 })]), true);
});

test('chat context lists commitments and the sections that fit', () => {
  const withSections = index.list.find((c) => c.sections.length && c.sections[0].meetings.some((m) => m.days && m.time));
  const m = withSections.sections[0].meetings.find((x) => x.days && x.time);
  const letter = m.days[0];
  const ctx = readClientContext({ busy: [{ label: 'Work', days: letter, start: 0, end: 24 }, { label: 'bad', days: 'M', start: 5, end: 1 }] }, index);
  assert.equal(ctx.busy.length, 1);
  const text = studentContextBlock(index, `tell me about ${withSections.code}`, ctx, programs);
  assert.match(text, /Time commitments the student listed/);
  assert.match(text, /Work:/);
  assert.match(text, /Sections that fit the student's commitments/);
  const none = studentContextBlock(index, 'hi', readClientContext({}, index), programs);
  assert.match(none, /Time commitments: none listed/);
});

test('advisor memory: the chat saves, replaces, and removes commitments', () => {
  const reply = 'Saved your hours.\n```advisor-memory\n[{"op":"add","label":"Work","days":"MW","start":"3:00 PM","end":"19:00"},{"op":"add","label":"Gym","days":"F","start":"07:00","end":"08:00"}]\n```';
  const { text, ops } = parseMemory(reply);
  assert.equal(text, 'Saved your hours.');
  assert.equal(ops.length, 2);
  let r = applyMemoryOps([], ops);
  assert.equal(r.busy.length, 2);
  assert.equal(r.busy[0].start, 15);
  r = applyMemoryOps(r.busy, [{ op: 'add', label: 'work', days: 'T', start: '09:00', end: '12:00' }]);
  assert.equal(r.busy.length, 2); // same name replaced
  assert.equal(r.busy.find((c) => c.label === 'work').days, 'T');
  r = applyMemoryOps(r.busy, [{ op: 'remove', label: 'Gym' }]);
  assert.equal(r.busy.length, 1);
  assert.equal(applyMemoryOps(r.busy, [{ op: 'clear' }]).busy.length, 0);
  assert.equal(applyMemoryOps([], [{ op: 'add', label: 'x', days: 'M', start: '10:00', end: '09:00' }]).notes.length, 0);
  // partial streaming text never shows the block
  assert.equal(parseMemory('Hi\n```advisor-memory\n[{"op":"ad').text, 'Hi');
});
