import { connect, bindStatus } from '/shared/socket.js';
import { icon } from '/shared/icons.js';

const $ = (id) => document.getElementById(id);
const PANELS = [['qr', 'QR'], ['red', 'Red'], ['votacion', 'Votación'], ['subasta', 'Subasta'], ['banco', 'Banco'], ['pruebas', 'Pruebas']];
const DIFFICULTIES = [3, 4, 5, 6];
const INTERVALS = [5, 8, 12, 20, 30];

const socket = connect('admin');
bindStatus(socket, $('status'));

let loggedIn = false;
let toastTimer = null;

function toast(msg, ok = true) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', !ok);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
}

// Sends a command and shows the ack as a toast.
function send(event, payload, okMsg = 'Listo') {
  socket.emit(event, payload, (res) => {
    if (res?.ok) toast(res.count !== undefined ? `${okMsg} (${res.count})` : okMsg);
    else toast(res?.reason || 'Error', false);
  });
}

function login(password, silent = false) {
  socket.emit('admin:login', { password }, (res) => {
    if (res?.ok) {
      loggedIn = true;
      try { sessionStorage.setItem('admin.pw', password); } catch { /* storage unavailable */ }
      $('login').hidden = true;
      $('panel').hidden = false;
      $('jump').hidden = false;
    } else {
      loggedIn = false;
      try { sessionStorage.removeItem('admin.pw'); } catch { /* storage unavailable */ }
      $('login').hidden = false;
      $('panel').hidden = true;
      $('jump').hidden = true;
      if (!silent) toast(res?.reason || 'Error', false);
    }
  });
}

$('login').addEventListener('submit', (e) => {
  e.preventDefault();
  login($('pw').value);
});

// Re-login on (re)connect with the stored password.
socket.on('connect', () => {
  let pw = null;
  try { pw = sessionStorage.getItem('admin.pw'); } catch { /* storage unavailable */ }
  if (pw) login(pw, true);
});
socket.on('disconnect', () => { loggedIn = false; });

// Section shortcuts: one chip per card, sticky under the header.
for (const section of document.querySelectorAll('#panel section[id]')) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = section.dataset.title;
  b.addEventListener('click', () => section.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  $('jump').appendChild(b);
}

// Static controls
const panelButtons = PANELS.map(([id, label]) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.dataset.panel = id;
  b.addEventListener('click', () => send('admin:panel', { panel: id }, `Pantalla: ${label}`));
  $('panels').appendChild(b);
  return b;
});

// Segmented control: one button per value, button.on marks the current one.
function buildSeg(el, values, label, onPick) {
  return values.map((v) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label(v);
    b.dataset.value = String(v);
    b.addEventListener('click', () => onPick(v));
    el.appendChild(b);
    return b;
  });
}
function markSeg(buttons, value) {
  buttons.forEach((b) => b.classList.toggle('on', b.dataset.value === String(value)));
}
const diffButtons = buildSeg($('difficulty'), DIFFICULTIES, (d) => String(d),
  (d) => send('admin:difficulty', { value: d }, 'Dificultad cambiada'));
const intervalButtons = buildSeg($('interval'), INTERVALS.map((s) => s * 1000), (ms) => `${ms / 1000} s`,
  (ms) => send('admin:interval', { ms }, 'Intervalo cambiado'));

let minerRunning = true;
$('toggle-miner').addEventListener('click', () =>
  send('admin:miner', { action: minerRunning ? 'pause' : 'resume' }, minerRunning ? 'Minería pausada' : 'Minería reanudada'));
$('mine-now').addEventListener('click', () => send('admin:miner', { action: 'mine-now' }, 'Minando…'));
$('gift').addEventListener('click', () => send('admin:gift', undefined, 'Regalo enviado'));

// Two-step confirm, no confirm() dialogs.
let resetTimer = null;
$('reset').addEventListener('click', () => {
  const btn = $('reset');
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.textContent = '¿Seguro? Toca otra vez';
    resetTimer = setTimeout(disarm, 4000);
    return;
  }
  disarm();
  send('admin:reset', undefined, 'Reset hecho');
});
function disarm() {
  clearTimeout(resetTimer);
  $('reset').classList.remove('armed');
  $('reset').textContent = 'Reset total';
}

// Manipular: block / tx selectors are rebuilt only when the chain shape changes, to keep the user's selection.
let chain = [];
let selectsSig = '';
const nickOf = new Map();
const name = (a) => nickOf.get(a) || a;
function renderTamper(s) {
  chain = s.chain || [];
  (s.accounts || []).forEach((a) => nickOf.set(a.address, a.nick));
  $('tampered').hidden = !s.tampered;
  const ul = $('validity');
  ul.replaceChildren();
  chain.forEach((b, i) => {
    const ok = (s.validity || [])[i]?.valid !== false;
    const li = document.createElement('li');
    li.className = ok ? 'chip c-ok' : 'chip c-bad';
    li.append(icon(ok ? 'check' : 'x'), ` #${b.index}`);
    ul.appendChild(li);
  });
  const withTxs = chain.filter((b) => b.index > 0 && b.txs.length);
  const sig = withTxs.map((b) => b.index + ':' + b.txs.length).join();
  if (sig === selectsSig) return;
  selectsSig = sig;
  const prev = $('t-block').value;
  $('t-block').replaceChildren(...withTxs.map((b) => new Option(`Bloque #${b.index} (${b.txs.length} tx)`, b.index)));
  if (withTxs.some((b) => String(b.index) === prev)) $('t-block').value = prev;
  fillTxs();
}
function fillTxs() {
  const b = chain.find((x) => String(x.index) === $('t-block').value);
  $('t-tx').replaceChildren(...(b ? b.txs : []).map((t, i) => new Option(`${name(t.from)} → ${name(t.to)} · ${t.amount}`, i)));
}
$('t-block').addEventListener('change', fillTxs);
$('tamper').addEventListener('click', () => send('admin:tamper', {
  block: Number($('t-block').value), tx: Number($('t-tx').value), amount: Number($('t-amount').value),
}, 'Cadena manipulada'));
$('remine').addEventListener('click', () => send('admin:remine', { block: Number($('t-block').value) }, 'Re-minando…'));
$('restore').addEventListener('click', () => send('admin:restore', undefined, 'Cadena restaurada'));

// Votación: the form is filled once from the server so typing is not overwritten by later state pushes.
let votingFilled = false;
$('v-save').addEventListener('click', () => send('admin:voting-config', {
  question: $('v-question').value,
  options: $('v-options').value.split('\n').map((o) => o.trim()).filter(Boolean),
}, 'Votación guardada'));
$('v-open').addEventListener('click', () => send('admin:voting-open', undefined, 'Votación abierta'));
$('v-close').addEventListener('click', () => send('admin:voting-close', undefined, 'Votación cerrada'));
function renderVoting(s) {
  const v = (s.contracts || []).find((c) => c.address === '0xVOTACION')?.view;
  if (!v) return;
  if (!votingFilled && v.question) {
    votingFilled = true;
    $('v-question').value = v.question;
    $('v-options').value = v.options.join('\n');
  }
  $('v-state').textContent = v.open ? 'abierta' : 'cerrada';
  $('v-counts').textContent = v.options.length ? v.options.map((o, i) => `${o}: ${v.counts[i]}`).join(' · ') : 'Sin configurar';
}

// Subasta: status is refreshed on every state push; the countdown ticks locally.
$('a-open').addEventListener('click', () => send('admin:auction-open', {
  item: $('a-item').value, seconds: Number($('a-seconds').value),
}, 'Subasta abierta'));
let auctionEnds = 0;
function renderAuction(s) {
  const v = (s.contracts || []).find((c) => c.address === '0xSUBASTA')?.view;
  if (!v) return;
  auctionEnds = v.open ? v.endsAt : 0;
  $('a-open').disabled = v.open;
  $('a-state').textContent = v.open ? 'abierta' : v.winner ? 'cerrada' : 'sin abrir';
  $('a-info').textContent = v.winner
    ? `Ganó ${v.winner.nick} con ${v.winner.amount} por "${v.item}"`
    : v.item ? `"${v.item}" · oferta más alta: ${v.highest ? `${v.highest.nick} (${v.highest.amount})` : 'ninguna'}` : '';
}
setInterval(() => {
  if (!auctionEnds) return;
  const left = Math.max(0, Math.ceil((auctionEnds - Date.now()) / 1000));
  $('a-state').textContent = left > 0 ? `abierta · ${left}s` : 'cerrando…';
}, 500);

// Banco: toggle the wallet attack button, seed the bank, launch the attack from 0xHACKER.
let attackEnabled = false;
$('b-toggle').addEventListener('click', () => send('admin:attack-enabled', { enabled: !attackEnabled }, attackEnabled ? 'Botón de ataque oculto' : 'Botón de ataque habilitado'));
$('b-seed').addEventListener('click', () => send('admin:bank-seed', { amount: Number($('b-amount').value) }, 'Depósito del sistema enviado'));
$('b-attack').addEventListener('click', () => send('admin:attack', { amount: Number($('b-amount').value) }, 'Ataque enviado al mempool'));
function renderBank(s) {
  const bank = (s.contracts || []).find((c) => c.address === '0xBANCO')?.view;
  const atk = (s.contracts || []).find((c) => c.address === '0xATACANTE')?.view;
  if (!bank || !atk) return;
  attackEnabled = atk.enabled;
  $('b-toggle').textContent = attackEnabled ? 'Deshabilitar botón de ataque' : 'Habilitar botón de ataque';
  $('b-state').textContent = attackEnabled ? 'ataque habilitado' : 'ataque oculto';
  $('b-info').textContent = `Saldo del banco: ${bank.balance}` + (atk.lastLoot ? ` · último botín: ${atk.lastLoot} (${atk.rounds} reentradas)` : '');
}

// Pruebas: suite rows are rebuilt on each push (small list, text only).
let lab = null;
const STATUS_CHIP = { pending: ['pendiente', 'c-neutral'], running: ['corriendo', 'c-running'], pass: ['pasó', 'c-ok'], fail: ['falló', 'c-bad'] };
const SUITE_ICON = { spec: 'clipboard', multicliente: 'copy', 'fuzz-red': 'shuffle', bft: 'shield', fork: 'fork', invariantes: 'scale' };
function labRun(suite, label) {
  const raw = $('lab-seed-in').value.trim();
  const payload = { suite };
  if (raw !== '') payload.seed = Number(raw);
  socket.emit('admin:lab-run', payload, (res) => {
    if (res?.ok) toast(`${label} · semilla ${res.seed}`);
    else toast(res?.reason || 'Error', false);
  });
}
$('lab-all').addEventListener('click', () => labRun('all', 'Corriendo todas'));
$('lab-seed-again').addEventListener('click', () => { if (lab?.seed != null) $('lab-seed-in').value = String(lab.seed); });
$('lab-clear').addEventListener('click', () => send('admin:lab-clear', {}, lab?.running ? 'Pruebas canceladas' : 'Pruebas limpiadas'));
function renderLab(s) {
  lab = s.lab;
  if (!lab) return;
  const running = !!lab.running;
  $('lab-all').disabled = running;
  $('lab-clear').textContent = running ? 'Cancelar' : 'Limpiar';
  $('lab-seed').textContent = lab.seed != null ? String(lab.seed) : '-';
  $('lab-seed-again').disabled = lab.seed == null;
  const st = $('lab-state');
  st.hidden = !running && !lab.finishedAt;
  st.className = running ? 'chip c-running' : 'chip c-neutral';
  st.textContent = running ? 'corriendo…' : 'terminado';
  const ul = $('lab-suites');
  ul.replaceChildren();
  for (const su of lab.suites || []) {
    const li = document.createElement('li');
    const ic = document.createElement('span');
    ic.className = 'sic';
    ic.appendChild(icon(SUITE_ICON[su.id] || 'flask'));
    const nm = document.createElement('div');
    nm.className = 'nm';
    const b = document.createElement('b');
    b.textContent = su.name;
    const sm = document.createElement('small');
    const done = su.status === 'pass' || su.status === 'fail';
    sm.textContent = su.status === 'running' && su.progress ? su.progress : done && su.summary ? su.summary : `diap. ${su.slides}`;
    let [txt, cls] = STATUS_CHIP[su.status] || STATUS_CHIP.pending;
    if (su.expectFail && su.status === 'fail') [txt, cls] = ['bug encontrado', 'c-ok'];
    const chip = document.createElement('span');
    chip.className = `chip ${cls}`;
    chip.textContent = txt;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = 'Correr';
    btn.disabled = running;
    btn.addEventListener('click', () => labRun(su.id, su.name));
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.append(chip, sm);
    nm.append(b, meta);
    li.append(ic, nm, btn);
    ul.appendChild(li);
  }
}

function render(s) {
  if (!loggedIn) return;
  renderLab(s);
  panelButtons.forEach((b) => b.classList.toggle('on', b.dataset.panel === s.panel));
  minerRunning = !!s.minerRunning;
  $('toggle-miner').textContent = minerRunning ? 'Pausar' : 'Reanudar';
  $('height').textContent = String(s.height);
  $('mempool').textContent = String((s.mempool || []).length);
  $('mining').hidden = !s.mining;
  const nMiners = s.pool?.miners?.length ?? 0;
  $('miners').hidden = nMiners === 0;
  $('miners').textContent = `${nMiners} ${nMiners === 1 ? 'minero' : 'mineros'}`;
  markSeg(diffButtons, s.difficulty);
  markSeg(intervalButtons, s.mineIntervalMs);
  renderTamper(s);
  renderVoting(s);
  renderAuction(s);
  renderBank(s);
}
socket.on('state:full', render);
socket.on('mine:start', () => { $('mining').hidden = false; $('remine-nonce').textContent = '0'; });
socket.on('mine:progress', (p) => { $('remine-nonce').textContent = String(p.nonce); });
socket.on('block:remined', () => { $('mining').hidden = true; });
socket.on('block:mined', () => { $('mining').hidden = true; });
