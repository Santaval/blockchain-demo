import './helpers/no-mine-pause.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as wc from '../public/shared/wallet-crypto.js';
import { state, reset, registerWallet, getBalance, createSystemTx, SYSTEM } from '../server/state.js';
import { submitTx } from '../server/validator.js';
import { mineBlock, setDifficulty } from '../server/miner.js';
import { getContract, contractsViewFor } from '../server/contracts/engine.js';
import '../server/contracts/index.js';
import { openAuction, pushCloseTx, AUCTION } from '../server/contracts/auction.js';

setDifficulty(2);

async function makeWallet(nick, balance = 100) {
  const kp = await wc.generateKeyPair();
  const pubKey = await wc.exportPublicKeyHex(kp.publicKey);
  const { account } = registerWallet(nick, pubKey);
  state.balances.set(account.address, balance);
  state.mempool.length = 0;
  return { priv: kp.privateKey, pubKey, address: account.address, nonce: 0 };
}

async function bid(w, amount) {
  const partial = await wc.buildTx({ from: w.address, to: AUCTION, amount, nonce: w.nonce, call: { method: 'ofertar', args: [] }, pubKey: w.pubKey });
  const tx = await wc.signTx(w.priv, partial);
  const res = submitTx(tx);
  assert.equal(res.ok, true, res.reason);
  w.nonce++;
  return tx;
}

const S = () => getContract(AUCTION).storage;
const status = (tx) => state.txStatus.get(tx.hash);
const closeTx = (from) => {
  const tx = createSystemTx(AUCTION, 0, { from, call: { method: 'cerrar', args: [] } });
  state.mempool.push(tx);
  state.txStatus.set(tx.hash, { status: 'pending' });
  return tx;
};
let ana, beto;

beforeEach(async () => {
  reset(); // also clears a pending close timer
  ana = await makeWallet('Ana');
  beto = await makeWallet('Beto');
  assert.deepEqual(openAuction({ item: 'Camiseta', seconds: 60 }), { ok: true });
});

test('a higher bid refunds only the previous bidder', async () => {
  const t1 = await bid(ana, 10);
  mineBlock();
  assert.equal(status(t1).status, 'confirmed');
  assert.equal(getBalance(AUCTION), 10);
  const t2 = await bid(beto, 15);
  mineBlock();
  assert.equal(status(t2).status, 'confirmed');
  assert.equal(getBalance(ana.address), 100);
  assert.equal(getBalance(beto.address), 85);
  assert.equal(getBalance(AUCTION), 15);
  assert.equal(S().highest.nick, 'Beto');
  assert.deepEqual(S().refunds, [{ nick: 'Ana', amount: 10 }]);
  assert.equal(S().bids.length, 2);
  assert.equal(contractsViewFor(beto.address).find((c) => c.address === AUCTION).me.isHighest, true);
  assert.equal(contractsViewFor(ana.address).find((c) => c.address === AUCTION).me.isHighest, false);
});

test('a lower or equal bid fails and is refunded by the revert', async () => {
  await bid(ana, 20);
  mineBlock();
  const low = await bid(beto, 20);
  mineBlock();
  assert.equal(status(low).status, 'failed');
  assert.equal(status(low).reason, 'La oferta debe superar 20');
  assert.equal(getBalance(beto.address), 100);
  assert.equal(getBalance(AUCTION), 20);
  assert.equal(S().highest.nick, 'Ana');
});

test('a bid mined after endsAt fails even if submitted before', async () => {
  const tx = await bid(ana, 10);
  S().endsAt = Date.now() - 1000; // block time is past the end by the time it is mined
  mineBlock();
  assert.equal(status(tx).reason, 'Subasta cerrada');
  assert.equal(getBalance(ana.address), 100);
  assert.equal(S().highest, null);
});

test('cerrar pays the presenter and records the winner', async () => {
  await bid(ana, 30);
  mineBlock();
  S().endsAt = Date.now() - 1000;
  const tx = closeTx(SYSTEM.SISTEMA);
  mineBlock();
  assert.equal(status(tx).status, 'confirmed');
  assert.equal(getBalance(SYSTEM.PRESENTADOR), 30);
  assert.equal(getBalance(AUCTION), 0);
  assert.equal(S().open, false);
  assert.equal(S().winner.nick, 'Ana');
  const late = await bid(beto, 50);
  mineBlock();
  assert.equal(status(late).reason, 'Subasta cerrada');
});

test('cerrar fails for non-system callers and before the end', async () => {
  const early = closeTx(SYSTEM.SISTEMA);
  mineBlock();
  assert.equal(status(early).reason, 'Todavía no termina');
  assert.equal(S().open, true);
  S().endsAt = Date.now() - 1000;
  const partial = await wc.buildTx({ from: ana.address, to: AUCTION, amount: 0, nonce: ana.nonce, call: { method: 'cerrar', args: [] }, pubKey: ana.pubKey });
  const tx = await wc.signTx(ana.priv, partial);
  assert.equal(submitTx(tx).ok, true);
  mineBlock();
  assert.equal(status(tx).reason, 'Solo el sistema puede cerrar');
  assert.equal(S().open, true);
});

test('open validates input and is refused while open', () => {
  S().open = false;
  assert.equal(openAuction({ item: '', seconds: 60 }).ok, false);
  assert.equal(openAuction({ item: 'x'.repeat(61), seconds: 60 }).ok, false);
  assert.equal(openAuction({ item: 'x', seconds: 14 }).ok, false);
  assert.equal(openAuction({ item: 'x', seconds: 601 }).ok, false);
  assert.equal(openAuction({ item: 'x', seconds: 15 }).ok, true);
  assert.equal(openAuction({ item: 'y', seconds: 60 }).ok, false); // already open
});

test('the scheduled close pushes a system cerrar tx into the mempool', async () => {
  let added = null;
  const onAdd = (tx) => { added = tx; };
  const { events } = await import('../server/state.js');
  events.on('mempool:add', onAdd);
  state.mempool.length = 0;
  pushCloseTx();
  events.off('mempool:add', onAdd);
  assert.equal(added.to, AUCTION);
  assert.equal(added.from, SYSTEM.SISTEMA);
  assert.deepEqual(added.call, { method: 'cerrar', args: [] });
  assert.equal(state.mempool.length, 1);
  assert.equal(status(added).status, 'pending');
});

test('reset gives fresh storage and cancels the close timer', () => {
  reset();
  assert.deepEqual(S(), { item: '', endsAt: 0, open: false, highest: null, bids: [], refunds: [], winner: null });
  assert.equal(state.accounts.get(AUCTION).contract, true);
});
