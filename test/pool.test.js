import './helpers/no-mine-pause.js';
import test, { beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { Server } from 'socket.io';
import { io as ioc } from 'socket.io-client';
import * as wc from '../public/shared/wallet-crypto.js';
import { sha256Hex } from '../public/shared/sha256.js';
import { POOL_REWARD } from '../server/config.js';
import { state, events, reset, registerWallet, getBalance } from '../server/state.js';
import { submitTx } from '../server/validator.js';
import { mineBlock, mineNow, isMining, setDifficulty, setTampered, validateChain } from '../server/miner.js';
import * as pool from '../server/pool.js';
import { attachSync } from '../server/sync.js';

const DIFF = 2;

async function makeWallet(nick) {
  const kp = await wc.generateKeyPair();
  const pubKey = await wc.exportPublicKeyHex(kp.publicKey);
  const { account } = registerWallet(nick, pubKey);
  return { priv: kp.privateKey, pubKey, address: account.address };
}
const makeTx = async (w, { to, amount = 5, nonce = 0 }) =>
  wc.signTx(w.priv, await wc.buildTx({ from: w.address, to, amount, nonce, pubKey: w.pubKey }));

// Brute-forces the nonce the way a phone does: hash(prefix + nonce).
function solve(job) {
  const zeros = '0'.repeat(job.difficulty);
  for (let nonce = 0; ; nonce++) if (sha256Hex(job.prefix + nonce).startsWith(zeros)) return nonce;
}

// Collects pool:job events per address from the bus.
let jobs;
const onJob = ({ address, job }) => jobs.set(address, job);
const once = (ev) => new Promise((r) => events.once(ev, r));

// Pool timers are unref'd (the server's http listener keeps the process alive), so tests need their own keep-alive.
let keepAlive;
before(() => { events.on('pool:job', onJob); keepAlive = setInterval(() => {}, 1000); });
after(() => { events.off('pool:job', onJob); clearInterval(keepAlive); });
beforeEach(() => {
  reset();
  jobs = new Map();
  setDifficulty(DIFF);
  pool.setPoolTimeout(60000);
});

test('sha256 matches node:crypto', () => {
  const samples = ['', 'abc', 'hola|mundo|123', 'ñandú ✓ 日本語 😀', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(10_000), '\ud800 lone'];
  for (let i = 0; i < 20; i++) samples.push(randomBytes(i * 7).toString('base64'));
  for (const s of samples) assert.equal(sha256Hex(s), createHash('sha256').update(s, 'utf8').digest('hex'), JSON.stringify(s.slice(0, 20)));
});

test('a valid submit commits the block with the coinbase first', async () => {
  const a = await makeWallet('Ana');
  const b = await makeWallet('Beto');
  mineBlock(); // faucets
  const tx = await makeTx(a, { to: b.address, amount: 20 });
  assert.equal(submitTx(tx).ok, true);
  assert.equal(pool.join(a.address, 's1').ok, true);
  const before = getBalance(a.address);

  assert.equal(mineNow() instanceof Promise, true);
  assert.equal(isMining(), true);
  const job = jobs.get(a.address);
  assert.equal(job.reward, POOL_REWARD);
  assert.equal(pool.poolState().round.index, 2);

  const won = once('pool:won');
  const res = pool.submit(a.address, { round: job.round, nonce: solve(job) });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(await won, { index: 2, address: a.address, nick: 'Ana', reward: POOL_REWARD });

  const block = state.chain[2];
  assert.equal(block.miner, a.address);
  assert.equal(block.txs.length, 2);
  assert.equal(block.txs[0].coinbase, true);
  assert.equal(block.txs[0].from, '0xSISTEMA');
  assert.equal(block.txs[0].to, a.address);
  assert.equal(block.txs[0].amount, POOL_REWARD);
  assert.equal(block.txs[1].hash, tx.hash);
  // phone hash == server hash, and the chain stays valid
  assert.equal(sha256Hex(job.prefix + block.nonce), block.hash);
  assert.ok(validateChain().every((v) => v.valid));
  assert.equal(getBalance(a.address), before - 20 + POOL_REWARD);
  assert.equal(getBalance(b.address), 120);
  assert.equal(state.mempool.length, 0);
  assert.equal(isMining(), false);
  assert.equal(pool.blocksWon(a.address), 1);
  assert.deepEqual(state.txStatus.get(block.txs[0].hash), { status: 'confirmed', block: 2 });
});

test('txs submitted during a round wait for the next block', async () => {
  const a = await makeWallet('Ana');
  const b = await makeWallet('Beto');
  mineBlock();
  const tx0 = await makeTx(a, { to: b.address, nonce: 0 });
  submitTx(tx0);
  pool.join(a.address, 's1');
  mineNow();
  const tx1 = await makeTx(a, { to: b.address, nonce: 1 });
  assert.equal(submitTx(tx1).ok, true);
  const job = jobs.get(a.address);
  assert.equal(pool.submit(a.address, { round: job.round, nonce: solve(job) }).ok, true);
  assert.deepEqual(state.mempool.map((t) => t.hash), [tx1.hash]);
  assert.equal(state.chain[2].txs.some((t) => t.hash === tx1.hash), false);
  assert.equal(state.nonces.get(a.address), 1);
  const tx2 = await makeTx(a, { to: b.address, nonce: 2 });
  assert.equal(submitTx(tx2).ok, true);
});

test('late, invalid and stolen solutions are rejected', async () => {
  const a = await makeWallet('Ana');
  const b = await makeWallet('Beto');
  pool.join(a.address, 's1');
  pool.join(b.address, 's2');
  mineNow();
  const ja = jobs.get(a.address);
  const jb = jobs.get(b.address);
  assert.notEqual(ja.prefix, jb.prefix);
  const nonceA = solve(ja);

  assert.deepEqual(pool.submit(a.address, { round: ja.round + 99, nonce: nonceA }), { ok: false, reason: 'Llegaste tarde' });
  assert.deepEqual(pool.submit(a.address, { round: ja.round, nonce: -1 }), { ok: false, reason: 'Solución inválida' });
  let bad = 0;
  while (sha256Hex(ja.prefix + bad).startsWith('0'.repeat(DIFF))) bad++;
  assert.deepEqual(pool.submit(a.address, { round: ja.round, nonce: bad }), { ok: false, reason: 'Solución inválida' });
  // B tries Ana's nonce on B's own puzzle (unless it happens to solve both)
  if (!sha256Hex(jb.prefix + nonceA).startsWith('0'.repeat(DIFF))) {
    assert.deepEqual(pool.submit(b.address, { round: jb.round, nonce: nonceA }), { ok: false, reason: 'Solución inválida' });
  }
  assert.equal(state.chain.length, 1);
  assert.equal(pool.submit(a.address, { round: ja.round, nonce: nonceA }).ok, true);
  assert.deepEqual(pool.submit(b.address, { round: jb.round, nonce: solve(jb) }), { ok: false, reason: 'Llegaste tarde' });
  assert.equal(state.chain[1].miner, a.address);
});

test('a miner who joins mid-round gets a job built on demand', async () => {
  const a = await makeWallet('Ana');
  const b = await makeWallet('Beto');
  pool.join(a.address, 's1');
  mineNow();
  assert.equal(jobs.has(b.address), false);
  pool.join(b.address, 's2');
  const jb = jobs.get(b.address);
  assert.equal(jb.round, jobs.get(a.address).round);
  assert.equal(pool.submit(b.address, { round: jb.round, nonce: solve(jb) }).ok, true);
  assert.equal(state.chain[1].miner, b.address);
});

test('progress aggregates attempts and keeps the best hash', async () => {
  const a = await makeWallet('Ana');
  const b = await makeWallet('Beto');
  pool.join(a.address, 's1');
  pool.join(b.address, 's2');
  const seen = [];
  const onProgress = (p) => seen.push(p);
  events.on('mine:progress', onProgress);
  mineNow();
  const ja = jobs.get(a.address);
  pool.progress(a.address, { round: ja.round, tried: 100, hash: '00' + 'a'.repeat(62) });
  pool.progress(b.address, { round: ja.round, tried: 50, hash: '0' + 'b'.repeat(63) });
  events.off('mine:progress', onProgress);
  assert.deepEqual(seen.at(-1), { index: 1, nonce: 150, hash: '00' + 'a'.repeat(62) });
});

test('difficulty above the maximum disables the pool and the server mines', async () => {
  const a = await makeWallet('Ana');
  pool.join(a.address, 's1');
  setDifficulty(5);
  const st = pool.poolState();
  assert.equal(st.enabled, false);
  assert.match(st.reason, /^La dificultad subió a 5: el grupo tardaría ~\d+ (s|min|h) por bloque\. Deja de minar\.$/);
  assert.equal(st.etaSeconds, Math.round((16 ** 5 / 4000) * 10) / 10);
  assert.equal(pool.canRun(), false);
  assert.equal(pool.join('0xother', 's2').ok, false);
  assert.equal(pool.join(a.address, 's3').reason, st.reason);

  const p = mineNow();
  assert.equal(isMining(), true);
  assert.equal(pool.poolState().round, null);
  reset(); // abort the (slow) server run
  await p;
});

test('raising the difficulty mid-round ends it and the server takes over', async () => {
  const a = await makeWallet('Ana');
  pool.join(a.address, 's1');
  mineNow();
  assert.notEqual(pool.poolState().round, null);
  const end = once('pool:end');
  setDifficulty(5);
  assert.match((await end).reason, /dificultad/);
  assert.equal(pool.poolState().round, null);
  assert.equal(isMining(), true); // server mining the same block
  reset();
});

test('on timeout the server mines the same block without a reward', async () => {
  const a = await makeWallet('Ana');
  pool.join(a.address, 's1');
  pool.setPoolTimeout(30);
  const end = once('pool:end');
  const mined = once('block:mined');
  mineNow();
  assert.match((await end).reason, /a tiempo/);
  const block = await mined;
  assert.equal(block.miner, undefined);
  assert.equal(block.txs.some((t) => t.coinbase), false);
  assert.equal(block.txs.length, 1); // the faucet
  assert.equal(getBalance(a.address), 100);
  assert.equal(isMining(), false);
});

test('all miners leaving ends the round', async () => {
  const a = await makeWallet('Ana');
  pool.join(a.address, 's1');
  const mined = once('block:mined');
  mineNow();
  pool.leaveSocket('s1');
  assert.equal(pool.poolState().round, null);
  assert.equal((await mined).miner, undefined);
});

test('reset and tamper abort the round quietly', async () => {
  const a = await makeWallet('Ana');
  pool.join(a.address, 's1');
  mineNow();
  assert.notEqual(pool.poolState().round, null);
  reset();
  assert.equal(pool.poolState().round, null);
  assert.equal(pool.poolState().miners.length, 0);
  assert.equal(isMining(), false);

  const b = await makeWallet('Beto');
  pool.join(b.address, 's2');
  mineNow();
  const job = jobs.get(b.address);
  setTampered(true);
  assert.equal(pool.poolState().round, null);
  assert.equal(isMining(), false);
  assert.deepEqual(pool.submit(b.address, { round: job.round, nonce: solve(job) }), { ok: false, reason: 'Llegaste tarde' });
  assert.equal(pool.canRun(), false);
  setTampered(false);
});

// --- sockets ---

let httpServer, io, detach, url;
const clients = [];

async function startServer() {
  httpServer = http.createServer();
  io = new Server(httpServer);
  detach = attachSync(io);
  await new Promise((r) => httpServer.listen(0, r));
  url = `http://localhost:${httpServer.address().port}`;
}
const client = (role) => { const c = ioc(url, { query: { role }, forceNew: true }); clients.push(c); return c; };
const onceC = (c, ev) => new Promise((r) => c.once(ev, r));
const emit = (c, ev, data) => new Promise((r) => c.emit(ev, data, r));

test('over sockets: join, job, submit, won and wallet state', async () => {
  await startServer();
  try {
    const pantalla = client('pantalla');
    await onceC(pantalla, 'state:full');
    const kp = await wc.generateKeyPair();
    const pubKey = await wc.exportPublicKeyHex(kp.publicKey);
    const c = client('wallet');
    const latest = {};
    c.on('state', (st) => { latest.wallet = st; });
    pantalla.on('state:full', (st) => { latest.full = st; });
    const until = async (get, pred) => { while (!pred(get())) await new Promise((r) => setTimeout(r, 20)); return get(); };
    const reg = await emit(c, 'register', { nick: 'Ana', pubKey });
    assert.equal(reg.ok, true);

    assert.deepEqual(await emit(client('wallet'), 'pool:join', {}), { ok: false, reason: 'Wallet no registrada' });
    const joined = await emit(c, 'pool:join', {});
    assert.deepEqual(joined, { ok: true, rate: 4000, reward: POOL_REWARD });

    const jobP = onceC(c, 'pool:job');
    const wonP = onceC(pantalla, 'pool:won');
    mineNow();
    const job = await jobP;
    assert.equal(job.difficulty, DIFF);
    const nonce = solve(job);
    c.emit('pool:progress', { round: job.round, tried: nonce, hash: sha256Hex(job.prefix + nonce) });
    assert.deepEqual(await emit(c, 'pool:submit', { round: job.round, nonce }), { ok: true });
    assert.deepEqual(await wonP, { index: 1, address: reg.address, nick: 'Ana', reward: POOL_REWARD });

    const ws = await until(() => latest.wallet, (w) => w?.balance === 110);
    assert.equal(ws.pool.mining, true);
    assert.equal(ws.pool.won, 1);
    assert.equal(ws.pool.enabled, true);
    assert.equal(ws.history.find((h) => h.reward).amount, POOL_REWARD);
    const full = await until(() => latest.full, (f) => f?.height === 1);
    assert.deepEqual(full.miners, [{ address: reg.address, nick: 'Ana', won: 1, mining: true }]);
    assert.equal(full.pool.enabled, true);

    // difficulty change reaches miners
    const st = onceC(c, 'pool:state');
    setDifficulty(5);
    const pst = await st;
    assert.equal(pst.enabled, false);
    assert.match(pst.reason, /^La dificultad subió a 5/);
    assert.equal((await emit(c, 'pool:join', {})).ok, false);
    assert.deepEqual(await emit(c, 'pool:leave', {}), { ok: true });
    assert.equal(pool.isMiner(reg.address), false);
  } finally {
    clients.forEach((c) => c.close());
    detach();
    await io.close();
  }
});
