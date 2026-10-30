// The advisor's recommended plan. The page builds the request, the server (app/advisor/server.py)
// sends it to Claude with COURSE DATA, and the page checks the answer (prerequisites, forecast,
// credits, coverage). If Claude is not available or fails, the app's rule-based plan is used.

import { degreeContext } from './context.js';
import { normalizePlan, checkPlan } from './plan-check.js';
import { describePlan } from './planner.js';

export function planTask({ terms, maxCredits }) {
  return `PLAN TASK
Write this student's recommended semester-by-semester plan to finish their degree.

Use everything you know: the transcript and degree progress, grades, courses in progress, saved sections, the tentative future-offerings forecast, prerequisites, and anything the student said in the conversation (interests, career goals, workload, terms they want lighter, courses they want or want to avoid).

Hard rules (the app checks these and flags any break):
- Use only these terms, in order: ${terms.join(', ')}. Leave out terms after the student finishes.
- A CS or CSP course may go only in a term where its "futureTerms" lists that term.
- Every prerequisite must be done in an earlier term. A prerequisite marked as "can be taken at the same time" may be in the same term. Courses in progress now count as done.
- Do not repeat a course the student already passed or is taking now.
- Keep each term at or under ${maxCredits} credits, unless the student asked for more.
- Spread electives and IPRO: one or two per term (CS electives, Core Curriculum, IPRO, free electives), not all at the end. When that is not possible, keep them as even as you can.
- Cover every remaining requirement in DEGREE PROGRESS. Put saved sections in their term.
- For Core Curriculum, IPRO, science, communication, and free electives you may use a slot with "code": null and a "label" like "Humanities (H) course, 200+". Name a real course only when you know it from COURSE DATA or the degree requirements.
- When a requirement lets the student choose from a list (for example the AI Depth Course), do NOT pick one course. Use a slot with "code": null, "label" set to the requirement name, and "options" listing every allowed course that is in COURSE DATA.
- Pick CS electives that fit what the student said they like. If they said nothing, pick broadly useful ones and say so.

Keep the output SHORT. The plan is long, so every word counts:
- "summary": at most 2 short sentences. "tips": at most 2, under 15 words each. "assumptions": at most 2, under 15 words each.
- "reason": 6 words or fewer, and only for electives and choices. Use "" for required courses.
- Leave out "note" and "label" unless needed. Omit "credits" for courses whose credits are in COURSE DATA.
- No spaces or line breaks in the JSON.

Return ONLY one JSON object, no prose, no code fences:
{"summary":"...","graduation":"Spring 2028","terms":[{"term":"Spring 2027","courses":[{"code":"CS 450","requirement":"Computer Science Requirements","reason":""},{"code":null,"label":"AI Depth Course","options":["CS 577","CS 581"],"credits":3,"requirement":"AI Depth Course","reason":""},{"code":null,"label":"Humanities (H) 200+","credits":3,"requirement":"Humanities and Social Science Requirements","reason":""}]}],"tips":["..."],"assumptions":["..."]}
Use the exact requirement group names from the degree program.`;
}

/** The app's own plan, in the same shape as the advisor's. */
export function rulePlan(index, programs, ctx) {
  const d = degreeContext(index, ctx, programs);
  if (!d) return null;
  const described = describePlan(d.plan, d.audit, { maxCredits: ctx.maxCredits });
  const check = checkPlan(described, { index, program: d.program, records: ctx.transcript, done: d.inputs.done, grades: ctx.grades, maxCredits: ctx.maxCredits, waivers: ctx.waivers });
  return { ...described, check, program: d.program.id };
}

/** What the student says to Claude when asking for the plan: the chat so far, then the request. */
export function planUserText(messages) {
  const convo = (messages || []).slice(-24)
    .map((m) => `${m.role === 'user' ? 'Student' : 'Advisor'}: ${String(m.content).slice(0, 1500)}`)
    .join('\n');
  return `${convo ? `CONVERSATION SO FAR (most recent last):\n${convo}\n\n` : 'There has been no conversation yet.\n\n'}Make my recommended plan now.`;
}

/** Pull the first JSON object out of a reply (handles code fences and stray text). */
export function extractJsonObject(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON');
  return JSON.parse(s.slice(start, end + 1));
}

/**
 * Turn Claude's reply into a checked plan. Falls back to the rule-based plan (with `error` set).
 * reply: { text, stopReason, model } from POST /api/plan.
 */
export function finishAdvisorPlan(reply, { index, programs, ctx }) {
  const fallback = rulePlan(index, programs, ctx);
  if (!fallback) return null;
  const d = degreeContext(index, ctx, programs);
  let raw;
  try {
    raw = extractJsonObject(reply?.text);
  } catch {
    return { ...fallback, error: reply?.stopReason === 'max_tokens' ? 'The advisor’s plan was cut off. Showing the app’s plan instead.' : 'The advisor did not return a plan. Showing the app’s plan instead.' };
  }
  const saved = d.inputs.locked ? Object.values(d.inputs.locked).flat() : [];
  const { terms: planTerms, droppedTerms } = normalizePlan(raw, { index, program: d.program, audit: d.audit, saved });
  if (!planTerms.length) return { ...fallback, error: 'The advisor’s plan had no usable terms. Showing the app’s plan instead.' };
  const notes = new Map((Array.isArray(raw.terms) ? raw.terms : []).map((t) => [String(t?.term || '').toLowerCase(), String(t?.note || '').slice(0, 240)]));
  for (const t of planTerms) t.note = notes.get(t.label.toLowerCase()) || '';
  const plan = {
    source: 'claude',
    model: String(reply?.model || ''),
    summary: String(raw.summary || '').slice(0, 600),
    graduation: String(raw.graduation || '').slice(0, 40),
    tips: (Array.isArray(raw.tips) ? raw.tips : []).filter((x) => typeof x === 'string').slice(0, 5).map((x) => x.slice(0, 240)),
    assumptions: (Array.isArray(raw.assumptions) ? raw.assumptions : []).filter((x) => typeof x === 'string').slice(0, 5).map((x) => x.slice(0, 240)),
    terms: planTerms,
    later: [],
    program: d.program.id,
  };
  if (droppedTerms.length) plan.assumptions.push(`Left out terms the app has no forecast for: ${droppedTerms.join(', ')}.`);
  plan.check = checkPlan(plan, { index, program: d.program, records: ctx.transcript, done: d.inputs.done, grades: ctx.grades, maxCredits: ctx.maxCredits, waivers: ctx.waivers });
  return plan;
}
