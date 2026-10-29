// Prerequisite graph for the "Course Graph" tab.
// Builds the set of nodes around the focus courses and lays them out in layers
// (prerequisites on top, later courses below). No DOM code here.

import { courseLeaves } from './prereq.js';
import { ancestors } from './catalog.js';

/**
 * opts:
 *   showDependents: also show courses that list a focus course as a prerequisite (1 level;
 *                   with several focus courses, only the ones that need two or more of them)
 *   hideBridge:     hide graduate bridge courses (CS 401/402/403) unless they are a focus
 *   hideExternal:   hide courses that are not in the catalog file (ECE 242, CSSP 401, ...)
 */
export function buildGraph(index, focusCodes, opts = {}) {
  const o = { showDependents: true, hideBridge: true, hideExternal: true, ...opts };
  const focus = new Set(focusCodes.filter((c) => index.courses.has(c)));
  const keep = (code) => {
    if (focus.has(code)) return true;
    const course = index.courses.get(code);
    if (!course) return !o.hideExternal;
    if (o.hideBridge && course.bridge) return false;
    return true;
  };

  const nodes = new Set(focus);
  for (const f of focus) {
    for (const a of ancestors(index, f, keep)) nodes.add(a);
  }
  // Courses the focus unlocks. With one focus course, show all of them.
  // With several, show only courses that build on two or more of them (keeps the graph readable).
  if (o.showDependents) {
    const count = new Map();
    for (const f of focus) {
      for (const d of index.courses.get(f).dependents) {
        if (keep(d.code)) count.set(d.code, (count.get(d.code) || 0) + 1);
      }
    }
    for (const [code, n] of count) if (focus.size === 1 || n >= 2) nodes.add(code);
  }

  const edges = [];
  for (const code of nodes) {
    const course = index.courses.get(code);
    if (!course) continue;
    for (const leaf of courseLeaves(course.prereq)) {
      if (!nodes.has(leaf.code)) continue;
      if (edges.some((e) => e.from === leaf.code && e.to === code)) continue;
      edges.push({ from: leaf.code, to: code, concurrent: leaf.concurrent, alternative: leaf.alternative });
    }
  }

  return {
    focus: [...focus],
    nodes: [...nodes].map((code) => {
      const course = index.courses.get(code);
      return { code, title: course?.title || '', subject: code.split(' ')[0], external: !course, focus: focus.has(code) };
    }),
    edges,
  };
}

const byCode = (a, b) => {
  const [sa, na] = a.split(' ');
  const [sb, nb] = b.split(' ');
  return sa === sb ? Number(na) - Number(nb) : sa.localeCompare(sb);
};

/**
 * Layered layout. Returns { nodes: [{code, x, y, layer}], width, height, nodeW, nodeH }.
 * x/y are node centers. A layer wider than `maxPerRow` wraps onto more rows,
 * so a course with many dependents still fits a narrow panel.
 */
export function layoutGraph(graph, { nodeW = 84, nodeH = 26, gapX = 22, gapY = 56, rowGap = 22, pad = 24, maxPerRow = Infinity } = {}) {
  const perRow = Number.isFinite(maxPerRow) ? Math.max(1, Math.floor(maxPerRow)) : Number.MAX_SAFE_INTEGER;
  const codes = graph.nodes.map((n) => n.code);
  const parents = new Map(codes.map((c) => [c, []]));
  const children = new Map(codes.map((c) => [c, []]));
  for (const e of graph.edges) {
    parents.get(e.to).push(e.from);
    children.get(e.from).push(e.to);
  }

  // longest-path layering (prereqs above). Depth guard keeps bad data from looping forever.
  const layerOf = new Map();
  const visit = (code, depth = 0) => {
    if (layerOf.has(code)) return layerOf.get(code);
    if (depth > codes.length) return 0;
    const ps = parents.get(code);
    const layer = ps.length ? 1 + Math.max(...ps.map((p) => visit(p, depth + 1))) : 0;
    layerOf.set(code, layer);
    return layer;
  };
  codes.forEach((c) => visit(c));

  const layerCount = codes.length ? Math.max(...layerOf.values()) + 1 : 0;
  const layers = Array.from({ length: layerCount }, () => []);
  for (const c of [...codes].sort(byCode)) layers[layerOf.get(c)].push(c);

  // barycenter sweeps to cut edge crossings
  const pos = new Map();
  const setPos = () => layers.forEach((l) => l.forEach((c, i) => pos.set(c, i - (l.length - 1) / 2)));
  setPos();
  const bary = (code, neighbors) => {
    const ns = neighbors.get(code);
    if (!ns.length) return pos.get(code);
    return ns.reduce((s, n) => s + pos.get(n), 0) / ns.length;
  };
  for (let iter = 0; iter < 6; iter++) {
    for (let i = 1; i < layers.length; i++) {
      layers[i].sort((a, b) => bary(a, parents) - bary(b, parents) || byCode(a, b));
      setPos();
    }
    for (let i = layers.length - 2; i >= 0; i--) {
      layers[i].sort((a, b) => bary(a, children) - bary(b, children) || byCode(a, b));
      setPos();
    }
  }

  const widest = Math.min(perRow, Math.max(1, ...layers.map((l) => l.length)));
  const width = pad * 2 + widest * nodeW + (widest - 1) * gapX;
  const out = [];
  let y = pad + nodeH / 2;
  layers.forEach((layer, li) => {
    for (let r = 0; r * perRow < layer.length; r++) {
      const row = layer.slice(r * perRow, (r + 1) * perRow);
      if (r > 0) y += nodeH + rowGap;
      const rowW = row.length * nodeW + (row.length - 1) * gapX;
      const x0 = (width - rowW) / 2 + nodeW / 2;
      row.forEach((code, i) => out.push({ code, layer: li, x: x0 + i * (nodeW + gapX), y }));
    }
    if (li < layers.length - 1) y += nodeH + gapY;
  });
  const height = codes.length ? y + nodeH / 2 + pad : pad * 2;
  return { nodes: out, width, height, nodeW, nodeH };
}
