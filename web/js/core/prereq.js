// Prerequisite trees.
// A tree node is one of:
//   { type: 'and',    children: [node, ...] }
//   { type: 'or',     children: [node, ...] }
//   { type: 'course', code: 'CS 331', minGrade?: 'C', concurrent?: true }
//   { type: 'text',   text: 'Graduate standing' }
// `concurrent: true` means the course may be taken in the same term (catalog asterisk).
// This file has no DOM code, so the server and the tests use it too.

const CODE_RE = /\b([A-Za-z]{2,4})[\s\-_]*(\d{3})(?![\d])/g;

/** "cs331", "CS-331", "cs 331" -> "CS 331". Returns '' when the text is not a course code. */
export function normalizeCode(text) {
  const m = /^\s*([A-Za-z]{2,4})[\s\-_]*(\d{3})\s*$/.exec(String(text || ''));
  return m ? `${m[1].toUpperCase()} ${m[2]}` : '';
}

/**
 * Find course codes in free text, in order, without repeats.
 * When `known` (a Set or Map of codes) is given, only known codes are kept.
 * Words like "and 300" are skipped because "AND" is not a subject.
 */
export function extractCodes(text, known) {
  const out = [];
  const seen = new Set();
  const src = String(text || '');
  CODE_RE.lastIndex = 0;
  let m;
  while ((m = CODE_RE.exec(src))) {
    const code = `${m[1].toUpperCase()} ${m[2]}`;
    if (seen.has(code)) continue;
    if (known && !known.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/** True when the tree can still be met without `code` (text rules count as met). */
function metWithout(node, code) {
  if (!node) return true;
  if (node.type === 'course') return node.code !== code;
  if (node.type === 'text') return true;
  if (node.type === 'and') return node.children.every((ch) => metWithout(ch, code));
  return node.children.some((ch) => metWithout(ch, code));
}

/**
 * All course leaves of a tree.
 * `alternative` is true when the rule can be met without this course
 * (it sits in an OR with other options), so the student does not need this exact course.
 */
export function courseLeaves(tree) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (node.type === 'course') {
      out.push({ code: node.code, concurrent: !!node.concurrent, minGrade: node.minGrade || '', alternative: metWithout(tree, node.code) });
    } else if (node.type === 'and' || node.type === 'or') {
      node.children.forEach(walk);
    }
  };
  walk(tree);
  return out;
}

function leafText(node) {
  if (node.type === 'text') return node.text;
  let s = node.code;
  if (node.concurrent) s += ' (can be taken at the same time)';
  if (node.minGrade) s += ` (min. grade ${node.minGrade})`;
  return s;
}

/** Plain-English text for a tree, with parentheses only where they matter. */
export function treeToText(tree) {
  if (!tree) return 'None';
  const walk = (node, parentType) => {
    if (node.type === 'course' || node.type === 'text') return leafText(node);
    const joiner = node.type === 'and' ? ' and ' : ' or ';
    const inner = node.children.map((ch) => walk(ch, node.type)).join(joiner);
    return parentType && parentType !== node.type && node.children.length > 1 ? `(${inner})` : inner;
  };
  return walk(tree, null);
}

/** True when `grade` is at least `minGrade` (letter grades only). */
const GRADE_RANK = { A: 4, B: 3, C: 2, D: 1, E: 0, F: 0 };
export function meetsMinGrade(grade, minGrade) {
  if (!minGrade || !grade) return true;
  const g = String(grade).toUpperCase().replace(/[+-]$/, '');
  const m = String(minGrade).toUpperCase();
  if (!(m in GRADE_RANK)) return true; // e.g. "S" (satisfactory) -> any passing grade
  if (!(g in GRADE_RANK)) return true; // P, S, TR, CR: cannot compare, count it
  return GRADE_RANK[g] >= GRADE_RANK[m];
}

/**
 * Check a tree against what the student has done.
 *   completed: Set of course codes already passed
 *   current:   Set of course codes planned for the same term (for concurrent leaves)
 * Returns 'met', 'unmet', or 'unknown'.
 * Text leaves ("Graduate standing", "Instructor permission") are 'unknown': the app cannot check them.
 * grades (optional): Map of code -> letter grade. When a rule has a minimum grade and the grade
 * is known, a lower grade does not count. Grades like P, S, or TR (transfer) count as meeting it.
 * textRules (optional): 'unknown' (default) or 'plan'. With 'plan' (used for an undergraduate plan),
 * "Graduate standing" counts as unmet, so "MATH 251 or Graduate standing" waits for MATH 251,
 * and other text rules (placement scores, permission) count as met.
 */
export function evaluate(tree, state = {}) {
  const { completed = new Set(), current = new Set(), grades = null } = state;
  if (!tree) return 'met';
  if (tree.type === 'course') {
    if (completed.has(tree.code)) {
      return grades && !meetsMinGrade(grades.get(tree.code), tree.minGrade) ? 'unmet' : 'met';
    }
    if (tree.concurrent && current.has(tree.code)) return 'met';
    return 'unmet';
  }
  if (tree.type === 'text') {
    if (state.textRules === 'plan') return /graduate standing/i.test(tree.text) ? 'unmet' : 'met';
    return 'unknown';
  }
  const results = tree.children.map((ch) => evaluate(ch, state));
  if (tree.type === 'and') {
    if (results.includes('unmet')) return 'unmet';
    if (results.includes('unknown')) return 'unknown';
    return 'met';
  }
  if (results.includes('met')) return 'met';
  if (results.includes('unknown')) return 'unknown';
  return 'unmet';
}

/** The parts of a tree that are still not met, as a list of short texts. */
export function missingParts(tree, state) {
  if (!tree) return [];
  const status = evaluate(tree, state);
  if (status === 'met') return [];
  if (tree.type === 'and') {
    return tree.children.flatMap((ch) => (evaluate(ch, state) === 'met' ? [] : [treeToText(ch)]));
  }
  return [treeToText(tree)];
}
