// Degree tab: transcript upload, degree audit, and semester plan.

import { detectProgram } from '../core/detect.js';
import { waiversOf, describeChange, undoChange } from '../core/changes.js';
import { parseTranscriptText, linesFromPdfItems, gradeStatus, cleanRecords, bestAttempts, REPEATABLE } from '../core/transcript.js';
import { auditDegree } from '../core/audit.js';
import { planSemesters, planInputs, describePlan } from '../core/planner.js';
import { checkPlan } from '../core/plan-check.js';
import { addSuggestions } from '../core/suggest.js';
import { normalizeCode } from '../core/prereq.js';
import { esc } from './util.js';

const MAX_FILE = 8 * 1024 * 1024;
const STATUS_TEXT = { done: 'Done', 'in-progress': 'In progress', planned: 'Planned', remaining: 'Needed' };

// ---------- reading files ----------

let pdfjsPromise = null;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('/vendor/pdfjs/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
      return lib;
    });
  }
  return pdfjsPromise;
}

async function pdfToText(file) {
  const lib = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await lib.getDocument({ data, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= Math.min(doc.numPages, 30); i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(linesFromPdfItems(content.items));
  }
  await doc.destroy();
  return pages.join('\n');
}

const kindOf = (file) => {
  const name = (file.name || '').toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (/^image\/(png|jpeg|gif|webp)$/.test(file.type) || /\.(png|jpe?g|gif|webp)$/.test(name)) return 'image';
  if (/\.(html?|txt|text|csv)$/.test(name) || /^text\//.test(file.type)) return 'text';
  return 'unknown';
};

function fileToBase64(file) {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1] || '');
    r.onerror = () => fail(new Error('Could not read the file.'));
    r.readAsDataURL(file);
  });
}

function imageMediaType(file) {
  if (file.type) return file.type;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] || 'image/png';
}

// ---------- rendering ----------

const KIND = {
  saved: { tag: 'Saved section', cls: 'k-saved' },
  required: { tag: 'Required', cls: 'k-req' },
  choice: { tag: '', cls: 'k-choice' },
  elective: { tag: 'CS elective', cls: 'k-elec' },
  placeholder: { tag: '', cls: 'k-open' },
};

function pill(status) {
  return `<span class="req-pill ${status}">${STATUS_TEXT[status] || status}</span>`;
}

function courseChip(c, known) {
  const cls = c.status === 'completed' ? 'done' : c.status === 'in-progress' ? 'ip' : 'pl';
  const label = `${c.code}${c.grade ? ` · ${c.grade}` : c.status === 'in-progress' ? ' · now' : c.status === 'planned' ? ' · saved' : ''}`;
  const tip = `${c.code}${c.title ? `: ${c.title}` : ''} — ${c.status === 'completed' ? 'completed' : c.status === 'in-progress' ? 'in progress' : 'planned (saved section)'}`;
  return known(c.code)
    ? `<button type="button" class="req-chip ${cls}" data-code="${esc(c.code)}" title="${esc(tip)}">${esc(label)}</button>`
    : `<span class="req-chip ${cls}" title="${esc(tip)}">${esc(label)}</span>`;
}

function linkify(text, known) {
  return esc(text).replace(/\b([A-Z]{2,4}) (\d{3})\b/g, (m) => (known(m) ? `<button type="button" class="code-link" data-code="${m}">${m}</button>` : m));
}

/** One course row in a term card. */
function planRow(it, known, titleOf = () => '', addButton = () => '') {
  const k = KIND[it.kind] || KIND.choice;
  const tag = k.tag || it.requirement || '';
  const name = it.code
    ? `${known(it.code) ? `<button type="button" class="code-link pr-code" data-code="${esc(it.code)}">${esc(it.code)}</button>` : `<span class="pr-code">${esc(it.code)}</span>`}<span class="pr-title">${esc(it.title || '')}</span>`
    : `<span class="pr-code open">${esc(it.label || it.requirement || 'Elective')}</span>`;
  // "One of A, B, C" repeats the options list shown above it
  const reason = !it.code && it.options?.length && /^One of /.test(it.reason || '') ? '' : (it.reason || '');
  const issues = [...(it.issues || []), ...(it.warning ? [{ level: 'warn', message: it.warning }] : [])];
  const plainReason = reason.replace(/\s+/g, ' ').trim();
  return `<li class="pr ${k.cls}"${plainReason ? ` title="${esc(plainReason)}"` : ''}>
      <div class="pr-top">
        <div class="pr-name">${name}</div>
        <span class="pr-cr">${esc(it.credits)} cr</span>
        ${addButton(it.code)}
      </div>
      ${it.suggestions?.length ? `<div class="pr-options pr-suggest">${it.suggestions.map((c) => {
    const title = titleOf(c);
    const fromChat = it.chatMatches?.includes(c);
    return `<button type="button" class="code-link sug${fromChat ? ' chat' : ''}" data-code="${esc(c)}" title="${esc(`${title ? `${c}: ${title}` : c}${fromChat ? ' · matches your chat' : ''}`)}">${fromChat ? '<span class="sug-star" aria-label="Matches your chat">★</span>' : ''}${esc(c)}${title ? `<span class="sug-title"> ${esc(title)}</span>` : ''}</button>`;
  }).join('')}</div>` : ''}
      ${it.options?.length ? `<div class="pr-options"><span class="small muted">${it.code ? 'Or' : 'Pick one'}:</span> ${it.options.filter((c) => known(c)).map((c) => `<button type="button" class="code-link${it.chatMatches?.includes(c) ? ' chat' : ''}" data-code="${esc(c)}"${it.chatMatches?.includes(c) ? ' title="Matches your chat"' : ''}>${it.chatMatches?.includes(c) ? '★ ' : ''}${esc(c)}</button>`).join(' ')}</div>` : ''}
      ${tag ? `<div class="pr-sub"><span class="pr-tag">${esc(tag)}</span></div>` : ''}
      ${issues.map((x) => `<div class="pr-issue ${x.level}">${x.level === 'error' ? '⚠' : '•'} ${esc(x.message)}</div>`).join('')}
    </li>`;
}

function termCard(term, i, firstIdx, known, titleOf, addFor) {
  return `<section class="term${i === firstIdx ? ' next' : ''}">
      <header class="term-head">
        <h3>${i === firstIdx ? '<span class="next-badge">Next</span>' : ''}${esc(term.label)}</h3>
        <span class="term-cr">${term.credits} credits</span>
      </header>
      ${term.note ? `<p class="term-note">${esc(term.note)}</p>` : ''}
      <ul class="term-list">${term.items.map((it) => planRow(it, known, titleOf, addFor(term))).join('')}</ul>
    </section>`;
}

/** Grouped list of programs, by college. */
function programOptions(programs, selectedId) {
  const groups = new Map();
  for (const p of programs) {
    const key = p.college || 'Programs';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return [...groups].map(([college, list]) => `<optgroup label="${esc(college)}">${list
    .slice().sort((a, b) => a.name.localeCompare(b.name))
    .map((x) => `<option value="${esc(x.id)}"${x.id === selectedId ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>`).join('');
}

/** The "we found your program" banner, with a way to change it. */
function programBanner(programs, program, transcript) {
  const d = transcript.detected;
  const alts = (d?.alternatives || []).map((a) => programs.find((p) => p.id === a.id)).filter((p) => p && p.id !== program.id);
  let tone = 'info';
  let title = `Your program: <strong>${esc(program.name)}</strong>`;
  let text = transcript.chosenByUser ? 'You chose this program.' : 'Pick your program so the plan fits you.';
  if (d && !transcript.chosenByUser) {
    if (d.confidence === 'high') { tone = 'ok'; title = `We found your program: <strong>${esc(program.name)}</strong>`; text = d.reason; }
    else { tone = 'warn'; title = `We think your program is <strong>${esc(program.name)}</strong>`; text = `${d.reason} Please check it.`; }
  }
  return `<div class="program-banner ${tone}">
      <div class="pb-text"><p class="pb-title">${title}</p><p class="small muted">${esc(text)}</p></div>
      <label class="pb-pick small muted">Not right? Change program
        <select id="program-select" aria-label="Degree program">${programOptions(programs, program.id)}</select>
      </label>
      ${alts.length ? `<div class="pb-alts small muted">Other likely matches: ${alts.map((p) => `<button type="button" class="link-btn" data-set-program="${esc(p.id)}">${esc(p.name)}</button>`).join(' · ')}</div>` : ''}
    </div>`;
}

/** Optional specializations and concentrations: how many of their courses the student has. */
function tracksCard(program, completed, inProgress) {
  if (!program.tracks?.length) return '';
  const rows = program.tracks.map((t) => {
    const total = t.codes.length;
    const done = t.codes.filter((c) => completed.has(c)).length;
    const ip = t.codes.filter((c) => inProgress.has(c)).length;
    const bar = total ? `<span class="mini-bar" role="img" aria-label="${done} of ${total} courses done"><i style="width:${(done / total * 100).toFixed(0)}%"></i></span>` : '';
    return `<li><div><strong>${esc(t.name)}</strong> <span class="muted small">${esc(t.kind)}</span>${t.note ? `<p class="small muted">${esc(t.note)}</p>` : ''}</div>${total ? `<div class="track-count small">${bar}<span>${done}${ip ? ` + ${ip} in progress` : ''} of ${total} listed courses</span></div>` : ''}</li>`;
  }).join('');
  return `<details class="card tracks-card"><summary><h2 class="card-title">Specializations and concentrations <span class="muted small">optional</span></h2></summary>
      <p class="small muted">Optional paths. Not part of the credit total.</p>
      <ul class="track-list">${rows}</ul></details>`;
}

/**
 * Render the whole Degree tab body.
 * ctx: { index, programs, transcript, savedCourses, known, plan: { view, ai, aiStale, busy, error }, hasClaude }
 * Returns { audit, ruleView, shown } (or null when there is no transcript).
 */
export function renderDegree(el, ctx) {
  const { index, programs, transcript, known } = ctx;
  const program = programs.find((p) => p.id === transcript?.programId) || programs[0];
  if (!transcript?.courses?.length || !program) {
    el.innerHTML = '';
    return null;
  }
  const tableWasOpen = !!el.querySelector('details.t-card[open]');
  const reqsWereOpen = !!el.querySelector('details.all-reqs[open]');
  const best = bestAttempts(transcript.courses);
  const completed = new Set(best.filter((r) => r.status === 'completed').map((r) => r.code));
  const inProgress = new Set(best.filter((r) => r.status === 'in-progress').map((r) => r.code));
  const grades = new Map(best.filter((r) => r.grade).map((r) => [r.code, r.grade]));
  const planned = [...ctx.savedCourses].filter((c) => !completed.has(c) && !inProgress.has(c));
  const waivers = waiversOf(transcript);
  const audit = auditDegree(program, transcript.courses, { index, planned, waivers });
  const maxCredits = transcript.maxCredits || 15;
  const inputs = planInputs(index, { completed, inProgress, saved: planned });
  const rule = planSemesters(audit, program, index, { ...inputs, grades, maxCredits });
  const ruleView = describePlan(rule, audit, { maxCredits });
  // real courses that fit each open slot (Core Curriculum, electives), shown under the slot
  const suggestCtx = { index, program, audit, done: inputs.done, grades, interests: ctx.interests || null };
  addSuggestions(ruleView, suggestCtx);
  const titleOf = (code) => index.get(code)?.title || '';
  // Add buttons only in the term the sections are for (the schedule semester)
  const addFor = (term) => (term.label === index.semester && ctx.addButton ? (code) => (code ? ctx.addButton(code) : '') : () => '');

  // which plan to show: the advisor's (if made and chosen) or the app's
  const p = ctx.plan || {};
  const useAi = p.view === 'advisor' && p.ai;
  const shown = useAi ? addSuggestions(JSON.parse(JSON.stringify(p.ai)), suggestCtx) : ruleView;
  const check = checkPlan(shown, { index, program, records: transcript.courses, done: inputs.done, grades, maxCredits, waivers });
  const t = audit.totals;
  const pct = (n) => `${Math.max(0, Math.min(100, (n / t.required) * 100)).toFixed(1)}%`;
  const usedTerms = shown.terms.filter((x) => x.items.length);
  const firstIdx = shown.terms.findIndex((x) => x.items.length);
  const graduation = shown.graduation || (!shown.later?.length && usedTerms.length ? usedTerms[usedTerms.length - 1].label : '');

  // a program the student chose, or one the transcript names for sure, needs no banner: just a menu to change it
  const sure = transcript.chosenByUser || transcript.detected?.confidence === 'high';

  // ----- 1. summary -----
  const headline = !usedTerms.length && !shown.later?.length
    ? 'Every requirement is done or in progress 🎓'
    : graduation ? `On track to finish in <strong>${esc(graduation)}</strong>` : `<strong>${t.remaining}</strong> credits to go`;
  let html = `<div class="card degree-hero">
      <div class="hero-top">
        <div>
          ${sure && programs.length > 1
            ? `<label class="program-inline"><span class="sr-only">Degree program</span><select id="program-select" title="Change program">${programOptions(programs, program.id)}</select></label>`
            : `<p class="eyebrow-sm">${esc(program.name)}</p>`}
          <h2 class="hero-line">${headline}</h2>
        </div>
      </div>
      ${programs.length > 1 && !sure ? programBanner(programs, program, transcript) : ''}
      <div class="progress" role="img" aria-label="${t.done} credits done, ${t.inProgress} in progress, ${t.planned} saved, ${t.remaining} to go, out of ${t.required}">
        <span class="p-done" style="width:${pct(t.done)}"></span><span class="p-ip" style="width:${pct(t.inProgress)}"></span><span class="p-pl" style="width:${pct(t.planned)}"></span>
      </div>
      <ul class="legend-row">
        <li><i class="dot done"></i><strong>${t.done}</strong> done</li>
        <li><i class="dot ip"></i><strong>${t.inProgress}</strong> in progress</li>
        ${t.planned ? `<li><i class="dot pl"></i><strong>${t.planned}</strong> saved for ${esc(index.semester)}</li>` : ''}
        <li><i class="dot togo"></i><strong>${t.remaining}</strong> to go</li>
        <li class="muted">of ${t.required} credits</li>
      </ul>
    </div>`;

  // ----- 2. recommended plan -----
  const errors = check.issues.filter((x) => x.level === 'error').length;
  const warns = check.issues.filter((x) => x.level === 'warn').length;
  const checkLine = errors
    ? `<span class="chk bad">⚠ ${errors} problem${errors === 1 ? '' : 's'} found</span>`
    : warns ? `<span class="chk warn">Checked · ${warns} note${warns === 1 ? '' : 's'}</span>` : '<span class="chk ok" title="Prerequisites, future offerings, and credits all fit">✓ Checked</span>';
  const source = useAi ? `<span class="src ai">Made by the advisor${p.ai.model ? ` · ${esc(p.ai.model)}` : ''}</span>` : '';
  let actions = '';
  if (ctx.hasClaude) {
    actions += p.busy
      ? '<button type="button" class="btn primary" disabled><span class="spin"></span> The advisor is building your plan…</button>'
      : `<button type="button" class="btn primary" data-build-plan>${p.ai ? 'Update plan' : '✨ Personalize with the advisor'}</button>`;
    if (p.ai && !p.busy) actions += `<button type="button" class="btn" data-plan-view="${useAi ? 'rules' : 'advisor'}">${useAi ? 'Basic plan' : 'Advisor’s plan'}</button>`;
  }
  actions += '<button type="button" class="btn" data-ask-plan>Ask about it</button>';
  const nextCodes = firstIdx >= 0 ? shown.terms[firstIdx].items.filter((i) => i.code).map((i) => i.code) : [];
  if (nextCodes.length) actions += `<button type="button" class="btn" data-plan-search="${esc(nextCodes.join(', '))}">Find ${esc(shown.terms[firstIdx].label)} sections</button>`;

  html += `<div class="card plan-card">
      <div class="plan-head">
        <div>
          <h2 class="card-title">Plan</h2>
          <div class="plan-meta">${source}${checkLine}</div>
        </div>
        <label class="small muted plan-max">Credits per term
          <select id="max-credits">${[12, 13, 15, 16, 18].map((n) => `<option value="${n}"${n === maxCredits ? ' selected' : ''}>${n}</option>`).join('')}</select>
        </label>
      </div>
      ${p.error ? `<p class="plan-alert">${esc(p.error)}</p>` : ''}
      ${useAi && p.aiStale ? '<p class="plan-alert">Your courses or saved sections changed since the advisor made this plan. Update it to include the changes.</p>' : ''}
      <div class="plan-actions">${actions}</div>
      ${useAi && shown.summary ? `<p class="plan-summary">${linkify(shown.summary, known)}</p>` : ''}`;
  if (usedTerms.length) {
    html += `<div class="timeline">${shown.terms.map((term, i) => (term.items.length ? termCard(term, i, firstIdx, known, titleOf, addFor) : '')).join('')}</div>`;
  }
  if (shown.later?.length) {
    html += `<section class="term later"><header class="term-head"><h3>Not placed yet</h3></header><ul class="term-list">${shown.later.map((it) => planRow({ ...it, issues: [{ level: 'warn', message: it.reason }], reason: '' }, known, titleOf)).join('')}</ul></section>`;
  }
  const general = check.issues.filter((x) => !x.code && x.term == null);
  const termWide = check.issues.filter((x) => !x.code && x.term != null);
  if (general.length || termWide.length) {
    html += `<ul class="plan-issues">${[...termWide, ...general].map((x) => `<li class="${x.level}">${esc(x.message)}</li>`).join('')}</ul>`;
  }
  if (useAi && (shown.tips?.length || shown.assumptions?.length)) {
    html += '<div class="plan-notes">';
    if (shown.tips?.length) html += `<div><h4>Tips</h4><ul>${shown.tips.map((x) => `<li>${linkify(x, known)}</li>`).join('')}</ul></div>`;
    if (shown.assumptions?.length) html += `<div><h4>Assumptions</h4><ul>${shown.assumptions.map((x) => `<li>${linkify(x, known)}</li>`).join('')}</ul></div>`;
    html += '</div>';
  }
  html += '</div>';

  // ----- 2b. changes from the chat or the student -----
  if (transcript.changes?.length) {
    html += `<div class="card changes-card">
        <div class="card-head"><h2 class="card-title">Your changes</h2></div>
        <ul class="change-list">${transcript.changes.map((c) => `<li><span>${esc(describeChange(c))}</span><button type="button" class="link-btn" data-undo-change="${esc(c.id)}">Undo</button></li>`).join('')}</ul>
      </div>`;
  }

  // ----- 3. what's left -----
  const left = audit.groups.filter((g) => g.status === 'remaining');
  // lets the student apply a course by hand, like an adviser exception in Degree Works
  const applyOptions = best.filter((r) => r.status === 'completed' || r.status === 'in-progress')
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((r) => `<option value="${esc(r.code)}">${esc(r.code)}${r.title ? ` ${esc(r.title)}` : ''}</option>`).join('');
  const doneGroups = audit.groups.filter((g) => g.status !== 'remaining');
  html += `<div class="card left-card">
      <div class="card-head"><h2 class="card-title">What’s left</h2><span class="small muted">${doneGroups.length}/${audit.groups.length} done</span></div>
      ${left.length ? `<ul class="left-list">${left.map((g) => `<li>
          <div class="left-head"><span class="left-name">${esc(g.name)}</span><span class="left-cr">${g.creditsLeft || '—'} cr left</span></div>
          <ul>${g.remaining.map((r) => `<li>${linkify(r, known)}</li>`).join('')}</ul>
        </li>`).join('')}</ul>` : '<p>Nothing left. 🎓</p>'}
      ${doneGroups.length ? `<div class="done-row">${doneGroups.map((g) => `<span class="done-chip ${g.status}">${g.status === 'done' ? '✓' : '◐'} ${esc(g.name)}</span>`).join('')}</div>` : ''}
      <details class="all-reqs"${reqsWereOpen ? ' open' : ''}><summary>All requirements</summary><ul class="req-list">`;
  for (const g of audit.groups) {
    const have = g.done + g.inProgress + g.planned;
    html += `<li class="req">
        <div class="req-head"><span class="req-name">${esc(g.name)}</span>${pill(g.status)}<span class="req-cr">${Math.min(have, g.credits)}/${g.credits} cr</span></div>
        <div class="req-bar"><span class="p-done" style="width:${Math.min(100, (g.done / g.credits) * 100)}%"></span><span class="p-ip" style="width:${Math.min(100, (g.inProgress / g.credits) * 100)}%"></span><span class="p-pl" style="width:${Math.min(100, (g.planned / g.credits) * 100)}%"></span></div>
        ${g.courses.length ? `<div class="req-chips">${g.courses.map((c) => courseChip(c, known)).join('')}</div>` : ''}
        ${g.waived ? `<p class="req-note"><strong>Marked as met:</strong> ${esc(g.waived)}</p>` : ''}
        ${g.note ? `<p class="req-note">${esc(g.note)}</p>` : ''}
        ${g.status === 'remaining' && (g.type === 'all' || g.type === 'pick') && applyOptions ? `<label class="small muted apply-pick">Adviser counted a course here?
            <select data-apply-group="${esc(g.name)}"><option value="">Pick the course…</option>${applyOptions}</select></label>` : ''}
      </li>`;
  }
  html += '</ul>';
  if (audit.extra.length) html += `<p class="small muted">Extra credit beyond the degree: ${audit.extra.map((e) => esc(e.code)).join(', ')}</p>`;
  html += '</details></div>';

  // ----- 4. transcript courses (editable) -----
  const rows = transcript.courses.map((r, i) => `<tr class="${r.status === 'not-counted' || r.repeatExcluded ? 'muted-row' : ''}">
      <td><strong>${esc(r.code)}</strong></td>
      <td class="t-title">${esc(r.title)}</td>
      <td>${esc(r.term)}</td>
      <td><input class="t-in" type="number" min="0" max="12" step="0.5" value="${r.credits ?? ''}" data-edit="credits" data-i="${i}" aria-label="Credits for ${esc(r.code)}"></td>
      <td><input class="t-in g" type="text" maxlength="3" value="${esc(r.grade)}" data-edit="grade" data-i="${i}" aria-label="Grade for ${esc(r.code)}" placeholder="—"></td>
      <td class="t-status">${r.repeatExcluded ? 'Repeat (excluded)' : r.status === 'completed' ? (r.transfer ? 'Transfer' : 'Done') : r.status === 'in-progress' ? 'In progress' : 'Not counted'}</td>
      <td><button type="button" class="saved-remove" data-del="${i}" aria-label="Remove ${esc(r.code)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></td>
    </tr>`).join('');
  html += `<details class="card t-card"${tableWasOpen ? ' open' : ''}>
      <summary><span class="card-title">Transcript courses (${transcript.courses.length})</span><span class="small muted">Fix anything read wrong</span></summary>
      ${transcript.warnings?.length ? `<ul class="t-warn">${transcript.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <div class="t-scroll"><table class="t-table">
        <thead><tr><th>Course</th><th>Title</th><th>Term</th><th>Credits</th><th>Grade</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <form class="t-add" id="t-add">
        <input name="code" placeholder="Add a course, e.g. COM 421" aria-label="Course code" required>
        <input name="credits" type="number" min="0" max="12" step="0.5" placeholder="Credits" aria-label="Credits">
        <input name="grade" maxlength="3" placeholder="Grade" aria-label="Grade (leave empty if in progress)">
        <button type="submit" class="btn">Add</button>
      </form>
      <p class="hint">Leave the grade empty for a course you are taking now. Grades like W, F, and I do not count.</p>
    </details>`;

  // ----- 4b. specializations -----
  html += tracksCard(program, completed, inProgress);

  // ----- 5. notes -----
  html += `<details class="card notes-card"><summary class="small muted"><strong>Planning aid, not an official audit.</strong> Confirm with your advisor.</summary><ul class="small muted">
      ${program.notes.map((n) => `<li>${esc(n)}</li>`).join('')}
      <li>Future offerings come from the CS department’s tentative schedule (${esc(index.forecast?.terms?.map((x) => x.label).join(', ') || 'none loaded')}). Non-CS courses are assumed to run every term.</li>
      <li>Requirements: <a href="${esc(program.source)}" target="_blank" rel="noopener noreferrer">${esc(program.name)} in the IIT catalog</a>.</li>
    </ul></details>`;

  el.innerHTML = html;
  return { audit, ruleView, shown, check, source: useAi ? 'claude' : 'rules' };
}

// ---------- wiring ----------

/**
 * els: { drop, file, pasteToggle, pasteBox, pasteText, pasteGo, sample, status, body, clear }
 * hooks: { getTranscript, setTranscript(t), rerender(), hasClaude(), onCode(code), askPlan(text), catalogTitles }
 */
export function wireDegree(els, hooks) {
  let lastInput = null; // { kind, file?, text? } for "Read with Claude"

  const status = (html, kind = '') => {
    els.status.className = `upload-status ${kind}`;
    els.status.innerHTML = html;
  };

  // Pick the program from the transcript. A choice the student made by hand is kept.
  const apply = (courses, source, warnings = [], { headerText = '', majors = [] } = {}) => {
    const prev = hooks.getTranscript();
    const programs = hooks.getPrograms?.() || [];
    let programId = prev?.programId;
    let detected = prev?.detected;
    let chosenByUser = prev?.chosenByUser;
    const found = detectProgram(courses, programs, { headerText, majors });
    // a program the student picked by hand stays unless the new transcript names a program for sure
    if (found && !(chosenByUser && found.confidence !== 'high')) {
      programId = found.programId;
      detected = { confidence: found.confidence, reason: found.reason, alternatives: found.alternatives };
      chosenByUser = false;
    } else if (!found && !chosenByUser) {
      detected = undefined;
    }
    // keep the changes the student already applied (adviser exceptions, waivers, notes, added courses)
    const changes = prev?.changes || [];
    let merged = courses;
    for (const c of changes) {
      if (c.kind === 'apply') merged = merged.map((r) => (r.code === c.code ? { ...r, appliesTo: c.group } : r));
      else if (c.kind === 'add-course' && !merged.some((r) => r.code === c.record.code)) merged = [...merged, { ...c.record }];
    }
    hooks.setTranscript({
      courses: merged,
      source,
      warnings,
      programId,
      detected,
      chosenByUser,
      changes,
      maxCredits: prev?.maxCredits || 15,
    });
  };

  const claudeButton = () => (hooks.hasClaude()
    ? ' <button type="button" class="btn" data-read-claude>Read with Claude</button>'
    : ' Ask the site owner to add a Claude API key to read scanned files, or paste the text instead.');

  async function handleText(text, source, note = '') {
    const { courses, warnings } = parseTranscriptText(text, { catalogTitles: hooks.catalogTitles });
    if (courses.length >= 3) {
      apply(courses, source, warnings, { headerText: text });
      status(`${note}Read <strong>${courses.length}</strong> course rows from ${esc(source)}. Check the list below if anything looks wrong.${hooks.hasClaude() ? ' <button type="button" class="link-btn" data-read-claude>Read again with Claude</button>' : ''}`, note ? 'warn' : 'ok');
    } else {
      status(`${note}Only found ${courses.length} course row${courses.length === 1 ? '' : 's'} in ${esc(source)}. It may be a scanned or unusual file.${claudeButton()}`, 'warn');
    }
  }

  /** Uploads and pasted text: Claude reads them by default; the app's own parser is the fallback. */
  async function readInput(text, source) {
    if (hooks.hasClaude()) {
      const err = await readWithClaude();
      if (!err) return;
      if (!text?.trim()) { status(`${esc(err)}${claudeButton()}`, 'warn'); return; }
      await handleText(text, source, `Claude could not read it (${esc(err)}), so the app's parser read it instead. `);
      return;
    }
    await handleText(text, source);
  }

  async function handleFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE) { status('That file is larger than 8 MB. Try the PDF from Banner, or paste the text.', 'warn'); return; }
    const kind = kindOf(file);
    lastInput = { kind, file };
    try {
      if (kind === 'pdf') {
        status('Reading the PDF…');
        const text = await pdfToText(file).catch(() => '');
        lastInput.text = text;
        if (!text.trim() && !hooks.hasClaude()) { status(`This PDF has no text layer (it may be a scan).${claudeButton()}`, 'warn'); return; }
        await readInput(text, file.name);
      } else if (kind === 'text') {
        const text = await file.text();
        lastInput.text = text;
        await readInput(text, file.name);
      } else if (kind === 'image') {
        if (!hooks.hasClaude()) { status(`Images need Claude to read them.${claudeButton()}`, 'warn'); return; }
        await readInput('', file.name);
      } else {
        status('Use a PDF, HTML, TXT, PNG, or JPG file.', 'warn');
      }
    } catch (err) {
      console.error(err);
      status(`Could not read that file (${esc(err.message || 'unknown error')}). Try pasting the text instead.`, 'warn');
    }
  }

  /** Send the last upload to Claude. Returns '' when it worked, else the error message. */
  async function readWithClaude() {
    if (!lastInput) return 'Nothing to read.';
    status('Claude is reading your transcript… this can take up to a minute.');
    try {
      let body;
      if (lastInput.file && (lastInput.kind === 'pdf' || lastInput.kind === 'image')) {
        body = { file: { mediaType: lastInput.kind === 'pdf' ? 'application/pdf' : imageMediaType(lastInput.file), data: await fileToBase64(lastInput.file) } };
      } else {
        body = { text: lastInput.text || '' };
      }
      const res = await fetch('/api/transcript', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
      const courses = cleanRecords(data.courses);
      if (!courses.length) throw new Error('Claude did not find any courses in that file');
      apply(courses, `${lastInput.file?.name || 'pasted text'} (read by Claude)`, data.warnings || [], { headerText: lastInput.text || '', majors: data.majors || [] });
      status(`Claude read <strong>${courses.length}</strong> course rows. Check the list below.`, 'ok');
      return '';
    } catch (err) {
      const msg = err.message || 'Claude could not read the transcript';
      status(esc(msg), 'warn');
      return msg;
    }
  }

  // drag and drop + file picker
  els.drop.addEventListener('click', (e) => { if (!e.target.closest('button')) els.file.click(); });
  els.drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.file.click(); } });
  els.drop.addEventListener('dragover', (e) => { e.preventDefault(); els.drop.classList.add('over'); });
  els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
  els.drop.addEventListener('drop', (e) => { e.preventDefault(); els.drop.classList.remove('over'); handleFile(e.dataTransfer.files[0]); });
  els.file.addEventListener('change', () => { handleFile(els.file.files[0]); els.file.value = ''; });
  els.pick.addEventListener('click', () => els.file.click());
  els.pasteToggle.addEventListener('click', () => { els.pasteBox.hidden = !els.pasteBox.hidden; if (!els.pasteBox.hidden) els.pasteText.focus(); });
  els.pasteGo.addEventListener('click', () => {
    const text = els.pasteText.value;
    if (!text.trim()) return;
    lastInput = { kind: 'text', text };
    readInput(text, 'pasted text');
  });
  els.sample.addEventListener('click', async () => {
    const text = await (await fetch('/samples/sample-transcript.txt')).text();
    lastInput = { kind: 'text', text };
    await handleText(text, 'the sample transcript (made-up student)');
  });
  els.clear.addEventListener('click', () => {
    hooks.setTranscript(null);
    status('Transcript cleared from this browser.');
  });
  els.status.addEventListener('click', (e) => { if (e.target.closest('[data-read-claude]')) readWithClaude(); });

  // edits in the body
  els.body.addEventListener('change', (e) => {
    const t = hooks.getTranscript();
    if (!t) return;
    if (e.target.id === 'program-select') { hooks.setTranscript({ ...t, programId: e.target.value, chosenByUser: true, detected: undefined }); return; }
    if (e.target.dataset.applyGroup !== undefined) {
      const code = e.target.value;
      if (!code) return;
      hooks.setTranscript({ ...t, courses: t.courses.map((c) => (c.code === code ? { ...c, appliesTo: e.target.dataset.applyGroup } : c)) });
      return;
    }
    if (e.target.id === 'max-credits') { hooks.setTranscript({ ...t, maxCredits: Number(e.target.value) }); return; }
    const input = e.target.closest('[data-edit]');
    if (!input) return;
    const i = Number(input.dataset.i);
    const rec = { ...t.courses[i] };
    if (input.dataset.edit === 'credits') rec.credits = input.value === '' ? null : Math.max(0, Math.min(12, Number(input.value)));
    if (input.dataset.edit === 'grade') {
      rec.grade = input.value.trim().toUpperCase();
      rec.status = gradeStatus(rec.grade, rec.transfer ? 'transfer' : '');
      rec.repeatExcluded = false;
    }
    const courses = t.courses.slice();
    courses[i] = rec;
    hooks.setTranscript({ ...t, courses });
  });
  els.body.addEventListener('click', (e) => {
    const t = hooks.getTranscript();
    const undo = e.target.closest('[data-undo-change]');
    if (undo && t) { hooks.setTranscript(undoChange(t, undo.dataset.undoChange)); return; }
    const setProg = e.target.closest('[data-set-program]');
    if (setProg && t) { hooks.setTranscript({ ...t, programId: setProg.dataset.setProgram, chosenByUser: true, detected: undefined }); return; }
    const del = e.target.closest('[data-del]');
    if (del && t) {
      const courses = t.courses.slice();
      courses.splice(Number(del.dataset.del), 1);
      hooks.setTranscript({ ...t, courses });
      return;
    }
    if (e.target.closest('[data-ask-plan]')) { hooks.askPlan(); return; }
    if (e.target.closest('[data-build-plan]')) { hooks.buildPlan(); return; }
    const pv = e.target.closest('[data-plan-view]');
    if (pv) { hooks.setPlanView(pv.dataset.planView); return; }
    const ps = e.target.closest('[data-plan-search]');
    if (ps) { hooks.onCode(ps.dataset.planSearch); return; }
    const chip = e.target.closest('.req-chip[data-code]');
    if (chip) hooks.onCode(chip.dataset.code);
  });
  els.body.addEventListener('submit', (e) => {
    if (e.target.id !== 't-add') return;
    e.preventDefault();
    const t = hooks.getTranscript();
    const f = new FormData(e.target);
    const code = normalizeCode(f.get('code'));
    if (!code || !t) { e.target.code.focus(); return; }
    const grade = String(f.get('grade') || '').trim().toUpperCase();
    const credits = f.get('credits') === '' ? null : Number(f.get('credits'));
    const rec = { code, title: '', credits: Number.isFinite(credits) ? credits : null, grade, term: 'Added by you', status: gradeStatus(grade), transfer: false, repeatExcluded: false };
    if (!REPEATABLE.has(code) && t.courses.some((c) => c.code === code && c.status === rec.status && c.grade === rec.grade)) return;
    hooks.setTranscript({ ...t, courses: [...t.courses, rec] });
  });
}
