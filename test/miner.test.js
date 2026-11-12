import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as wc from '../public/shared/wallet-crypto.js';
import { MAX_TXS_PER_BLOCK } from '../server/config.js';
import { state, events, SYSTEM, reset, registerWallet, getBalance, createSystemTx } from '../server/state.js';
import { submitTx } from '../server/validator.js';
import { mineBlock, validateChain, setDifficulty, getDifficulty, setMineInterval, getMineInterval, startMiner, stopMiner } from '../server/miner.js';

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
