import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeCode, extractCodes, evaluate, treeToText, courseLeaves, missingParts } from '../js/core/prereq.js';
import { buildIndex, ancestors } from '../js/core/catalog.js';
import { search, keywordsFor, highlightPieces } from '../js/core/search.js';
import { parseClock, parseRange, buildBlocks, findConflicts, gridBounds } from '../js/core/schedule.js';
import { buildGraph, layoutGraph } from '../js/core/graph.js';

const catalog = JSON.parse(readFileSync(new URL('./data/catalog.json', import.meta.url)));
const sections = JSON.parse(readFileSync(new URL('./data/sample-sections.json', import.meta.url)));
const index = buildIndex(catalog, sections);

test('normalizeCode and extractCodes', () => {
  assert.equal(normalizeCode('cs331'), 'CS 331');
  assert.equal(normalizeCode(' math-474 '), 'MATH 474');
  assert.equal(normalizeCode('hello'), '');
  assert.deepEqual(extractCodes('Can I take cs481 with MATH 474* and CS 331?'), ['CS 481', 'MATH 474', 'CS 331']);
  assert.deepEqual(extractCodes('and 300 or CS 999', index.courses), []);
});

test('prereq tree evaluation', () => {
  const cs480 = index.get('CS 480');
  assert.equal(evaluate(cs480.prereq, { completed: new Set(['CS 331']) }), 'unmet');
  assert.equal(evaluate(cs480.prereq, { completed: new Set(['CS 331']), current: new Set(['MATH 474']) }), 'met');
  assert.equal(evaluate(cs480.prereq, { completed: new Set(['CS 331', 'MATH 475']) }), 'met');
  assert.deepEqual(missingParts(cs480.prereq, { completed: new Set(['CS 331']) }),
    ['MATH 474 (can be taken at the same time) or MATH 475 (can be taken at the same time)']);
  // text leaf -> unknown
  assert.equal(evaluate(index.get('CS 397').prereq, {}), 'unknown');
  assert.equal(evaluate(index.get('CS 115').prereq, {}), 'met');
  assert.match(treeToText(index.get('CS 351').prereq), /\(CS 331 and CS 350\) or \(CS 331 and ECE 242\)/);
});

test('leaves mark alternatives', () => {
  const leaves = courseLeaves(index.get('CS 487').prereq);
  assert.equal(leaves.find((l) => l.code === 'CS 425').alternative, false);
  assert.equal(leaves.find((l) => l.code === 'CS 331').alternative, true);
});

test('index: sections, CRNs, dependents, ancestors', () => {
  assert.equal(index.semester, 'Spring 2027');
  assert.equal(index.crnMap.get('10161').course, 'CS 331');
  const deps = index.get('CS 331').dependents.map((d) => d.code);
  for (const c of ['CS 351', 'CS 425', 'CS 430', 'CS 480', 'CS 481']) assert.ok(deps.includes(c), c);
  const anc = ancestors(index, 'CS 481', (c) => index.has(c) && !index.get(c).bridge);
  for (const c of ['CS 331', 'CS 116', 'CS 115', 'CS 201', 'MATH 474', 'MATH 251', 'MATH 152', 'MATH 151']) assert.ok(anc.has(c), c);
  assert.ok(!anc.has('CS 401'));
  assert.ok(!anc.has('ECE 242'));
});

test('search: comma list, code, CRN, words', () => {
  const r = search(index, 'CS 331, MATH 251, MATH 474');
  assert.deepEqual(r.focus, ['CS 331', 'MATH 251', 'MATH 474']);
  assert.deepEqual(r.results.slice(0, 3).map((x) => x.course.code), ['CS 331', 'MATH 251', 'MATH 474']);
  assert.equal(search(index, '10161').results[0].course.code, 'CS 331');
  assert.equal(search(index, 'cs331').results[0].course.code, 'CS 331');
  assert.equal(search(index, 'compiler').results[0].course.code, 'CS 443');
  const graphics = search(index, 'comp graphics').results.map((x) => x.course.code);
  assert.equal(graphics[0], 'CS 411');
  assert.ok(search(index, 'sokolova').results.some((x) => x.course.code === 'CS 330'));
  assert.ok(search(index, 'stuart 104').results.some((x) => x.course.code === 'CS 487'));
  assert.ok(search(index, 'deep learning').results.some((x) => x.course.code === 'CS 495'));
  const math = search(index, 'math').results.map((x) => x.course.code);
  assert.ok(math.slice(0, 5).every((c) => c.startsWith('MATH')));
  assert.ok(search(index, 'spring 2027').results.length > 10);
  assert.ok(search(index, 'mwf').results.some((x) => x.course.code === 'MATH 251'));
  assert.deepEqual(search(index, '').results, []);
  assert.deepEqual(search(index, '   ,  ,').results, []);
  assert.deepEqual(search(index, 'zzzzqqq').results, []);
  // regex characters must not throw
  assert.doesNotThrow(() => search(index, '(cs+ [*'));
});

test('keywords and highlight', () => {
  assert.deepEqual(keywordsFor('CS 331'), ['cs', '331']);
  assert.deepEqual(keywordsFor('comp computer'), ['computer']);
  const pieces = highlightPieces('Data Structures and Algorithms', ['data', 'alg']);
  assert.deepEqual(pieces.filter((p) => p.match).map((p) => p.text), ['Data', 'Alg']);
  assert.equal(pieces.map((p) => p.text).join(''), 'Data Structures and Algorithms');
});

test('schedule time parsing', () => {
  assert.equal(parseClock('10 AM'), 10);
  assert.equal(parseClock('12:40 PM'), 12 + 40 / 60);
  assert.equal(parseClock('12 AM'), 0);
  assert.ok(Number.isNaN(parseClock('TBA')));
  assert.deepEqual(parseRange('11:25 AM - 12:40 PM'), { start: 11 + 25 / 60, end: 12 + 40 / 60 });
  assert.deepEqual(parseRange('1:50 - 3:05 PM'), { start: 13 + 50 / 60, end: 15 + 5 / 60 });
  assert.equal(parseRange('TBA'), null);
});

test('schedule layout splits overlaps into columns (pop.ai algorithm)', () => {
  const mk = (crn) => {
    const s = index.crnMap.get(crn);
    return { key: crn, label: s.course, colorKey: s.course, section: s };
  };
  // CS 331 TR 10-11:15 and CS 116 TR 10-11:15 overlap; MATH 251 MWF 10-10:50 does not
  const { blocks, unscheduled } = buildBlocks([mk('10161'), mk('10131'), mk('20131'), mk('10163')]);
  assert.equal(unscheduled.length, 1); // internet section
  const tue = blocks.filter((b) => b.day === 2);
  assert.equal(tue.length, 2);
  assert.ok(tue.every((b) => b.numColumns === 2));
  assert.notEqual(tue[0].column, tue[1].column);
  const mon = blocks.filter((b) => b.day === 1);
  assert.equal(mon[0].numColumns, 1);
  const conflicts = findConflicts(blocks);
  assert.equal(conflicts.length, 1);
  assert.deepEqual([conflicts[0].a, conflicts[0].b].sort(), ['10131', '10161']);
  assert.deepEqual(gridBounds(blocks), { start: 9, end: 16, days: [1, 2, 3, 4, 5] });
});

test('graph for CS 481 and layout', () => {
  const g = buildGraph(index, ['CS 481']);
  const codes = g.nodes.map((n) => n.code);
  for (const c of ['CS 481', 'CS 331', 'MATH 474', 'MATH 475', 'MATH 251']) assert.ok(codes.includes(c), c);
  assert.ok(!codes.includes('CS 401'));
  const coreq = g.edges.find((e) => e.from === 'MATH 474' && e.to === 'CS 481');
  assert.equal(coreq.concurrent, true);
  const lay = layoutGraph(g);
  const y = (c) => lay.nodes.find((n) => n.code === c).y;
  assert.ok(y('CS 331') < y('CS 481'));
  assert.ok(y('MATH 152') < y('MATH 251'));
  // no two nodes share a spot
  const spots = new Set(lay.nodes.map((n) => `${n.x},${n.y}`));
  assert.equal(spots.size, lay.nodes.length);
  assert.equal(layoutGraph(buildGraph(index, [])).nodes.length, 0);
});

test('graph layout wraps wide layers', () => {
  const g = buildGraph(index, ['CS 331']);
  const lay = layoutGraph(g, { maxPerRow: 4 });
  const rows = new Map();
  for (const n of lay.nodes) rows.set(n.y, (rows.get(n.y) || 0) + 1);
  assert.ok([...rows.values()].every((count) => count <= 4));
  assert.equal(lay.nodes.length, g.nodes.length);
  const spots = new Set(lay.nodes.map((n) => `${n.x},${n.y}`));
  assert.equal(spots.size, lay.nodes.length);
  // every prerequisite sits above the course that needs it
  const y = new Map(lay.nodes.map((n) => [n.code, n.y]));
  for (const e of g.edges) assert.ok(y.get(e.from) < y.get(e.to), `${e.from} -> ${e.to}`);
});

test('graph with several focus courses keeps only shared dependents', () => {
  const g = buildGraph(index, ['CS 331', 'MATH 251', 'MATH 474']);
  const codes = new Set(g.nodes.map((n) => n.code));
  assert.ok(codes.has('CS 480') && codes.has('CS 481'));
  assert.ok(!codes.has('CS 425'));
  assert.ok(!codes.has('MATH 332'));
});

test('alternative flag: required in every branch is not an alternative', () => {
  const leaves = courseLeaves(index.get('CS 351').prereq);
  assert.ok(leaves.filter((l) => l.code === 'CS 331').every((l) => !l.alternative));
  assert.ok(leaves.find((l) => l.code === 'CS 350').alternative);
  assert.ok(courseLeaves(index.get('MATH 474').prereq)[0].alternative); // "or Graduate standing"
  assert.ok(!courseLeaves(index.get('CS 443').prereq)[0].alternative);
});

test('sections listed once per meeting time are merged by CRN', () => {
  const offerings = {
    semester_name: 'Spring 2027',
    courses: [{ name: 'ARCH 202', title: 'Studio', sections: { 'Spring 2027': { Class: [
      { crn: '21896', schedule_type: 'STU', available: '3', meetings: [{ days: 'W', time: '4 PM - 5:50 PM', where: 'Crown Hall', instructors: ['A B'] }] },
      { crn: '21896', schedule_type: 'STU', available: '3', meetings: [{ days: 'MF', time: '1:50 PM - 5:50 PM', where: 'Crown Hall', instructors: ['A B'] }] },
      { crn: '21896', schedule_type: 'STU', available: '3', meetings: [{ days: 'MF', time: '1:50 PM - 5:50 PM', where: 'Crown Hall', instructors: ['A B'] }] },
    ] } } }, { name: 'CHE 317', title: 'Lab course', sections: { 'Spring 2027': { Class: [
      { crn: '20659', schedule_type: 'Lecture', meetings: [{ days: 'F', time: '11:25 AM - 12:40 PM', where: '', instructors: [] }] },
      { crn: '20659', schedule_type: 'Lab', meetings: [{ days: 'F', time: '1:50 PM - 4:30 PM', where: '', instructors: [] }] },
    ] } } }],
  };
  const idx = buildIndex(catalog, offerings);
  const studio = idx.crnMap.get('21896');
  assert.equal(idx.get('ARCH 202').sections.length, 1);
  assert.deepEqual(studio.meetings.map((m) => m.days), ['W', 'MF']);
  assert.equal(idx.crnMap.get('20659').scheduleType, 'Lecture + Lab');
  const { blocks } = buildBlocks([{ key: '21896', label: 'ARCH 202', colorKey: 'ARCH 202', section: studio }]);
  assert.equal(blocks.length, 3, 'W, M, and F blocks');
});
