import './helpers/no-mine-pause.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as wc from '../public/shared/wallet-crypto.js';
import { MAX_TXS_PER_BLOCK } from '../server/config.js';
import { state, events, SYSTEM, reset, registerWallet, getBalance, createSystemTx } from '../server/state.js';
import { submitTx } from '../server/validator.js';
import { mineBlock, mineBlockAnimated, isMining, mineNow, validateChain, setDifficulty, getDifficulty, setMineInterval, getMineInterval, startMiner, stopMiner } from '../server/miner.js';

setDifficulty(2);

async function makeWallet(nick) {
  const kp = await wc.generateKeyPair();
  const pubKey = await wc.exportPublicKeyHex(kp.publicKey);
  const { account } = registerWallet(nick, pubKey);
  return { priv: kp.privateKey, pubKey, address: account.address };
}

async function makeTx(w, { to, amount = 10, nonce = 0, call } = {}) {
  const partial = await wc.buildTx({ from: w.address, to, amount, nonce, call, pubKey: w.pubKey });
  return wc.signTx(w.priv, partial);
}

beforeEach(() => reset());

test('mining an empty mempool returns null', () => {
  assert.equal(mineBlock(), null);
  assert.equal(state.chain.length, 1);
});

test('faucet tx is mined: balance, status, nonce, mempool', async () => {
  const a = await makeWallet('Alice');
  const [faucet] = state.mempool;
  const block = mineBlock();
  assert.equal(block.index, 1);
  assert.equal(getBalance(a.address), 100);
  assert.deepEqual(state.txStatus.get(faucet.hash), { status: 'confirmed', block: 1 });
  assert.equal(state.nonces.get(SYSTEM.SISTEMA), 1);
  assert.equal(getBalance(SYSTEM.SISTEMA), Infinity);
  assert.equal(state.mempool.length, 0);
});

test('block meets difficulty and links to previous hash', async () => {
  await makeWallet('Alice');
  const prev = state.chain[0];
  const block = mineBlock();
  assert.ok(block.hash.startsWith('0'.repeat(getDifficulty())));
  assert.equal(block.difficulty, getDifficulty());
  assert.equal(block.prevHash, prev.hash);
});

test('at most MAX_TXS_PER_BLOCK txs per block', () => {
  for (let i = 0; i < MAX_TXS_PER_BLOCK + 3; i++) {
    state.mempool.push(createSystemTx(SYSTEM.PRESENTADOR, 1));
  }
  assert.equal(mineBlock().txs.length, MAX_TXS_PER_BLOCK);
  assert.equal(state.mempool.length, 3);
});

test('regular transfers move funds and emit events', async () => {
  const a = await makeWallet('Alice');
  const b = await makeWallet('Bob');
  mineBlock();
  const tx = await makeTx(a, { to: b.address, amount: 30 });
  assert.equal(submitTx(tx).ok, true);
  const confirmed = [];
  events.on('tx:confirmed', (t, i) => confirmed.push([t.hash, i]));
  mineBlock();
  events.removeAllListeners('tx:confirmed');
  assert.equal(getBalance(a.address), 70);
  assert.equal(getBalance(b.address), 130);
  assert.deepEqual(confirmed, [[tx.hash, 2]]);
});

test('txs failing at apply stay in the block as failed, nonce still increments', async () => {
  const a = await makeWallet('Alice');
  const b = await makeWallet('Bob');
  mineBlock();
  const noFunds = await makeTx(a, { to: b.address, amount: 50 });
  const withCall = await makeTx(a, { to: b.address, amount: 1, nonce: 1, call: { method: 'x', args: [] } });
  assert.equal(submitTx(noFunds).ok, true);
  assert.equal(submitTx(withCall).ok, true);
  state.balances.set(a.address, 0);
  const failed = [];
  events.on('tx:failed', (t, i, r) => failed.push([t.hash, i, r]));
  const block = mineBlock();
  events.removeAllListeners('tx:failed');
  assert.equal(block.txs.length, 2);
  assert.deepEqual(state.txStatus.get(noFunds.hash), { status: 'failed', block: 2, reason: 'Saldo insuficiente' });
  assert.equal(state.txStatus.get(withCall.hash).reason, 'Contratos no disponibles todavía');
  assert.equal(state.nonces.get(a.address), 2);
  assert.equal(getBalance(a.address), 0);
  assert.equal(failed.length, 2);
});

test('validateChain: all valid on an honest chain', async () => {
  await makeWallet('Alice');
  mineBlock();
  state.mempool.push(createSystemTx(SYSTEM.PRESENTADOR, 5));
  mineBlock();
  const v = validateChain();
  assert.equal(v.length, 3);
  assert.ok(v.every((x) => x.valid && x.reason === null));
});

test('tampering an amount invalidates that block and the next ones', async () => {
  await makeWallet('Alice');
  mineBlock();
  state.mempool.push(createSystemTx(SYSTEM.PRESENTADOR, 5));
  mineBlock();
  state.chain[1].txs[0].amount = 9999;
  const v = validateChain();
  assert.equal(v[0].valid, true);
  assert.deepEqual(v[1], { index: 1, valid: false, reason: 'Hash no coincide' });
  assert.deepEqual(v[2], { index: 2, valid: false, reason: 'Bloque anterior inválido' });
});

test('tampering prevHash is detected', async () => {
  await makeWallet('Alice');
  mineBlock();
  state.chain[1].prevHash = 'f'.repeat(64);
  assert.equal(validateChain()[1].valid, false);
});

test('difficulty is checked using the block own field', async () => {
  await makeWallet('Alice');
  mineBlock();
  const copy = structuredClone(state.chain);
  copy[1].difficulty = 64;
  assert.equal(validateChain(copy)[1].reason, 'No cumple la dificultad');
});

test('mine interval setter restarts a running timer', () => {
  const old = getMineInterval();
  startMiner();
  setMineInterval(50);
  assert.equal(getMineInterval(), 50);
  stopMiner();
  setMineInterval(old);
});

// --- animated mining ---
const animated = () => {
  const seen = { start: [], progress: [] };
  const onStart = (e) => seen.start.push(e);
  const onProgress = (e) => seen.progress.push(e);
  events.on('mine:start', onStart);
  events.on('mine:progress', onProgress);
  return { seen, off: () => { events.off('mine:start', onStart); events.off('mine:progress', onProgress); } };
};

test('mineBlockAnimated mines a valid block and emits start/progress', async () => {
  setDifficulty(5); // ~1M hashes expected, so many batches (progress is practically certain)
  try {
    await makeWallet('Alice');
    const { seen, off } = animated();
    const block = await mineBlockAnimated();
    off();
    assert.equal(block.index, 1);
    assert.ok(validateChain().every((v) => v.valid));
    assert.equal(state.mempool.length, 0);
    assert.deepEqual(seen.start, [{ index: 1, difficulty: 5, txCount: 1 }]);
    assert.ok(seen.progress.length > 0);
    assert.ok(seen.progress.every((p) => p.index === 1 && typeof p.nonce === 'number' && p.hash.length === 64));
    assert.equal(isMining(), false);
  } finally { setDifficulty(2); }
});

test('concurrent animated runs mine only once', async () => {
  setDifficulty(3);
  try {
    await makeWallet('Alice');
    const [a, b, c] = await Promise.all([mineBlockAnimated(), mineBlockAnimated(), mineNow()]);
    assert.ok(a);
    assert.equal(b, null);
    assert.equal(c, null);
    assert.equal(state.chain.length, 2);
  } finally { setDifficulty(2); }
});

test('tx submitted during mining stays in the mempool with a correct nonce', async () => {
  setDifficulty(5); // long enough that the run is still going when the tx arrives
  try {
    const a = await makeWallet('Alice');
    const b = await makeWallet('Bob');
    mineBlock(); // confirm faucet txs
    assert.equal((await submitTx(await makeTx(a, { to: b.address, nonce: 0 }))).ok, true);
    const mining = mineBlockAnimated();
    assert.equal(isMining(), true);
    const second = await makeTx(a, { to: b.address, amount: 5, nonce: 1 });
    assert.equal((await submitTx(second)).ok, true);
    const block = await mining;
    assert.equal(block.txs.length, 1);
    assert.deepEqual(state.mempool.map((t) => t.hash), [second.hash]);
    assert.equal(state.nonces.get(a.address), 1);
    assert.equal(state.txStatus.get(second.hash).status, 'pending');
  } finally { setDifficulty(2); }
});

test('reset during animated mining aborts quietly', async () => {
  setDifficulty(5);
  try {
    await makeWallet('Alice');
    const run = mineBlockAnimated();
    reset();
    assert.equal(await run, null);
    assert.equal(state.chain.length, 1);
    assert.equal(isMining(), false);
  } finally { setDifficulty(2); }
});
