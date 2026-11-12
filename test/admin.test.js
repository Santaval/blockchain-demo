import './helpers/no-mine-pause.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server } from 'socket.io';
import { io as ioc } from 'socket.io-client';
import * as wc from '../public/shared/wallet-crypto.js';
import { ADMIN_PASSWORD } from '../server/config.js';
import { state, reset, registerWallet } from '../server/state.js';
import { getDifficulty, getMineInterval, isMinerRunning, stopMiner, setDifficulty, setMineInterval } from '../server/miner.js';
import { mineBlock } from '../server/miner.js';
import { attachSync } from '../server/sync.js';

let httpServer, io, detach, url;
const clients = [];

before(async () => {
  reset();
  httpServer = http.createServer();
  io = new Server(httpServer);
  detach = attachSync(io);
  await new Promise((r) => httpServer.listen(0, r));
  url = `http://localhost:${httpServer.address().port}`;
});

after(async () => {
  clients.forEach((c) => c.close());
  stopMiner();
  setDifficulty(4);
  setMineInterval(12000);
  detach();
  await io.close();
});

function client(role) {
  const c = ioc(url, { query: { role }, forceNew: true });
  clients.push(c);
  return c;
}
const once = (c, ev) => new Promise((r) => c.once(ev, r));
const emit = (c, ev, data) => new Promise((r) => c.emit(ev, data, r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function loggedAdmin() {
  const c = client('admin');
  const full = once(c, 'state:full');
  assert.deepEqual(await emit(c, 'admin:login', { password: ADMIN_PASSWORD }), { ok: true });
  await full;
  return c;
}

async function addWallet(nick) {
  const kp = await wc.generateKeyPair();
  registerWallet(nick, await wc.exportPublicKeyHex(kp.publicKey));
}

test('unauthenticated admin commands are rejected and no state is sent', async () => {
  const c = client('admin');
  let gotState = false;
  c.on('state:full', () => { gotState = true; });
  for (const ev of ['admin:panel', 'admin:miner', 'admin:difficulty', 'admin:interval', 'admin:gift', 'admin:reset']) {
    assert.deepEqual(await emit(c, ev, {}), { ok: false, reason: 'No autorizado' });
  }
  await wait(400);
  assert.equal(gotState, false);
});

test('wrong password is rejected', async () => {
  const c = client('admin');
  assert.deepEqual(await emit(c, 'admin:login', { password: 'nope' }), { ok: false, reason: 'Contraseña incorrecta' });
  assert.deepEqual(await emit(c, 'admin:login', {}), { ok: false, reason: 'Contraseña incorrecta' });
  assert.deepEqual(await emit(c, 'admin:panel', { panel: 'red' }), { ok: false, reason: 'No autorizado' });
});

test('non-admin roles cannot log in or run commands', async () => {
  for (const role of ['wallet', 'pantalla']) {
    const c = client(role);
    assert.equal((await emit(c, 'admin:login', { password: ADMIN_PASSWORD })).ok, false);
    assert.deepEqual(await emit(c, 'admin:gift'), { ok: false, reason: 'No autorizado' });
  }
});

test('after login: panel, difficulty, interval, pause/resume work', async () => {
  reset();
  const a = await loggedAdmin();

  const full = once(a, 'state:full');
  assert.equal((await emit(a, 'admin:panel', { panel: 'red' })).ok, true);
  assert.equal((await full).panel, 'red');
  assert.equal((await emit(a, 'admin:panel', { panel: 'xx' })).ok, false);

  assert.equal((await emit(a, 'admin:difficulty', { value: 2 })).ok, false);
  assert.equal((await emit(a, 'admin:difficulty', { value: 7 })).ok, false);
  assert.equal((await emit(a, 'admin:difficulty', { value: 3 })).ok, true);
  assert.equal(getDifficulty(), 3);

  assert.equal((await emit(a, 'admin:interval', { ms: 100 })).ok, false);
  assert.equal((await emit(a, 'admin:interval', { ms: 5000 })).ok, true);
  assert.equal(getMineInterval(), 5000);

  assert.equal((await emit(a, 'admin:miner', { action: 'resume' })).ok, true);
  assert.equal(isMinerRunning(), true);
  assert.equal((await emit(a, 'admin:miner', { action: 'pause' })).ok, true);
  assert.equal(isMinerRunning(), false);
  assert.equal((await emit(a, 'admin:miner', { action: 'boom' })).ok, false);
  assert.equal((await emit(a, 'admin:miner', { action: 'mine-now' })).ok, false); // empty mempool
});

test('gift queues +50 per non-system account; panel survives reset', async () => {
  reset();
  await addWallet('Ana');
  await addWallet('Beto');
  const a = await loggedAdmin();
  const added = [];
  a.on('mempool:add', (tx) => added.push(tx));
  const before = state.mempool.length;
  assert.deepEqual(await emit(a, 'admin:gift'), { ok: true, count: 2 });
  assert.equal(state.mempool.length, before + 2);
  assert.ok(state.mempool.slice(-2).every((t) => t.amount === 50 && state.txStatus.get(t.hash).status === 'pending'));
  await wait(100);
  assert.equal(added.length, 2);

  await emit(a, 'admin:panel', { panel: 'banco' });
  const full = once(a, 'state:full');
  assert.equal((await emit(a, 'admin:reset')).ok, true);
  assert.equal(state.chain.length, 1);
  assert.equal((await full).panel, 'banco');
});

test('tamper commands work, and resume / mine-now are refused while tampered', async () => {
  reset();
  await addWallet('Ana');
  mineBlock();
  const a = await loggedAdmin();
  assert.equal((await emit(a, 'admin:tamper', { block: 1, tx: 0, amount: 0 })).ok, false);
  assert.equal((await emit(a, 'admin:restore')).ok, false);
  assert.equal((await emit(a, 'admin:tamper', { block: 1, tx: 0, amount: 999 })).ok, true);
  assert.deepEqual(await emit(a, 'admin:miner', { action: 'resume' }), { ok: false, reason: 'Restaura la cadena primero' });
  assert.deepEqual(await emit(a, 'admin:miner', { action: 'mine-now' }), { ok: false, reason: 'Restaura la cadena primero' });
  assert.equal((await emit(a, 'admin:restore')).ok, true);
  assert.equal((await emit(a, 'admin:miner', { action: 'resume' })).ok, true);
  stopMiner();
});
