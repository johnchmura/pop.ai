// A draggable divider between the left (search) and right (tabs) panels.
// Drag, or focus it and use the arrow keys. Double-click resets. The size is saved in the browser.

import { store } from './util.js';

const MIN = 28; // percent of the window width
const MAX = 72;
const WIDE = '(min-width: 961px)';

export function initSplitter({ app, left, handle }) {
  const media = window.matchMedia(WIDE);
  let pct = Number(store.get('splitPct', 0)) || 0; // 0 = default layout
  if (pct && (pct < MIN || pct > MAX)) pct = 0;

  const place = () => {
    handle.hidden = !media.matches;
    if (!media.matches) { app.style.gridTemplateColumns = ''; return; }
    app.style.gridTemplateColumns = pct ? `${pct}% minmax(0, 1fr)` : '';
    const x = left.getBoundingClientRect().right - app.getBoundingClientRect().left;
    handle.style.left = `${x}px`;
    const now = Math.round((x / app.clientWidth) * 100);
    handle.setAttribute('aria-valuenow', String(now));
  };

  const set = (value, save = true) => {
    pct = value ? Math.min(MAX, Math.max(MIN, value)) : 0;
    if (save) store.set('splitPct', pct);
    place();
  };
  const fromPointer = (clientX) => set(((clientX - app.getBoundingClientRect().left) / app.clientWidth) * 100, false);

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const move = (ev) => fromPointer(ev.clientX);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      store.set('splitPct', pct);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
    e.preventDefault();
  });
  handle.addEventListener('dblclick', () => set(0));
  handle.addEventListener('keydown', (e) => {
    const current = Number(handle.getAttribute('aria-valuenow')) || 54;
    if (e.key === 'ArrowLeft') set(current - 2);
    else if (e.key === 'ArrowRight') set(current + 2);
    else if (e.key === 'Home') set(MIN);
    else if (e.key === 'End') set(MAX);
    else if (e.key === 'Escape') set(0);
    else return;
    e.preventDefault();
  });

  media.addEventListener('change', place);
  window.addEventListener('resize', place);
  new ResizeObserver(place).observe(left);
  place();
  return { reset: () => set(0), place };
}
