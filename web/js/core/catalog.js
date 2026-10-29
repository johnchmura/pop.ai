// Course index: turns catalog.json + a pop.ai-style sections file into fast lookups.
// No DOM code here; the server and tests use it too.

import { courseLeaves, normalizeCode } from './prereq.js';

const DAY_NAMES = { U: 'Sunday', M: 'Monday', T: 'Tuesday', W: 'Wednesday', R: 'Thursday', F: 'Friday', S: 'Saturday' };

/**
 * pop.ai stores sections as { "Spring 2027": { Class: [...], Internet: [...] } }.
 * Its scraper output can also be { Class: [...] }. Accept both.
 */
function flattenSections(sections, fallbackSemester) {
  const out = [];
  if (!sections || typeof sections !== 'object') return out;
  const values = Object.values(sections);
  const isFlat = values.length > 0 && values.every(Array.isArray);
  const bySemester = isFlat ? { [fallbackSemester]: sections } : sections;
  for (const [semester, buckets] of Object.entries(bySemester)) {
    if (!buckets || typeof buckets !== 'object') continue;
    for (const [bucket, list] of Object.entries(buckets)) {
      if (!Array.isArray(list)) continue;
      for (const s of list) {
        out.push({
          crn: String(s.crn ?? '').trim(),
          scheduleType: TYPE_NAMES[s.schedule_type] || s.schedule_type || '',
          bucket: s.type || bucket,
          available: s.available === '' || s.available == null ? null : Number(s.available),
          specialTitle: s.special_title || '',
          semester,
          meetings: (s.meetings || []).map((m) => ({
            days: String(m.days || '').trim(),
            time: String(m.time || '').trim(),
            where: String(m.where || '').trim(),
            instructors: Array.isArray(m.instructors) ? m.instructors.filter(Boolean) : (m.instructors ? [String(m.instructors)] : []),
            dates: m.dates || '',
          })),
        });
      }
    }
  }
  return out;
}

export function dayWords(days) {
  return String(days || '').split('').map((d) => DAY_NAMES[d]).filter(Boolean);
}

/**
 * Build the index. `catalog` is data/catalog.json, `offerings` is data/sections.json (pop.ai export shape),
 * `forecast` (optional) is data/forecast.json: the CS department's tentative future offerings.
 */
// IIT schedule-type codes that Pop leaves as codes. Unknown codes are shown as they are.
const TYPE_NAMES = { STU: 'Studio', SEM: 'Seminar', PRA: 'Practicum', CLN: 'Clinic' };

export function buildIndex(catalog, offerings, forecast = null) {
  const semester = offerings?.semester_name || 'Spring 2027';
  const courses = new Map();
  const departments = catalog.departments || {};

  for (const raw of catalog.courses) {
    const code = normalizeCode(raw.code);
    if (!code) continue;
    const [subject, number] = code.split(' ');
    courses.set(code, {
      ...raw,
      code,
      subject,
      number,
      level: Number(number[0]) * 100,
      department: departments[subject] || subject,
      sections: [],
      dependents: [],
    });
  }

  // Sections. Courses that are offered but missing from the catalog get a small stub,
  // so real pop.ai exports with other subjects still load.
  const crnMap = new Map();
  for (const off of offerings?.courses || []) {
    const code = normalizeCode(off.name || off.course_name || off.code);
    if (!code) continue;
    if (!courses.has(code)) {
      const [subject, number] = code.split(' ');
      courses.set(code, {
        code, subject, number, level: Number(number[0]) * 100,
        title: off.title || '', credits: '', description: off.description || '',
        satisfies: off.attributes || '', prereqText: '', prereq: null,
        department: departments[subject] || subject, sections: [], dependents: [], stub: true,
      });
    }
    const course = courses.get(code);
    for (const section of flattenSections(off.sections, semester)) {
      if (!section.crn) continue;
      section.course = code;
      // IIT's report lists a section once per meeting time (a studio that meets W 1:50 and MF 1:50),
      // and Pop keeps each row. Merge rows with the same CRN into one section with all its meetings.
      const same = crnMap.get(section.crn);
      if (same && same.course === code) {
        for (const m of section.meetings || []) {
          const key = JSON.stringify([m.days, m.time, m.where]);
          if (!same.meetings.some((x) => JSON.stringify([x.days, x.time, x.where]) === key)) same.meetings.push(m);
        }
        if (section.scheduleType && !same.scheduleType.split(' + ').includes(section.scheduleType)) same.scheduleType += ` + ${section.scheduleType}`;
        continue;
      }
      course.sections.push(section);
      crnMap.set(section.crn, section);
    }
  }

  // Reverse edges: which courses list this one as a prerequisite.
  const external = new Map(); // code -> list of courses that mention it
  for (const course of courses.values()) {
    for (const leaf of courseLeaves(course.prereq)) {
      const target = courses.get(leaf.code);
      const entry = { code: course.code, concurrent: leaf.concurrent, alternative: leaf.alternative };
      if (target) {
        if (!target.dependents.some((d) => d.code === course.code)) target.dependents.push(entry);
      } else {
        if (!external.has(leaf.code)) external.set(leaf.code, []);
        external.get(leaf.code).push(entry);
      }
    }
  }
  for (const course of courses.values()) {
    course.dependents.sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
  }

  // Future offerings from the forecast
  if (forecast?.courses) {
    const labels = new Map((forecast.terms || []).map((t) => [t.key, t.label]));
    for (const course of courses.values()) {
      const keys = forecast.courses[course.code];
      course.futureTerms = keys ? keys.map((k) => labels.get(k) || k) : null;
      course.forecastNote = forecast.notes?.[course.code] || '';
    }
  }

  const sorted = [...courses.values()].sort((a, b) =>
    a.subject === b.subject ? Number(a.number) - Number(b.number) : a.subject.localeCompare(b.subject));

  return {
    semester,
    termCode: offerings?.term_code || '',
    sample: !!offerings?.sample,
    forecast: forecast || null,
    source: catalog.source || '',
    courses,
    list: sorted,
    crnMap,
    external,
    has: (code) => courses.has(code),
    get: (code) => courses.get(normalizeCode(code) || code),
  };
}

/**
 * Every course reachable by following prerequisite edges upward from `code`.
 * `filter(code)` can drop nodes (and stops the walk through them).
 * Returns Set of codes, not including `code` itself.
 */
export function ancestors(index, code, filter = () => true) {
  const out = new Set();
  const stack = [code];
  while (stack.length) {
    const cur = index.courses.get(stack.pop());
    if (!cur) continue;
    for (const leaf of courseLeaves(cur.prereq)) {
      if (out.has(leaf.code) || leaf.code === code || !filter(leaf.code)) continue;
      out.add(leaf.code);
      stack.push(leaf.code);
    }
  }
  return out;
}

/** Credits as a number, or 0 for "Variable" and unknown. */
export function creditNumber(course) {
  const n = Number(String(course?.credits || '').trim());
  return Number.isFinite(n) ? n : 0;
}

/** Short text for one section, close to pop.ai's section text. */
export function sectionText(section) {
  const parts = [];
  if (section.specialTitle) parts.push(section.specialTitle);
  parts.push(`${section.scheduleType || 'Section'} (${section.bucket})`);
  for (const m of section.meetings) {
    const bits = [];
    if (m.days && m.days !== 'TBA') bits.push(m.days);
    if (m.time && m.time !== 'TBA') bits.push(m.time);
    if (m.where) bits.push(m.where);
    if (m.instructors.length) bits.push(m.instructors.join(', '));
    if (bits.length) parts.push(bits.join(' · '));
  }
  return parts.join(' — ');
}
