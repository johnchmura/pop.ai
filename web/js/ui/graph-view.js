// Course Graph tab: SVG drawing of core/graph.js output.

import { buildGraph, layoutGraph } from '../core/graph.js';
import { treeToText, evaluate, missingParts } from '../core/prereq.js';
import { esc, linkCodes, colorFamily } from './util.js';

const SVGNS = 'http://www.w3.org/2000/svg';

function subjectClass(node) {
  return node.external ? 'other external' : 'course';
}

export function renderGraph({ index, focus, options, completed, planned, els, selected, filtered = false, addButton = () => '', suggestions = [] }) {
  const graph = buildGraph(index, focus, {
    showDependents: options.showDependents,
    hideBridge: !options.showBridge,
    hideExternal: !options.showExternal,
  });

  if (!graph.focus.length) {
    els.focus.innerHTML = '';
    els.scroll.innerHTML = `<div class="graph-empty">
        <p>Search a course to view its prerequisites.</p>
        <div class="seg">${(suggestions.length ? suggestions : ['CS 331', 'MATH 251', 'CS 480', 'CS 115', 'MATH 151'].filter((c) => index.get(c)?.sections?.length).slice(0, 3)).map((c) => `<button type="button" data-search="${esc(c)}" title="${esc(index.get(c)?.title || '')}">${esc(c)}</button>`).join('')}</div>
      </div>`;
    els.detail.hidden = true;
    return;
  }

  els.focus.innerHTML = `<span>Showing:</span>${graph.focus.map((c) => {
    const cls = `c-${colorFamily(c.split(' ')[0])}`;
    return `<span class="focus-chip ${cls}">${esc(c)}${filtered ? `<button type="button" class="chip-x" data-unfilter="${esc(c)}" aria-label="Remove ${esc(c)} from filter">×</button>` : ''}</span>`;
  }).join('')}<span>· ${graph.nodes.length} course${graph.nodes.length === 1 ? '' : 's'}</span>`;

  const avail = Math.max(320, (els.scroll.clientWidth || els.scroll.parentElement?.clientWidth || 520) - 4);
  // Fit up to ~30% more nodes per row than the panel holds, then scale the drawing down to fit.
  const fit = Math.max(3, Math.floor((avail - 48 + 22) / (84 + 22)));
  const lay = layoutGraph(graph, { maxPerRow: Math.max(3, Math.floor(fit * 1.3)) });
  const scale = Math.min(1, avail / lay.width);
  const pos = new Map(lay.nodes.map((n) => [n.code, n]));
  const nodeInfo = new Map(graph.nodes.map((n) => [n.code, n]));
  const { nodeW, nodeH } = lay;
  // Courses that touch a focus course stay bold. Everything else is faded.
  const focusSet = new Set(graph.focus);
  const near = new Set();
  for (const e of graph.edges) {
    if (focusSet.has(e.from)) near.add(e.to);
    if (focusSet.has(e.to)) near.add(e.from);
  }

  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('width', Math.round(lay.width * scale));
  svg.setAttribute('height', Math.round(lay.height * scale));
  svg.setAttribute('viewBox', `0 0 ${lay.width} ${lay.height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Prerequisite graph for ${graph.focus.join(', ')}`);

  let out = `<defs>
      <marker id="arr-pre" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrow-pre" d="M0 0 L10 5 L0 10 z"/></marker>
      <marker id="arr-co" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrow-co" d="M0 0 L10 5 L0 10 z"/></marker>
    </defs><g class="edges">`;

  for (const e of graph.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x;
    const y1 = a.y + nodeH / 2;
    const x2 = b.x;
    const y2 = b.y - nodeH / 2 - 2;
    const dy = Math.max(30, (y2 - y1) * 0.5);
    const d = `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`;
    const touches = focusSet.has(e.from) || focusSet.has(e.to);
    const cls = `gedge${e.concurrent ? ' co' : ''}${e.alternative ? ' alt' : ''}${touches ? '' : ' faded'}`;
    const how = e.concurrent ? 'can be taken at the same time as' : 'is a prerequisite for';
    out += `<path class="${cls}" d="${d}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" marker-end="url(#${e.concurrent ? 'arr-co' : 'arr-pre'})"><title>${esc(`${e.from} ${how} ${e.to}${e.alternative ? ' (one of several options)' : ''}`)}</title></path>`;
  }
  out += '</g><g class="nodes">';

  for (const n of lay.nodes) {
    const info = nodeInfo.get(n.code);
    const done = completed.has(n.code);
    const course = index.get(n.code);
    const cls = `gnode${info.focus || near.has(n.code) ? '' : ' faded'} ${subjectClass(info)}${info.focus ? ' focus' : ''}${done ? ' done' : ''}${selected === n.code ? ' selected' : ''}`;
    const tip = info.external ? `${n.code} (not in this catalog)` : `${n.code}: ${course.title}${done ? ' — completed' : ''}`;
    out += `<g class="${cls}" data-code="${esc(n.code)}" tabindex="0" role="button" aria-label="${esc(tip)}" transform="translate(${n.x - nodeW / 2},${n.y - nodeH / 2})">
        <title>${esc(tip)}</title>
        <rect width="${nodeW}" height="${nodeH}" rx="${nodeH / 2}"/>
        <text x="${nodeW / 2}" y="${nodeH / 2}">${esc(n.code)}</text>
      </g>`;
  }
  out += '</g>';
  svg.innerHTML = out;
  els.scroll.replaceChildren(svg);

  renderDetail({ index, code: selected && pos.has(selected) ? selected : null, completed, planned, els, addButton });
}

export function renderDetail({ index, code, completed, planned, els, addButton = () => '' }) {
  if (!code) { els.detail.hidden = true; return; }
  const course = index.get(code);
  els.detail.hidden = false;
  if (!course) {
    els.detail.innerHTML = `<h3>${esc(code)}</h3><p class="muted">Not in the catalog.</p>`;
    return;
  }
  const known = (c) => index.has(c);
  let status = '';
  if (completed.has(code)) status = '<span class="badge ok">Completed</span>';
  else if (completed.size) {
    const st = evaluate(course.prereq, { completed, current: planned });
    if (st === 'met') status = '<span class="badge ok" title="You have every prerequisite">Eligible</span>';
    else if (st === 'unknown') status = `<span class="badge warn">Needs: ${esc(missingParts(course.prereq, { completed, current: planned }).join('; '))}</span>`;
    else status = `<span class="badge no">Missing: ${esc(missingParts(course.prereq, { completed, current: planned }).join('; '))}</span>`;
  }
  els.detail.innerHTML = `
    <h3>${esc(course.code)}: ${esc(course.title)}</h3>
    <div class="badges"><span class="badge">${esc(course.credits || '?')} credits</span>${status}</div>
    <p><b>Prerequisites:</b> ${course.prereq ? linkCodes(treeToText(course.prereq), known) : 'None'}</p>
    ${course.note ? `<p class="meta-line">${esc(course.note)}</p>` : ''}
    <p><b>Unlocks:</b> ${course.dependents.length ? course.dependents.map((d, i, a) => `<span class="nw"><button type="button" class="code-link" data-code="${esc(d.code)}">${esc(d.code)}</button>${i < a.length - 1 ? ',' : ''}</span>`).join(' ') : 'None'}</p>
    <div class="course-actions">
      ${addButton(code)}
      <button type="button" class="btn" data-search="${esc(code)}">Search ${esc(code)}</button>
      <button type="button" class="btn" data-ask="${esc(code)}">Ask advisor</button>
      <button type="button" class="btn${completed.has(code) ? ' on' : ''}" data-complete="${esc(code)}">${completed.has(code) ? '<span class="chk-ic" aria-hidden="true">✓</span>Taken' : 'Mark completed'}</button>
    </div>`;
}

/** Hover / focus a node: dim the rest and light up its edges. */
export function wireGraphHover(scrollEl) {
  const light = (code) => {
    const svg = scrollEl.querySelector('svg');
    if (!svg) return;
    if (!code) { svg.classList.remove('graph-dim'); return; }
    svg.classList.add('graph-dim');
    const on = new Set([code]);
    svg.querySelectorAll('.gedge').forEach((p) => {
      const hit = p.dataset.from === code || p.dataset.to === code;
      p.classList.toggle('on', hit);
      if (hit) { on.add(p.dataset.from); on.add(p.dataset.to); }
    });
    svg.querySelectorAll('.gnode').forEach((g) => g.classList.toggle('on', on.has(g.dataset.code)));
  };
  scrollEl.addEventListener('mouseover', (e) => light(e.target.closest('.gnode')?.dataset.code || null));
  scrollEl.addEventListener('mouseleave', () => light(null));
  scrollEl.addEventListener('focusin', (e) => light(e.target.closest('.gnode')?.dataset.code || null));
  scrollEl.addEventListener('focusout', () => light(null));
}
