// Pantalla (projector): socket, state, signature-based re-render and event -> canvas token wiring.
import { connect, bindStatus } from '/shared/socket.js';
import { icon } from '/shared/icons.js';
import { createGraph, el, LOOP_EDGE, BLOCK_WINDOW } from './graph.js';
import {
  PANEL_META, LOCAL_META, initPanels, setPublicUrl, getPublicUrl, renderPanelBody, renderLocalBody, paintPow, tickAuction,
  bankInit, bankEnqueue, bankOverride, isBankLog, BANK, ATTACKER,
} from './panels.js';
import { renderLabStage, initLabStage, tickLab, moveLabFocus, clearLabFocus } from './lab.js';

const MAX_LOGS = 4;
const MAX_CHIPS = 40;
const CONTRACT_ORDER = ['0xVOTACION', '0xSUBASTA', BANK, ATTACKER];
const PANEL_NODE = { qr: 'wallets', votacion: 'contract:0xVOTACION', subasta: 'contract:0xSUBASTA', banco: `contract:${BANK}`, pruebas: 'miner' };
const CONTRACT_PANEL = { '0xVOTACION': 'votacion', '0xSUBASTA': 'subasta', [BANK]: 'banco', [ATTACKER]: 'banco' };
const $ = (id) => document.getElementById(id);

const socket = connect('pantalla');
bindStatus(socket, $('status'));
const graph = createGraph($('canvas'), { onSelect: selectNode });

let mineIntervalMs = 0;
let lastBlockAt = Date.now();
let lastHeight = null;
let state = null;
const sig = { panel: null, logs: null, strip: null, lab: null };

// Local view: what the presenter opened by clicking a node. It wins over the panel chosen in the admin
// until Esc / the back button, or until the admin picks another panel.
//   { kind: 'block', index } | { kind: 'mempool' | 'miner' | 'wallets' } | { kind: 'panel', panel }
let local = null;
let serverPanel = null;
let chainOffset = 0; // newest blocks scrolled out of the block row


// Mining state machine: `mining` is the run in progress ({ index, difficulty, remine? }) or null.
let mining = null;
let minedLabel = '';
let minedTimer = null;
const miner = { nonce: '-', hash: '', hit: false };
let wonLabel = '';
let wonTimer = null;

function humanEta(sec) {
  if (sec < 60) return `~${Math.max(1, Math.round(sec))} s`;
  if (sec < 3600) return `~${Math.round(sec / 60)} min`;
  return `~${Math.round(sec / 3600)} h`;
}
const poolEta = (p) => `Dificultad ${state.difficulty}: ${humanEta(p.etaSeconds)} para el grupo`;

fetch('/api/info').then((r) => r.json()).then((i) => {
  setPublicUrl(i.url);
  $('url-small').textContent = i.url.replace(/^https?:\/\//, '');
  if (state) { sig.panel = null; render(state); }
}).catch(() => {});

initPanels({ getState: () => state, onBankStep });

const nickMap = (s) => new Map((s.accounts || []).map((a) => [a.address, a.nick]));
const isRevert = (l) => l.message.startsWith('Revertido');

// ---------- miner node ----------

function refreshMiner() {
  let sub;
  if (wonLabel) sub = wonLabel;
  else if (mining?.pool) sub = `Minando entre ${mining.miners}`;
  else if (mining) sub = `${mining.remine ? 'Re-minando' : 'Minando'} #${mining.index}`;
  else if (minedLabel) sub = minedLabel;
  else if (state && state.minerRunning === false) sub = 'En pausa';
  else if (state?.pool && !state.pool.enabled && state.miners?.length) sub = poolEta(state.pool); // miners have left by now; still show the lesson
  else sub = 'Esperando transacciones…';
  graph.setMiner({ sub, active: !!mining, nonce: miner.nonce, hash: miner.hash, hit: miner.hit });
  paintPow(miner);
}
function minerHash(h, difficulty) {
  const zeros = (h.match(/^0*/) || [''])[0].length;
  miner.hash = h;
  miner.hit = zeros >= difficulty;
}
function setMining(info) {
  mining = info;
  if (info) minedLabel = '';
  else { miner.nonce = '-'; miner.hash = ''; miner.hit = false; }
  refreshMiner();
}

// ---------- graph model ----------

function contractFigure(c) {
  const v = c.view || {};
  if (c.address === '0xVOTACION') {
    const n = (v.votes || []).length;
    return `${n} ${n === 1 ? 'voto' : 'votos'}`;
  }
  if (c.address === '0xSUBASTA') return v.highest ? `${v.highest.amount} · ${v.highest.nick}` : 'Sin ofertas';
  if (c.address === BANK) return `Saldo ${bankOverride() ?? v.balance}`;
  if (c.address === ATTACKER) return `${v.rounds ?? 0} reentradas`;
  return `Saldo ${c.balance ?? 0}`;
}

function syncGraph() {
  if (!state) return;
  const s = state;
  const contracts = (s.contracts || [])
    .filter((c) => c.active || (c.address === ATTACKER && c.view?.rounds > 0))
    .sort((a, b) => {
      const ia = CONTRACT_ORDER.indexOf(a.address), ib = CONTRACT_ORDER.indexOf(b.address);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    })
    .slice(0, 4)
    .map((c) => ({ address: c.address, name: c.name || c.address, figure: contractFigure(c) }));
  const chain = (s.chain || []).map((b, i) => {
    const v = (s.validity || [])[i];
    return { index: b.index, hash: b.hash || '', prevHash: b.prevHash || '', nonce: b.nonce, txs: (b.txs || []).length, invalid: !!v && v.valid === false, reason: v?.reason };
  });
  const panel = PANEL_META[s.panel] ? s.panel : 'qr';
  let selected = panel === 'red' ? (chain.length ? `block:${chain[chain.length - 1].index}` : null) : PANEL_NODE[panel];
  if (local) selected = local.kind === 'block' ? `block:${local.index}` : local.kind === 'panel' ? local.node : local.kind;
  chainOffset = Math.min(chainOffset, Math.max(0, chain.length - BLOCK_WINDOW));
  graph.sync({ participants: s.participants ?? 0, pending: (s.mempool || []).length, chain, contracts, selected, offset: chainOffset });
  renderChainNav(chain);
}

// ---------- block row navigation ----------

function renderChainNav(chain) {
  const total = chain.length;
  const end = total - chainOffset;
  const start = Math.max(0, end - BLOCK_WINDOW);
  $('chain-nav').hidden = total <= BLOCK_WINDOW;
  if (!total) return;
  $('chain-range').textContent = `Bloques #${chain[start].index} a #${chain[end - 1].index}`;
  $('chain-older').disabled = start === 0;
  $('chain-newer').disabled = chainOffset === 0;
  $('chain-tip').hidden = chainOffset === 0;
}
function scrollChain(delta) {
  const total = (state?.chain || []).length;
  chainOffset = Math.max(0, Math.min(Math.max(0, total - BLOCK_WINDOW), chainOffset + delta));
  syncGraph();
}
$('chain-older').addEventListener('click', () => scrollChain(1));
$('chain-newer').addEventListener('click', () => scrollChain(-1));
$('chain-tip').addEventListener('click', () => scrollChain(-Infinity));

// ---------- local views (click a node) ----------

function setLocal(next) {
  local = next;
  if (next?.kind === 'block' && state) { // keep the picked block inside the visible row
    const chain = state.chain || [];
    const at = chain.findIndex((b) => b.index === next.index);
    if (at >= 0) {
      const fromTip = chain.length - 1 - at;
      if (fromTip < chainOffset) chainOffset = fromTip;
      else if (fromTip > chainOffset + BLOCK_WINDOW - 1) chainOffset = fromTip - (BLOCK_WINDOW - 1);
    }
  }
  sig.panel = null;
  if (state) render(state);
}
function selectNode(id) {
  if (id.startsWith('block:')) return setLocal({ kind: 'block', index: Number(id.slice(6)) });
  if (id.startsWith('contract:')) {
    const panel = CONTRACT_PANEL[id.slice(9)];
    return panel ? setLocal({ kind: 'panel', panel, node: id }) : undefined;
  }
  setLocal({ kind: id });
}
function stepBlock(delta) {
  const chain = state?.chain || [];
  if (!chain.length) return;
  const at = local?.kind === 'block' ? chain.findIndex((b) => b.index === local.index) : chain.length - (delta < 0 ? 0 : 1);
  const next = chain[Math.max(0, Math.min(chain.length - 1, at + delta))];
  if (next) setLocal({ kind: 'block', index: next.index });
}
$('panel-back').addEventListener('click', () => setLocal(null));
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || !state) return;
  const lab = shownPanel() === 'pruebas';
  if (e.key === 'Escape') {
    if (lab && !local) { clearLabFocus(); sig.lab = null; sig.panel = null; render(state); } else setLocal(null);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const delta = e.key === 'ArrowLeft' ? -1 : 1;
    if (lab && !local) { moveLabFocus(state.lab, delta); sig.lab = null; sig.panel = null; render(state); } else stepBlock(delta);
  } else return;
  e.preventDefault();
});

// ---------- bottom strip ----------

function renderStrip(s) {
  const nick = nickMap(s);
  const name = (addr) => nick.get(addr) || (addr ? addr.slice(0, 8) + '…' : '?');
  const strip = $('strip');
  strip.replaceChildren();
  const chip = (t, cls) => strip.appendChild(el('span', `chip tx-chip ${cls}`, `${name(t.from)}→${name(t.to)} · ${t.amount}`));
  const last = (s.chain || [])[(s.chain || []).length - 1];
  const status = new Map((s.lastBlockStatus || []).map((x) => [x.hash, x.status]));
  if (last && last.index > 0) (last.txs || []).forEach((t) => chip(t, status.get(t.hash) === 'failed' ? 'c-bad' : 'c-ok'));
  (s.mempool || []).forEach((t) => chip(t, 'c-running'));
  while (strip.children.length > MAX_CHIPS) strip.firstChild.remove();
  if (!strip.children.length) strip.appendChild(el('span', 'strip-empty', 'Sin transacciones todavía'));
  strip.scrollLeft = strip.scrollWidth;
}

// ---------- contract log ----------

function renderContractLog(s) {
  const nick = nickMap(s);
  const ul = $('contract-log');
  ul.replaceChildren();
  const logs = [...(s.contractLogs || [])].reverse().slice(0, MAX_LOGS); // newest first
  if (!logs.length) return void ul.appendChild(el('li', 'empty', 'Sin actividad de contratos'));
  for (const l of logs) {
    const li = el('li', isRevert(l) ? 'revert' : '');
    li.appendChild(el('b', null, nick.get(l.contract) || l.contract));
    li.append(l.message);
    ul.appendChild(li);
  }
}

// ---------- panel ----------

// Panel on screen: the admin's choice unless a local contract view replaced it.
function shownPanel() {
  const panel = PANEL_META[state?.panel] ? state.panel : 'qr';
  return local?.kind === 'panel' ? local.panel : panel;
}

function renderPanel(s) {
  const panel = shownPanel();
  const view = local && local.kind !== 'panel' ? local.kind : null;
  const meta = view ? LOCAL_META[view] : PANEL_META[panel];
  document.body.dataset.panel = view ? `local-${view}` : panel; // the small QR in the top bar hides while the big one shows
  $('main-panel-title').textContent = meta.title;
  $('panel-ic').replaceChildren(icon(meta.icon));
  $('panel-back').hidden = !local;
  $('panel-hint').hidden = !!local || panel === 'pruebas';
  const body = $('main-panel-body');
  body.dataset.panel = view ? `local-${view}` : panel;
  if (view) renderLocalBody(local, s, body);
  else renderPanelBody(panel, s, body);
}

initLabStage($('lab-stage'), { getState: () => state, rerender: () => { sig.lab = null; sig.panel = null; if (state) render(state); } });

// ---------- state ----------

function render(s) {
  state = s;
  bankInit(s);
  if (s.panel !== serverPanel) { // the presenter moved on from the admin: drop whatever was opened by hand
    if (serverPanel !== null) local = null;
    serverPanel = s.panel;
  }
  const lab = shownPanel() === 'pruebas' && !(local && local.kind !== 'panel');
  $('canvas').toggleAttribute('hidden', lab); // SVG elements have no .hidden property
  $('logcard').hidden = lab;
  $('lab-stage').hidden = !lab;
  if (lab) {
    const lSig = JSON.stringify(s.lab) + '|' + s.height + '|' + JSON.stringify((s.contracts || []).find((c) => c.address === BANK)?.view?.balance);
    if (lSig !== sig.lab) { sig.lab = lSig; renderLabStage(s, $('lab-stage')); }
  } else sig.lab = null;
  const pSig = [JSON.stringify(local), s.difficulty, (s.mempool || []).map((t) => t.hash).join(), JSON.stringify(s.validity?.map((v) => v.valid)), s.panel, s.participants, s.lastBlockStatus?.map((x) => x.hash + x.status).join(), s.chain?.at(-1)?.hash,
    s.accounts?.map((a) => a.nick + a.balance).join(), JSON.stringify(s.contracts), s.contractLogs?.length, JSON.stringify(s.miners), JSON.stringify(s.lab)].join('|') + getPublicUrl();
  if (pSig !== sig.panel) { sig.panel = pSig; renderPanel(s); }
  $('tamper-chip').hidden = !s.tampered;
  document.body.classList.toggle('tampered', !!s.tampered);
  if (mining && !s.mining) setMining(null); // run aborted (tamper/restore/reset)
  else refreshMiner();
  mineIntervalMs = s.mineIntervalMs || mineIntervalMs;
  $('participants').textContent = String(s.participants ?? 0);
  $('height').textContent = String(s.height ?? 0);
  $('difficulty').textContent = `${s.difficulty} ${s.difficulty === 1 ? 'cero' : 'ceros'}`;
  if (lastHeight !== null && s.height !== lastHeight) lastBlockAt = Date.now();
  lastHeight = s.height;
  syncGraph(); // nodes are persistent and only refilled when their own key changes
  const lSig = JSON.stringify(s.contractLogs || []) + (s.accounts || []).map((a) => a.address + a.nick).join();
  if (lSig !== sig.logs) { sig.logs = lSig; renderContractLog(s); }
  const tSig = (s.mempool || []).map((t) => t.hash).join() + '|' + (s.lastBlockStatus || []).map((x) => x.hash + x.status).join()
    + '|' + (s.chain?.at(-1)?.hash ?? '') + '|' + (s.accounts || []).map((a) => a.address + a.nick).join();
  if (tSig !== sig.strip) { sig.strip = tSig; renderStrip(s); }
}

function tick() {
  if (!mineIntervalMs) return;
  const left = Math.max(0, Math.ceil((mineIntervalMs - (Date.now() - lastBlockAt)) / 1000));
  $('countdown').textContent = left > 0 ? `~${left}s` : 'minando…';
}
setInterval(tick, 250);
setInterval(tickAuction, 250);
setInterval(tickLab, 500);

// ---------- bank cascade ----------

let flip = false;
function onBankStep(l) {
  syncGraph(); // the bank node reads the replayed balance
  if (!l) return;
  if (graph.hasEdge(LOOP_EDGE)) {
    graph.token(LOOP_EDGE, { reverse: flip, cls: l.contract === ATTACKER || isRevert(l) ? 't-bad' : '', dur: 320 });
    flip = !flip;
  } else {
    graph.token(`miner>contract:${BANK}`, { cls: isRevert(l) ? 't-bad' : '', dur: 400 });
  }
}

// ---------- events ----------

socket.on('state:full', render);

socket.on('contract:log', (entry) => {
  if (!state) return;
  state.contractLogs = [...(state.contractLogs || []), entry].slice(-60);
  sig.logs = JSON.stringify(state.contractLogs) + (state.accounts || []).map((a) => a.address + a.nick).join();
  renderContractLog(state);
  if (isBankLog(entry)) bankEnqueue(entry); // the bank replay queue draws its own tokens
  else {
    const id = `miner>contract:${entry.contract}`;
    graph.token(id, { cls: isRevert(entry) ? 't-bad' : '', onDone: () => graph.pop(`contract:${entry.contract}`) });
  }
});

socket.on('mempool:add', (tx) => {
  graph.token('wallets>mempool', { cls: tx.from === '0xSISTEMA' ? 't-ok' : '', onDone: () => graph.pop('mempool') });
});

socket.on('block:mined', (b) => {
  lastBlockAt = Date.now();
  if (mining && mining.index === b.index) {
    miner.nonce = String(b.nonce);
    minerHash(b.hash, b.difficulty);
    mining = null;
    minedLabel = `Bloque #${b.index} minado`;
    refreshMiner();
    graph.pop('miner');
    clearTimeout(minedTimer);
    minedTimer = setTimeout(() => { if (!mining) { minedLabel = ''; setMining(null); } }, 1500);
  }
  graph.token(`miner>block:${b.index}`, { cls: 't-ok', onDone: () => graph.pop(`block:${b.index}`) });
});

socket.on('pool:won', (w) => {
  wonLabel = `¡${w.nick} ganó +${w.reward}!`;
  clearTimeout(wonTimer);
  wonTimer = setTimeout(() => { wonLabel = ''; refreshMiner(); }, 3000);
  // Participantes -> Mempool -> Minero (the graph has no direct edge between the two ends)
  graph.token('wallets>mempool', {
    cls: 't-ok',
    onDone: () => graph.token('mempool>miner', { cls: 't-ok', onDone: () => graph.pop('miner') }),
  });
  refreshMiner();
});

socket.on('block:remined', () => setMining(null));

socket.on('mine:start', (info) => {
  setMining(info);
  miner.nonce = '0';
  miner.hash = '';
  miner.hit = false;
  refreshMiner();
  const n = Math.min(info.txCount || 0, 5);
  for (let i = 0; i < n; i++) graph.token('mempool>miner', { delay: i * 150 });
});

socket.on('mine:progress', (p) => {
  if (!mining || p.index !== mining.index) return;
  miner.nonce = String(p.nonce);
  minerHash(p.hash, mining.difficulty);
  refreshMiner();
});
