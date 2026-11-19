// Triolima demo — the live view. Vanilla ES module, no build step.
// It only renders what the server emits; all the logic is the real agent loop.

const ACTORS = {
  agent: 'var(--agent)',
  fastpath: 'var(--fastpath)',
  rubric: 'var(--rubric)',
  ranker: 'var(--ranker)',
  human: 'var(--human)',
};

const $ = (id) => document.getElementById(id);
const chat = $('chat');
const tree = $('tree');
let seenEvents = 0;
let pendingCard = null;

// --- connection ------------------------------------------------------------

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);

  ws.addEventListener('open', () => setStatus(true, 'connected'));
  ws.addEventListener('close', () => { setStatus(false, 'disconnected'); setTimeout(connect, 1500); });
  ws.addEventListener('message', (ev) => handle(JSON.parse(ev.data)));

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('input').value.trim();
    if (!text) return;
    bubble('user', text);
    ws.send(JSON.stringify({ type: 'say', text }));
    $('input').value = '';
  });

  document.querySelectorAll('.card-actions button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const answer = btn.dataset.answer;
      if (answer === 'correct' && $('card-correct').hidden) {
        $('card-correct').hidden = false; $('card-correct').focus(); return;
      }
      const text = $('card-correct').value.trim();
      ws.send(JSON.stringify({ type: 'answer', answer, text: text || undefined }));
      closeCard();
    });
  });

  return ws;
}

function setStatus(on, text) {
  $('status').classList.toggle('on', on);
  $('status-text').textContent = text;
}

// --- event handling --------------------------------------------------------

function handle(e) {
  switch (e.kind) {
    case 'ready':
      renderLegend();
      renderSuggest();
      setStatus(true, e.model ? `live · ${e.model}` : 'no key');
      break;
    case 'assistant': bubble('assistant', e.text); break;
    case 'tool_call': toolLine(`→ ${e.name}`, JSON.stringify(e.input)); break;
    case 'tool_result': toolLine(`← ${e.name}`, e.output); break;
    case 'memory': renderMemory(e.snapshot); break;
    case 'card': openCard(e.card); break;
    case 'notice': bubble('note', e.text); break;
    case 'error': bubble('err', e.message); break;
    case 'done': break;
  }
}

// --- chat ------------------------------------------------------------------

function bubble(cls, text) {
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  el.textContent = text;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}
function toolLine(head, detail) {
  const el = document.createElement('div');
  el.className = 'msg tool';
  const b = document.createElement('b');
  b.textContent = head;
  el.appendChild(b);
  el.appendChild(document.createTextNode('  ' + (detail.length > 160 ? detail.slice(0, 160) + '…' : detail)));
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

// --- audit tree ------------------------------------------------------------

function renderLegend() {
  $('legend').innerHTML = Object.entries(ACTORS)
    .map(([a, c]) => `<span><i style="background:${c}"></i>${a}</span>`)
    .join('');
}

function renderTree(events) {
  // Append only the new ones so the animation reads as a growing log.
  for (let i = seenEvents; i < events.length; i++) {
    const e = events[i];
    const color = ACTORS[e.actor] ?? 'var(--muted)';
    const row = document.createElement('div');
    row.className = 'evt fresh';
    row.innerHTML =
      `<div class="rail"><div class="node" style="background:${color}"></div></div>` +
      `<div class="body"><div class="head"><span class="op" style="color:${color}">${e.actor}·${e.op}</span> <span class="at">t${e.at} ${e.id}</span></div>` +
      `<div class="sum">${escape(e.summary)}</div></div>`;
    tree.appendChild(row);
  }
  seenEvents = events.length;
  tree.scrollTop = tree.scrollHeight;
}

// --- memory ----------------------------------------------------------------

function renderMemory(s) {
  renderTree(s.events);

  // meter
  const max = Math.max(s.naiveTokens, s.memoryTokens, 1);
  $('naive-tok').textContent = s.naiveTokens.toLocaleString();
  $('mem-tok').textContent = s.memoryTokens.toLocaleString();
  $('naive-bar').style.width = `${(s.naiveTokens / max) * 100}%`;
  $('mem-bar').style.width = `${(s.memoryTokens / max) * 100}%`;
  if (s.naiveTokens > s.memoryTokens && s.memoryTokens > 0) {
    const x = (s.naiveTokens / s.memoryTokens).toFixed(1);
    $('meter-note').textContent = `${x}× smaller prompt — and nothing important dropped.`;
  } else {
    $('meter-note').textContent = '';
  }

  // L1 pins
  const pins = s.facts.filter((f) => f.kind === 'pin');
  $('pins').innerHTML = pins.length
    ? pins.map((f) => `<span class="chip">${escape(f.text)}</span>`).join('')
    : '<span class="archive">none yet</span>';

  // L2 verified, with a decay bar from the header score
  const headerScore = new Map(s.header.map((h) => [h.id, h.score]));
  const verified = s.facts.filter((f) => f.kind === 'verified');
  const maxScore = Math.max(0.01, ...verified.map((f) => headerScore.get(f.id) ?? (f.confidence ?? 0) * f.weight));
  $('verified').innerHTML = verified.length
    ? verified.map((f) => {
        const inHeader = headerScore.has(f.id);
        const score = headerScore.get(f.id) ?? (f.confidence ?? 0) * f.weight;
        const pct = Math.max(6, Math.min(100, (score / maxScore) * 100));
        return `<div class="fact">
          <div class="ft">${escape(f.text)}</div>
          <div class="fmeta">
            <span><span class="tag">${escape(f.rubric ?? 'signal')}</span> · ${(f.confidence ?? 0).toFixed(2)} · ${inHeader ? 'in header' : 'faded'}</span>
            <span class="decay"><i style="width:${pct}%"></i></span>
          </div>
        </div>`;
      }).join('')
    : '<span class="archive">none yet — ask the agent to diagnose</span>';

  // L3 archive
  $('archive').textContent = `${s.archiveSize} fact${s.archiveSize === 1 ? '' : 's'} held; only the header + retrieved reach the model.`;
}

// --- HITL card -------------------------------------------------------------

function openCard(card) {
  pendingCard = card;
  $('card-tag').textContent = card.rubric;
  $('card-says').textContent = card.says;
  $('card-meta').textContent = `confidence ${card.confidence.toFixed(2)} ≥ alert ${card.alert.toFixed(2)} · turn ${card.sourceTurn}`;
  $('card-correct').value = '';
  $('card-correct').hidden = true;
  $('overlay').hidden = false;
}
function closeCard() {
  $('overlay').hidden = true;
  pendingCard = null;
}

// --- suggestions -----------------------------------------------------------

function renderSuggest() {
  const prompts = [
    'Investigate INC-7788 on payments-api.',
    'What do the metrics say?',
    'Apply the fix.',
  ];
  $('suggest').innerHTML = '';
  prompts.forEach((p) => {
    const b = document.createElement('button');
    b.textContent = p;
    b.addEventListener('click', () => { $('input').value = p; $('input').focus(); });
    $('suggest').appendChild(b);
  });
}

function escape(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

connect();
