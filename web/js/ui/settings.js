// Settings menu: light / dark / system, and the colors.
// Colors are CSS variables set on <html>. Everything is saved in this browser.

import { store, esc } from './util.js';

// Each theme sets the accent (links, focus), the course color, and the graph lines.
const PRESETS = [
  { name: 'Default', colors: { accent: '#3b6fd8', course: '#7f9be0', edge: '#1b365d' } },
  { name: 'Ocean', colors: { accent: '#0e7490', course: '#3aa6b9', edge: '#0b3d5c' } },
  // Forest keeps green out of the course and accent colors, so "completed" (green) stays easy to see
  { name: 'Forest', colors: { accent: '#2e6b5e', course: '#b39b6e', edge: '#2a4a3f' } },
  { name: 'Sunset', colors: { accent: '#d9622b', course: '#e8955f', edge: '#6b2d3c' } },
  { name: 'Violet', colors: { accent: '#7048e8', course: '#9d85f2', edge: '#3b2a78' } },
  { name: 'Mono', colors: { accent: '#333333', course: '#9aa0a6', edge: '#333333' } },
];
const HEX = /^#[0-9a-f]{6}$/i;

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
/** t = share of `b`. */
const mix = (a, b, t) => { const x = rgb(a); const y = rgb(b); return hex(x.map((v, i) => v * (1 - t) + y[i] * t)); };

/** bg / border / text / sub colors for a base color. */
export function shades(base, dark) {
  if (dark) {
    return { bg: mix('#15171c', base, 0.26), border: mix('#15171c', base, 0.5), text: mix(base, '#ffffff', 0.72), sub: mix(base, '#ffffff', 0.5) };
  }
  return { bg: mix(base, '#ffffff', 0.78), border: mix(base, '#ffffff', 0.42), text: mix(base, '#000000', 0.62), sub: mix(base, '#000000', 0.42) };
}

export function createSettings({ button, menu, onChange }) {
  const root = document.documentElement;
  let theme = store.get('theme', 'system');
  if (!['light', 'dark', 'system'].includes(theme)) theme = 'system';
  let presetName = store.get('colorTheme', 'Default');
  if (!PRESETS.some((p) => p.name === presetName)) presetName = 'Default';
  const colors = () => PRESETS.find((p) => p.name === presetName).colors;

  const effective = () => {
    if (theme === 'light' || theme === 'dark') return theme;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  };

  function apply() {
    if (theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme);
    const mode = effective();
    const dark = mode === 'dark';
    const set = (name, value) => (value ? root.style.setProperty(name, value) : root.style.removeProperty(name));
    const c = colors();
    set('--focus', dark ? mix(c.accent, '#ffffff', 0.35) : c.accent); // lighter on dark backgrounds so links stay readable
    const sh = shades(c.course, dark);
    set('--course-bg', sh.bg); set('--course-border', sh.border); set('--course-text', sh.text); set('--course-sub', sh.sub);
    set('--edge', dark ? mix(c.edge, '#ffffff', 0.55) : c.edge);
    button.setAttribute('aria-label', 'Settings');
    onChange?.();
  }

  const save = () => { store.set('theme', theme); store.set('colorTheme', presetName); };

  function render() {
    menu.innerHTML = `
      <h2 class="set-title">Settings</h2>
      <fieldset class="set-group"><legend>Mode</legend>
        <div class="set-seg" role="radiogroup" aria-label="Mode">
          ${['light', 'dark', 'system'].map((t) => `<button type="button" role="radio" aria-checked="${theme === t}" data-mode="${t}">${t[0].toUpperCase()}${t.slice(1)}</button>`).join('')}
        </div>
      </fieldset>
      <fieldset class="set-group"><legend>Theme</legend>
        <div class="set-presets" role="radiogroup" aria-label="Theme">
          ${PRESETS.map((p) => `<button type="button" class="preset" role="radio" aria-checked="${p.name === presetName}" data-preset="${esc(p.name)}"><span class="sw"><i style="background:${p.colors.accent}"></i><i style="background:${p.colors.course}"></i></span>${esc(p.name)}</button>`).join('')}
        </div>
      </fieldset>
      <fieldset class="set-group"><legend>Your data</legend>
        <button type="button" class="btn danger-outline" data-erase>Erase my data</button>
      </fieldset>`;
  }

  const open = () => { render(); menu.hidden = false; button.setAttribute('aria-expanded', 'true'); };
  const close = () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };

  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => (menu.hidden ? open() : close()));
  document.addEventListener('click', (e) => { if (!menu.hidden && e.target.isConnected && !menu.contains(e.target) && !button.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { close(); button.focus(); } });

  menu.addEventListener('click', (e) => {
    // data-mode, not data-theme: <html> carries data-theme too, and closest() would find it
    const t = e.target.closest('[data-mode]');
    if (t && menu.contains(t)) { theme = t.dataset.mode; save(); apply(); render(); return; }
    if (e.target.closest('[data-erase]')) { close(); confirmErase(); return; }
    const p = e.target.closest('[data-preset]');
    if (p) { presetName = p.dataset.preset; save(); apply(); render(); }
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (theme === 'system') apply(); });

  // erase everything the app knows about the student (display settings stay); asks first
  const STUDENT_KEYS = ['transcript', 'aiPlan', 'planCache', 'readCache', 'chat', 'chatArchive', 'prefs', 'busy', 'completed', 'saved', 'filters', 'graphFilter', 'tab'];
  function confirmErase() {
    let dlg = document.getElementById('erase-dialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'erase-dialog';
      dlg.className = 'confirm-dialog';
      dlg.setAttribute('aria-labelledby', 'erase-title');
      dlg.innerHTML = `<h2 id="erase-title">Erase your data?</h2>
        <p>This removes your transcript, plan, saved courses, chat, saved preferences, and time commitments from this browser. Display settings stay. This cannot be undone.</p>
        <div class="confirm-actions"><button type="button" class="btn" value="cancel" data-cancel autofocus>Cancel</button><button type="button" class="btn danger" data-confirm>Erase</button></div>`;
      document.body.appendChild(dlg);
      dlg.addEventListener('click', (e) => {
        if (e.target === dlg || e.target.closest('[data-cancel]')) { dlg.close(); return; }
        if (e.target.closest('[data-confirm]')) {
          for (const k of STUDENT_KEYS) { try { localStorage.removeItem(`advisor:${k}`); } catch { /* storage off */ } }
          location.reload();
        }
      });
    }
    dlg.showModal();
  }

  apply();
  return { apply, close };
}
