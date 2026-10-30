// advisor. — main app: loads data, runs search, and wires the four tabs.

import { buildIndex, creditNumber } from './core/catalog.js';
import { search, highlightPieces } from './core/search.js';
import { normalizeCode, treeToText, evaluate, missingParts } from './core/prereq.js';
import { esc, $, $$, store, linkCodes, debounce } from './ui/util.js';
import { renderSchedule, wireSchedule } from './ui/schedule-view.js';
import { renderGraph, wireGraphHover } from './ui/graph-view.js';
import { createChat } from './ui/chat.js';
import { initSplitter } from './ui/splitter.js';
import { createSettings } from './ui/settings.js';
import { renderDegree, wireDegree } from './ui/degree-view.js';
import { bestAttempts, cleanRecords } from './core/transcript.js';
import { cleanCommitments, sectionClashes, applyMemoryOps } from './core/commitments.js';
import { resolveProposal, applyChange, changesForServer, describeChange } from './core/changes.js';
import { studentContextBlock, readClientContext } from './core/context.js';
import { chatInterests, programInterests, interestScore } from './core/interests.js';
import { planTask, planUserText, finishAdvisorPlan } from './core/plan-ai.js';

// ---------- state ----------
const DEFAULT_OPTIONS = {
  searchDescriptions: true,
  searchSections: true,
  detail: 3,
  showDependents: true,
  showBridge: false,
  showExternal: false,
  showLinks: true,
  collapseSections: true,
};
const DEFAULT_FILTERS = { subjects: [], levels: [], days: [], offered: false, open: false, eligible: false };

const state = {
  index: null,
  query: '',
  results: [],
  focus: [],
  graphFilter: store.get('graphFilter', []).filter((c) => typeof c === 'string').slice(0, 8),
  keywords: [],
  shown: 25,
  expanded: new Set(), // course codes whose sections are fully shown
  compactOpen: new Set(), // course codes opened from a compact result
  options: { ...DEFAULT_OPTIONS, ...store.get('options', {}) },
  filters: { ...DEFAULT_FILTERS, ...store.get('filters', {}) },
  saved: store.get('saved', []),
  busy: cleanCommitments(store.get('busy', [])),
  completed: store.get('completed', []),
  tab: store.get('tab', 'degree'),
  graphSelected: null,
  transcript: loadTranscript(),
  // recommended plan: which one to show, and the advisor's latest plan
  plan: { ai: store.get('aiPlan', null)?.plan || null, busy: false },
  programs: [],
  health: null,
};

function loadTranscript() {
  const t = store.get('transcript', null);
  if (!t || !Array.isArray(t.courses)) return null;
  const courses = cleanRecords(t.courses);
  return courses.length ? { ...t, courses } : null;
}

const els = {
  search: $('#search'),
  results: $('#results'),
  defaults: $('#default-content'),
  examples: $('#examples'),
  dataNote: $('#data-note'),
  filtersBtn: $('#filters-btn'),
  filtersPanel: $('#filters-panel'),
  filtersCount: $('#filters-count'),
  completedChips: $('#completed-chips'),
  completedInput: $('#completed-input'),
  schedule: {
    list: $('#saved-list'),
    summary: $('#saved-summary'),
    grid: $('#schedule-grid'),
    unscheduled: $('#unscheduled'),
    foot: null,
  },
  graph: { focus: $('#graph-focus'), scroll: $('#graph-scroll'), detail: $('#graph-detail') },
};

// ---------- theme ----------
createSettings({ button: $('#settings-btn'), menu: $('#settings-menu') });

// ---------- helpers ----------
const known = (code) => !!state.index?.has(code);
// Courses from the transcript: completed, in progress, and grades (best attempt per course).
let tCache = { ref: null, sets: null };
function transcriptSets() {
  if (tCache.ref === state.transcript && tCache.sets) return tCache.sets;
  const best = state.transcript ? bestAttempts(state.transcript.courses) : [];
  const sets = {
    completed: new Set(best.filter((r) => r.status === 'completed').map((r) => r.code)),
    inProgress: new Set(best.filter((r) => r.status === 'in-progress').map((r) => r.code)),
    grades: new Map(best.filter((r) => r.grade).map((r) => [r.code, r.grade])),
  };
  tCache = { ref: state.transcript, sets };
  return sets;
}
/** Courses finished: entered by hand or on the transcript. */
const doneSet = () => new Set([...state.completed, ...transcriptSets().completed]);
/** For "can I take it next term?": finished plus in progress now. */
const completedSet = () => new Set([...doneSet(), ...transcriptSets().inProgress]);
const gradeMap = () => transcriptSets().grades;
const plannedCourses = () => new Set(state.saved.map((crn) => state.index.crnMap.get(crn)?.course).filter(Boolean));

function hl(text) {
  return highlightPieces(text, state.keywords).map((p) => (p.match ? `<mark>${esc(p.text)}</mark>` : esc(p.text))).join('');
}

function eligibilityBadge(course) {
  if (doneSet().has(course.code)) {
    const g = gradeMap().get(course.code);
    return `<span class="badge ok"><span class="chk-ic" aria-hidden="true">✓</span>Completed${g ? ` · ${esc(g)}` : ''}</span>`;
  }
  if (transcriptSets().inProgress.has(course.code)) return '<span class="badge">In progress now</span>';
  const done = completedSet();
  if (!done.size) return '';
  const planned = plannedCourses();
  planned.delete(course.code);
  const st = { completed: done, current: planned, grades: gradeMap() };
  const result = evaluate(course.prereq, st);
  if (result === 'met') return '<span class="badge ok">You can take this</span>';
  const missing = missingParts(course.prereq, st).join('; ');
  if (result === 'unknown') return `<span class="badge warn">Needs: ${esc(missing)}</span>`;
  return `<span class="badge no">Missing: ${esc(missing)}</span>`;
}

// The subject page of the official catalog (for example catalog.iit.edu/courses/cs/).
function catalogUrl(code) {
  return `https://catalog.iit.edu/courses/${encodeURIComponent(code.split(' ')[0].toLowerCase())}/`;
}

// ---------- filters ----------
function courseMatchesFilters(course) {
  const f = state.filters;
  if (f.subjects.length && !f.subjects.includes(course.subject)) return false;
  if (f.levels.length && !f.levels.includes(course.level)) return false;
  if (f.open && !course.sections.some((s) => s.available == null || s.available > 0)) return false;
  if (f.days.length) {
    const ok = course.sections.some((s) => s.meetings.some((m) => m.days && m.days !== 'TBA')
      && s.meetings.every((m) => !m.days || m.days === 'TBA' || [...m.days].every((d) => f.days.includes(d))));
    if (!ok) return false;
  }
  if (f.eligible) {
    const done = completedSet();
    if (done.has(course.code)) return false;
    const planned = plannedCourses();
    planned.delete(course.code);
    if (evaluate(course.prereq, { completed: done, current: planned, grades: gradeMap() }) !== 'met') return false;
  }
  return true;
}
function activeFilterCount() {
  const f = state.filters;
  return (f.subjects.length ? 1 : 0) + (f.levels.length ? 1 : 0) + (f.days.length ? 1 : 0) + (f.open ? 1 : 0) + (f.eligible ? 1 : 0);
}

// ---------- search + results ----------
function runSearch() {
  const q = state.query;
  if (!q.trim()) {
    state.results = [];
    state.focus = [];
    state.keywords = [];
  } else {
    const r = search(state.index, q, {
      searchDescriptions: state.options.searchDescriptions,
      searchSections: state.options.searchSections,
      filter: courseMatchesFilters,
      require: (course) => course.sections.length > 0, // only courses that can be added this semester
    });
    state.results = r.results;
    state.focus = r.focus;
    state.keywords = r.keywords;
  }
  state.shown = 25;
  state.expanded.clear();
  state.compactOpen.clear();
  renderResults();
  renderGraphTab();
}

function sectionRow(s) {
  const added = state.saved.includes(s.crn);
  const meetings = s.meetings.map((m) => {
    const when = [m.days && m.days !== 'TBA' ? m.days : '', m.time && m.time !== 'TBA' ? m.time : ''].filter(Boolean).join(' ') || 'Time TBA';
    const who = m.instructors.length ? ` · ${m.instructors.join(', ')}` : '';
    return `${hl(when)} · ${hl(m.where || 'TBA')}${hl(who)}`;
  }).join('<br>');
  const clash = sectionClashes(s, state.busy);
  const clashNote = clash.length ? `<div class="busy-note">Clashes with ${[...new Set(clash.map((c) => esc(c.label)))].join(', ')}</div>` : '';
  const seats = s.available == null ? '' : `<span class="seats${s.available <= 0 ? ' full' : ''}">${s.available <= 0 ? 'Full' : `${s.available} open`}</span> · `;
  return `<div class="section-row">
      <div class="section-main">
        <div class="section-top">${hl(s.scheduleType || 'Section')}${s.bucket && s.bucket !== 'Class' ? ` (${hl(s.bucket)})` : ''} <span class="muted small">· CRN ${hl(s.crn)}</span></div>
        <div class="section-sub">${seats}${meetings}</div>${clashNote}
      </div>
      <button type="button" class="add-btn${added ? ' added' : ''}" data-add="${esc(s.crn)}" aria-pressed="${added}">${added ? '✓ Added' : 'Add'}</button>
    </div>`;
}

/**
 * One Add button for a whole course (compact results, graph details, Degree plan).
 * One section: adds it. Several: opens the course in search with every section shown, to pick one.
 * Returns '' when the course has no sections this semester.
 */
function addCourseButton(code) {
  const course = state.index?.get(code);
  const n = course?.sections?.length || 0;
  if (!n) return '';
  const added = course.sections.some((s) => state.saved.includes(s.crn));
  const label = added ? '✓ Added' : n === 1 ? 'Add' : `Add · ${n} sections`;
  const tip = added ? `Remove ${code} from your schedule` : n === 1 ? `Add ${code} (CRN ${course.sections[0].crn}) to your schedule` : `Pick one of the ${n} ${code} sections`;
  return `<button type="button" class="add-btn${added ? ' added' : ''}" data-add-course="${esc(code)}" title="${esc(tip)}" aria-label="${esc(tip)}" aria-pressed="${added}">${label}</button>`;
}

/** One line for a section in the picker: "Lecture · MW 11:25 AM - 12:40 PM · 40 open". */
function sectionLine(s) {
  const when = s.meetings.map((m) => [m.days && m.days !== 'TBA' ? m.days : '', m.time && m.time !== 'TBA' ? m.time : ''].filter(Boolean).join(' ')).filter(Boolean).join(', ') || 'Time TBA';
  const seats = s.available == null ? '' : s.available <= 0 ? ' · Full' : ` · ${s.available} open`;
  const clash = sectionClashes(s, state.busy).length ? ' · clashes' : '';
  return `${s.scheduleType || 'Section'}${s.bucket && s.bucket !== 'Class' ? ` (${s.bucket})` : ''} · ${when}${seats}${clash}`;
}
function closeSectionPicker() {
  document.querySelector('.sec-pop')?.remove();
}
/** A small menu next to the button: pick one section, right where you are. */
function openSectionPicker(btn, course) {
  closeSectionPicker();
  const pop = document.createElement('div');
  pop.className = 'sec-pop';
  pop.setAttribute('role', 'menu');
  pop.innerHTML = course.sections.map((s) => `<button type="button" role="menuitem" data-pick-crn="${esc(s.crn)}">${esc(sectionLine(s))}</button>`).join('');
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.top = `${window.scrollY + r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(window.scrollX + r.right - w, window.scrollX + document.documentElement.clientWidth - w - 8))}px`;
  pop.querySelector('button')?.focus();
}
function addCourse(code, btn) {
  const course = state.index?.get(code);
  if (!course?.sections?.length) return;
  // added: the same button removes it
  const saved = course.sections.filter((s) => state.saved.includes(s.crn));
  if (saved.length) {
    state.saved = state.saved.filter((crn) => !saved.some((s) => s.crn === crn));
    store.set('saved', state.saved);
    renderAfterChange();
    return;
  }
  if (course.sections.length === 1) return toggleSaved(course.sections[0].crn);
  if (btn) return openSectionPicker(btn, course);
  // no button to anchor to: show every section in search
  state.expanded.add(code);
  setQuery(code, { focusInput: false });
  state.compactOpen.add(code);
  renderResults();
}

function courseCard(course) {
  const detail = state.compactOpen.has(course.code) ? 3 : Number(state.options.detail);
  const head = `<div class="course-head">
      <span class="course-code">${hl(course.code)}</span>
      <span class="course-title">${hl(course.title)}</span>
      ${detail > 1 ? `<span class="course-credits">${esc(course.credits || '?')} credit${course.credits === '1' ? '' : 's'}</span>` : ''}
    </div>`;
  if (detail === 1) {
    return `<article class="course compact" data-expand="${esc(course.code)}" tabindex="0" title="Click to expand ${esc(course.code)}">${head}${course.sections.length ? `<div class="compact-add">${addCourseButton(course.code)}</div>` : ''}</article>`;
  }
  const badges = [eligibilityBadge(course), course.satisfies ? `<span class="badge">${hl(course.satisfies)}</span>` : '', course.bridge ? '<span class="badge">Graduate bridge course</span>' : '']
    .filter(Boolean).join('');
  let html = `<article class="course${detail === 2 ? ' compact' : ''}" ${detail === 2 ? `data-expand="${esc(course.code)}" tabindex="0"` : ''}>${head}`;
  if (badges) html += `<div class="badges">${badges}</div>`;
  html += `<p class="desc">${state.options.searchDescriptions ? hl(course.description) : esc(course.description)}</p>`;
  if (detail === 2) return `${html}${course.sections.length ? `<div class="compact-add">${addCourseButton(course.code)}</div>` : ''}</article>`;

  html += `<p class="meta-line"><b>Prerequisites:</b> ${course.prereqText ? linkCodes(course.prereqText, known) : 'None'}</p>`;
  const graphLink = `<button type="button" class="link-btn" data-graph="${esc(course.code)}">${course.dependents.length ? `Unlocks ${course.dependents.length} course${course.dependents.length === 1 ? '' : 's'}` : 'Prerequisite graph'} →</button>`;
  if (course.note) html += `<p class="meta-line">${esc(course.note)}</p>`;
  if (course.futureTerms) {
    if (course.futureTerms.length) html += `<p class="meta-line"><b>Also offered:</b> ${course.futureTerms.filter((t) => t !== state.index.semester).map((t) => hl(t)).join(', ') || 'None planned'} <span class="tent">(tentative)</span></p>`;
  }
  html += `<p class="meta-line">${graphLink}</p>`;

  if (course.sections.length) {
    const many = state.options.collapseSections && course.sections.length >= 5 && !state.expanded.has(course.code);
    const list = many ? course.sections.slice(0, 3) : course.sections;
    html += `<div class="sections" aria-label="${esc(state.index.semester)} sections">${list.map(sectionRow).join('')}</div>`;
    if (many) html += `<button type="button" class="toggle-sections" data-more="${esc(course.code)}">Show all ${course.sections.length} sections</button>`;
  } else {
    html += `<p class="meta-line">No ${esc(state.index.semester)} sections in this data.</p>`;
  }

  const done = state.completed.includes(course.code);
  const onTranscript = transcriptSets().completed.has(course.code);
  html += `<div class="course-actions">
      <button type="button" class="btn" data-ask="${esc(course.code)}">Ask advisor</button>
      ${onTranscript ? '' : `<button type="button" class="btn${done ? ' on' : ''}" data-complete="${esc(course.code)}" aria-pressed="${done}">${done ? '<span class="chk-ic" aria-hidden="true">✓</span>Taken' : 'I took this'}</button>`}
      ${!course.stub ? `<a class="link-btn" href="${catalogUrl(course.code)}" target="_blank" rel="noopener noreferrer">Catalog ↗</a>` : ''}
    </div>`;
  return `${html}</article>`;
}

// ---------- Pop's meaning-based search (when the server has Pop's model and embeddings) ----------
/** A "Search by meaning" button for word searches, like Shift+Enter in Pop. */
function semanticButton(q) {
  if (!state.health?.semantic || !/[a-z]{3,}/i.test(q) || /^[\s,]*([A-Za-z]{2,4}\s*\d{3}[\s,]*)+$/.test(q)) return '';
  return `<p class="semantic-row"><button type="button" class="btn" data-semantic="${esc(q)}">Search by meaning: “${esc(q)}”</button>
    <span class="small muted">Pop finds courses about this topic, even when the words differ.</span></p>`;
}
async function semanticSearch(q) {
  const btn = els.results.querySelector('[data-semantic]');
  if (btn) { btn.disabled = true; btn.textContent = 'Searching by meaning…'; }
  try {
    const res = await fetch('/api/search/semantic', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q, limit: 15 }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    const codes = (data.results || []).map((r) => normalizeCode(r.code)).filter((c) => c && known(c) && state.index.courses.get(c).sections.length);
    if (!codes.length) throw new Error('No courses found for that topic.');
    setQuery(codes.join(', '), { focusInput: false }); // the comma list shows every match
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = err.message; }
  }
}


function renderResults() {
  const q = state.query.trim();
  els.defaults.hidden = !!q;
  els.results.hidden = !q;
  if (!q) { els.results.innerHTML = ''; return; }
  const total = state.results.length;
  const filters = activeFilterCount();
  // search lists only courses with sections this semester; say so when a typed code is not offered
  const notOffered = state.focus.filter((c) => !state.index.courses.get(c)?.sections.length);
  const offNote = notOffered.length
    ? `<p class="search-note small muted">Not offered in ${esc(state.index.semester)}: ${notOffered.map(esc).join(', ')}. Ask the advisor for the next offering.</p>`
    : '';
  if (!total) {
    els.results.innerHTML = `<div class="results-head"><span>No results</span></div>
      ${offNote}
      ${semanticButton(q)}
      ${offNote ? '' : `<p class="empty">No ${esc(state.index.semester)} courses matched “${esc(q)}”.${filters ? ` <button type="button" class="link-btn" data-reset-filters>Clear filters</button>` : ''}</p>`}`;
    return;
  }
  const shown = state.results.slice(0, state.shown);
  els.results.innerHTML = `<div class="results-head">
      <span>${total} result${total === 1 ? '' : 's'}${filters ? ` · ${filters} filter${filters === 1 ? '' : 's'} on` : ''}</span>
      <button type="button" data-clear>Clear search</button>
    </div>
    ${offNote}
    ${semanticButton(q)}
    ${shown.map((r) => courseCard(r.course)).join('')}
    ${total > state.shown ? `<button type="button" class="btn more-btn" data-show-more>Show ${Math.min(25, total - state.shown)} more</button>` : ''}`;
}

// phone layout hooks (set in init)
let paneHook = null;
let startPhone = null;
let paneLeft = null;
function setQuery(text, { focusInput = true } = {}) {
  state.query = text;
  els.search.value = text;
  updateHash();
  runSearch();
  paneLeft?.(); // phone: show the search results
  if (focusInput) els.search.focus();
  window.scrollTo({ top: 0 });
}

const updateHash = debounce(() => {
  const url = state.query.trim() ? `#q=${encodeURIComponent(state.query.trim())}` : location.pathname + location.search;
  history.replaceState(null, '', url);
}, 300);

// ---------- saved + completed ----------
function toggleSaved(crn) {
  const i = state.saved.indexOf(crn);
  if (i >= 0) state.saved.splice(i, 1);
  else state.saved.push(crn);
  store.set('saved', state.saved);
  renderAfterChange();
}
function toggleCompleted(code) {
  const c = normalizeCode(code);
  if (!c) return;
  const i = state.completed.indexOf(c);
  if (i >= 0) state.completed.splice(i, 1);
  else state.completed.push(c);
  state.completed.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  store.set('completed', state.completed);
  renderCompletedChips();
  if (state.filters.eligible) runSearch(); else { renderResults(); renderGraphTab(); }
}
function renderAfterChange() {
  if (state.filters.eligible) runSearch(); else renderResults();
  renderScheduleTab();
  renderGraphTab();
  renderDegreeTab();
}

function renderCompletedChips() {
  els.completedChips.innerHTML = state.completed.map((c) => `<span class="chip${known(c) ? '' : ' unknown'}">${esc(c)}<button type="button" data-uncomplete="${esc(c)}" aria-label="Remove ${esc(c)}">×</button></span>`).join('');
  const t = transcriptSets();
  const hint = $('#completed-hint');
  if (hint) {
    hint.textContent = state.transcript ? `Plus ${t.completed.size} completed and ${t.inProgress.size} in-progress from your transcript.` : '';
  }
}

/** Everything the server needs to know about this student for chat and plans. */
function chatContext() {
  return {
    query: state.query,
    savedCrns: state.saved,
    busy: state.busy,
    completed: state.completed,
    transcript: state.transcript?.courses || [],
    changes: changesForServer(state.transcript),
    programId: state.transcript?.programId || '',
    maxCredits: state.transcript?.maxCredits || 15,
    plan: shownPlanSummary(),
    planSource: lastDegree?.source || 'rules',
    focus: state.focus.length ? state.focus : state.results.slice(0, 3).map((r) => r.course.code),
  };
}

// ---------- degree ----------
function setTranscript(t) {
  const isNew = t && (!state.transcript || t.source !== state.transcript.source);
  state.transcript = t && t.courses?.length ? t : null;
  if (!state.transcript) setPlan(null); // cleared: the plan goes with it
  if (isNew || !state.transcript) $('.upload-card')?.classList.remove('replacing');
  store.set('transcript', state.transcript);
  renderCompletedChips();
  if (state.filters.eligible) runSearch(); else { renderResults(); renderGraphTab(); }
  renderDegreeTab();
}
let lastDegree = null;
function renderDegreeTab() {
  const card = $('.upload-card');
  const hasT = !!state.transcript;
  card.classList.toggle('compact', hasT && !card.classList.contains('replacing'));
  $('#degree-intro').hidden = hasT && !card.classList.contains('replacing');
  const sum = $('#upload-summary-text');
  if (sum) sum.textContent = hasT ? (state.transcript.source || 'Transcript') : '';
  if (state.tab !== 'degree') return;
  lastDegree = renderDegree($('#degree-body'), {
    index: state.index,
    programs: state.programs,
    transcript: state.transcript,
    savedCourses: plannedCourses(),
    known,
    addButton: addCourseButton,
    interests: chatInterests(store.get('chat', [])), // suggested courses follow what the chat discussed
    plan: state.plan,
  });
}
/** The plan on screen, short, for the chat advisor. */
function shownPlanSummary() {
  const shown = lastDegree?.shown;
  if (!shown) return [];
  return shown.terms.filter((t) => t.items.length).map((t) => ({
    term: t.label,
    items: t.items.map((i) => i.code || `[${i.label || i.requirement}${i.suggestions?.length ? `; suggested: ${i.suggestions.join(', ')}` : ''}]`),
  }));
}
function setPlan(plan) {
  state.plan.ai = plan;
  store.set('aiPlan', plan ? { plan, at: Date.now() } : null);
}
/**
 * Make the plan. Runs only when a transcript is uploaded (or uploaded again) and when the student
 * asks for a change in the chat. Until then, and if it fails, the plan follows the degree rules.
 */
async function buildPlan() {
  if (state.plan.busy || !state.transcript || state.health?.mode !== 'claude') return;
  state.plan.busy = true;
  renderDegreeTab();
  try {
    const ctx = readClientContext({ ...chatContext(), plan: [] }, state.index);
    if (!ctx.transcript.length) return;
    const terms = (state.index.forecast?.terms || []).map((t) => t.label);
    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        studentContext: `${studentContextBlock(state.index, 'my degree plan', ctx, state.programs)}\n\n${planTask({ terms, maxCredits: ctx.maxCredits })}`,
        userText: planUserText(chat.messages()),
      }),
    });
    const reply = await res.json().catch(() => ({}));
    if (!res.ok) return;
    const data = finishAdvisorPlan(reply, { index: state.index, programs: state.programs, ctx });
    if (data?.source === 'claude') setPlan(data);
  } catch {
    // keep the plan on screen
  } finally {
    state.plan.busy = false;
    renderDegreeTab();
  }
}

// ---------- time commitments (kept by the chat advisor) ----------
function applyMemory(ops) {
  const { busy, notes } = applyMemoryOps(state.busy, ops);
  if (!notes.length) return [];
  state.busy = busy;
  store.set('busy', state.busy);
  renderResults();
  renderScheduleTab();
  return notes;
}

// ---------- tabs ----------
let scheduleLayout = null;
function setTab(tab) {
  if (!['schedule', 'chat', 'graph', 'degree'].includes(tab)) tab = 'degree';
  state.tab = tab;
  store.set('tab', tab);
  for (const t of $$('.tab')) {
    const on = t.dataset.tab === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  }
  $('#view-schedule').hidden = tab !== 'schedule';
  $('#view-chat').hidden = tab !== 'chat';
  $('#view-graph').hidden = tab !== 'graph';
  $('#view-degree').hidden = tab !== 'degree';
  document.querySelector('.app').classList.toggle('wide-right', tab === 'degree');
  $('#chat-fab').classList.toggle('hide', tab === 'chat');
  if (tab === 'schedule') requestAnimationFrame(() => scheduleLayout?.place());
  if (tab === 'graph') renderGraphTab();
  if (tab === 'degree') renderDegreeTab();
  paneHook?.();
}

function renderScheduleTab() {
  scheduleLayout = renderSchedule({ index: state.index, savedCrns: state.saved, busy: state.busy, els: els.schedule });
}

let graphPin = null; // { code, focus }: the graph stays put while the left side shows a clicked course
function graphFocus() {
  if (graphPin && state.query.trim() === graphPin.code) return graphPin.focus;
  graphPin = null;
  if (state.graphFilter.length) return state.graphFilter.slice(0, 8);
  if (state.focus.length) return state.focus.slice(0, 6);
  if (state.query.trim() && state.results.length) return state.results.slice(0, 3).map((r) => r.course.code);
  return [...plannedCourses()].slice(0, 6);
}
/** Graph tab with nothing searched: courses from the student's major that are next (not done, offered now). */
function graphSuggestions() {
  const program = state.programs.find((p) => p.id === state.transcript?.programId);
  const done = completedSet();
  const offered = (c) => state.index.get(c)?.sections?.length;
  // no major: a few common courses, only the ones offered this semester
  if (!program) return ['CS 331', 'MATH 251', 'CS 480', 'CS 115', 'MATH 151', 'PHYS 123'].filter((c) => offered(c) && !done.has(c)).slice(0, 4);
  const out = [];
  // the plan on the Degree tab, in order (it already skips what is done or covered)
  for (const t of lastDegree?.shown?.terms || []) {
    for (const it of t.items) {
      for (const c of [it.code, ...(it.chatMatches || []), ...(it.majorMatches || [])]) if (c && !done.has(c) && offered(c) && !out.includes(c)) out.push(c);
    }
  }
  // no plan yet: required courses from slots the student has not covered
  if (!out.length) {
    for (const g of program.groups) {
      for (const slot of g.slots || []) {
        if (slot.some((option) => option.every((c) => done.has(c)))) continue;
        for (const option of slot) for (const c of option) if (!done.has(c) && offered(c) && !out.includes(c)) out.push(c);
      }
    }
  }
  // then courses outside the requirement lists that fit the major (History of AI for an AI major)
  const major = programInterests(program);
  for (const c of state.index.list) if (out.length < 12 && !done.has(c.code) && c.sections.length && Number(c.code.split(' ')[1]) < 500 && interestScore(c, major) >= 3 && !out.includes(c.code)) out.push(c.code);
  return out.slice(0, 6);
}
function renderGraphTab() {
  if (state.tab !== 'graph') return;
  renderGraph({
    index: state.index,
    focus: graphFocus(),
    options: state.options,
    completed: completedSet(),
    planned: plannedCourses(),
    els: els.graph,
    selected: state.graphSelected,
    filtered: state.graphFilter.length > 0,
    addButton: addCourseButton,
    suggestions: graphSuggestions(),
  });
  els.graph.detail.hidden = true; // a clicked course shows on the left, in search
  $('#graph-clear').hidden = !state.graphFilter.length;
}

// ---------- events ----------
function wire() {
  // search box (instant, like pop.ai)
  els.search.addEventListener('input', () => {
    state.query = els.search.value;
    updateHash();
    runSearch();
  });
  els.search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setQuery('');
  });
  $('#logo-link').addEventListener('click', (e) => { e.preventDefault(); setQuery(''); });

  // filters panel
  els.filtersBtn.addEventListener('click', () => {
    const open = els.filtersPanel.hidden;
    els.filtersPanel.hidden = !open;
    els.filtersBtn.setAttribute('aria-expanded', String(open));
  });

  // the few options left on screen (the graph's "unlocks" switch); the rest keep their defaults
  for (const input of $$('[data-opt]')) {
    const key = input.dataset.opt;
    if (input.type === 'radio') input.checked = Number(input.value) === Number(state.options[key]);
    else input.checked = !!state.options[key];
    input.addEventListener('change', () => {
      state.options[key] = input.type === 'radio' ? Number(input.value) : input.checked;
      store.set('options', state.options);
      if (key === 'searchDescriptions' || key === 'searchSections') runSearch();
      else { renderResults(); renderGraphTab(); }
    });
  }

  // filter chips
  const subjects = [...new Set(state.index.list.map((c) => c.subject))];
  const levels = [...new Set(state.index.list.filter((c) => c.sections.length && c.level >= 100).map((c) => c.level))].sort();
  const seg = (el, values, key, label) => {
    el.innerHTML = values.map((v) => `<button type="button" data-val="${esc(v)}" aria-pressed="${state.filters[key].includes(v)}">${esc(label(v))}</button>`).join('');
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const v = typeof values[0] === 'number' ? Number(b.dataset.val) : b.dataset.val;
      const list = state.filters[key];
      const i = list.indexOf(v);
      if (i >= 0) list.splice(i, 1); else list.push(v);
      b.setAttribute('aria-pressed', String(i < 0));
      filtersChanged();
    });
  };
  const subjectSelect = $('#f-subject');
  const deptName = new Map(state.index.list.map((c) => [c.subject, c.department]));
  subjectSelect.innerHTML += subjects.sort().map((v) => `<option value="${esc(v)}">${esc(v)}${deptName.get(v) && deptName.get(v) !== v ? ` · ${esc(deptName.get(v))}` : ''}</option>`).join('');
  subjectSelect.value = state.filters.subjects[0] || '';
  subjectSelect.addEventListener('change', () => { state.filters.subjects = subjectSelect.value ? [subjectSelect.value] : []; filtersChanged(); });
  seg($('#f-level'), levels, 'levels', (l) => `${l}s`);
  seg($('#f-days'), ['M', 'T', 'W', 'R', 'F'], 'days', (d) => d);
  for (const [id, key] of [['f-open', 'open'], ['f-eligible', 'eligible']]) {
    const box = $(`#${id}`);
    box.checked = !!state.filters[key];
    box.addEventListener('change', () => { state.filters[key] = box.checked; filtersChanged(); });
  }
  $('#f-reset').addEventListener('click', resetFilters);

  // completed courses input
  const addCompleted = () => {
    const parts = els.completedInput.value.split(/[,;]+/).map(normalizeCode).filter(Boolean);
    for (const c of parts) if (!state.completed.includes(c)) state.completed.push(c);
    state.completed.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    store.set('completed', state.completed);
    els.completedInput.value = '';
    renderCompletedChips();
    if (state.filters.eligible) runSearch(); else { renderResults(); renderGraphTab(); }
  };
  els.completedInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addCompleted(); }
    if (e.key === 'Backspace' && !els.completedInput.value && state.completed.length) toggleCompleted(state.completed[state.completed.length - 1]);
  });
  els.completedInput.addEventListener('blur', () => { if (els.completedInput.value.trim()) addCompleted(); });
  els.completedChips.addEventListener('click', (e) => {
    const b = e.target.closest('[data-uncomplete]');
    if (b) toggleCompleted(b.dataset.uncomplete);
  });

  // one click handler for result cards, graph detail, and the empty states
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSectionPicker(); });
  window.addEventListener('resize', closeSectionPicker);
  document.addEventListener('click', (e) => {
    const t = e.target;
    const by = (attr) => t.closest(`[${attr}]`);
    let el;
    if ((el = by('data-add'))) return toggleSaved(el.dataset.add);
    if ((el = by('data-pick-crn'))) { closeSectionPicker(); if (!state.saved.includes(el.dataset.pickCrn)) toggleSaved(el.dataset.pickCrn); return undefined; }
    if (!t.closest('.sec-pop')) closeSectionPicker();
    if ((el = by('data-add-course'))) return addCourse(el.dataset.addCourse, el);
    if ((el = by('data-semantic'))) return semanticSearch(el.dataset.semantic);
    if ((el = by('data-complete'))) return toggleCompleted(el.dataset.complete);
    if ((el = by('data-graph'))) { state.graphSelected = el.dataset.graph; if (!state.focus.includes(el.dataset.graph)) setQuery(el.dataset.graph, { focusInput: false }); setTab('graph'); return; }
    if ((el = by('data-ask'))) { setTab('chat'); chat.ask(`Tell me about ${el.dataset.ask}. What do I need before I can take it, and what does it lead to?`); return; }
    if ((el = by('data-search'))) return setQuery(el.dataset.search);
    if ((el = by('data-more'))) { state.expanded.add(el.dataset.more); return renderResults(); }
    if ((el = by('data-show-more'))) { state.shown += 25; return renderResults(); }
    if ((el = by('data-clear'))) return setQuery('');
    if ((el = by('data-reset-filters'))) return resetFilters();
    if (t.closest('#chat-log')) return; // chat handles its own code links
    if ((el = t.closest('.code-link'))) return setQuery(el.dataset.code);
    if ((el = by('data-expand')) && !t.closest('button, a')) {
      state.compactOpen.add(el.dataset.expand);
      return renderResults();
    }
    return undefined;
  });
  els.results.addEventListener('keydown', (e) => {
    const el = e.target.closest('[data-expand]');
    if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); state.compactOpen.add(el.dataset.expand); renderResults(); }
  });

  // tabs (click + arrow keys)
  const tabs = $$('.tab');
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => setTab(t.dataset.tab));
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      setTab(next.dataset.tab);
      next.focus();
    });
  });

  $('#chat-fab').addEventListener('click', () => {
    setTab('chat');
    $('#right').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#chat-input').focus({ preventScroll: true });
  });

  // graph: click a node to see its details
  els.graph.scroll.addEventListener('click', (e) => {
    const node = e.target.closest('.gnode');
    if (!node) return;
    const code = node.dataset.code;
    if (!state.index.get(code)) return; // not in this catalog
    // show the course on the left, like a search, and keep this graph in place
    const focus = graphFocus();
    state.graphSelected = code;
    graphPin = { code, focus };
    setQuery(code, { focusInput: false });
  });
  els.graph.scroll.addEventListener('keydown', (e) => {
    const node = e.target.closest('.gnode');
    if (node && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); node.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
  });
  wireGraphHover(els.graph.scroll);

  wireSchedule(els.schedule, {
    onRemove: (crn) => toggleSaved(crn),
    onOpenCourse: (code) => setQuery(code),
  });

  // keep schedule blocks aligned when the layout changes size
  // and re-fit the graph when its panel width changes
  const refitGraph = debounce(renderGraphTab, 150);
  let graphWidth = 0;
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => scheduleLayout?.place()).observe(els.schedule.grid);
    new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w && Math.abs(w - graphWidth) > 30) { graphWidth = w; refitGraph(); }
    }).observe(els.graph.scroll);
  } else {
    window.addEventListener('resize', () => { scheduleLayout?.place(); refitGraph(); });
  }

  window.addEventListener('hashchange', () => {
    const q = readHash();
    if (q !== state.query.trim()) setQuery(q, { focusInput: false });
  });
}

function filtersChanged() {
  store.set('filters', state.filters);
  const n = activeFilterCount();
  els.filtersCount.hidden = !n;
  els.filtersCount.textContent = n;
  runSearch();
}
function resetFilters() {
  state.filters = { ...DEFAULT_FILTERS, subjects: [], levels: [], days: [] };
  for (const b of $$('.seg button', els.filtersPanel)) b.setAttribute('aria-pressed', 'false');
  $('#f-subject').value = '';
  for (const id of ['f-open', 'f-eligible']) $(`#${id}`).checked = false;
  filtersChanged();
}

function readHash() {
  const m = /[#&]q=([^&]*)/.exec(location.hash);
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return ''; }
}

function renderExamples() {
  // a few tries show what search understands (codes, topics, days, professors); no list to read
  const idx = state.index;
  const firstSection = idx.list.flatMap((c) => c.sections)[0];
  const prof = firstSection?.meetings[0]?.instructors[0]?.split(' ').pop() || '';
  const tries = ['CS 331', 'machine learning', 'math mwf', prof].filter(Boolean);
  els.examples.innerHTML = `<span class="ex-label">Try</span>${tries.map((t) => `<button type="button" class="ex-chip" data-search="${esc(t)}">${esc(t)}</button>`).join('')}`;
}

// ---------- chat ----------
let chat;

// ---------- start ----------
async function start() {
  let catalog;
  let sections;
  let forecast = null;
  let programs = { programs: [] };
  const getJson = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  try {
    [catalog, sections] = await Promise.all([getJson('/data/catalog.json'), getJson('/data/sections.json')]);
    [forecast, programs] = await Promise.all([
      getJson('/data/forecast.json').catch(() => null),
      getJson('/data/programs.json').catch(() => ({ programs: [] })),
    ]);
  } catch {
    $('#content').innerHTML = '<p class="data-note">Could not load the course data. Start the app with <code>npm start</code> and open the address it prints.</p>';
    return;
  }
  state.index = buildIndex(catalog, sections, forecast);
  state.programs = programs.programs || [];
  fetch('/api/health').then((r) => r.json()).then((h) => { state.health = h; renderDegreeTab(); renderResults(); }).catch(() => {});
  const idx = state.index;

  // drop saved CRNs that no longer exist (for example after importing new data)
  state.saved = state.saved.filter((crn) => idx.crnMap.has(String(crn))).map(String);
  store.set('saved', state.saved);

  $('#schedule-title').textContent = idx.semester;
  if (idx.sample) {
    els.dataNote.hidden = false;
    els.dataNote.textContent = `${idx.semester} sections are sample data.`;
  }
  const foot = document.createElement('p');
  foot.className = 'saved-foot';
  foot.textContent = 'Sample sections — confirm times and seats in the Course Status Report before you register.';
  $('.saved-card').appendChild(foot);
  els.schedule.foot = foot;

  renderExamples();
  renderCompletedChips();
  const n = activeFilterCount();
  els.filtersCount.hidden = !n;
  els.filtersCount.textContent = n;

  chat = createChat({
    onChange: () => renderDegreeTab(), // suggested courses follow the chat
    els: {
      log: $('#chat-log'), form: $('#chat-form'), input: $('#chat-input'), send: $('#chat-send'),
      clear: $('#chat-clear'),
    },
    known,
    // STUDENT CONTEXT is built here in the page; the server adds COURSE DATA from Pop's database
    getContext: (question) => studentContextBlock(state.index, question, readClientContext(chatContext(), state.index), state.programs),
    onCodeClick: (code) => setQuery(code),
    onPlanRequest: () => buildPlan(), // the advisor marks replies that change the plan
    resolveProposals: (list) => {
      const t = state.transcript;
      if (!t) return list.map(() => ({ ok: false, label: 'Change', problem: 'Upload your transcript or Degree Works audit on the Degree tab first.' }));
      const program = state.programs.find((p) => p.id === t.programId) || state.programs[0];
      return list.map((p) => resolveProposal(p, program, state.index));
    },
    applyProposals: (changes) => {
      let t = state.transcript;
      if (!t) return;
      for (const c of changes) t = applyChange(t, c);
      setTranscript(t);
      buildPlan(); // a change made in the chat updates the plan
      return (t.changes || []).slice(-changes.length).map((c) => c.id);
    },
    onMemory: applyMemory,
    openDegree: () => setTab('degree'),
  });

  initSplitter({ app: document.querySelector('.app'), left: $('#left'), handle: $('#splitter') });
  wire();
  wireDegree({
    drop: $('#drop'), file: $('#transcript-file'), pick: $('#pick-file'), pasteToggle: $('#paste-toggle'),
    pasteBox: $('#paste-box'), pasteText: $('#paste-text'), pasteGo: $('#paste-go'), sample: $('#try-sample'),
    status: $('#upload-status'), body: $('#degree-body'), clear: $('#clear-transcript'),
  }, {
    getTranscript: () => state.transcript,
    setTranscript,
    getPrograms: () => state.programs,
    onCode: (code) => setQuery(code),
    onNewTranscript: () => { setPlan(null); buildPlan(); }, // a new upload makes a new plan
    onUndoChange: (change) => { chat.changeUndone(change.id, describeChange(change)); buildPlan(); },
    catalogTitles: new Map(idx.list.map((c) => [c.code, c.title])),
  });
  $('#replace-transcript').addEventListener('click', () => {
    const card = $('.upload-card');
    card.classList.add('replacing');
    card.classList.remove('compact');
    $('#degree-intro').hidden = false;
    $('#drop').focus();
  });
  $('#clear-transcript-2').addEventListener('click', () => $('#clear-transcript').click());
  $('#graph-courses').innerHTML = idx.list.map((c) => `<option value="${esc(c.code)}">${esc(c.title)}</option>`).join('');
  const setGraphFilter = (list) => { state.graphFilter = list; store.set('graphFilter', list); renderGraphTab(); };
  $('#graph-add').addEventListener('change', (e) => {
    const code = e.target.value.trim().toUpperCase().replace(/^([A-Z]+)\s*(\d)/, '$1 $2');
    e.target.value = '';
    if (known(code) && !state.graphFilter.includes(code)) { state.graphSelected = null; setGraphFilter([...state.graphFilter, code]); }
  });
  $('#graph-clear').addEventListener('click', () => setGraphFilter([]));
  $('#graph-focus').addEventListener('click', (e) => {
    const r = e.target.closest('[data-unfilter]');
    if (r) setGraphFilter(state.graphFilter.filter((c) => c !== r.dataset.unfilter));
  });
  // phone layout: one pane at a time, switched by the bottom bar
  const appEl = document.querySelector('.app');
  const phone = window.matchMedia('(max-width: 960px)');
  const showPane = (pane) => {
    appEl.classList.toggle('show-left', pane === 'left');
    appEl.classList.toggle('show-right', pane === 'right');
    $('#mtab-search').classList.toggle('on', pane === 'left');
    if (pane === 'left') for (const t of $$('.tab')) t.setAttribute('aria-selected', 'false');
    else window.scrollTo({ top: 0 });
  };
  $('#mtab-search').addEventListener('click', () => showPane('left'));
  for (const t of $$('.tab')) t.addEventListener('click', () => showPane('right'));
  // anything that calls setTab (Add buttons, graph links, chat links) also reveals the right pane
  let ready = false;
  paneHook = () => { if (ready && phone.matches) showPane('right'); };
  startPhone = () => { ready = true; if (phone.matches) showPane('left'); };
  paneLeft = () => { if (ready && phone.matches) showPane('left'); };
  els.search.placeholder = phone.matches ? 'Search courses, e.g. CS 331' : els.search.placeholder;
  renderScheduleTab();
  setTab(state.tab);
  startPhone?.();

  const q = readHash();
  if (q) setQuery(q, { focusInput: false });
  else els.search.focus({ preventScroll: true });
}

start();

// for debugging in the console
window.advisor = { state, creditNumber, treeToText };
