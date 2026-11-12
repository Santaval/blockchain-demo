import './helpers/no-mine-pause.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as wc from '../public/shared/wallet-crypto.js';
import { state, reset, registerWallet, getBalance, SYSTEM } from '../server/state.js';
import { submitTx } from '../server/validator.js';
import { mineBlock, setDifficulty } from '../server/miner.js';
import { getContract, getLogs } from '../server/contracts/engine.js';
import '../server/contracts/index.js';
import { BANK, seedBank } from '../server/contracts/bank.js';
import { ATTACKER, setAttackEnabled, launchAttack } from '../server/contracts/attacker.js';

setDifficulty(2);

async function makeWallet(nick, balance = 100) {
  const kp = await wc.generateKeyPair();
  const pubKey = await wc.exportPublicKeyHex(kp.publicKey);
  const { account } = registerWallet(nick, pubKey);
  state.balances.set(account.address, balance);
  state.mempool.length = 0;
  return { priv: kp.privateKey, pubKey, address: account.address, nonce: 0 };
}

async function call(w, to, method, amount = 0) {
  const partial = await wc.buildTx({ from: w.address, to, amount, nonce: w.nonce, call: { method, args: [] }, pubKey: w.pubKey });
  const tx = await wc.signTx(w.priv, partial);
  const res = submitTx(tx);
  assert.equal(res.ok, true, res.reason);
  w.nonce++;
  return tx;
}

const status = (tx) => state.txStatus.get(tx.hash);
const deposits = () => getContract(BANK).storage.deposits;
let ana, beto, carla;

beforeEach(async () => {
  reset();
  ana = await makeWallet('Ana');
  beto = await makeWallet('Beto');
  carla = await makeWallet('Carla');
});

async function fundBank() {
  await call(ana, BANK, 'depositar', 40);
  await call(beto, BANK, 'depositar', 40);
  mineBlock();
}

test('normal deposit and withdraw', async () => {
  const d = await call(ana, BANK, 'depositar', 30);
  mineBlock();
  assert.equal(status(d).status, 'confirmed');
  assert.equal(getBalance(BANK), 30);
  assert.equal(getBalance(ana.address), 70);
  assert.equal(deposits()[ana.address], 30);
  const w = await call(ana, BANK, 'retirar');
  mineBlock();
  assert.equal(status(w).status, 'confirmed');
  assert.equal(getBalance(ana.address), 100);
  assert.equal(getBalance(BANK), 0);
  assert.equal(deposits()[ana.address], 0);
  assert.ok(getLogs().some((l) => /^Retiro de Ana: 30 · quedan 0$/.test(l.message)));
});

test('retirar without deposit and depositar without coins fail', async () => {
  const w = await call(ana, BANK, 'retirar');
  const d = await call(beto, BANK, 'depositar', 0);
  mineBlock();
  assert.equal(status(w).reason, 'No tienes depósito');
  assert.equal(status(d).status, 'failed');
});

test('attack drains the bank in rounds and the owner keeps the loot', async () => {
  await fundBank(); // bank holds 80 from others
  setAttackEnabled(true);
  const tx = await call(carla, ATTACKER, 'atacar', 20);
  mineBlock();
  assert.equal(status(tx).status, 'confirmed', status(tx).reason);
  const a = getContract(ATTACKER).storage;
  assert.equal(a.rounds, 4); // 100 -> 80 -> 60 -> 40 -> 20 -> 0, one outer withdraw + 4 reentries
  assert.ok(a.rounds <= 30);
  assert.equal(getBalance(BANK), 0);
  assert.equal(a.lastLoot, 100);
  assert.equal(getBalance(carla.address), 180); // 100 - 20 deposit + 100 loot
  assert.equal(getBalance(ATTACKER), 0);
  assert.ok(getLogs().some((l) => l.message.startsWith('Reentrada #1 ')));
  // the honest depositors lost their money: later withdrawals fail
  const w = await call(ana, BANK, 'retirar');
  mineBlock();
  assert.equal(status(w).status, 'failed');
  assert.equal(status(w).reason, 'Saldo insuficiente del contrato');
  assert.equal(getBalance(ana.address), 60);
});

test('attack stops at 30 rounds when the bank is much bigger', async () => {
  await call(ana, BANK, 'depositar', 100);
  await call(beto, BANK, 'depositar', 100);
  mineBlock();
  for (let i = 0; i < 4; i++) state.balances.set(BANK, getBalance(BANK) + 100); // 600 in the bank
  setAttackEnabled(true);
  const tx = await call(carla, ATTACKER, 'atacar', 1);
  mineBlock();
  assert.equal(status(tx).status, 'confirmed', status(tx).reason);
  assert.equal(getContract(ATTACKER).storage.rounds, 30);
  assert.equal(getBalance(BANK), 601 - 31);
});

test('a disabled attack fails for wallets and is refunded', async () => {
  const tx = await call(carla, ATTACKER, 'atacar', 20);
  mineBlock();
  assert.equal(status(tx).reason, 'Ataque deshabilitado');
  assert.equal(getBalance(carla.address), 100);
  assert.equal(getBalance(ATTACKER), 0);
});

test('admin attack from HACKER works with the button disabled, funding tx and call in the same block', async () => {
  await fundBank();
  assert.equal(getContract(ATTACKER).storage.enabled, false);
  assert.deepEqual(launchAttack({ amount: 20 }), { ok: true });
  assert.equal(state.mempool.length, 2);
  assert.equal(state.mempool[0].from, SYSTEM.SISTEMA);
  assert.equal(state.mempool[0].to, SYSTEM.HACKER);
  assert.equal(state.mempool[1].from, SYSTEM.HACKER);
  assert.equal(state.mempool[1].to, ATTACKER);
  mineBlock();
  for (const tx of state.chain.at(-1).txs) assert.equal(status(tx).status, 'confirmed', status(tx).reason);
  assert.equal(getBalance(BANK), 0);
  assert.equal(getBalance(SYSTEM.HACKER), 100); // 80 stolen from others + own 20 back
  // a second launch does not need funding when HACKER already has the coins
  launchAttack({ amount: 20 });
  assert.equal(state.mempool.length, 1);
});

test('admin helpers validate input; bank seed deposits from SISTEMA', () => {
  assert.equal(launchAttack({ amount: 0 }).ok, false);
  assert.equal(launchAttack({ amount: 1001 }).ok, false);
  assert.equal(seedBank({ amount: 0 }).ok, false);
  assert.equal(setAttackEnabled('x').ok, false);
  assert.equal(seedBank({ amount: 50 }).ok, true);
  mineBlock();
  assert.equal(getBalance(BANK), 50);
  assert.equal(deposits()[SYSTEM.SISTEMA], 50);
});

test('reset gives fresh storage', () => {
  setAttackEnabled(true);
  reset();
  assert.deepEqual(getContract(BANK).storage, { deposits: {} });
  assert.equal(getContract(ATTACKER).storage.enabled, false);
});
