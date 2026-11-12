import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as wc from '../public/shared/wallet-crypto.js';
import { state, events, SYSTEM, reset, registerWallet } from '../server/state.js';
import { validateTx, submitTx } from '../server/validator.js';

async function makeWallet(nick, balance = 0) {
  const kp = await wc.generateKeyPair();
  const pubKey = await wc.exportPublicKeyHex(kp.publicKey);
  const { account } = registerWallet(nick, pubKey);
  state.balances.set(account.address, balance);
  return { priv: kp.privateKey, pubKey, address: account.address };
}

async function makeTx(w, { to, amount = 10, nonce = 0, call } = {}) {
  const partial = await wc.buildTx({ from: w.address, to, amount, nonce, call, pubKey: w.pubKey });
  return wc.signTx(w.priv, partial);
}

let alice, bob;
beforeEach(async () => {
  reset();
  alice = await makeWallet('Alice', 100);
  bob = await makeWallet('Bob');
});

const reason = (tx) => validateTx(tx).reason;

test('accepts a valid tx', async () => {
  assert.deepEqual(validateTx(await makeTx(alice, { to: bob.address })), { ok: true });
});

test('malformed objects return ok:false without throwing', async () => {
  for (const bad of [null, undefined, 5, 'x', {}, { from: 'a' }]) assert.equal(validateTx(bad).ok, false);
  assert.equal(reason(null), 'Transacción mal formada');
  const tx = await makeTx(alice, { to: bob.address });
  assert.equal(reason({ ...tx, call: { method: 'x' } }), 'Transacción mal formada');
  assert.equal(reason({ ...tx, call: 'nope' }), 'Transacción mal formada');
  assert.equal(submitTx(null).ok, false);
});

test('rejects invalid amounts', async () => {
  for (const amount of [0, -5, 1.5, '10', NaN, Infinity]) {
    assert.equal(reason(await makeTx(alice, { to: bob.address, amount })), 'Monto inválido');
  }
});

test('rejects unknown recipient and self-send', async () => {
  assert.equal(reason(await makeTx(alice, { to: '0xdeadbeef0000' })), 'Destinatario desconocido');
  assert.equal(reason(await makeTx(alice, { to: alice.address })), 'No puedes enviarte a ti mismo');
});

test('rejects system accounts as sender', async () => {
  const tx = await makeTx(alice, { to: bob.address });
  assert.equal(validateTx({ ...tx, from: SYSTEM.SISTEMA }).ok, false);
  assert.equal(validateTx({ ...tx, from: SYSTEM.HACKER }).ok, false);
});

test('rejects address not matching pubKey', async () => {
  const tx = await makeTx(alice, { to: bob.address });
  assert.equal(reason({ ...tx, pubKey: bob.pubKey }), 'La dirección no corresponde a la llave pública');
});

test('rejects tampered fields as invalid signature', async () => {
  const tx = await makeTx(alice, { to: bob.address });
  assert.equal(reason({ ...tx, amount: 99 }), 'Firma inválida');
  assert.equal(reason({ ...tx, nonce: 5 }), 'Firma inválida');
});

test('rejects signature by another key', async () => {
  const partial = await wc.buildTx({ from: alice.address, to: bob.address, amount: 5, nonce: 0, pubKey: alice.pubKey });
  const tx = await wc.signTx(bob.priv, partial);
  assert.equal(reason(tx), 'Firma inválida');
});

test('rejects hash mismatch', async () => {
  const tx = await makeTx(alice, { to: bob.address });
  assert.equal(reason({ ...tx, hash: 'ab'.repeat(32) }), 'Hash no coincide');
});

test('rejects duplicates (pending and confirmed)', async () => {
  const tx = await makeTx(alice, { to: bob.address });
  assert.equal(submitTx(tx).ok, true);
  assert.equal(reason(tx), 'Transacción duplicada');
  state.mempool.length = 0; // pretend mined: still known via txStatus
  assert.equal(reason(tx), 'Transacción duplicada');
});

test('rejects wrong nonce with expected value', async () => {
  assert.equal(reason(await makeTx(alice, { to: bob.address, nonce: 3 })), 'Nonce incorrecto (esperado 0)');
  state.nonces.set(alice.address, 2);
  assert.equal(reason(await makeTx(alice, { to: bob.address, nonce: 0 })), 'Nonce incorrecto (esperado 2)');
});

test('rejects insufficient balance', async () => {
  assert.equal(reason(await makeTx(alice, { to: bob.address, amount: 101 })), 'Saldo insuficiente');
  assert.equal(reason(await makeTx(bob, { to: alice.address, amount: 1 })), 'Saldo insuficiente');
});

test('consecutive nonces 0 and 1 are both accepted (pending counted)', async () => {
  assert.equal(submitTx(await makeTx(alice, { to: bob.address, amount: 10, nonce: 0 })).ok, true);
  assert.equal(submitTx(await makeTx(alice, { to: bob.address, amount: 10, nonce: 1 })).ok, true);
  assert.equal(state.mempool.filter((t) => t.from === alice.address).length, 2);
});

test('second tx exceeding available (confirmed - pending) is rejected', async () => {
  assert.equal(submitTx(await makeTx(alice, { to: bob.address, amount: 70, nonce: 0 })).ok, true);
  const r = submitTx(await makeTx(alice, { to: bob.address, amount: 40, nonce: 1 }));
  assert.deepEqual(r, { ok: false, reason: 'Saldo insuficiente' });
  assert.equal(submitTx(await makeTx(alice, { to: bob.address, amount: 30, nonce: 1 })).ok, true);
});

test('tx with well-formed call passes validation', async () => {
  const tx = await makeTx(alice, { to: bob.address, call: { method: 'vote', args: [1] } });
  assert.equal(validateTx(tx).ok, true);
});

test('submitTx adds to mempool, marks pending and emits events', async () => {
  const added = [];
  let changed = 0;
  const onAdd = (t) => added.push(t);
  const onChanged = () => changed++;
  events.on('mempool:add', onAdd);
  events.on('state:changed', onChanged);
  try {
    const tx = await makeTx(alice, { to: bob.address });
    assert.deepEqual(submitTx(tx), { ok: true });
    assert.ok(state.mempool.includes(tx));
    assert.deepEqual(state.txStatus.get(tx.hash), { status: 'pending' });
    assert.deepEqual(added, [tx]);
    assert.equal(changed, 1);
  } finally {
    events.off('mempool:add', onAdd);
    events.off('state:changed', onChanged);
  }
});

test('rejected submitTx leaves mempool untouched', async () => {
  const before = state.mempool.length;
  const r = submitTx(await makeTx(alice, { to: bob.address, amount: 0 }));
  assert.equal(r.ok, false);
  assert.equal(state.mempool.length, before);
});
