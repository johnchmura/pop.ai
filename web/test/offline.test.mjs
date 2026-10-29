import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildIndex } from '../js/core/catalog.js';
import { offlineAnswer } from '../js/core/offline.js';
import { readClientContext, courseDataBlock } from '../js/core/context.js';

const index = buildIndex(
  JSON.parse(readFileSync(new URL('./data/catalog.json', import.meta.url))),
  JSON.parse(readFileSync(new URL('./data/sample-sections.json', import.meta.url))),
);
const ctx = (raw = {}) => readClientContext(raw, index);

test('offline: concurrency questions', () => {
  assert.match(offlineAnswer(index, 'Can I take MATH 474 at the same time as CS 480?', ctx()), /\*\*Yes\.\*\* MATH 474 may be taken at the same time as CS 480/);
  assert.match(offlineAnswer(index, 'Can I take CS 331 with CS 351 together?', ctx()), /\*\*No\.\*\* CS 331 is a prerequisite for CS 351/);
  assert.match(offlineAnswer(index, 'can I take CS 100 and MATH 151 together', ctx()), /Neither course lists the other/);
});

test('offline: prereqs, eligibility, unlocks, sections, schedule', () => {
  const a = offlineAnswer(index, 'prereqs for cs481?', ctx({ completed: ['CS 331'] }));
  assert.match(a, /Prerequisites: \(CS 331 or CS 401/);
  assert.match(a, /you still need: MATH 474/);
  assert.match(offlineAnswer(index, 'What does CS 331 unlock?', ctx()), /CS 425 Database Organization/);
  assert.match(offlineAnswer(index, 'when is 331 offered', ctx()), /CRN 10161/);
  assert.match(offlineAnswer(index, 'any conflicts in my schedule?', ctx({ savedCrns: ['10161', '10131'] })), /overlap on TUE/);
  assert.match(offlineAnswer(index, 'hello', ctx()), /Ask me about a course/);
});

test('context: client input is cleaned', () => {
  const c = ctx({ completed: ['cs115', 'junk', 42], savedCrns: ['10161', '<script>'], query: 5, focus: 'CS 331' });
  assert.deepEqual(c.completed, ['CS 115']);
  assert.deepEqual(c.savedCrns, ['10161']);
  assert.equal(c.query, '');
  assert.deepEqual(c.focus, []);
});

test('course data block lists every course and flags sample data', () => {
  const block = courseDataBlock(index);
  assert.match(block, /SECTIONS ARE SAMPLE DATA/);
  for (const c of index.list) assert.ok(block.includes(`"code":"${c.code}"`), c.code);
});
