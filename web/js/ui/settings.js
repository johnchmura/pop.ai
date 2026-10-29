// Settings menu: light / dark / system, and the colors.
// Colors are CSS variables set on <html>. Everything is saved in this browser.

import { store, esc } from './util.js';

const DEFAULTS = { accent: '#3b6fd8', cs: '#a9bf2a', math: '#6aa6e0', arch: '#4f93d6', edge: '#1b365d' };
const LABELS = { accent: 'Accent (links, focus)', cs: 'CS courses', math: 'MATH courses', arch: 'ARCH courses', edge: 'Graph lines' };
const BG_DEFAULT = { light: { left: '#ffffff', right: '#f2f2f7' }, dark: { left: '#15171c', right: '#0f1115' } };
const PRESETS = [
  { name: 'Default', colors: null },
  { name: 'Ocean', colors: { accent: '#0e7490', cs: '#2bb3a3', math: '#5aa9e6', arch: '#2f6fb5', edge: '#0b3d5c' } },
  { name: 'Forest', colors: { accent: '#2e7d4f', cs: '#7bb661', math: '#4fb0a0', arch: '#2f7d6d', edge: '#1f4d3a' } },
  { name: 'Sunset', colors: { accent: '#d9622b', cs: '#e8b339', math: '#f08a6c', arch: '#c9486b', edge: '#6b2d3c' } },
  { name: 'Violet', colors: { accent: '#7048e8', cs: '#b197fc', math: '#74c0fc', arch: '#9775fa', edge: '#3b2a78' } },
  { name: 'Mono', colors: { accent: '#333333', cs: '#9aa0a6', math: '#c3c7cc', arch: '#6f757b', edge: '#333333' } },
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
  let colors = (() => { const c = store.get('colors', {}); const out = {}; for (const k of Object.keys(DEFAULTS)) if (HEX.test(c?.[k] || '')) out[k] = c[k]; return out; })();
  let bg = (() => { const c = store.get('panelColors', {}); const out = { light: {}, dark: {} }; for (const m of ['light', 'dark']) for (const k of ['left', 'right']) if (HEX.test(c?.[m]?.[k] || '')) out[m][k] = c[m][k]; return out; })();

  const effective = () => {
    if (theme === 'light' || theme === 'dark') return theme;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  };

  function apply() {
    if (theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme);
    const mode = effective();
    const dark = mode === 'dark';
    const set = (name, value) => (value ? root.style.setProperty(name, value) : root.style.removeProperty(name));
    set('--focus', colors.accent);
    for (const [key, prefix] of [['cs', 'lime'], ['math', 'sky'], ['arch', 'blue']]) {
      const s = colors[key] ? shades(colors[key], dark) : null;
      set(`--${prefix}-bg`, s?.bg); set(`--${prefix}-border`, s?.border); set(`--${prefix}-text`, s?.text); set(`--${prefix}-sub`, s?.sub);
    }
    set('--edge', colors.edge ? (dark ? mix(colors.edge, '#ffffff', 0.55) : colors.edge) : '');
    set('--left-bg', bg[mode].left);
    set('--right-bg', bg[mode].right);
    set('--page', bg[mode].right ? mix(bg[mode].right, dark ? '#000000' : '#000000', dark ? 0.2 : 0.04) : '');
    button.setAttribute('aria-label', 'Settings');
    onChange?.();
  }

  const save = () => { store.set('theme', theme); store.set('colors', colors); store.set('panelColors', bg); };

  function render() {
    const mode = effective();
    const val = (k) => colors[k] || DEFAULTS[k];
    menu.innerHTML = `
      <h2 class="set-title">Settings</h2>
      <fieldset class="set-group"><legend>Mode</legend>
        <div class="set-seg" role="radiogroup" aria-label="Mode">
          ${['light', 'dark', 'system'].map((t) => `<button type="button" role="radio" aria-checked="${theme === t}" data-mode="${t}">${t[0].toUpperCase()}${t.slice(1)}</button>`).join('')}
        </div>
      </fieldset>
      <fieldset class="set-group"><legend>Color themes</legend>
        <div class="set-presets">
          ${PRESETS.map((p) => {
            const c = p.colors || DEFAULTS;
            return `<button type="button" class="preset" data-preset="${esc(p.name)}" title="${esc(p.name)}"><span class="sw"><i style="background:${c.cs}"></i><i style="background:${c.math}"></i><i style="background:${c.arch}"></i></span>${esc(p.name)}</button>`;
          }).join('')}
        </div>
      </fieldset>
      <fieldset class="set-group"><legend>Colors</legend>
        ${Object.keys(DEFAULTS).map((k) => `<label class="set-row"><span>${esc(LABELS[k])}</span><span class="set-pick"><input type="color" data-color="${k}" value="${val(k)}" aria-label="${esc(LABELS[k])}"></span></label>`).join('')}
        <label class="set-row"><span>Left panel (${mode})</span><span class="set-pick"><input type="color" data-bg="left" value="${bg[mode].left || BG_DEFAULT[mode].left}" aria-label="left panel"></span></label>
        <label class="set-row"><span>Right panel (${mode})</span><span class="set-pick"><input type="color" data-bg="right" value="${bg[mode].right || BG_DEFAULT[mode].right}" aria-label="right panel"></span></label>
      </fieldset>
      <button type="button" class="btn" data-reset>Reset colors</button>`;
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
    const p = e.target.closest('[data-preset]');
    if (p) { const preset = PRESETS.find((x) => x.name === p.dataset.preset); colors = preset?.colors ? { ...preset.colors } : {}; save(); apply(); render(); return; }
    if (e.target.closest('[data-reset]')) { colors = {}; bg = { light: {}, dark: {} }; save(); apply(); render(); }
  });
  // live update while a color picker is dragged
  menu.addEventListener('input', (e) => {
    const el = e.target.closest('[data-color], [data-bg]');
    if (!el) return;
    let v = el.value.trim();
    if (el.type === 'text' && /^[0-9a-f]{6}$/i.test(v)) v = `#${v}`;
    if (!HEX.test(v)) return;
    if (el.dataset.color) colors[el.dataset.color] = v; else bg[effective()][el.dataset.bg] = v;
    // keep the picker and the text box in step
    for (const o of el.closest('.set-pick').querySelectorAll('input')) if (o !== el && o !== document.activeElement) o.value = v;
    save(); apply();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (theme === 'system') apply(); });

  apply();
  return { apply, close };
}
