import test from 'node:test';
import assert from 'node:assert/strict';
import * as wc from '../public/shared/wallet-crypto.js';
import { signedPayload } from '../public/shared/canonical.js';
import {
  addressFromPubKey, verifyTxSignature, computeTxHash, computeBlockHash,
} from '../server/crypto.js';

async function makeSignedTx(overrides = {}) {
  const { publicKey, privateKey } = await wc.generateKeyPair();
  const pubKey = await wc.exportPublicKeyHex(publicKey);
  const partial = await wc.buildTx({ to: '0xabcdef012345', amount: 10, nonce: 0, pubKey, ...overrides });
  return { tx: await wc.signTx(privateKey, partial), pubKey, privateKey };
}

test('pubKey is 65-byte raw uncompressed hex', async () => {
  const { pubKey } = await makeSignedTx();
  assert.match(pubKey, /^04[0-9a-f]{128}$/);
});

test('client signature verifies on server', async () => {
  const { tx } = await makeSignedTx();
  assert.equal(verifyTxSignature(tx), true);
});

test('client and server derive the same address', async () => {
  const { tx, pubKey } = await makeSignedTx();
  const a = await wc.addressFromPubKeyHex(pubKey);
  assert.equal(a, addressFromPubKey(pubKey));
  assert.equal(tx.from, a);
  assert.match(a, /^0x[0-9a-f]{12}$/);
});

test('contract call is part of the signed content', async () => {
  const { tx } = await makeSignedTx({ call: { method: 'vote', args: ['a', 1] } });
  assert.equal(verifyTxSignature(tx), true);
  assert.equal(verifyTxSignature({ ...tx, call: { method: 'vote', args: ['b', 1] } }), false);
});

test('altering amount, to, nonce or signature invalidates', async () => {
  const { tx } = await makeSignedTx();
  assert.equal(verifyTxSignature({ ...tx, amount: 11 }), false);
  assert.equal(verifyTxSignature({ ...tx, to: '0x000000000000' }), false);
  assert.equal(verifyTxSignature({ ...tx, nonce: 1 }), false);
  const flipped = (tx.signature[0] === '0' ? '1' : '0') + tx.signature.slice(1);
  assert.equal(verifyTxSignature({ ...tx, signature: flipped }), false);
});

test('verifyTxSignature never throws on garbage', () => {
  assert.equal(verifyTxSignature({}), false);
  assert.equal(verifyTxSignature({ pubKey: 'zz', signature: 'SISTEMA' }), false);
  assert.equal(verifyTxSignature({ pubKey: '', signature: '' }), false);
});

test('signature from another key fails', async () => {
  const a = await makeSignedTx();
  const b = await makeSignedTx();
  assert.equal(verifyTxSignature({ ...a.tx, pubKey: b.pubKey }), false);
});

test('hash computed by client matches server recompute', async () => {
  const { tx } = await makeSignedTx();
  assert.equal(computeTxHash(tx), tx.hash);
  assert.equal(await wc.sha256HexAsync(signedPayload(tx) + '|' + tx.signature), tx.hash);
});

test('private JWK export/import round-trips and still signs', async () => {
  const { publicKey, privateKey } = await wc.generateKeyPair();
  const pubKey = await wc.exportPublicKeyHex(publicKey);
  const restored = await wc.importPrivateJwk(await wc.exportPrivateJwk(privateKey));
  const tx = await wc.signTx(restored, await wc.buildTx({ to: '0xabcdef012345', amount: 1, nonce: 0, pubKey }));
  assert.equal(verifyTxSignature(tx), true);
});

test('block hash changes when a tx amount changes', async () => {
  const { tx } = await makeSignedTx();
  const block = { index: 1, prevHash: '0'.repeat(64), timestamp: 1, txs: [tx], nonce: 5 };
  const h = computeBlockHash(block);
  assert.equal(computeBlockHash(block), h);
  assert.notEqual(computeBlockHash({ ...block, txs: [{ ...tx, amount: tx.amount + 1 }] }), h);
});
