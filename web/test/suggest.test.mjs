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
const index = buildIndex(j('data/catalog.json'), j('data/sample-sections.json'), j('data/forecast.json'));
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
