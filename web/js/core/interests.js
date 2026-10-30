// What the student said in the chat, used to rank suggested courses for open plan slots.
// Course codes the student named count most; topic words the
// student typed ("machine learning", "psychology", "music") count when they appear in a course
// title or description. No DOM code here; tests use it too.

const CODE = /\b([A-Z]{2,4})\s?(\d{3})\b/g;
const WORD = /[a-z][a-z-]{3,}/g;
// common words and advising words that say nothing about a topic
const STOP = new Set(`
about above after again against also always another anything because been before being below between
both cannot class classes could course courses credit credits does doing done during each easy elective
electives else even every fall find from good great hard have having help here into just know like
looking make many maybe more most much must need needs next only other over really recommend
semester should some something spring still such summer sure take taken taking than that their them
then there these they thing things think this those through take took very want wants what when where
which while will with would year years your yours plan plans schedule degree major minor graduate
graduation requirement requirements required interested interest interesting best better please thanks
thank okay advisor professor professors research suggest suggested option options start term terms
love loved enjoy enjoyed stuff kind sort cool fun idea ideas topic topics field fields
`.split(/\s+/).filter(Boolean));

// words that only mean something inside a phrase ("machine learning", not "learn")
const SOLO_SKIP = new Set(['learn', 'learning', 'study', 'studying', 'system', 'systems', 'design', 'science', 'engineering', 'management', 'analysis', 'theory', 'applied', 'introduction']);

// short forms that course titles use: "History of AI", "Trustworthy AI"
const ALIASES = { 'artificial intelligence': /\bA\.?I\b\.?/, 'machine learn': /\bML\b/ };

const stem = (w) => w.replace(/(ies)$/, 'y').replace(/(ing|ers|er|s)$/, '');

/**
 * Read the chat. Returns { codes: Map(code -> weight), words: Set(stem) }.
 * Later messages count more (the student's latest interests win).
 */
export function chatInterests(messages = []) {
  const codes = new Map();
  const words = new Set();
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && typeof m.content === 'string' && !m.error).slice(-30);
  list.forEach((m, i) => {
    const recent = 1 + i / Math.max(1, list.length); // 1 .. 2
    const text = m.content.replace(/```[\s\S]*?```/g, ' '); // skip machine blocks
    // only what the student said counts (a star means "you mentioned this")
    if (m.role !== 'user') return;
    for (const [, subj, num] of text.toUpperCase().matchAll(CODE)) {
      const code = `${subj} ${num}`;
      codes.set(code, (codes.get(code) || 0) + recent);
    }
    topicWords(text, words);
  });
  return { codes, words };
}

/** Topic words and two-word phrases from free text ("machine learning" -> "machine learn"). */
function topicWords(text, words = new Set()) {
  if (/\bA\.?I\b/.test(text)) words.add('artificial intelligence'); // "AI" is too short for the word list
  for (const chunk of String(text).toLowerCase().split(/[^a-z\s-]+/)) {
    let run = [];
    const flush = () => {
      if (run.length === 1 && !SOLO_SKIP.has(run[0].raw)) words.add(run[0].stem);
      run = run.map((r) => r.stem);
      for (let k = 0; k + 1 < run.length; k++) words.add(`${run[k]} ${run[k + 1]}`);
      run = [];
    };
    for (const w of chunk.split(/\s+/)) {
      if (w.length >= 4 && !STOP.has(w)) run.push({ raw: w, stem: stem(w) });
      else flush();
    }
    flush();
  }
  return words;
}

/** The student's major as interests: "B.S. in Artificial Intelligence" -> "artificial intelligence". */
export function programInterests(program) {
  const name = String(program?.name || '').replace(/^(B\.?[AS]\.?|Bachelor)\s+(of|in)\s+/i, '').replace(/\b(with|and)\b/gi, ',');
  return { codes: new Map(), words: topicWords(name) };
}

/** How well one course matches the interests (0 = not at all). */
export function interestScore(course, interests) {
  if (!interests || (!interests.codes?.size && !interests.words?.size)) return 0;
  let score = (interests.codes.get(course.code) || 0) * 10;
  if (interests.words.size) {
    const stems = (t) => ` ${(String(t || '').toLowerCase().match(WORD) || []).map(stem).join(' ')} `;
    const title = stems(course.title);
    const desc = stems(course.description);
    for (const w of interests.words) {
      const alias = ALIASES[w];
      if (title.includes(` ${w} `) || alias?.test(course.title || '')) score += 3;
      else if (desc.includes(` ${w} `) || alias?.test(course.description || '')) score += 1;
    }
  }
  return score;
}

/**
 * Drop chat words that appear in many course descriptions ("learn", "students", "design"):
 * they match everything and say nothing about the student's interests.
 */
export function focusInterests(interests, courses, share = 0.03) {
  if (!interests?.words?.size || !courses?.length) return interests;
  const df = new Map();
  for (const c of courses) {
    const seen = ` ${(`${c.title || ''} ${c.description || ''}`.toLowerCase().match(WORD) || []).map(stem).join(' ')} `;
    for (const w of interests.words) if (seen.includes(` ${w} `)) df.set(w, (df.get(w) || 0) + 1);
  }
  const limit = Math.max(3, courses.length * share);
  return { codes: interests.codes, words: new Set([...interests.words].filter((w) => (df.get(w) || 0) <= limit)) };
}
