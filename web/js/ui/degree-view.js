// Degree tab: transcript upload, degree audit, and semester plan.

import { detectProgram } from '../core/detect.js';
import { waiversOf, describeChange, undoChange } from '../core/changes.js';
import { parseTranscriptText, linesFromPdfItems, gradeStatus, cleanRecords, bestAttempts, REPEATABLE } from '../core/transcript.js';
import { auditDegree } from '../core/audit.js';
import { planSemesters, planInputs, describePlan, repackPlan } from '../core/planner.js';
import { checkPlan } from '../core/plan-check.js';
import { addSuggestions } from '../core/suggest.js';
import { normalizeCode } from '../core/prereq.js';
import { esc } from './util.js';

const MAX_FILE = 8 * 1024 * 1024;

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

/** Why a suggested course has a star: something the student said, or the student's major. */
function starReason(it, code) {
  if (it.chatMatches?.includes(code)) return 'you mentioned this';
  if (it.majorMatches?.includes(code)) return 'related to your major';
  return '';
}

function linkify(text, known) {
  return esc(text).replace(/\b([A-Z]{2,4}) (\d{3})\b/g, (m) => (known(m) ? `<button type="button" class="code-link" data-code="${m}">${m}</button>` : m));
}

/**
 * The one way the Degree tab shows course choices: chips with code and title, a star when the
 * course matches what the student said or the major, three at a time and "+N" for the rest.
 * Open slots show their suggestions (or the program's list); a placed course shows its alternatives after "or".
 */
function courseChips(it, known, titleOf) {
  const list = (it.code ? (it.options || []) : (it.suggestions?.length ? it.suggestions : (it.options || []))).filter((c) => known(c));
  if (!list.length) return '';
  const chip = (c, hidden) => {
    const title = titleOf(c);
    const why = starReason(it, c);
    return `<button type="button" class="code-link sug${why ? ' chat' : ''}${hidden ? ' extra' : ''}" data-code="${esc(c)}" title="${esc(`${title ? `${c}: ${title}` : c}${why ? ` · ${why}` : ''}`)}">${why ? `<span class="sug-star" aria-label="${esc(why)}">★</span>` : ''}${esc(c)}${title ? `<span class="sug-title"> ${esc(title)}</span>` : ''}</button>`;
  };
  return `<div class="pr-options pr-suggest">${it.code ? '<span class="small muted">or</span>' : ''}${list.map((c, i) => chip(c, i >= 3)).join('')}${list.length > 3 ? `<button type="button" class="sug more-chips" data-more-chips title="Show all ${list.length}">+${list.length - 3}</button>` : ''}</div>`;
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
  const issues = (it.issues || []).filter((x) => x.level === 'error');
  const plainReason = reason.replace(/\s+/g, ' ').trim();
  return `<li class="pr ${k.cls}"${plainReason ? ` title="${esc(plainReason)}"` : ''}>
      <div class="pr-top">
        <div class="pr-name">${name}</div>
        <span class="pr-cr">${esc(it.credits)} cr</span>
        ${addButton(it.code)}
      </div>
      ${courseChips(it, known, titleOf)}
      ${tag && it.code && k.tag ? `<div class="pr-sub"><span class="pr-tag">${esc(tag)}</span></div>` : ''}
      ${issues.map((x) => `<div class="pr-issue ${x.level}">${x.level === 'error' ? '⚠' : '•'} ${esc(x.message)}</div>`).join('')}
    </li>`;
}

function termCard(term, i, firstIdx, known, titleOf, addFor) {
  return `<section class="term${i === firstIdx ? ' next' : ''}">
      <header class="term-head">
        <h3>${i === firstIdx ? '<span class="next-badge">Next</span>' : ''}${esc(term.label)}</h3>
        <span class="term-cr">${term.credits} cr</span>
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
  let title = `Program: <strong>${esc(program.name)}</strong>`;
  let text = transcript.chosenByUser ? '' : 'Select your program.';
  if (d && !transcript.chosenByUser) {
    if (d.confidence === 'high') { tone = 'ok'; title = `Detected program: <strong>${esc(program.name)}</strong>`; text = d.reason; }
    else { tone = 'warn'; title = `Likely program: <strong>${esc(program.name)}</strong>`; text = `${d.reason} Confirm below.`; }
  }
  return `<div class="program-banner ${tone}">
      <div class="pb-text"><p class="pb-title">${title}</p>${text ? `<p class="small muted">${esc(text)}</p>` : ''}</div>
      <label class="pb-pick small muted">Change program
        <select id="program-select" aria-label="Degree program">${programOptions(programs, program.id)}</select>
      </label>
      ${alts.length ? `<div class="pb-alts small muted">Other matches: ${alts.map((p) => `<button type="button" class="link-btn" data-set-program="${esc(p.id)}">${esc(p.name)}</button>`).join(' · ')}</div>` : ''}
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
  return `<details class="card tracks-card"><summary><h2 class="card-title">Specializations</h2></summary>
      <ul class="track-list">${rows}</ul></details>`;
}

/**
 * Render the whole Degree tab body.
 * ctx: { index, programs, transcript, savedCourses, known, plan: { ai, busy }, interests }
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
  const suggestCtx = { index, program, audit, done: inputs.done, grades, interests: ctx.interests || null, majorKnown: !!transcript.programId };
  addSuggestions(ruleView, suggestCtx);
  const titleOf = (code) => index.get(code)?.title || '';
  // Add buttons only in the term the sections are for (the schedule semester)
  const addFor = (term) => (term.label === index.semester && ctx.addButton ? (code) => (code ? ctx.addButton(code) : '') : () => '');

  // which plan to show: the advisor's (if made and chosen) or the app's
  const p = ctx.plan || {};
  const useAi = !!p.ai;
  // the credits-per-term setting re-spreads the advisor's plan at once (the last term moves as needed)
  const aiView = useAi && (p.ai.maxCredits || 15) !== maxCredits
    ? repackPlan(JSON.parse(JSON.stringify(p.ai)), { index, program, done: inputs.done, grades, maxCredits, locked: inputs.locked })
    : useAi ? JSON.parse(JSON.stringify(p.ai)) : null;
  const shown = useAi ? addSuggestions(aiView, suggestCtx) : ruleView;
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
    ? 'All requirements complete or in progress'
    : graduation ? `Expected graduation: <strong>${esc(graduation)}</strong>` : `<strong>${t.remaining}</strong> credits to go`;
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
        ${t.planned ? `<li><i class="dot pl"></i><strong>${t.planned}</strong> saved</li>` : ''}
        <li><i class="dot togo"></i><strong>${t.remaining}</strong> to go</li>
        <li class="muted">of ${t.required} credits</li>
      </ul>
    </div>`;

  // ----- 2. recommended plan -----
  const errors = check.issues.filter((x) => x.level === 'error').length;
  const checkLine = errors
    ? `<span class="chk bad">⚠ ${errors} problem${errors === 1 ? '' : 's'} found</span>`
    : '';
  // feedback while a new plan is made (after an upload, or a change asked for in the chat)
  const busyLine = p.busy ? '<p class="plan-busy small muted"><span class="spin"></span> Updating your plan…</p>' : '';

  html += `<div class="card plan-card">
      <div class="plan-head">
        <div>
          <h2 class="card-title">Plan</h2>
          ${checkLine ? `<div class="plan-meta">${checkLine}</div>` : ''}
        </div>
        <label class="small muted plan-max">Credits per term
          <select id="max-credits">${[12, 13, 15, 16, 18].map((n) => `<option value="${n}"${n === maxCredits ? ' selected' : ''}>${n}</option>`).join('')}</select>
        </label>
      </div>
      ${busyLine}
`;
  if (usedTerms.length) {
    html += `<div class="timeline">${shown.terms.map((term, i) => (term.items.length ? termCard(term, i, firstIdx, known, titleOf, addFor) : '')).join('')}</div>`;
  }
  if (shown.later?.length) {
    html += `<section class="term later"><header class="term-head"><h3>Unscheduled</h3></header><ul class="term-list">${shown.later.map((it) => planRow(it, known, titleOf)).join('')}</ul></section>`;
  }
  const general = check.issues.filter((x) => !x.code && x.term == null && x.level === 'error');
  const termWide = check.issues.filter((x) => !x.code && x.term != null && x.level === 'error');
  if (general.length || termWide.length) {
    html += `<ul class="plan-issues">${[...termWide, ...general].map((x) => `<li class="${x.level}">${esc(x.message)}</li>`).join('')}</ul>`;
  }
  html += '</div>';

  // ----- 2b. changes from the chat or the student -----
  if (transcript.changes?.length) {
    html += `<div class="card changes-card">
        <div class="card-head"><h2 class="card-title">Adjustments</h2></div>
        <ul class="change-list">${transcript.changes.map((c) => `<li><span>${esc(describeChange(c))}</span><button type="button" class="link-btn" data-undo-change="${esc(c.id)}">Undo</button></li>`).join('')}</ul>
      </div>`;
  }

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
      <summary><span class="card-title">Transcript courses</span><span class="small muted">${transcript.courses.length} courses</span></summary>
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
    </details>`;

  // ----- 4b. specializations -----
  html += tracksCard(program, completed, inProgress);

  // ----- 5. notes -----
  html += `<p class="small muted audit-note">Unofficial planning aid · <a href="${esc(program.source)}" target="_blank" rel="noopener noreferrer">Catalog requirements ↗</a></p>`;

  el.innerHTML = html;
  return { audit, ruleView, shown, check, source: useAi ? 'claude' : 'rules' };
}

// ---------- wiring ----------

/**
 * els: { drop, file, pasteToggle, pasteBox, pasteText, pasteGo, sample, status, body, clear }
 * hooks: { getTranscript, setTranscript(t), getPrograms(), onCode(code), onNewTranscript(), catalogTitles }
 */
export function wireDegree(els, hooks) {
  let lastInput = null; // { kind, file?, text? }: the last upload or pasted text

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

  /** The sample transcript is plain text in a known layout: read it here. */
  function readSample(text, source) {
    const { courses, warnings } = parseTranscriptText(text, { catalogTitles: hooks.catalogTitles });
    apply(courses, source, warnings, { headerText: text });
    status('');
    hooks.onNewTranscript?.();
  }

  async function handleFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE) { status('File exceeds 8 MB. Use the Banner PDF or paste the text.', 'warn'); return; }
    const kind = kindOf(file);
    if (kind === 'unknown') { status('Unsupported file. Use PDF, HTML, TXT, PNG, or JPG.', 'warn'); return; }
    lastInput = { kind, file };
    try {
      // the text layer helps find the program in the header; scans have none, which is fine
      if (kind === 'pdf') lastInput.text = await pdfToText(file).catch(() => '');
      else if (kind === 'text') lastInput.text = await file.text();
      await readTranscript();
    } catch (err) {
      console.error(err);
      status('Could not read the file. Try again or paste the text.', 'warn');
    }
  }

  /** Read the last upload or pasted text on the server. */
  async function readTranscript() {
    if (!lastInput) return;
    status('<span class="spin"></span> Reading your transcript…');
    try {
      let body;
      if (lastInput.file && (lastInput.kind === 'pdf' || lastInput.kind === 'image')) {
        body = { file: { mediaType: lastInput.kind === 'pdf' ? 'application/pdf' : imageMediaType(lastInput.file), data: await fileToBase64(lastInput.file) } };
      } else {
        body = { text: lastInput.text || '' };
      }
      const res = await fetch('/api/transcript', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 503) throw new Error('Transcript reading is unavailable. Try again later.');
      if (!res.ok) throw new Error(data.error || 'Could not read the transcript. Try again.');
      const courses = cleanRecords(data.courses);
      if (!courses.length) throw new Error('No courses found. Use the unofficial transcript PDF from Banner.');
      apply(courses, lastInput.file?.name || 'Pasted transcript', data.warnings || [], { headerText: lastInput.text || '', majors: data.majors || [] });
      status('');
      hooks.onNewTranscript?.();
    } catch (err) {
      status(esc(err.message || 'Could not read the transcript. Try again.'), 'warn');
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
    readTranscript();
  });
  els.sample.addEventListener('click', async () => {
    const text = await (await fetch('/samples/sample-transcript.txt')).text();
    readSample(text, 'Sample transcript');
  });
  els.clear.addEventListener('click', () => {
    hooks.setTranscript(null);
    status('Transcript cleared.');
  });

  // edits in the body
  els.body.addEventListener('change', (e) => {
    const t = hooks.getTranscript();
    if (!t) return;
    if (e.target.id === 'program-select') { hooks.setTranscript({ ...t, programId: e.target.value, chosenByUser: true, detected: undefined }); hooks.onNewTranscript?.(); return; }
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
    const more = e.target.closest('[data-more-chips]');
    if (more) { more.parentElement.classList.add('all'); more.remove(); return; }
    const t = hooks.getTranscript();
    const undo = e.target.closest('[data-undo-change]');
    if (undo && t) {
      const change = (t.changes || []).find((c) => c.id === undo.dataset.undoChange);
      hooks.setTranscript(undoChange(t, undo.dataset.undoChange));
      if (change) hooks.onUndoChange?.(change); // the chat says so
      return;
    }
    const setProg = e.target.closest('[data-set-program]');
    if (setProg && t) { hooks.setTranscript({ ...t, programId: setProg.dataset.setProgram, chosenByUser: true, detected: undefined }); hooks.onNewTranscript?.(); return; }
    const del = e.target.closest('[data-del]');
    if (del && t) {
      const courses = t.courses.slice();
      courses.splice(Number(del.dataset.del), 1);
      hooks.setTranscript({ ...t, courses });
      return;
    }
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
