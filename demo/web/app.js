// Triolima demo — the live view. Vanilla ES module, no build step.
// It renders only what the server emits; the logic is the real agent loop.

const TIER = {
  code: 'var(--code)',
  decision: 'var(--decision)',
  llm: 'var(--llm)',
  human: 'var(--human)',
};
const TIER_NOTE = {
  code: 'deterministic — regex / threshold',
  decision: 'scored decision — model-free gate',
  llm: 'narrow LLM — subjective fallback',
  human: 'human — critical, non-negotiable',
};

const $ = (id) => document.getElementById(id);
const chat = $('chat');
const traceEl = $('trace');

let policy = [];
const fired = new Map();
let hopBody = null;

// ───────────────────────── connection ─────────────────────────

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  ws.addEventListener('open', () => setConn(true, 'connected'));
  ws.addEventListener('close', () => { setConn(false, 'reconnecting'); setTimeout(connect, 1500); });
  ws.addEventListener('message', (e) => handle(JSON.parse(e.data), ws));

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('input').value.trim();
    if (!text) return;
    addTurn('user', text);
    ws.send(JSON.stringify({ type: 'say', text }));
    $('input').value = '';
  });

  document.querySelectorAll('.card-actions button').forEach((b) =>
    b.addEventListener('click', () => {
      const answer = b.dataset.answer;
      const correct = $('card-correct');
      if (answer === 'correct' && correct.hidden) { correct.hidden = false; correct.focus(); return; }
      ws.send(JSON.stringify({ type: 'answer', answer, text: correct.value.trim() || undefined }));
      closeCard();
    }),
  );
  return ws;
}

function setConn(on, text) {
  $('conn').classList.toggle('live', on);
  $('conn-text').textContent = text;
}

function handle(e) {
  switch (e.kind) {
    case 'ready': renderLegend(); renderChips(); if (e.model) setConn(true, e.model); break;
    case 'policy': policy = e.items; renderRubric(); break;
    case 'hop': addHop(e.hop, e.at); break;
    case 'assistant': addTurn('agent', e.text); break;
    case 'tool_call': addTool('→', e.name, JSON.stringify(e.input), false); break;
    case 'tool_result': addTool('←', e.name, e.output, true); break;
    case 'trace': addRow(e.row); break;
    case 'stat': renderStat(e); break;
    case 'card': openCard(e.card); break;
    case 'notice': addMeta('note', e.text); break;
    case 'error': addMeta('err', e.message); break;
    case 'done': break;
  }
}

// ───────────────────────── chat ─────────────────────────

function addTurn(who, text) {
  const el = document.createElement('div');
  el.className = `turn ${who}`;
  if (who === 'agent') { const w = document.createElement('p'); w.className = 'who'; w.textContent = 'agent'; el.appendChild(w); }
  const b = document.createElement('div'); b.className = 'body'; b.textContent = text; el.appendChild(b);
  chat.appendChild(el); scrollChat();
}
function addTool(arrow, name, payload, isRes) {
  const el = document.createElement('div');
  el.className = `tool${isRes ? ' res' : ''}`;
  el.innerHTML = `<span class="arrow">${arrow}</span><b>${esc(name)}</b><span class="payload">${esc(payload)}</span>`;
  chat.appendChild(el); scrollChat();
}
function addMeta(cls, text) {
  const el = document.createElement('div'); el.className = cls; el.textContent = text;
  chat.appendChild(el); scrollChat();
}
function scrollChat() { chat.scrollTop = chat.scrollHeight; }

// ───────────────────────── trace ─────────────────────────

function renderLegend() {
  $('legend').innerHTML = Object.entries(TIER)
    .map(([t, c]) => `<span><i style="background:${c}"></i>${t}</span>`).join('');
}

function addHop(hop, at) {
  $('trace-empty').style.display = 'none';
  const g = document.createElement('div'); g.className = 'hopgroup';
  g.innerHTML = `<div class="hophead">${esc(hop)} · t${at}</div>`;
  const body = document.createElement('div'); body.className = 'hopbody';
  g.appendChild(body); traceEl.appendChild(g); hopBody = body;
  $('panel-trace').scrollTop = $('panel-trace').scrollHeight;
}

function addRow(row) {
  $('trace-empty').style.display = 'none';
  if (!hopBody) addHop(row.hop, row.at);
  const el = document.createElement('div');
  el.className = 'row fresh';
  el.innerHTML =
    `<span class="dot" style="background:${TIER[row.tier]}"></span>` +
    `<span class="item">${esc(row.item)}</span>` +
    `<span class="verdict">${esc(row.verdict)}</span>`;
  hopBody.appendChild(el);
  $('panel-trace').scrollTop = $('panel-trace').scrollHeight;

  fired.set(row.item, (fired.get(row.item) ?? 0) + 1);
  const badge = document.querySelector(`.fired[data-item="${cssEsc(row.item)}"]`);
  if (badge) badge.textContent = `×${fired.get(row.item)}`;
}

// ───────────────────────── rubric (ownership) ─────────────────────────

function renderRubric() {
  $('rubric').innerHTML = policy.map((p) => `
    <div class="item-card" style="--tier:${TIER[p.tier]}" data-id="${cssEsc(p.id)}">
      <div class="item-head">
        <span class="nm">${esc(p.name)}</span>
        <span class="tag">${esc(p.tier)}</span>
        <span class="fired" data-item="${cssEsc(p.name)}">${fired.get(p.name) ? '×' + fired.get(p.name) : ''}</span>
      </div>
      <div class="item-what">${esc(p.what)}</div>
      <dl class="item-more">
        <dt>how</dt><dd>${esc(p.how)}</dd>
        <dt>why this tier</dt><dd>${esc(p.why)}</dd>
      </dl>
    </div>`).join('');
  document.querySelectorAll('.item-head').forEach((h) =>
    h.addEventListener('click', () => h.parentElement.classList.toggle('open')));
}

// ───────────────────────── stat footer ─────────────────────────

function renderStat(s) {
  const naive = s.naiveTokens.toLocaleString();
  const mem = s.memoryTokens.toLocaleString();
  const win = s.memoryTokens > 0 && s.naiveTokens > s.memoryTokens
    ? `<span class="win">${(s.naiveTokens / s.memoryTokens).toFixed(1)}× leaner</span>` : '';
  $('stat').innerHTML = `prompt <b>${mem}</b> tok · naive <b>${naive}</b> tok${win}`;
}

// ───────────────────────── HITL card ─────────────────────────

function openCard(card) {
  $('card-says').textContent = card.says;
  $('card-meta').textContent = `${card.rubric} · confidence ${card.confidence.toFixed(2)} ≥ alert ${card.alert.toFixed(2)} · turn ${card.sourceTurn}`;
  const c = $('card-correct'); c.value = ''; c.hidden = true;
  $('overlay').hidden = false;
}
function closeCard() { $('overlay').hidden = true; }

// ───────────────────────── chrome: tabs, collapse, chips ─────────────────────────

$('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b === btn));
  const trace = btn.dataset.tab === 'trace';
  $('panel-trace').hidden = !trace;
  $('panel-rubric').hidden = trace;
});
$('hide').addEventListener('click', () => $('app').classList.add('collapsed'));
$('reopen').addEventListener('click', () => $('app').classList.remove('collapsed'));

function renderChips() {
  const prompts = ['Investigate INC-7788 on payments-api.', 'What do the metrics say?', 'Apply the fix.'];
  $('chips').innerHTML = '';
  prompts.forEach((p) => {
    const b = document.createElement('button');
    b.textContent = p;
    b.addEventListener('click', () => { $('input').value = p; $('input').focus(); });
    $('chips').appendChild(b);
  });
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

connect();
