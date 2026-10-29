// Changes to the degree plan that come from the student or the advisor chat.
// Degree Works shows things the app cannot know: adviser exceptions, waivers, transfer credit that
// was approved by email. The student pastes the email into the chat. The advisor proposes changes
// in a fenced block, and nothing changes until the student presses "Apply".
//
//   ```degree-changes
//   [{"type":"apply","course":"PHIL 381","requirement":"AI Breadth Course","why":"Adviser exception, 11/07/2024"},
//    {"type":"waive","requirement":"Minor Requirement","why":"Dean approved a second major"},
//    {"type":"add-course","course":"PHYS 221","title":"...","credits":4,"grade":"TR","term":"Summer 2026","requirement":"Science Requirements","why":"Transfer petition approved"},
//    {"type":"note","text":"Plans to retake CS 425 in summer"}]
//   ```
//
// No DOM code here; tests use it too.

import { normalizeCode } from './prereq.js';
import { groupForLabel } from './audit.js';

const FENCE = /```degree-changes[ \t]*\n?([\s\S]*?)(?:```|$)/;
const MAX_CHANGES = 12;
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Split a chat answer into its text and the proposed changes. Works on partial (streaming) text too. */
export function parseProposals(content) {
  const text = String(content || '');
  const m = FENCE.exec(text);
  if (!m) return { text, proposals: [] };
  const shown = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  let proposals = [];
  try {
    const parsed = JSON.parse(m[1]);
    if (Array.isArray(parsed)) proposals = parsed.filter((p) => p && typeof p === 'object').slice(0, MAX_CHANGES);
  } catch { /* partial or invalid: show nothing */ }
  return { text: shown, proposals };
}

/** The requirement group a name points to: exact name first, then a close match. */
export function findGroup(label, program) {
  const want = clip(label, 100).toLowerCase();
  if (!want) return null;
  return program.groups.find((g) => g.name.toLowerCase() === want || g.id === want) || groupForLabel(label, program);
}

let counter = 0;
const newId = () => `c${Date.now().toString(36)}${(counter++).toString(36)}`;

/**
 * Check one proposal. Returns { ok, label, change } or { ok: false, label, problem }.
 * `index` gives catalog titles and credits (optional).
 */
export function resolveProposal(p, program, index) {
  const type = String(p?.type || '');
  const why = clip(p?.why, 200);
  const needGroup = () => findGroup(p.requirement ?? p.group, program);
  if (type === 'apply') {
    const code = normalizeCode(p.course);
    const group = needGroup();
    if (!code) return { ok: false, label: 'Count a course toward a requirement', problem: 'The course code is missing or not valid.' };
    if (!group) return { ok: false, label: `Count ${code} toward “${clip(p.requirement, 60)}”`, problem: 'I could not find that requirement in your program.' };
    return { ok: true, label: `Count ${code} toward ${group.name}`, why, change: { kind: 'apply', code, group: group.name, reason: why } };
  }
  if (type === 'waive') {
    const group = needGroup();
    if (!group) return { ok: false, label: `Mark “${clip(p.requirement, 60)}” as met`, problem: 'I could not find that requirement in your program.' };
    return { ok: true, label: `Mark ${group.name} as met`, why, change: { kind: 'waive', group: group.name, reason: why } };
  }
  if (type === 'add-course') {
    const code = normalizeCode(p.course);
    if (!code) return { ok: false, label: 'Add a course', problem: 'The course code is missing or not valid.' };
    const grade = clip(p.grade, 3).toUpperCase();
    const status = p.status === 'in-progress' || (!grade && p.status !== 'completed') ? 'in-progress' : 'completed';
    let credits = Number(p.credits);
    if (!Number.isFinite(credits) || credits < 0 || credits > 12) credits = null;
    if (credits == null) { const n = Number(index?.get?.(code)?.credits); credits = Number.isFinite(n) && n > 0 ? n : null; }
    const group = p.requirement ? needGroup() : null;
    if (p.requirement && !group) return { ok: false, label: `Add ${code}`, problem: `I could not find the requirement “${clip(p.requirement, 60)}”.` };
    const record = {
      code, title: clip(p.title || index?.get?.(code)?.title, 120), credits, grade: status === 'in-progress' ? '' : grade, term: clip(p.term, 30),
      status, transfer: ['TR', 'T', 'AP', 'CR'].includes(grade), repeatExcluded: false,
      ...(group ? { appliesTo: group.name } : {}),
    };
    const what = status === 'in-progress' ? 'in progress' : (grade || 'completed');
    return { ok: true, label: `Add ${code}${record.title ? ` ${record.title}` : ''} (${what}${record.term ? `, ${record.term}` : ''})${group ? ` toward ${group.name}` : ''}`, why, change: { kind: 'add-course', record, group: group?.name || '', reason: why } };
  }
  if (type === 'note') {
    const text = clip(p.text, 300);
    if (!text) return { ok: false, label: 'Add a note', problem: 'The note is empty.' };
    return { ok: true, label: `Note: ${text}`, why: '', change: { kind: 'note', text, reason: '' } };
  }
  return { ok: false, label: 'Unknown change', problem: 'I do not know how to apply this change.' };
}

/** Apply one change to a transcript object. Returns a new transcript object. */
export function applyChange(t, change) {
  const entry = { id: newId(), at: Date.now(), ...change };
  let courses = t.courses || [];
  if (change.kind === 'apply') {
    const prev = courses.find((c) => c.code === change.code)?.appliesTo || '';
    entry.prev = prev;
    courses = courses.map((c) => (c.code === change.code ? { ...c, appliesTo: change.group } : c));
  } else if (change.kind === 'add-course') {
    courses = [...courses, { ...change.record }];
  }
  const changes = [...(t.changes || []).filter((c) => !(c.kind === change.kind && c.code === change.code && c.group === change.group && c.text === change.text && c.kind !== 'add-course')), entry];
  return { ...t, courses, changes };
}

/** Undo a change by id. */
export function undoChange(t, id) {
  const entry = (t.changes || []).find((c) => c.id === id);
  if (!entry) return t;
  let courses = t.courses || [];
  if (entry.kind === 'apply') {
    courses = courses.map((c) => {
      if (c.code !== entry.code) return c;
      const { appliesTo, ...rest } = c; // eslint-disable-line no-unused-vars
      return entry.prev ? { ...rest, appliesTo: entry.prev } : rest;
    });
  } else if (entry.kind === 'add-course') {
    const r = entry.record;
    const i = courses.findIndex((c) => c.code === r.code && c.term === r.term && c.grade === r.grade);
    if (i >= 0) courses = [...courses.slice(0, i), ...courses.slice(i + 1)];
  }
  return { ...t, courses, changes: t.changes.filter((c) => c.id !== id) };
}

/** Requirements the student marked as met. */
export const waiversOf = (t) => (t?.changes || []).filter((c) => c.kind === 'waive').map((c) => ({ group: c.group, reason: c.reason || '' }));

/** A short, safe copy of the changes for the server (chat context). */
export function changesForServer(t) {
  return (t?.changes || []).slice(0, 30).map((c) => ({
    kind: c.kind, code: c.code || c.record?.code || '', group: c.group || '', text: c.text || '', reason: c.reason || '',
    ...(c.kind === 'add-course' ? { grade: c.record?.grade || '', term: c.record?.term || '', credits: c.record?.credits ?? null } : {}),
  }));
}

/** One line of plain text for a change (Degree tab list and server context). */
export function describeChange(c) {
  const why = c.reason ? ` (${c.reason})` : '';
  if (c.kind === 'apply') return `${c.code} counts toward ${c.group}${why}`;
  if (c.kind === 'waive') return `${c.group} is marked as met${why}`;
  if (c.kind === 'add-course') {
    const r = c.record || c;
    return `${r.code} added${r.grade ? ` (${r.grade})` : r.status === 'in-progress' ? ' (in progress)' : ''}${c.group ? ` toward ${c.group}` : ''}${why}`;
  }
  return `Note: ${c.text}`;
}
