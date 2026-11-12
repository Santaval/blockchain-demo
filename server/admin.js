// Admin commands: password login, then panel / miner / difficulty / interval / gift / reset.
import crypto from 'node:crypto';
import { ADMIN_PASSWORD } from './config.js';
import { state, events, createSystemTx, reset } from './state.js';
import { setDifficulty, setMineInterval, startMiner, stopMiner, isMinerRunning, isMining, isTampered, mineNow } from './miner.js';
import { tamper, remine, restore } from './tamper.js';

export const PANELS = ['qr', 'red', 'votacion', 'subasta', 'banco'];
const GIFT_AMOUNT = 50;

let panel = 'qr'; // survives reset()
export const getPanel = () => panel;

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const passwordOk = (given) => typeof given === 'string' && crypto.timingSafeEqual(digest(given), digest(ADMIN_PASSWORD));

const inRange = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const changed = () => events.emit('state:changed');

// ctx.sendFull(socket) sends a state:full snapshot to the socket.
export function registerAdminHandlers(socket, ctx) {
  const isAdminRole = socket.handshake.query.role === 'admin';
  const authed = () => isAdminRole && socket.data.isAdmin === true;

  // Registers `admin:<name>`; every command except login needs an authenticated admin socket.
  const command = (name, fn) => socket.on(`admin:${name}`, (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!authed()) return reply({ ok: false, reason: 'No autorizado' });
    reply(fn(payload ?? {}));
  });

  socket.on('admin:login', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!isAdminRole) return reply({ ok: false, reason: 'No autorizado' });
    if (!passwordOk(payload?.password)) return reply({ ok: false, reason: 'Contraseña incorrecta' });
    socket.data.isAdmin = true;
    socket.join('admin');
    reply({ ok: true });
    ctx.sendFull(socket);
  });

  command('panel', ({ panel: p }) => {
    if (!PANELS.includes(p)) return { ok: false, reason: 'Panel inválido' };
    panel = p;
    changed();
    return { ok: true };
  });

  command('miner', ({ action }) => {
    if ((action === 'resume' || action === 'mine-now') && isTampered()) return { ok: false, reason: 'Restaura la cadena primero' };
    if (action === 'pause') stopMiner();
    else if (action === 'resume') startMiner();
    else if (action === 'mine-now') {
      if (isMining()) return { ok: false, reason: 'Ya se está minando un bloque' };
      if (state.mempool.length === 0) return { ok: false, reason: 'El mempool está vacío' };
      mineNow();
    } else return { ok: false, reason: 'Acción inválida' };
    changed();
    return { ok: true };
  });

  command('difficulty', ({ value }) => {
    if (!inRange(value, 3, 6)) return { ok: false, reason: 'La dificultad debe ser un entero de 3 a 6' };
    setDifficulty(value);
    changed();
    return { ok: true };
  });

  command('interval', ({ ms }) => {
    if (!inRange(ms, 3000, 60000)) return { ok: false, reason: 'El intervalo debe estar entre 3000 y 60000 ms' };
    setMineInterval(ms);
    changed();
    return { ok: true };
  });

  command('gift', () => {
    const targets = [...state.accounts.values()].filter((a) => !a.system);
    for (const a of targets) {
      const tx = createSystemTx(a.address, GIFT_AMOUNT);
      state.mempool.push(tx);
      state.txStatus.set(tx.hash, { status: 'pending' });
      events.emit('mempool:add', tx);
    }
    changed();
    return { ok: true, count: targets.length };
  });

  command('tamper', (p) => tamper(p));
  command('remine', (p) => remine(p));
  command('restore', () => restore());

  command('reset', () => {
    reset();
    changed();
    return { ok: true };
  });
}
