// Inspector panels (welcome, network, voting, auction, bank, lab) and the local views opened by clicking a node
// on the canvas (block, mempool, miner, participants). All DOM is built with createElement/textContent.
import { el, hashEl } from './graph.js';
import { icon } from '/shared/icons.js';
import { renderLabInspector } from './lab.js';

export const PANEL_META = {
  qr: { title: 'Bienvenida', icon: 'logo' },
  red: { title: 'Red', icon: 'block' },
  votacion: { title: 'Votación', icon: 'vote' },
  subasta: { title: 'Subasta', icon: 'tag' },
  banco: { title: 'Banco', icon: 'bank' },
  pruebas: { title: 'Pruebas', icon: 'flask' },
};

const mark = (ok) => icon(ok ? 'check' : 'x', ok ? 'm-ok' : 'm-bad');
const shortAddr = (addr) => (addr ? addr.slice(0, 8) + '…' : '?');

// app.js wires these in: getState() returns the latest state:full, onBankStep(logEntry|undefined) fires on each replay step.
let getState = () => null;
let onBankStep = () => {};
let publicUrl = '';
export function initPanels(hooks) {
  if (hooks.getState) getState = hooks.getState;
  if (hooks.onBankStep) onBankStep = hooks.onBankStep;
}
export function setPublicUrl(u) { publicUrl = u; }
export const getPublicUrl = () => publicUrl;

const nickMap = (s) => new Map((s.accounts || []).map((a) => [a.address, a.nick]));

function fullHash(h) {
  const span = el('span', 'hash mono');
  const zeros = (h.match(/^0*/) || [''])[0].length;
  if (zeros) span.appendChild(el('span', 'zeros', h.slice(0, zeros)));
  span.append(h.slice(zeros));
  return span;
}

function panelWelcome(s, body) {
  const qr = el('img', 'qr-big');
  qr.src = '/qr.svg';
  qr.alt = 'QR para unirse';
  const side = el('div', 'welcome-side');
  side.appendChild(el('div', 'welcome-title', 'Escanea para unirte'));
  side.appendChild(el('div', 'welcome-url mono', publicUrl.replace(/^https?:\/\//, '')));
  const count = el('div', 'welcome-count');
  count.appendChild(el('b', null, String(s.participants ?? 0)));
  count.append((s.participants ?? 0) === 1 ? ' participante' : ' participantes');
  side.appendChild(count);
  body.append(qr, side);
}

function panelNetwork(s, body) {
  const nick = nickMap(s);
  const name = (addr) => nick.get(addr) || (addr ? addr.slice(0, 8) + '…' : '?');
  const last = (s.chain || [])[(s.chain || []).length - 1];

  const detail = el('div', 'net-col');
  detail.appendChild(el('h3', null, last ? (last.index === 0 ? 'Último bloque: Génesis' : `Último bloque: #${last.index}`) : 'Sin bloques'));
  if (last) {
    const kv = el('dl', 'kv');
    const add = (k, v) => {
      kv.appendChild(el('dt', null, k));
      const dd = el('dd');
      if (typeof v === 'string') dd.appendChild(el('span', 'mono', v)); else dd.appendChild(v);
      kv.appendChild(dd);
    };
    add('hash', fullHash(last.hash || ''));
    add('prev', last.index === 0 ? 'ninguno' : fullHash(last.prevHash || ''));
    add('nonce', String(last.nonce));
    add('dificultad', String(last.difficulty));
    add('hora', new Date(last.timestamp).toLocaleTimeString('es'));
    detail.appendChild(kv);
    const status = new Map((s.lastBlockStatus || []).map((x) => [x.hash, x]));
    const ul = el('ul', 'net-txs');
    (last.txs || []).slice(0, 5).forEach((t) => {
      const st = status.get(t.hash);
      const failed = st && st.status === 'failed';
      const li = el('li', failed ? 'failed' : '');
      li.append(mark(!failed), ` ${name(t.from)} → ${name(t.to)} · ${t.amount}`);
      if (failed && st.reason) li.appendChild(el('span', 'why', ' (' + st.reason + ')'));
      ul.appendChild(li);
    });
    if ((last.txs || []).length > 5) ul.appendChild(el('li', 'more', `+${last.txs.length - 5} más`));
    if (!(last.txs || []).length) ul.appendChild(el('li', 'more', 'Sin transacciones'));
    detail.appendChild(ul);
  }

  body.append(detail, rankingCol(s));
}

// Miners first: during the mining part of the demo they matter most, and the balance ranking can be cut.
function rankingCol(s) {
  const rank = el('div', 'net-col');
  const miners = (s.miners || []).slice(0, 5);
  if (miners.length) {
    rank.appendChild(el('h3', null, 'Mineros'));
    const ml = el('ol', 'ranking miners');
    miners.forEach((m) => {
      const li = el('li');
      const nm = el('span', 'rk-name', m.nick);
      if (m.mining) nm.prepend(icon('pick'), ' ');
      li.appendChild(nm);
      li.appendChild(el('span', 'rk-bal', `${m.won} ${m.won === 1 ? 'bloque' : 'bloques'}`));
      ml.appendChild(li);
    });
    rank.appendChild(ml);
  }
  rank.appendChild(el('h3', null, 'Ranking de saldos'));
  const top = (s.accounts || []).filter((a) => !a.system)
    .sort((a, b) => Number(b.balance) - Number(a.balance)).slice(0, miners.length ? 5 : 8);
  const ol = el('ol', 'ranking');
  if (!top.length) ol.appendChild(el('li', 'more', 'Aún no hay participantes'));
  top.forEach((a) => {
    const li = el('li');
    li.appendChild(el('span', 'rk-name', a.nick));
    li.appendChild(el('span', 'rk-bal', String(a.balance)));
    ol.appendChild(li);
  });
  rank.appendChild(ol);
  return rank;
}

// Contract panels plug in here: PANEL_RENDERERS[panelName] = (state, body) => {...}.
const PANEL_RENDERERS = {};

PANEL_RENDERERS.votacion = (s, body) => {
  const v = (s.contracts || []).find((x) => x.address === '0xVOTACION')?.view;
  if (!v || !v.question) return void body.appendChild(el('div', 'placeholder', 'Sin votación configurada'));
  const nick = nickMap(s);
  const main = el('div', 'vote-main');
  const head = el('div', 'vote-head');
  head.appendChild(el('div', 'vote-question', v.question));
  head.appendChild(el('span', 'chip ' + (v.open ? 'c-ok' : 'c-bad'), v.open ? 'ABIERTA' : 'CERRADA'));
  main.appendChild(head);
  const max = Math.max(1, ...v.counts);
  v.options.forEach((opt, i) => {
    const r = el('div', 'vote-row');
    r.appendChild(el('span', 'vote-opt', opt));
    const track = el('div', 'vote-track');
    const bar = el('div', 'vote-bar');
    bar.style.width = (v.counts[i] / max) * 100 + '%';
    track.appendChild(bar);
    r.append(track, el('span', 'vote-count', String(v.counts[i])));
    main.appendChild(r);
  });
  const list = el('div', 'side-list');
  list.appendChild(el('h3', null, `Votos (${v.votes.length})`));
  const ul = el('ul');
  [...v.votes].reverse().slice(0, 6).forEach((x) => {
    ul.appendChild(el('li', null, `${nick.get(x.address) || x.nick} → ${v.options[x.option]}`));
  });
  if (!v.votes.length) ul.appendChild(el('li', 'more', 'Aún no hay votos'));
  list.appendChild(ul);
  body.append(main, list);
};

PANEL_RENDERERS.subasta = (s, body) => {
  const v = (s.contracts || []).find((x) => x.address === '0xSUBASTA')?.view;
  if (!v || !v.item) return void body.appendChild(el('div', 'placeholder', 'Sin subasta abierta'));
  const main = el('div', 'auc-main');
  main.appendChild(el('div', 'auc-item', v.item));
  if (v.open) {
    const cd = el('div', 'auc-count');
    cd.dataset.endsAt = v.endsAt;
    main.appendChild(cd);
    tickAuction();
  } else main.appendChild(el('div', 'auc-count done', 'CERRADA'));
  main.appendChild(el('div', 'auc-highest', v.highest ? `${v.highest.amount} · ${v.highest.nick}` : 'Sin ofertas'));
  if (v.winner) main.appendChild(el('div', 'auc-winner', `Ganó ${v.winner.nick} · el contrato pagó ${v.winner.amount} al Presentador`));
  const side = el('div', 'side-list');
  const list = (title, items, fmt) => {
    side.appendChild(el('h3', null, `${title} (${items.length})`));
    const ul = el('ul');
    [...items].reverse().slice(0, 4).forEach((x) => ul.appendChild(el('li', null, fmt(x))));
    if (!items.length) ul.appendChild(el('li', 'more', 'Ninguno'));
    side.appendChild(ul);
  };
  list('Ofertas', v.bids, (b) => `${b.nick} ofertó ${b.amount}`);
  list('Reembolsos', v.refunds, (r) => `${r.nick} recuperó ${r.amount}`);
  body.append(main, side);
};

// Bank panel: reentrancy logs are replayed one by one (BANK_STEP_MS apart) so the balance visibly drops in a cascade.
// Only logs that arrive live are queued; on page load the existing logs are shown instantly.
export const BANK = '0xBANCO', ATTACKER = '0xATACANTE';
const BANK_STEP_MS = 200, BANK_LINES = 10;
const bank = { ready: false, shown: 0, lines: [], queue: [], timer: null };
const bankView = () => (getState()?.contracts || []).find((c) => c.address === BANK)?.view;
export const isBankLog = (l) => l.contract === BANK || l.contract === ATTACKER;
const quedan = (l) => (l.contract === BANK ? /quedan (\d+)$/.exec(l.message) : null);

/** Balance to show on the graph while a replay is running; null means "use the real one". */
export const bankOverride = () => (bank.timer ? bank.shown : null);

export function bankInit(s) {
  if (bank.ready) return;
  bank.ready = true;
  bank.lines = (s.contractLogs || []).filter(isBankLog).slice(-BANK_LINES);
  bank.shown = Number(bankView()?.balance ?? 0);
}
export function bankEnqueue(l) {
  if (!isBankLog(l)) return;
  bank.queue.push(l);
  bank.timer ??= setInterval(bankStep, BANK_STEP_MS);
}
function bankStep() {
  const l = bank.queue.shift();
  if (l) {
    bank.lines = [...bank.lines, l].slice(-BANK_LINES);
    const m = quedan(l);
    if (m) bank.shown = Number(m[1]);
  }
  if (!bank.queue.length) { // replay done: settle on the real balance
    clearInterval(bank.timer);
    bank.timer = null;
    bank.shown = Number(bankView()?.balance ?? bank.shown);
  }
  paintBank();
  onBankStep(l);
}
function paintBank() {
  const num = document.getElementById('bank-balance');
  if (num) num.textContent = String(bank.shown);
  const ul = document.getElementById('bank-log');
  if (!ul) return;
  ul.replaceChildren();
  [...bank.lines].reverse().forEach((l) => {
    const li = el('li', l.contract === ATTACKER ? 'atk' : l.message.startsWith('Revertido') ? 'revert' : '');
    li.textContent = l.message;
    ul.appendChild(li);
  });
  if (!bank.lines.length) ul.appendChild(el('li', 'more', 'Sin actividad'));
}

PANEL_RENDERERS.banco = (s, body) => {
  bankInit(s);
  const v = bankView();
  if (!v) return void body.appendChild(el('div', 'placeholder', 'Sin banco'));
  if (!bank.queue.length) bank.shown = Number(v.balance);
  const nick = nickMap(s);
  const atk = (s.contracts || []).find((c) => c.address === ATTACKER)?.view;
  const main = el('div', 'bank-main');
  main.appendChild(el('div', 'bank-label', 'Saldo del banco'));
  const num = el('div', 'bank-balance');
  num.id = 'bank-balance';
  main.appendChild(num);
  if (atk && atk.lastLoot > 0) main.appendChild(el('div', 'bank-loot', `Botín: ${atk.lastLoot} para ${nick.get(atk.owner) || '?'} · ${atk.rounds} reentradas`));
  main.appendChild(el('div', 'bank-quote', 'El código es ley · The DAO, 2016'));
  const side = el('div', 'side-list');
  side.appendChild(el('h3', null, 'Depositantes'));
  const dep = el('ul');
  v.depositors.slice(0, 4).forEach((d) => dep.appendChild(el('li', null, `${nick.get(d.address) || d.nick}: ${d.amount}`)));
  if (!v.depositors.length) dep.appendChild(el('li', 'more', 'Ninguno'));
  side.appendChild(dep);
  side.appendChild(el('h3', null, 'Registro'));
  const log = el('ul', 'bank-log');
  log.id = 'bank-log';
  side.appendChild(log);
  body.append(main, side);
  paintBank();
};

export function tickAuction() {
  const e = document.querySelector('.auc-count[data-ends-at]');
  if (!e) return;
  const left = Math.max(0, Math.ceil((Number(e.dataset.endsAt) - Date.now()) / 1000));
  e.textContent = left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Cerrando…';
}

export function renderPanelBody(panel, s, body) {
  body.replaceChildren();
  if (panel === 'qr') panelWelcome(s, body);
  else if (panel === 'red') panelNetwork(s, body);
  else if (PANEL_RENDERERS[panel]) PANEL_RENDERERS[panel](s, body);
  else body.appendChild(el('div', 'placeholder', 'Disponible en la fase 3'));
}

PANEL_RENDERERS.pruebas = renderLabInspector;

// ---------- local views: what the presenter opens by clicking a node on the canvas ----------

function kvList(rows) {
  const kv = el('dl', 'kv');
  for (const [k, v] of rows) {
    kv.appendChild(el('dt', null, k));
    const dd = el('dd');
    if (typeof v === 'string') dd.appendChild(el('span', 'mono', v)); else dd.append(v);
    kv.appendChild(dd);
  }
  return kv;
}

function txLine(t, name, st) {
  const failed = st?.status === 'failed';
  const li = el('li', failed ? 'failed' : '');
  const what = t.call ? `${name(t.from)} llama ${t.call.method}() en ${name(t.to)}` : `${name(t.from)} → ${name(t.to)}`;
  li.append(st ? mark(!failed) : icon('circle'), ` ${what} · ${t.amount}`);
  if (t.coinbase) li.appendChild(el('span', 'chip c-violet', 'recompensa'));
  if (failed && st.reason) li.appendChild(el('span', 'why', ` (${st.reason})`));
  return li;
}

function viewBlock(s, body, index) {
  const chain = s.chain || [];
  const at = chain.findIndex((b) => b.index === index);
  const b = chain[at];
  if (!b) return void body.appendChild(el('div', 'placeholder', `El bloque #${index} ya no está en la ventana`));
  const nick = nickMap(s);
  const name = (addr) => nick.get(addr) || shortAddr(addr);
  const v = (s.validity || [])[at];
  const valid = !v || v.valid !== false;
  const col = el('div', 'net-col');
  const head = el('div', 'loc-head');
  head.append(el('b', null, b.index === 0 ? 'Bloque Génesis' : `Bloque #${b.index}`),
    Object.assign(el('span', `chip ${valid ? 'c-ok' : 'c-bad'}`), { textContent: valid ? 'válido' : v.reason || 'inválido' }));
  col.appendChild(head);
  col.appendChild(kvList([
    ['hash', fullHash(b.hash || '')],
    ['prev', b.index === 0 ? 'ninguno: es el primero' : fullHash(b.prevHash || '')],
    ['nonce', String(b.nonce)],
    ['dificultad', `${b.difficulty} ${b.difficulty === 1 ? 'cero' : 'ceros'} al inicio del hash`],
    ['hora', new Date(b.timestamp).toLocaleTimeString('es')],
    ['minero', b.miner ? name(b.miner) : 'servidor'],
  ]));
  const prev = chain[at - 1];
  if (b.index > 0) {
    const linked = !prev || prev.hash === b.prevHash;
    const note = el('div', `loc-note ${linked ? 'ok' : 'bad'}`);
    note.append(mark(linked), linked
      ? ` «prev» es el hash del bloque #${b.index - 1}: si ese bloque cambia, este deja de encajar.`
      : ` «prev» ya no coincide con el hash del bloque #${b.index - 1}: la cadena se rompió aquí.`);
    col.appendChild(note);
  }
  const txs = el('div', 'net-col');
  txs.appendChild(el('h3', null, `Transacciones (${(b.txs || []).length})`));
  const status = at === chain.length - 1 ? new Map((s.lastBlockStatus || []).map((x) => [x.hash, x])) : null;
  const ul = el('ul', 'net-txs');
  (b.txs || []).slice(0, 7).forEach((t) => ul.appendChild(txLine(t, name, status ? status.get(t.hash) : { status: 'confirmed' })));
  if ((b.txs || []).length > 7) ul.appendChild(el('li', 'more', `+${b.txs.length - 7} más`));
  if (!(b.txs || []).length) ul.appendChild(el('li', 'more', 'Sin transacciones'));
  txs.appendChild(ul);
  body.append(col, txs, el('div', 'loc-keys', 'Flechas ← → para recorrer la cadena · Esc para volver'));
}

function viewMempool(s, body) {
  const nick = nickMap(s);
  const name = (addr) => nick.get(addr) || shortAddr(addr);
  const pending = s.mempool || [];
  const col = el('div', 'net-col');
  col.appendChild(el('div', 'loc-lead', 'Sala de espera: transacciones firmadas y válidas que todavía no están en ningún bloque.'));
  col.appendChild(el('h3', null, `En espera (${pending.length})`));
  const ul = el('ul', 'net-txs pending');
  pending.slice(0, 10).forEach((t) => ul.appendChild(txLine(t, name, null)));
  if (pending.length > 10) ul.appendChild(el('li', 'more', `+${pending.length - 10} más`));
  if (!pending.length) ul.appendChild(el('li', 'more', 'Vacío: el minero no tiene nada que incluir'));
  col.appendChild(ul);
  col.appendChild(el('div', 'loc-note', 'El minero las toma, las mete en un bloque y busca el nonce. Hasta entonces no cambian ningún saldo.'));
  body.appendChild(col);
}

// The miner view is repainted in place by paintPow() on every mine:progress, so it is not rebuilt.
let powModel = { nonce: '-', hash: '', hit: false };
export function paintPow(m) {
  if (m) powModel = m;
  const n = document.getElementById('pow-nonce');
  if (!n) return;
  n.textContent = String(powModel.nonce);
  const hEl = document.getElementById('pow-hash');
  hEl.replaceChildren(powModel.hash ? fullHash(powModel.hash) : 'esperando el próximo bloque');
  hEl.classList.toggle('hit', !!powModel.hit);
}

function viewMiner(s, body) {
  const d = s.difficulty ?? 0;
  const tip = (s.chain || [])[(s.chain || []).length - 1];
  const col = el('div', 'net-col');
  col.appendChild(el('div', 'loc-lead', 'Prueba de trabajo: probar números (nonce) hasta que el hash del bloque empiece con suficientes ceros.'));
  const formula = el('div', 'pow-formula mono');
  formula.append('SHA-256( ', el('span', 'f', `#${(tip?.index ?? 0) + 1}`), ' | ', el('span', 'f', 'hash anterior'), ' | ',
    el('span', 'f', 'hora'), ' | ', el('span', 'f', 'transacciones'), ' | ', el('span', 'f nonce', 'nonce'), ' )');
  col.appendChild(formula);
  const nonce = el('b', 'mono');
  nonce.id = 'pow-nonce';
  const hash = el('div', 'pow-hash mono');
  hash.id = 'pow-hash';
  col.appendChild(kvList([['nonce', nonce], ['hash', hash], ['meta', `empezar con ${'0'.repeat(d)}`]]));
  const tries = 16 ** d;
  col.appendChild(el('div', 'loc-note', `Con dificultad ${d} acierta 1 de cada ${tries.toLocaleString('es')} intentos. Cada cero extra multiplica el trabajo por 16.`));
  const ladder = el('div', 'pow-ladder');
  for (const k of [3, 4, 5, 6]) {
    const row = el('div', k === d ? 'on' : '');
    row.append(el('span', 'mono', '0'.repeat(k)), el('b', null, `${(16 ** k).toLocaleString('es')} intentos`));
    ladder.appendChild(row);
  }
  col.appendChild(ladder);
  body.append(col);
  if ((s.miners || []).length) body.append(rankingCol(s));
  paintPow();
}

function viewWallets(s, body) {
  const col = el('div', 'net-col');
  col.appendChild(el('div', 'loc-lead', 'Cada teléfono genera su par de llaves. La privada firma las transacciones; con la pública cualquiera verifica la firma.'));
  body.append(col, rankingCol(s));
}

export const LOCAL_META = {
  block: { title: 'Bloque', icon: 'block' },
  mempool: { title: 'Mempool', icon: 'layers' },
  miner: { title: 'Minero', icon: 'pick' },
  wallets: { title: 'Participantes', icon: 'users' },
};

/** local: { kind: 'block', index } | { kind: 'mempool' | 'miner' | 'wallets' } */
export function renderLocalBody(local, s, body) {
  body.replaceChildren();
  if (local.kind === 'block') viewBlock(s, body, local.index);
  else if (local.kind === 'mempool') viewMempool(s, body);
  else if (local.kind === 'miner') viewMiner(s, body);
  else viewWallets(s, body);
}
