// Schedule tab: saved sections list + weekly grid.
// The grid uses the pop.ai layout from core/schedule.js.

import { buildBlocks, gridBounds, findConflicts, DAY_LABELS, formatHour } from '../core/schedule.js';
import { creditNumber } from '../core/catalog.js';
import { commitmentBlocks, sectionClashes } from '../core/commitments.js';
import { esc, colorFamily } from './util.js';

const X_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

function meetingSummary(section) {
  const real = section.meetings.filter((m) => m.days && m.days !== 'TBA' && m.time && m.time !== 'TBA');
  if (!real.length) return section.bucket === 'Internet' ? 'Online · no meeting time' : 'Time TBA';
  return real.map((m) => `${m.days} ${m.time.replace(/\s*-\s*/, '–').replace(/ (AM|PM)/g, (x, ap) => ap.toLowerCase())}`).join(', ');
}

export function renderSchedule({ index, savedCrns, busy = [], els, onRemove, onOpenCourse }) {
  const items = savedCrns
    .map((crn) => index.crnMap.get(crn))
    .filter(Boolean)
    .map((s) => ({ key: s.crn, label: s.course, colorKey: s.course.split(' ')[0], section: s }));

  const { blocks, unscheduled } = buildBlocks(items);
  const conflicts = findConflicts(blocks);
  const busyBlocks = commitmentBlocks(busy);
  const conflictWith = new Map();
  for (const c of conflicts) {
    for (const [x, y] of [[c.a, c.b], [c.b, c.a]]) {
      if (!conflictWith.has(x)) conflictWith.set(x, []);
      conflictWith.get(x).push({ other: y, day: c.day, start: c.start, end: c.end });
    }
  }

  // ----- saved list -----
  const courseCodes = [...new Set(items.map((i) => i.label))];
  const credits = courseCodes.reduce((sum, code) => sum + creditNumber(index.get(code)), 0);
  els.summary.textContent = items.length
    ? `${courseCodes.length} course${courseCodes.length === 1 ? '' : 's'} · ${credits} credits`
    : '';

  if (!items.length) {
    els.list.innerHTML = '<p class="saved-empty">No saved courses.</p>';
  } else {
    els.list.innerHTML = items.map((it) => {
      const s = it.section;
      const course = index.get(s.course);
      const fam = colorFamily(it.colorKey);
      const clash = conflictWith.get(s.crn) || [];
      const clashText = clash.length
        ? `<span class="conflict-note">Time conflict with ${clash.map((c) => `${esc(index.crnMap.get(c.other).course)} on ${DAY_LABELS[c.day][0]}${DAY_LABELS[c.day].slice(1).toLowerCase()} ${formatHour(c.start)}`).join(', ')}</span>`
        : '';
      const busyHits = sectionClashes(s, busy);
      const busyText = busyHits.length ? `<span class="conflict-note">Conflicts with ${[...new Set(busyHits.map((h) => esc(h.label)))].join(', ')}</span>` : '';
      const seats = s.available == null ? '' : `<small>${s.available} seat${s.available === 1 ? '' : 's'} open · CRN ${esc(s.crn)}</small>`;
      return `<div class="saved-item c-${fam}${clash.length || busyHits.length ? ' has-conflict' : ''}" data-crn="${esc(s.crn)}">
          <div>
            <button type="button" class="saved-code" data-open="${esc(s.course)}">${esc(s.course)}${s.scheduleType && s.scheduleType !== 'Lecture' ? ` <span class="sub" style="font-size:14px;font-weight:500">· ${esc(s.scheduleType)}</span>` : ''}</button>
            <div class="saved-title sub">${esc(course?.title || '')}</div>
          </div>
          <div class="saved-time">${esc(meetingSummary(s))}${seats}</div>
          <button type="button" class="saved-remove" data-remove="${esc(s.crn)}" aria-label="Remove ${esc(s.course)} CRN ${esc(s.crn)}">${X_ICON}</button>
          ${clashText}${busyText}
        </div>`;
    }).join('');
  }
  els.foot.hidden = !index.sample;

  // ----- grid -----
  const { start, end, days } = gridBounds([...blocks, ...busyBlocks]);
  const cols = days.length;
  const hours = [];
  for (let h = start; h < end; h++) hours.push(h);
  let html = `<div class="h corner"></div>${days.map((d) => `<div class="h">${DAY_LABELS[d]}</div>`).join('')}`;
  for (const h of hours) {
    html += `<div class="t">${formatHour(h)}</div>`;
    for (let i = 0; i < cols; i++) html += '<div class="c"></div>';
  }
  html += '<div class="blocks" id="sched-blocks"></div>';
  els.grid.style.gridTemplateColumns = `var(--timecol) repeat(${cols}, minmax(0, 1fr))`;
  els.grid.innerHTML = html;

  // Place blocks over the day cells using the cell boxes, so they line up at any width.
  const place = () => {
    const layer = els.grid.querySelector('#sched-blocks');
    if (!layer) return;
    const gridBox = els.grid.getBoundingClientRect();
    const heads = [...els.grid.querySelectorAll('.h')].slice(1);
    const times = [...els.grid.querySelectorAll('.t')];
    if (!heads.length || !times.length) return;
    const top0 = times[0].getBoundingClientRect().top - gridBox.top;
    const lastBox = times[times.length - 1].getBoundingClientRect();
    const bottom = lastBox.bottom - gridBox.top;
    const perHour = (bottom - top0) / (end - start);
    layer.style.cssText = 'left:0;top:0;right:0;bottom:0';
    const busyHtml = busyBlocks.map((b) => {
      const col = days.indexOf(b.day);
      if (col < 0) return '';
      const hb = heads[col].getBoundingClientRect();
      const left = hb.left - gridBox.left + 2;
      const top = top0 + (Math.max(b.start, start) - start) * perHour + 1;
      const height = Math.max(14, (Math.min(b.end, end) - Math.max(b.start, start)) * perHour - 2);
      const label = `${b.label}, ${DAY_LABELS[b.day]} ${formatHour(b.start)} to ${formatHour(b.end)}`;
      return `<div class="busy-block" style="left:${left}px;top:${top}px;width:${hb.width - 4}px;height:${height}px" title="${esc(label)}" aria-label="${esc(label)}"><span>${esc(b.label)}</span></div>`;
    }).join('');
    layer.innerHTML = busyHtml + blocks.map((b) => {
      const col = days.indexOf(b.day);
      if (col < 0) return '';
      const hb = heads[col].getBoundingClientRect();
      const colW = hb.width / b.numColumns;
      const left = hb.left - gridBox.left + b.column * colW + 2;
      const width = colW - 4;
      const top = top0 + (b.start - start) * perHour + 2;
      const height = Math.max(18, (b.end - b.start) * perHour - 4);
      const fam = colorFamily(b.colorKey);
      const short = height < 54 || width < 104;
      const clash = conflictWith.has(b.key) ? ' conflict' : '';
      const label = `${b.label}, ${DAY_LABELS[b.day]} ${formatHour(b.start)} to ${formatHour(b.end)}${b.where ? `, ${b.where}` : ''}`;
      const narrow = width < 62 ? ' narrow' : '';
      return `<button type="button" class="block c-${fam}${short ? ' short' : ''}${narrow}${clash}" data-open="${esc(b.label)}" data-crn="${esc(b.key)}"
          style="left:${left}px;top:${top}px;width:${width}px;height:${height}px" title="${esc(label)}" aria-label="${esc(label)}">
          <span class="bl">${esc(b.label)}</span><small>${esc(formatHour(b.start))}–${esc(formatHour(b.end))}</small></button>`;
    }).join('');
  };
  place();
  requestAnimationFrame(place);

  // Online / TBA sections
  els.unscheduled.innerHTML = unscheduled.length
    ? `Unscheduled (online or TBA): ${unscheduled.map((u) => `<strong>${esc(u.label)}</strong> (CRN ${esc(u.key)})`).join(', ')}`
    : '';

  return { place, conflicts };
}

export function wireSchedule(els, { onRemove, onOpenCourse }) {
  const handler = (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) return onRemove(rm.dataset.remove);
    const open = e.target.closest('[data-open]');
    if (open) return onOpenCourse(open.dataset.open);
  };
  els.list.addEventListener('click', handler);
  els.grid.addEventListener('click', handler);
  // hover a saved item -> highlight its blocks
  els.list.addEventListener('mouseover', (e) => {
    const item = e.target.closest('.saved-item');
    els.grid.querySelectorAll('.block').forEach((b) => b.classList.toggle('hl', !!item && b.dataset.crn === item.dataset.crn));
  });
  els.list.addEventListener('mouseleave', () => els.grid.querySelectorAll('.block.hl').forEach((b) => b.classList.remove('hl')));
}
