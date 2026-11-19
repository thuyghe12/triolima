// Triolima — the live view. Vanilla ES module, no build. Renders only what the
// server emits; all logic is the real agent loop.

const TIER = { code: '#6f6d75', decision: '#1f8a5b', llm: '#6b4fd8', human: '#d23f57' };
const KIND = { input: '#9a98a0', memory: '#6f6d75', llm: '#6f8a00', tool: '#6b4fd8', output: '#18181c' };
const colorOf = (s) => (s.kind === 'watcher' ? TIER[s.tier] ?? '#9a98a0' : KIND[s.kind] ?? '#9a98a0');

const $ = (id) => document.getElementById(id);
const chat = $('chat');
const spansEl = $('spans');

let ws = null;
let watchers = [];
const turns = new Map(); // turn → { el, body, spans: [] }

// ───────── connection ─────────
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.addEventListener('open', () => setConn(true, 'connected'));
  ws.addEventListener('close', () => { setConn(false, 'reconnecting'); setTimeout(connect, 1500); });
  ws.addEventListener('message', (e) => handle(JSON.parse(e.data)));
}
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function setConn(on, text) { $('conn').classList.toggle('live', on); $('conn-text').textContent = text; }

function handle(e) {
  switch (e.kind) {
    case 'ready': renderLegend(); if (e.model) setConn(true, e.model); break;
    case 'policy': watchers = e.items; renderMatrix(); break;
    case 'span': addSpan(e.span); break;
    case 'assistant': addTurn('agent', e.text); break;
    case 'tool_call': addTool('→', e.name, JSON.stringify(e.input), false); break;
    case 'tool_result': addTool('←', e.name, e.output, true); break;
    case 'stat': renderStat(e); break;
    case 'card': openCard(e.card); break;
    case 'notice': addMeta('note', e.text); break;
    case 'error': addMeta('err', e.message); break;
    case 'done': break;
  }
}

// ───────── chat ─────────
function hideHello() { const h = $('hello'); if (h) h.remove(); }
function addTurn(who, text) {
  hideHello();
  const el = document.createElement('div');
  el.className = `turn ${who}`;
  if (who === 'agent') { const w = document.createElement('div'); w.className = 'eyebrow who'; w.textContent = 'agent'; el.appendChild(w); }
  const b = document.createElement('div'); b.className = 'body'; b.textContent = text; el.appendChild(b);
  chat.appendChild(el); chat.scrollTop = chat.scrollHeight;
}
function addTool(arrow, name, payload, isRes) {
  const el = document.createElement('div');
  el.className = `tool${isRes ? ' res' : ''}`;
  el.innerHTML = `<span class="arrow">${arrow}</span><b>${esc(name)}</b><span class="payload">${esc(payload)}</span>`;
  chat.appendChild(el); chat.scrollTop = chat.scrollHeight;
}
function addMeta(cls, text) { const el = document.createElement('div'); el.className = cls; el.textContent = text; chat.appendChild(el); chat.scrollTop = chat.scrollHeight; }

// ───────── per-hop span trace ─────────
function renderLegend() {
  $('legend').innerHTML = Object.entries(TIER).map(([t, c]) => `<span><i style="background:${c}"></i>${t}</span>`).join('');
}
function addSpan(s) {
  const te = $('trace-empty'); if (te) te.style.display = 'none';
  let t = turns.get(s.turn);
  if (!t) {
    const block = document.createElement('div'); block.className = 'turnblock';
    block.innerHTML = `<div class="turnhead"><span class="eyebrow">turn ${s.turn}</span><span class="eyebrow turn-ms"></span></div>`;
    const body = document.createElement('div'); block.appendChild(body);
    spansEl.appendChild(block);
    t = { el: block, body, spans: [] };
    turns.set(s.turn, t);
  }
  t.spans.push(s);

  const row = document.createElement('div');
  row.className = 'span fresh';
  row.innerHTML =
    `<span class="dot" style="background:${colorOf(s)}"></span>` +
    `<div class="main"><div class="top"><span class="nm">${esc(s.name)}</span><span class="dur">${s.durMs.toFixed(1)}ms</span></div>` +
    `<div class="track"><i style="background:${colorOf(s)}"></i></div>` +
    `<div class="det">${s.status !== 'ok' ? `<span class="chip ${s.status}">${s.status}</span>` : ''}${esc(s.detail)}</div></div>`;
  t.body.appendChild(row);
  relayout(t);
  $('panel-trace').scrollTop = $('panel-trace').scrollHeight;
}
function relayout(t) {
  const maxEnd = Math.max(1, ...t.spans.map((s) => s.startMs + s.durMs));
  const bars = t.body.querySelectorAll('.track i');
  t.spans.forEach((s, i) => {
    const bar = bars[i]; if (!bar) return;
    bar.style.left = `${(s.startMs / maxEnd) * 100}%`;
    bar.style.width = `${Math.max(2, (s.durMs / maxEnd) * 100)}%`;
  });
  const head = t.el.querySelector('.turn-ms');
  if (head) head.textContent = `${maxEnd.toFixed(0)}ms`;
}

// ───────── rubric matrix (owned, editable) ─────────
function renderMatrix() {
  $('matrix').innerHTML = watchers.map((w, i) => `
    <div class="watch ${w.enabled ? '' : 'off'}" data-i="${i}" style="--tier:${TIER[w.tier]}">
      <div class="watch-head">
        <span class="toggle" data-toggle="${i}"><i></i></span>
        <span class="nm">${esc(w.name)}</span>
        <span class="tier-tag">${esc(w.tier)}</span>
        <span class="thr">${w.threshold == null ? '—' : w.threshold.toFixed(2)}</span>
      </div>
      <div class="watch-body">
        <div class="sig">${esc(w.what || w.signal)}</div>
        <dl><dt>signal</dt><dd>${esc(w.signal)}</dd><dt>how</dt><dd>${esc(w.how)}</dd><dt>why this tier</dt><dd>${esc(w.why)}</dd></dl>
        <div class="meta"><span>action · ${esc(w.action)}</span><span>owner · ${esc(w.owner)}</span></div>
      </div>
    </div>`).join('');

  $('matrix').querySelectorAll('.watch-head').forEach((h) => h.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-toggle]')) return;
    h.parentElement.classList.toggle('open');
  }));
  $('matrix').querySelectorAll('[data-toggle]').forEach((t) => t.addEventListener('click', () => {
    const i = Number(t.dataset.toggle);
    watchers[i] = { ...watchers[i], enabled: !watchers[i].enabled };
    renderMatrix(); pushRubric();
  }));
}
function pushRubric() { send({ type: 'rubric', watchers }); }

// ───────── stat ─────────
function renderStat(s) {
  const win = s.memoryTokens > 0 && s.naiveTokens > s.memoryTokens ? `<span class="win">${(s.naiveTokens / s.memoryTokens).toFixed(1)}× leaner</span>` : '';
  const real = typeof s.usageIn === 'number'
    ? ` · model <b>${s.usageIn.toLocaleString()}→${(s.usageOut ?? 0).toLocaleString()}</b>${typeof s.costUsd === 'number' ? ` · <b>$${s.costUsd.toFixed(4)}</b>` : ''}`
    : '';
  $('stat').innerHTML = `memory <b>${s.memoryTokens.toLocaleString()}</b> tok${real}${win}`;
}

// ───────── HITL card ─────────
function openCard(card) {
  $('card-says').textContent = card.says;
  $('card-meta').textContent = `${card.rubric} · confidence ${card.confidence.toFixed(2)} ≥ alert ${card.alert.toFixed(2)}`;
  const c = $('card-correct'); c.value = ''; c.hidden = true;
  $('overlay').hidden = false;
}
document.querySelectorAll('#overlay .card-actions button').forEach((b) => b.addEventListener('click', () => {
  const answer = b.dataset.answer; const c = $('card-correct');
  if (answer === 'correct' && c.hidden) { c.hidden = false; c.focus(); return; }
  send({ type: 'answer', answer, text: c.value.trim() || undefined });
  $('overlay').hidden = true;
}));

// ───────── add-rule sheet ─────────
$('add-rule').addEventListener('click', () => { $('add-overlay').hidden = false; });
$('add-cancel').addEventListener('click', () => { $('add-overlay').hidden = true; });
$('add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = String(f.get('name') || '').trim(); if (!name) return;
  const tier = String(f.get('tier'));
  const thr = parseFloat(String(f.get('threshold')));
  watchers = [...watchers, {
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `w${watchers.length}`,
    name, tier, action: String(f.get('action')),
    signal: String(f.get('signal') || ''), owner: String(f.get('owner') || 'you'),
    threshold: tier === 'code' ? null : (Number.isFinite(thr) ? thr : 0.6),
    enabled: true, what: String(f.get('signal') || ''), how: 'user-defined', why: String(f.get('why') || ''),
  }];
  renderMatrix(); pushRubric();
  e.target.reset(); $('add-overlay').hidden = true;
});

// ───────── chrome ─────────
$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('input').value.trim(); if (!text) return;
  addTurn('user', text); send({ type: 'say', text }); $('input').value = '';
});
$('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b === btn));
  const trace = btn.dataset.tab === 'trace';
  $('panel-trace').hidden = !trace; $('panel-rubric').hidden = trace;
});
$('hide').addEventListener('click', () => $('app').classList.add('collapsed'));
$('reopen').addEventListener('click', () => $('app').classList.remove('collapsed'));

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

connect();
