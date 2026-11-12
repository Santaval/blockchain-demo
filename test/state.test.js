import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as wc from '../public/shared/wallet-crypto.js';
import { DIFFICULTY, FAUCET_AMOUNT } from '../server/config.js';
import { computeBlockHash } from '../server/crypto.js';
import {
  state, events, SYSTEM, reset, registerWallet, getBalance, pendingOutgoing,
  availableBalance, expectedNonce, findByNick, listNicks, createSystemTx,
} from '../server/state.js';

async function newPubKey() {
  const { publicKey } = await wc.generateKeyPair();
  return wc.exportPublicKeyHex(publicKey);
}

beforeEach(() => reset());

test('genesis block is valid and meets difficulty', () => {
  assert.equal(state.chain.length, 1);
  const g = state.chain[0];
  assert.equal(g.index, 0);
  assert.equal(g.prevHash, '0'.repeat(64));
  assert.equal(g.hash, computeBlockHash(g));
  assert.ok(g.hash.startsWith('0'.repeat(DIFFICULTY)));
});

test('system accounts exist', () => {
  assert.equal(getBalance(SYSTEM.SISTEMA), Infinity);
  assert.equal(getBalance(SYSTEM.PRESENTADOR), 0);
  assert.equal(getBalance(SYSTEM.HACKER), 0);
  assert.equal(findByNick('sistema').address, SYSTEM.SISTEMA);
  assert.deepEqual(listNicks(), []);
});

test('new wallet gets account and pending faucet tx', async () => {
  const added = [];
  const onAdd = (tx) => added.push(tx);
  events.on('mempool:add', onAdd);
  const pubKey = await newPubKey();
  const r = registerWallet('  Ana ', pubKey);
  events.off('mempool:add', onAdd);
  assert.equal(r.ok, true);
  assert.equal(r.isNew, true);
  assert.equal(r.account.nick, 'Ana');
  assert.equal(state.accounts.get(r.account.address).pubKey, pubKey);
  assert.equal(state.mempool.length, 1);
  const tx = state.mempool[0];
  assert.equal(tx.from, SYSTEM.SISTEMA);
  assert.equal(tx.to, r.account.address);
  assert.equal(tx.amount, FAUCET_AMOUNT);
  assert.equal(tx.signature, 'SISTEMA');
  assert.deepEqual(added, [tx]);
  assert.equal(state.txStatus.get(tx.hash).status, 'pending');
  assert.deepEqual(listNicks(), [{ nick: 'Ana', address: r.account.address }]);
});

test('re-register same pubKey returns same account without second faucet', async () => {
  const pubKey = await newPubKey();
  const a = registerWallet('Ana', pubKey);
  const b = registerWallet('Otro', pubKey);
  assert.equal(b.ok, true);
  assert.equal(b.isNew, false);
  assert.equal(b.account.address, a.account.address);
  assert.equal(b.account.nick, 'Ana');
  assert.equal(state.mempool.length, 1);
});

test('duplicate nick (case-insensitive) for a different key is rejected', async () => {
  registerWallet('Ana', await newPubKey());
  const r = registerWallet('ANA', await newPubKey());
  assert.deepEqual(r, { ok: false, reason: 'Ese apodo ya está en uso' });
  assert.equal(state.mempool.length, 1);
});

test('invalid pubKey and bad nick are rejected', async () => {
  assert.equal(registerWallet('Ana', 'zz').ok, false);
  assert.equal(registerWallet('', await newPubKey()).ok, false);
  assert.equal(registerWallet('x'.repeat(21), await newPubKey()).ok, false);
  assert.equal(state.accounts.size, 3);
});

test('availableBalance and expectedNonce account for mempool', async () => {
  const r = registerWallet('Ana', await newPubKey());
  const addr = r.account.address;
  assert.equal(getBalance(addr), 0);
  assert.equal(expectedNonce(SYSTEM.SISTEMA), 1);
  assert.equal(expectedNonce(addr), 0);
  state.balances.set(addr, 50);
  state.mempool.push({ from: addr, to: SYSTEM.PRESENTADOR, amount: 20 });
  state.mempool.push({ from: addr, to: SYSTEM.PRESENTADOR, amount: 5 });
  assert.equal(pendingOutgoing(addr), 25);
  assert.equal(availableBalance(addr), 25);
  assert.equal(expectedNonce(addr), 2);
  assert.equal(createSystemTx(addr, 1).nonce, 1);
});

test('reset clears everything and keeps the state reference', async () => {
  const ref = state;
  const r = registerWallet('Ana', await newPubKey());
  let fired = false;
  events.once('reset', () => { fired = true; });
  reset();
  assert.equal(ref, state);
  assert.ok(fired);
  assert.equal(state.mempool.length, 0);
  assert.equal(state.txStatus.size, 0);
  assert.equal(state.chain.length, 1);
  assert.equal(state.accounts.has(r.account.address), false);
  assert.equal(findByNick('Ana'), undefined);
  assert.equal(expectedNonce(SYSTEM.SISTEMA), 0);
});
