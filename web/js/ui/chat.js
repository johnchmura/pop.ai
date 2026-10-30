// Chat tab: talks to /api/chat (server-sent events) and renders answers.

import { esc, renderMarkdown, store } from './util.js';
import { parseProposals } from '../core/changes.js';
import { parseMemory } from '../core/commitments.js';

const BOT_ICON = '<span class="bot-avatar" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M2 13v2M22 13v2"/></svg></span>';
// the advisor ends a reply with this when the student asks to change the degree plan
const PLAN_MARK = /\s*\[\[update-plan\]\]\s*/;
const PLAN_MARKS = /\s*\[\[update-plan\]\]\s*/g;

const GREETING = 'Ask about courses, your plan, or research. 👋';
const SUGGESTIONS = [
  'What can I take after CS 331?',
  'Does my schedule have time conflicts?',
  'Who does machine learning research?',
];

export function createChat({ els, known, getContext, onCodeClick, resolveProposals, applyProposals, onMemory, openDegree, onChange, onPlanRequest }) {
  let messages = store.get('chat', []);
  if (!Array.isArray(messages)) messages = [];
  messages = messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-40);
  let busy = false;
  let controller = null;

  const save = () => { store.set('chat', messages.filter((m) => !m.error).slice(-40)); onChange?.(); };

  function bubble(m, i) {
    if (m.role === 'user') return `<div class="msg user"><div class="bubble">${esc(m.content)}</div></div>`;
    if (m.note) return `<div class="msg note" role="status"><span class="chk-ic" aria-hidden="true">✓</span>${esc(m.content)}</div>`;
    const { text, proposals } = parseProposals(parseMemory(m.content.replace(PLAN_MARKS, ' ')).text);
    const body = m.pending && !text
      ? '<span class="typing" aria-label="Thinking"><i></i><i></i><i></i></span>'
      : renderMarkdown(text, known);
    const card = proposals.length && !m.pending && !m.error ? proposalCard(m, i, proposals) : '';
    const mem = m.memoryNotes?.length ? `<p class="memory-note small muted">Saved to the advisor's memory: ${m.memoryNotes.map(esc).join('; ')}</p>` : '';
    const retry = m.error ? '<button type="button" class="btn retry" data-retry>Try again</button>' : '';
    return `<div class="msg bot${m.error ? ' error' : ''}">${BOT_ICON}<div class="bubble">${body}${card}${mem}${retry}</div></div>`;
  }

  /** The "Changes to your degree plan" card under an answer. */
  function proposalCard(m, i, proposals) {
    const items = resolveProposals ? resolveProposals(proposals) : [];
    const good = items.filter((x) => x.ok);
    const list = items.map((x) => `<li class="${x.ok ? '' : 'bad'}">${esc(x.label)}${x.why ? ` <span class="muted">· ${esc(x.why)}</span>` : ''}${x.ok ? '' : ` <span class="prob">${esc(x.problem)}</span>`}</li>`).join('');
    const action = m.applied
      ? '<p class="small">✓ Applied. <button type="button" class="link-btn" data-open-degree>See it on the Degree tab</button></p>'
      : m.undone && good.length ? `<p class="small">Undone on the Degree tab. <button type="button" class="link-btn" data-apply-proposals="${i}">Apply again</button></p>`
      : good.length ? `<button type="button" class="btn primary" data-apply-proposals="${i}">Apply ${good.length} change${good.length === 1 ? '' : 's'} to my degree plan</button>` : '';
    return `<div class="proposal"><h4>Changes to your degree plan</h4><ul>${list}</ul>${action}<p class="small muted">Nothing changes until you press Apply. You can undo each change on the Degree tab.</p></div>`;
  }

  function render() {
    const atBottom = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 60;
    let html = bubble({ role: 'assistant', content: GREETING });
    html += messages.map((m, i) => bubble(m, i)).join('');
    if (!messages.length) {
      html += `<div class="suggestions">${SUGGESTIONS.map((s) => `<button type="button" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>`;
    }
    els.log.innerHTML = html;
    if (atBottom || busy) els.log.scrollTop = els.log.scrollHeight;
    els.send.classList.toggle('stop', busy);
    els.send.setAttribute('aria-label', busy ? 'Stop' : 'Send');
  }

  let frame = 0;
  const renderSoon = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; render(); });
  };

  async function ask(text) {
    const question = String(text || '').trim();
    if (!question || busy) return;
    messages.push({ role: 'user', content: question.slice(0, 12000) });
    const reply = { role: 'assistant', content: '', pending: true };
    messages.push(reply);
    busy = true;
    render();

    controller = new AbortController();
    try {
      const history = messages.filter((m) => m !== reply && !m.error && !m.note).map(({ role, content }) => ({ role, content }));
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: history, studentContext: getContext(question) }),
        signal: controller.signal,
      });
      if (res.status === 503) {
        const j = await res.json().catch(() => ({}));
        throw Object.assign(new Error('The advisor is not available right now. Try again later.'), { safe: true });
      }
      if (!res.ok || !res.body) {
        let msg = `The server returned an error (${res.status}).`;
        try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* not JSON */ }
        throw Object.assign(new Error(msg), { safe: true });
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const line = raw.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line.slice(5)); } catch { continue; }
          if (evt.type === 'text') { reply.content += evt.text; renderSoon(); }
          else if (evt.type === 'error') throw Object.assign(new Error(evt.message), { safe: true });
          else if (evt.type === 'done') finished = true;
        }
      }
      if (!reply.content.trim()) throw Object.assign(new Error('The advisor sent an empty answer. Try again.'), { safe: true });
    } catch (err) {
      if (err.name === 'AbortError') {
        if (!reply.content) reply.content = '_Stopped._';
        else reply.content += '\n\n_Stopped._';
      } else {
        reply.error = true;
        reply.retryText = question;
        reply.content = err.safe ? err.message : 'Could not reach the advisor server. Is it still running?';
      }
    } finally {
      reply.pending = false;
      if (!reply.error && PLAN_MARK.test(reply.content)) {
        reply.content = reply.content.replace(PLAN_MARKS, '').trimEnd();
        onPlanRequest?.();
      }
      if (!reply.error && onMemory) {
        const { ops } = parseMemory(reply.content);
        if (ops.length) { const notes = onMemory(ops); if (notes.length) reply.memoryNotes = notes; }
      }
      busy = false;
      controller = null;
      save();
      render();
    }
  }

  // ----- events -----
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) { controller?.abort(); return; }
    const text = els.input.value;
    els.input.value = '';
    autosize();
    ask(text);
  });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      els.form.requestSubmit();
    }
  });
  const autosize = () => {
    els.input.style.height = 'auto';
    els.input.style.height = `${Math.min(els.input.scrollHeight, 180)}px`;
  };
  els.input.addEventListener('input', autosize);
  els.log.addEventListener('click', (e) => {
    const apply = e.target.closest('[data-apply-proposals]');
    if (apply) {
      const m = messages[Number(apply.dataset.applyProposals)];
      if (m && !m.applied && applyProposals) {
        const items = resolveProposals(parseProposals(m.content).proposals);
        m.appliedIds = applyProposals(items.filter((x) => x.ok).map((x) => x.change)) || [];
        m.applied = true;
        m.undone = false;
        save();
        render();
      }
      return;
    }
    if (e.target.closest('[data-open-degree]')) return openDegree?.();
    const s = e.target.closest('[data-suggest]');
    if (s) return ask(s.dataset.suggest);
    const code = e.target.closest('.code-link');
    if (code) return onCodeClick(code.dataset.code);
    if (e.target.closest('[data-retry]')) {
      const last = messages[messages.length - 1];
      if (last?.error) {
        messages.pop(); // error bubble
        const q = messages.pop(); // the question
        ask(q?.content || last.retryText);
      }
    }
  });
  // clearing the chat cannot be undone, so it asks first, right next to the button
  let confirmTimer = 0;
  const confirmBox = document.createElement('div');
  confirmBox.className = 'clear-confirm';
  confirmBox.hidden = true;
  confirmBox.setAttribute('role', 'alertdialog');
  confirmBox.innerHTML = '<span>Delete the chat messages? Saved preferences and time commitments stay.</span><button type="button" class="btn danger" data-clear-yes>Delete</button><button type="button" class="btn" data-clear-no>Cancel</button>';
  els.clear.after(confirmBox);
  const closeConfirm = () => { confirmBox.hidden = true; els.clear.hidden = false; clearTimeout(confirmTimer); };
  els.clear.addEventListener('click', () => {
    if (!messages.length) return;
    els.clear.hidden = true;
    confirmBox.hidden = false;
    confirmBox.querySelector('[data-clear-no]').focus();
    confirmTimer = setTimeout(closeConfirm, 8000);
  });
  confirmBox.addEventListener('click', (e) => {
    if (e.target.closest('[data-clear-no]')) { closeConfirm(); els.clear.focus(); return; }
    if (!e.target.closest('[data-clear-yes]')) return;
    closeConfirm();
    if (busy) controller?.abort();
    // the advisor's memory (time commitments, saved notes) stays; what the student said still guides suggestions
    const said = messages.filter((m) => m.role === 'user' && !m.error).map((m) => m.content.slice(0, 600));
    store.set('chatArchive', [...(store.get('chatArchive', []) || []), ...said].slice(-30));
    messages = [];
    save();
    render();
    els.input.focus();
  });
  confirmBox.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeConfirm(); els.clear.focus(); } });

  render();
  return {
    ask,
    render,
    /** The conversation so far (no error bubbles), for the plan builder. */
    messages: () => messages.filter((m) => !m.error && !m.pending && !m.note && m.content).map(({ role, content }) => ({ role, content })),
    /** A change was undone on the Degree tab: say so in the chat, and let its card offer "Apply again". */
    changeUndone(id, text) {
      for (const m of messages) {
        if (!m.appliedIds?.includes(id)) continue;
        m.appliedIds = m.appliedIds.filter((x) => x !== id);
        if (!m.appliedIds.length) { m.applied = false; m.undone = true; }
      }
      messages.push({ role: 'assistant', note: true, content: `Undid “${text}”` });
      save();
      render();
    },
    get busy() { return busy; },
  };
}
