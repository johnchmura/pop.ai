// Finds the student's degree program from a transcript.
// Two signals:
//   1. The header text ("Major and Department: Computer Science"). Strong when it matches a program name.
//   2. The courses. Required courses that few programs share count more (a simple IDF weight).
// Returns { programId, confidence: 'high' | 'medium' | 'low', reason, alternatives: [{ id, name }] }.
// It never needs a network call. The student can always change the program.

const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/\bb\.?\s?s\.?\b/g, ' ')
  .replace(/\bbachelor('?s)? of (science|arts|architecture)( in)?\b/g, ' ')
  .replace(/\bartificial intelligence\b/g, 'ai')
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const HEADER_RX = /(?:major(?:\s+and\s+department)?|program|degree|curriculum|field\s+of\s+study)\s*[:\-]\s*([^\n\r]{2,120})/gi;

/** Candidate major names found in the transcript header. */
export function headerMajors(text) {
  const head = String(text || '').split('\n').slice(0, 60).join('\n');
  const found = [];
  // Degree Works: "Major Artificial Intelligence Minor Economics Program Bachelor of Science - Artificial Intelligence College ..."
  const flat = head.replace(/\s+/g, ' ');
  const dwMajor = /\bMajor ([A-Z][A-Za-z&,' -]{2,80}?) (?:Minor|Program|Concentration|College)\b/.exec(flat);
  if (dwMajor) found.push(dwMajor[1].trim());
  const dwProgram = /\bProgram Bachelor of (?:Science|Arts)(?: in)? - ([A-Z][A-Za-z&,' -]{2,80}?) College\b/.exec(flat);
  if (dwProgram) found.push(dwProgram[1].trim());
  for (const m of head.matchAll(HEADER_RX)) {
    // "Computer Science, Computer Science" -> both parts; drop generic words
    for (const part of m[1].split(/[,;|]|\s{3,}/)) {
      const p = part.trim();
      if (p && !/^(bachelor|master|undergraduate|graduate|none|n\/a)\b/i.test(p) && !/^(of )?(science|arts)$/i.test(p)) found.push(p);
    }
  }
  return found;
}

function requiredCodes(program) {
  const out = new Set();
  for (const g of program.groups || []) {
    if (g.type === 'all') for (const slot of g.slots) for (const option of slot) option.forEach((c) => out.add(c));
    else for (const c of g.from?.codes || []) out.add(c);
  }
  return out;
}

const shortName = (p) => p.majorName || p.name.replace(/^B\.[SA]\. in /, '');

/**
 * records: transcript courses [{ code, status }]. status 'not-counted' is ignored.
 * opts.headerText: raw transcript text, or opts.majors: list of major strings (from Claude).
 */
export function detectProgram(records, programs, opts = {}) {
  if (!programs?.length) return null;
  const majors = [...(opts.majors || []), ...headerMajors(opts.headerText || '')].map(norm).filter(Boolean);
  const alt = (list) => list.filter(Boolean).slice(0, 3).map((p) => ({ id: p.id, name: p.name }));

  // 1. header match
  let headerHit = null;
  if (majors.length) {
    const scored = programs.map((p) => {
      const name = norm(shortName(p));
      let score = 0;
      for (const m of majors) {
        if (m === name) score = Math.max(score, 3);
        else if (name.startsWith(`${m} `) || m.startsWith(`${name} `)) score = Math.max(score, 2);
        else if (name.includes(m) && m.length > 4) score = Math.max(score, 1);
      }
      // a plain "Computer Science" header must not pick the AI variant
      if (score && /\bai\b/.test(name) && !majors.some((m) => /\bai\b/.test(m))) score -= 0.5;
      return { p, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    if (scored.length) headerHit = scored;
  }

  // 2. course match
  const have = new Set((records || []).filter((r) => r.status !== 'not-counted').map((r) => r.code));
  const codeSets = programs.map(requiredCodes);
  const df = new Map();
  for (const set of codeSets) for (const c of set) df.set(c, (df.get(c) || 0) + 1);
  const idf = (c) => Math.log(1 + programs.length / (df.get(c) || 1));
  const ranked = programs.map((p, i) => {
    const set = codeSets[i];
    let hit = 0;
    let total = 0;
    for (const c of set) { const w = idf(c); total += w; if (have.has(c)) hit += w; }
    // reward matches, but do not punish a program just because it lists many courses
    const score = total ? hit / Math.sqrt(total) : 0;
    return { p, score, hit };
  }).sort((a, b) => b.score - a.score);
  const top = ranked[0];
  const second = ranked[1];
  const courseOk = top && top.hit > 0 && (!second || top.score >= second.score * 1.15);

  if (headerHit) {
    const best = headerHit[0];
    const tied = headerHit.filter((x) => x.score === best.score);
    if (tied.length === 1) {
      return { programId: best.p.id, confidence: 'high', reason: `Your transcript says your major is ${shortName(best.p)}.`, alternatives: alt(headerHit.slice(1).map((x) => x.p)) };
    }
    // several programs share the major name (for example a plain and an "AI" version): use the courses to choose
    const pick = ranked.find((r) => tied.some((t) => t.p.id === r.p.id)) || tied[0];
    return { programId: pick.p.id, confidence: 'medium', reason: `Your transcript names ${shortName(best.p)}. Several programs match, so the app used your courses to choose.`, alternatives: alt(tied.map((x) => x.p).filter((p) => p.id !== pick.p.id)) };
  }
  if (courseOk && top.score >= 2) {
    return { programId: top.p.id, confidence: top.score >= 4 ? 'high' : 'medium', reason: 'Your courses match this program best.', alternatives: alt(ranked.slice(1, 4).filter((r) => r.hit > 0).map((r) => r.p)) };
  }
  if (top && top.hit > 0) {
    return { programId: top.p.id, confidence: 'low', reason: 'There are not enough courses to be sure. Please check the program.', alternatives: alt(ranked.slice(1, 4).filter((r) => r.hit > 0).map((r) => r.p)) };
  }
  return null;
}
