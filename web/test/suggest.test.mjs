import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildIndex } from '../js/core/catalog.js';
import { parseTranscriptText, bestAttempts } from '../js/core/transcript.js';
import { auditDegree } from '../js/core/audit.js';
import { planSemesters, planInputs, describePlan } from '../js/core/planner.js';
import { addSuggestions, hssPartFor } from '../js/core/suggest.js';
import { evaluate } from '../js/core/prereq.js';
import { offeredIn } from '../js/core/forecast.js';
import { REPEATABLE } from '../js/core/transcript.js';

const j = (f) => JSON.parse(readFileSync(new URL(`./${f}`, import.meta.url)));
// real Spring 2027 sections: suggestions must be courses that are offered
const index = buildIndex(j('data/catalog.json'), JSON.parse(readFileSync(new URL('../../seed/spring_2027.json', import.meta.url))), j('data/forecast.json'));
const { programs } = j('data/programs.json');
const titles = new Map(index.list.map((c) => [c.code, c.title]));
const sample = parseTranscriptText(readFileSync(new URL('../samples/sample-transcript.txt', import.meta.url), 'utf8'), { catalogTitles: titles });

/** The Degree tab's rule plan with suggestions, for one program and transcript. */
function planFor(program, records) {
  const best = bestAttempts(records);
  const completed = new Set(best.filter((r) => r.status === 'completed').map((r) => r.code));
  const inProgress = new Set(best.filter((r) => r.status === 'in-progress').map((r) => r.code));
  const grades = new Map(best.filter((r) => r.grade).map((r) => [r.code, r.grade]));
  const audit = auditDegree(program, records, { index });
  const inputs = planInputs(index, { completed, inProgress, saved: [] });
  const view = describePlan(planSemesters(audit, program, index, { ...inputs, grades }), audit);
  addSuggestions(view, { index, program, audit, done: inputs.done, grades });
  return { audit, inputs, grades, view };
}

test('audit works for every program, even with few or no courses', () => {
  for (const program of programs) {
    for (const records of [[], sample.courses.slice(0, 5), sample.courses]) {
      assert.doesNotThrow(() => auditDegree(program, records, { index }), program.id);
    }
  }
});

test('humanities groups never count natural science courses', () => {
  for (const program of programs) {
    for (const g of program.groups) {
      if (/humanit/i.test(g.name)) assert.ok(!g.from?.subjects?.includes('BIOL'), `${program.id}/${g.id}`);
    }
  }
  const me = programs.find((p) => p.id === 'bs-mechanical-engineering');
  assert.equal(me.groups.find((g) => /humanities and social/i.test(g.name)).type, 'hss');
});

test('which Core Curriculum part an open slot is for', () => {
  assert.equal(hssPartFor('HUM 100-level course'), 'hum100');
  assert.equal(hssPartFor('Humanities (H) course, 200+'), 'h200');
  assert.equal(hssPartFor('Social science (S) course'), 's');
  assert.equal(hssPartFor('Social science (S) course, 200+ or another field'), 's');
  assert.equal(hssPartFor('Humanities, social science, or COM course'), 'hs-extra');
});

test('suggested courses fit the slot, are new, and are ready that term', () => {
  let checked = 0;
  for (const program of programs) {
    for (const records of [[], sample.courses.slice(0, 6), sample.courses]) {
      const { audit, inputs, grades, view } = planFor(program, records);
      const inPlan = new Set([...view.terms.flatMap((t) => t.items), ...view.later].filter((i) => i.code).map((i) => i.code));
      const finished = new Set(inputs.done);
      const run = (items, key) => {
        const current = new Set(items.filter((i) => i.code).map((i) => i.code));
        for (const it of items) {
          if (it.code || it.options?.length) { assert.deepEqual(it.suggestions, [], 'only open slots get suggestions'); continue; }
          if (/free/i.test(it.label)) assert.deepEqual(it.suggestions, [], 'free electives get none');
          assert.ok(it.suggestions.length <= 3);
          assert.equal(new Set(it.suggestions).size, it.suggestions.length);
          for (const code of it.suggestions) {
            const c = index.get(code);
            assert.ok(c, code);
            if (!REPEATABLE.has(code)) {
              assert.ok(!inputs.done.has(code) && !inPlan.has(code), `${program.id}: ${code} is taken or planned`);
              assert.ok(!audit.groups.some((g) => g.courses.some((x) => x.code === code)), `${program.id}: ${code} already counts`);
            }
            if (c.prereq) assert.equal(evaluate(c.prereq, { completed: finished, current, grades, textRules: 'plan' }), 'met', `${program.id}: ${code} prerequisites`);
            if (key && c.subject === 'CS') assert.equal(offeredIn(index.forecast, code, key), true, `${code} offered ${key}`);
            const part = hssPartFor(it.label);
            if (it.label === 'Humanities (H) course, 200+') assert.ok(/\(H\)/.test(c.satisfies) && c.level >= 200, `${code} is (H) 200+`);
            if (part === 's' && /Social science \(S\)/.test(it.label)) assert.ok(/\(S\)/.test(c.satisfies), `${code} is (S)`);
            if (it.label === 'HUM 100-level course') assert.ok(c.subject === 'HUM' && c.level === 100, code);
            checked++;
          }
        }
        for (const c of current) finished.add(c);
      };
      for (const t of view.terms) run(t.items, t.key);
      run(view.later, '');
    }
  }
  assert.ok(checked > 1000, `checked ${checked} suggestions`);
});

test('CS student: Core Curriculum slots get real courses', () => {
  const cs = programs.find((p) => p.id === 'bs-cs');
  const { view } = planFor(cs, sample.courses);
  const open = [...view.terms.flatMap((t) => t.items), ...view.later].filter((i) => !i.code && !i.options?.length);
  const ipro = open.find((i) => /ipro/i.test(i.label));
  // IPRO 497 can be repeated, so it is still suggested after the student took it once
  if (ipro) assert.deepEqual(ipro.suggestions, ['IPRO 497', 'IPRO 397']);
  assert.ok(open.some((i) => i.suggestions.length), 'at least one open slot has suggestions');
});

test('suggested courses follow what the chat discussed', async () => {
  const { chatInterests } = await import('../js/core/interests.js');
  const program = programs.find((p) => p.id === 'bs-cs');
  const base = planFor(program, sample.courses);
  const slot = (view) => view.terms.flatMap((t) => t.items).find((i) => /social science \(S\)/i.test(i.label || ''));
  assert.ok(slot(base.view)?.suggestions?.length, 'the sample plan has a social science slot');
  // the student says what interests them; the advisor names a course
  const chat = [
    { role: 'user', content: 'I am really into psychology and how people make decisions.' },
    { role: 'assistant', content: 'PSYC 221 could be a good fit.' }, // the advisor's words do not count
  ];
  const interests = chatInterests(chat);
  assert.ok(!interests.codes.has('PSYC 221') && interests.words.has('psychology'));
  const { audit, inputs, grades } = base;
  const best = bestAttempts(sample.courses);
  const completed = new Set(best.filter((r) => r.status === 'completed').map((r) => r.code));
  const inProgress = new Set(best.filter((r) => r.status === 'in-progress').map((r) => r.code));
  const view = describePlan(planSemesters(audit, program, index, { ...planInputs(index, { completed, inProgress, saved: [] }), grades }), audit);
  addSuggestions(view, { index, program, audit, done: inputs.done, grades, interests });
  const s = slot(view);
  assert.ok(s.suggestions[0].startsWith('PSYC'), `got ${s.suggestions.join(', ')}`);
  assert.ok(s.chatMatches.includes(s.suggestions[0]));
  // no chat: the old order
  assert.ok(chatInterests([]).codes.size === 0);
});

test('suggested courses are offered: sections this semester, or the forecast or sections for later terms', () => {
  let checked = 0;
  for (const program of programs.slice(0, 12)) {
    const { view } = planFor(program, sample.courses);
    for (const term of view.terms) {
      for (const it of term.items) {
        for (const code of it.suggestions || []) {
          const c = index.get(code);
          if (term.label === index.semester) assert.ok(c.sections.length, `${code} has no ${term.label} sections`);
          else assert.ok(c.sections.length || offeredIn(index.forecast, code, term.key) === true, `${code} not offered in ${term.label}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 10, `checked ${checked}`);
});

test('courses related to the major get a star too (History of AI for an AI major)', async () => {
  const { programInterests } = await import('../js/core/interests.js');
  const ai = programs.find((p) => p.name === 'B.S. in Artificial Intelligence');
  assert.ok(programInterests(ai).words.has('artificial intelligence'));
  assert.ok(!programInterests(programs.find((p) => p.name === 'B.S. in Computer Science')).words.has('b.s'));
  const { view } = planFor(ai, sample.courses);
  const starred = view.terms.flatMap((t) => t.items).flatMap((i) => i.majorMatches || []);
  assert.ok(starred.length, 'an AI major sees starred AI-related suggestions');
  for (const code of starred) {
    const c = index.get(code);
    assert.match(`${c.title} ${c.description}`, /artificial intelligence|\bA\.?I\b/i, code);
  }
});

test('option lists keep only courses offered that term', async () => {
  const { isOffered } = await import('../js/core/suggest.js');
  for (const program of programs.slice(0, 12)) {
    const { view } = planFor(program, sample.courses);
    for (const term of view.terms) for (const it of term.items) for (const c of it.options || []) assert.ok(isOffered(index, c, term.key, term.label), `${c} in ${term.label}`);
  }
});

test('one star per slot, and a starred course is starred and suggested in one slot only', async () => {
  const { chatInterests } = await import('../js/core/interests.js');
  const program = programs.find((p) => p.id === 'bs-cs');
  const { audit, inputs, grades } = planFor(program, sample.courses);
  const view = describePlan(planSemesters(audit, program, index, { ...inputs, grades }), audit);
  addSuggestions(view, { index, program, audit, done: inputs.done, grades, interests: chatInterests([{ role: 'user', content: 'I love psychology and PSYC 210' }]) });
  const items = view.terms.flatMap((t) => t.items);
  const stars = items.flatMap((i) => [...(i.chatMatches || []), ...(i.majorMatches || [])]);
  assert.ok(stars.length >= 1);
  assert.equal(new Set(stars).size, stars.length, `starred twice: ${stars}`);
  for (const i of items) assert.ok((i.chatMatches?.length || 0) + (i.majorMatches?.length || 0) <= 1, `${i.label}: ${i.chatMatches}`);
  const sugg = items.flatMap((i) => i.suggestions || []);
  for (const c of stars) assert.equal(sugg.filter((x) => x === c).length, 1, `${c} suggested more than once`);
});

test('only required courses (or ones the student named) show as one course; other picks show the requirement', async () => {
  const { slotifyChoices } = await import('../js/core/suggest.js');
  const program = programs.find((p) => p.id === 'bs-cs');
  const { audit, inputs, grades } = planFor(program, sample.courses);
  const make = (mentioned) => addSuggestions(slotifyChoices(describePlan(planSemesters(audit, program, index, { ...inputs, grades }), audit), new Set(mentioned)), { index, program, audit, done: inputs.done, grades });
  const items = make([]).terms.flatMap((t) => t.items);
  for (const i of items) if (i.code) assert.ok(['required', 'saved'].includes(i.kind), `${i.code} (${i.kind}) shown as a single course`);
  const cs = items.find((i) => i.label === 'CS elective');
  assert.ok(cs && cs.recommended && cs.suggestions[0] === cs.recommended, 'the picked elective is the first recommendation');
  // a course the student named stays as a course
  const named = make([cs.recommended]).terms.flatMap((t) => t.items);
  assert.ok(named.some((i) => i.code === cs.recommended));
});
