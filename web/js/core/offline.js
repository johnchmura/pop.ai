// Answers used when no Claude API key is set. They come only from the app's own data,
// so the app still works for prerequisites, unlocks, and schedule checks.

import { courseLeaves, treeToText } from './prereq.js';
import { ancestors } from './catalog.js';
import { relevantCodes, scheduleFacts, eligibility } from './context.js';
import { auditDegree } from './audit.js';
import { planSemesters, planInputs } from './planner.js';

function degreeAnswer(index, ctx, programs, sched) {
  const program = programs.find((p) => p.id === ctx.programId) || programs[0];
  if (!program) return 'No degree program is set up in this app yet.';
  if (!ctx.transcript?.length) {
    return 'Upload your unofficial transcript on the **Degree** tab first. Then I can list what is left for your degree and draft a semester plan.';
  }
  const planned = sched.courses.filter((c) => !ctx.completed.includes(c) && !ctx.inProgress.includes(c));
  const audit = auditDegree(program, ctx.transcript, { index, planned, waivers: ctx.waivers });
  const t = audit.totals;
  const out = [`**${program.name}:** ${t.done} of ${t.required} credits done, ${t.inProgress} in progress, ${t.remaining} still needed.`];
  const left = audit.groups.filter((g) => g.remaining.length);
  if (left.length) out.push(`Still needed:\n${left.map((g) => `- ${g.name}: ${g.remaining.join('; ')}`).join('\n')}`);
  const inputs = planInputs(index, { completed: new Set(ctx.completed), inProgress: new Set(ctx.inProgress), saved: planned });
  const plan = planSemesters(audit, program, index, { ...inputs, grades: ctx.grades, maxCredits: ctx.maxCredits });
  const first = plan.terms.find((term) => term.items.length);
  if (first) {
    out.push(`A plan for **${first.label}** (${first.credits} credits, from the tentative forecast):\n${first.items.map((i) => `- ${i.code ? `${i.code} ${i.title || ''}`.trim() : i.label}${i.kind === 'elective' ? ' (suggested elective)' : i.kind === 'saved' ? ` (saved section${i.warning ? ': prerequisites not finished before this term' : ''})` : ''}`).join('\n')}`);
  }
  return out.join('\n\n');
}

const NOTE = '_Offline mode: no Claude API key is set, so this answer comes only from the app\'s course data. Add `ANTHROPIC_API_KEY` to `.env` for full answers._';

function sectionLines(index, course) {
  if (!course.sections.length) return [`- No ${index.semester} sections in the app data.`];
  return course.sections.slice(0, 6).map((s) => {
    const m = s.meetings[0] || {};
    const seats = s.available == null ? '' : `, ${s.available} seats open`;
    return `- CRN ${s.crn}: ${s.scheduleType}, ${m.days || 'TBA'} ${m.time || 'TBA'}, ${m.where || 'TBA'}${seats}`;
  });
}

function concurrentAnswer(index, a, b) {
  const find = (x, y) => courseLeaves(index.get(x).prereq).find((l) => l.code === y);
  const ab = find(a, b);
  const ba = find(b, a);
  if (ab?.concurrent) return `**Yes.** ${b} may be taken at the same time as ${a}. The catalog marks it with an asterisk (*) in the ${a} prerequisites.`;
  if (ba?.concurrent) return `**Yes.** ${a} may be taken at the same time as ${b}. The catalog marks it with an asterisk (*) in the ${b} prerequisites.`;
  if (ab) return `**No.** ${b} is a prerequisite for ${a}, and it is not marked as "may be taken concurrently". Finish ${b} first${ab.alternative ? ', or use one of the other options in the rule' : ''}.`;
  if (ba) return `**No.** ${a} is a prerequisite for ${b}, and it is not marked as "may be taken concurrently". Finish ${a} first${ba.alternative ? ', or use one of the other options in the rule' : ''}.`;
  return `**Yes, as far as prerequisites go.** Neither course lists the other as a prerequisite. Check that their times do not overlap on the Schedule tab.`;
}

export function offlineAnswer(index, message, ctx, programs = []) {
  const text = String(message || '').toLowerCase();
  const codes = relevantCodes(index, message, { ...ctx, focus: [] });
  const out = [];
  const sched = scheduleFacts(index, ctx);

  if (/what('?s| is)? left|remaining|graduat|degree|requirement|next (semester|term)|semester plan|what should i take/.test(text)) {
    return `${degreeAnswer(index, ctx, programs, sched)}\n\n${NOTE}`;
  }

  if (!codes.length) {
    if (/schedule|conflict|overlap|credit|saved/.test(text)) {
      if (!sched.items.length) {
        out.push('You have no saved sections yet. Search for a course and press **Add** on a section.');
      } else {
        out.push(`You have ${sched.courses.length} course(s) saved: ${sched.courses.join(', ')} (${sched.credits} credits).`);
        out.push(sched.conflicts.length ? `**Time conflicts:**\n${sched.conflicts.map((c) => `- ${c}`).join('\n')}` : 'No time conflicts.');
      }
    } else {
      out.push('Ask me about a course by its code, for example:');
      out.push('- "What are the prerequisites for CS 481?"\n- "Can I take MATH 474 at the same time as CS 480?"\n- "What does CS 331 unlock?"\n- "Does my schedule have conflicts?"');
    }
    return `${out.join('\n\n')}\n\n${NOTE}`;
  }

  const [a, b] = codes;
  if (b && /same time|together|concurrent|co-?req|at once|alongside|with/.test(text)) {
    out.push(concurrentAnswer(index, a, b));
  } else {
    for (const code of codes.slice(0, 3)) {
      const c = index.get(code);
      const part = [`**${code}: ${c.title}** (${c.credits || '?'} credits)`];
      if (/unlock|lead|open|after|next|depend/.test(text)) {
        part.push(c.dependents.length
          ? `Courses that list ${code} as a prerequisite:\n${c.dependents.map((d) => `- ${d.code} ${index.get(d.code).title}${d.concurrent ? ' (can be taken at the same time)' : ''}`).join('\n')}`
          : `No course in the app data lists ${code} as a prerequisite.`);
      } else if (/when|time|section|crn|seat|room|professor|instructor|who teaches|offered/.test(text)) {
        part.push(`${index.semester} sections${index.sample ? ' (SAMPLE data)' : ''}:\n${sectionLines(index, c).join('\n')}`);
        if (c.futureTerms) part.push(`Future terms (tentative forecast): ${c.futureTerms.length ? c.futureTerms.join(', ') : 'not planned'}.`);
      } else {
        part.push(`Prerequisites: ${c.prereq ? treeToText(c.prereq) : 'none'}.`);
        if (c.note) part.push(`Note: ${c.note}`);
        const chain = [...ancestors(index, code, (x) => index.has(x) && !index.get(x).bridge)];
        if (chain.length) part.push(`Full chain (all options): ${chain.join(', ')}.`);
        const el = eligibility(index, code, ctx, sched.courses.filter((x) => x !== code));
        if (el && el.status === 'met') part.push('With your completed courses, you meet the prerequisites (minimum grades not checked).');
        if (el && el.status === 'unmet') part.push(`With your completed courses, you still need: ${el.missing.join('; ')}.`);
        if (el && el.status === 'unknown') part.push(`You still need something the app cannot check: ${el.missing.join('; ')}.`);
      }
      out.push(part.join('\n'));
    }
  }
  return `${out.join('\n\n')}\n\n${NOTE}`;
}
