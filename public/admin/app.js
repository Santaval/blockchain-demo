import { connect, bindStatus } from '/shared/socket.js';

const $ = (id) => document.getElementById(id);
const PANELS = [['qr', 'QR'], ['red', 'Red'], ['votacion', 'Votación'], ['subasta', 'Subasta'], ['banco', 'Banco']];
const DIFFICULTIES = [3, 4, 5, 6];
const INTERVALS = [5, 8, 12, 20, 30];

const socket = connect('admin');
bindStatus(socket, $('status'));

let loggedIn = false;
let toastTimer = null;

function toast(msg, ok = true) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', !ok);
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
    } else {
      loggedIn = false;
      try { sessionStorage.removeItem('admin.pw'); } catch { /* storage unavailable */ }
      $('login').hidden = false;
      $('panel').hidden = true;
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
DIFFICULTIES.forEach((d) => $('difficulty').appendChild(new Option(`${d} ceros`, d)));
INTERVALS.forEach((s) => $('interval').appendChild(new Option(`${s} s`, s * 1000)));

let minerRunning = true;
$('toggle-miner').addEventListener('click', () =>
  send('admin:miner', { action: minerRunning ? 'pause' : 'resume' }, minerRunning ? 'Minería pausada' : 'Minería reanudada'));
$('mine-now').addEventListener('click', () => send('admin:miner', { action: 'mine-now' }, 'Minando…'));
$('difficulty').addEventListener('change', (e) => send('admin:difficulty', { value: Number(e.target.value) }, 'Dificultad cambiada'));
$('interval').addEventListener('change', (e) => send('admin:interval', { ms: Number(e.target.value) }, 'Intervalo cambiado'));
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

function render(s) {
  if (!loggedIn) return;
  panelButtons.forEach((b) => b.classList.toggle('active', b.dataset.panel === s.panel));
  minerRunning = !!s.minerRunning;
  $('toggle-miner').textContent = minerRunning ? 'Pausar' : 'Reanudar';
  $('height').textContent = String(s.height);
  $('mempool').textContent = String((s.mempool || []).length);
  $('mining').hidden = !s.mining;
  $('difficulty').value = String(s.difficulty);
  $('interval').value = String(s.mineIntervalMs);
}
socket.on('state:full', render);
socket.on('mine:start', () => { $('mining').hidden = false; });
socket.on('block:mined', () => { $('mining').hidden = true; });
