import './helpers/no-mine-pause.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as wc from '../public/shared/wallet-crypto.js';
import { state, events, reset, registerWallet, getBalance } from '../server/state.js';
import { buildFullState, buildWalletState } from '../server/sync.js';
import { submitTx } from '../server/validator.js';
import { mineBlock, setDifficulty } from '../server/miner.js';
import {
  registerContract, isContract, getContract, executeTx, getLogs, getInternalTransfers, contractsView, contractsViewFor,
} from '../server/contracts/engine.js';

setDifficulty(2);

// Throwaway contracts: A is the main one, B is called/paid by A.
registerContract({
  address: '0xTESTA', name: 'ContratoA',
  init: () => ({ n: 0, received: [] }),
  methods: {
    inc(ctx) { ctx.storage.n++; ctx.log(`n=${ctx.storage.n}`); },
    boom(ctx) { ctx.storage.n = 99; ctx.log('no deberia verse'); throw new Error('Explotó'); },
    pay(ctx, to, amount) { ctx.storage.n++; ctx.transfer(to, amount); },
    payB(ctx, amount) { ctx.transfer('0xTESTB', amount); },
    callB(ctx, amount) { return ctx.call('0xTESTB', 'echo', ['hola'], amount); },
    loop(ctx) { ctx.storage.n++; ctx.call('0xTESTA', 'loop'); },
  },
  onReceive(ctx) { ctx.storage.received.push({ sender: ctx.sender, value: ctx.value }); },
  view: (s) => ({ n: s.n }),
  viewFor: (s, addr) => ({ addr }),
  active: (s) => s.n > 0,
});
registerContract({
  address: '0xTESTB', name: 'ContratoB',
  init: () => ({ got: [] }),
  methods: { echo(ctx, msg) { ctx.storage.got.push({ msg, sender: ctx.sender, origin: ctx.origin, value: ctx.value }); return msg + '!'; } },
  onReceive(ctx) { ctx.storage.got.push({ recv: true, sender: ctx.sender, value: ctx.value }); },
  view: (s) => ({ got: s.got.length }),
  active: () => true,
});

async function makeWallet(nick, balance = 100) {
  const kp = await wc.generateKeyPair();
  const pubKey = await wc.exportPublicKeyHex(kp.publicKey);
  const { account } = registerWallet(nick, pubKey);
  state.balances.set(account.address, balance);
  state.mempool.length = 0; // drop the faucet tx
  return { priv: kp.privateKey, pubKey, address: account.address, nonce: 0 };
}

async function send(w, to, amount, call) {
  const partial = await wc.buildTx({ from: w.address, to, amount, nonce: w.nonce, call, pubKey: w.pubKey });
  const tx = await wc.signTx(w.priv, partial);
  const res = submitTx(tx);
  assert.equal(res.ok, true, res.reason);
  w.nonce++;
  return tx;
}

const A = () => getContract('0xTESTA').storage;
const B = () => getContract('0xTESTB').storage;
const status = (tx) => state.txStatus.get(tx.hash);

let alice;
beforeEach(async () => {
  reset();
  alice = await makeWallet('Alice');
});

test('contracts are registered as system accounts', () => {
  assert.equal(isContract('0xTESTA'), true);
  assert.equal(isContract(alice.address), false);
  assert.deepEqual(state.accounts.get('0xTESTA'), { address: '0xTESTA', nick: 'ContratoA', pubKey: '', system: true, contract: true });
  assert.equal(getBalance('0xTESTA'), 0);
});

test('a call is executed at mining, not at submission', async () => {
  const tx = await send(alice, '0xTESTA', 5, { method: 'inc', args: [] });
  assert.equal(A().n, 0);
  assert.equal(getBalance(alice.address), 100);
  assert.deepEqual(status(tx), { status: 'pending' });
  mineBlock();
  assert.equal(A().n, 1);
  assert.equal(getBalance(alice.address), 95);
  assert.equal(getBalance('0xTESTA'), 5);
  assert.equal(status(tx).status, 'confirmed');
});

test('a throwing method reverts balances and storage, tx fails with the reason', async () => {
  const tx = await send(alice, '0xTESTA', 5, { method: 'boom', args: [] });
  mineBlock();
  assert.deepEqual(status(tx), { status: 'failed', block: 1, reason: 'Explotó' });
  assert.equal(A().n, 0);
  assert.equal(getBalance(alice.address), 100);
  assert.equal(getBalance('0xTESTA'), 0);
  assert.equal(state.nonces.get(alice.address), 1);
});

test('unknown method fails and refunds', async () => {
  const tx = await send(alice, '0xTESTA', 5, { method: 'nope', args: [] });
  mineBlock();
  assert.equal(status(tx).reason, 'Método desconocido: nope');
  assert.equal(getBalance(alice.address), 100);
});

test('transfer to a contract runs its onReceive; nested call passes sender/value', async () => {
  await send(alice, '0xTESTA', 20, { method: 'payB', args: [7] });
  mineBlock();
  assert.deepEqual(B().got, [{ recv: true, sender: '0xTESTA', value: 7 }]);
  assert.equal(getBalance('0xTESTB'), 7);
  assert.equal(getBalance('0xTESTA'), 13);
  await send(alice, '0xTESTA', 10, { method: 'callB', args: [4] });
  mineBlock();
  assert.deepEqual(B().got[1], { msg: 'hola', sender: '0xTESTA', origin: alice.address, value: 4 });
  assert.equal(getBalance('0xTESTB'), 11);
  assert.deepEqual(A().received, []); // direct calls with a method do not run onReceive
});

test('plain coins to a contract trigger onReceive', async () => {
  await send(alice, '0xTESTA', 3);
  mineBlock();
  assert.deepEqual(A().received, [{ sender: alice.address, value: 3 }]);
  assert.equal(getBalance('0xTESTA'), 3);
});

test('transfer beyond the contract balance reverts everything', async () => {
  const tx = await send(alice, '0xTESTA', 2, { method: 'pay', args: [alice.address, 50] });
  mineBlock();
  assert.equal(status(tx).reason, 'Saldo insuficiente del contrato');
  assert.equal(A().n, 0);
  assert.equal(getBalance(alice.address), 100);
});

test('internal transfers are recorded only on success', async () => {
  await send(alice, '0xTESTA', 10, { method: 'pay', args: [alice.address, 4] });
  mineBlock();
  const [t] = getInternalTransfers();
  assert.equal(t.from, '0xTESTA');
  assert.equal(t.to, alice.address);
  assert.equal(t.amount, 4);
  assert.equal(getBalance(alice.address), 94);
  await send(alice, '0xTESTA', 1, { method: 'pay', args: [alice.address, 500] });
  mineBlock();
  assert.equal(getInternalTransfers().length, 1);
});

test('infinite recursion fails with the depth reason and fully reverts', async () => {
  const tx = await send(alice, '0xTESTA', 5, { method: 'loop', args: [] });
  mineBlock();
  assert.equal(status(tx).status, 'failed');
  assert.equal(status(tx).reason, 'Profundidad máxima de llamadas (200)');
  assert.equal(A().n, 0);
  assert.equal(getBalance(alice.address), 100);
});

test('logs appear only on success; a revert adds "Revertido"', async () => {
  const emitted = [];
  const onLog = (e) => emitted.push(e);
  events.on('contract:log', onLog);
  try {
    const ok = await send(alice, '0xTESTA', 0, { method: 'inc', args: [] });
    await send(alice, '0xTESTA', 0, { method: 'boom', args: [] });
    mineBlock();
    const logs = getLogs();
    assert.deepEqual(logs.map((l) => l.message), ['n=1', 'Revertido: Explotó']);
    assert.equal(logs[0].contract, '0xTESTA');
    assert.equal(logs[0].tx, ok.hash);
    assert.equal(logs[0].block, 1);
    assert.equal(emitted.length, 2);
  } finally {
    events.off('contract:log', onLog);
  }
});

test('executor receives block time and index', async () => {
  const seen = [];
  registerContract({
    address: '0xTESTT', name: 'Tiempo', init: () => ({}),
    methods: { now(ctx) { seen.push(ctx.time); } }, view: () => ({}), active: () => false,
  });
  await send(alice, '0xTESTT', 0, { method: 'now', args: [] });
  const block = mineBlock();
  assert.deepEqual(seen, [block.timestamp]);
});

test('call to a non-contract fails in executeTx', () => {
  const r = executeTx({ from: alice.address, to: alice.address, amount: 0, call: { method: 'x', args: [] }, hash: 'h' }, { time: 0, block: 1 });
  assert.deepEqual(r, { ok: false, reason: 'El destinatario no es un contrato' });
});

test('views: contractsView and contractsViewFor', async () => {
  await send(alice, '0xTESTA', 0, { method: 'inc', args: [] });
  mineBlock();
  const a = contractsView().find((c) => c.address === '0xTESTA');
  assert.deepEqual(a, { address: '0xTESTA', name: 'ContratoA', balance: 0, active: true, view: { n: 1 } });
  const mine = contractsViewFor(alice.address).find((c) => c.address === '0xTESTA');
  assert.deepEqual(mine.me, { addr: alice.address });
});

test('reset gives contracts fresh storage and keeps their accounts', async () => {
  await send(alice, '0xTESTA', 3, { method: 'inc', args: [] });
  mineBlock();
  assert.equal(A().n, 1);
  reset();
  assert.equal(A().n, 0);
  assert.equal(getLogs().length, 0);
  assert.equal(getInternalTransfers().length, 0);
  assert.equal(state.accounts.get('0xTESTA').contract, true);
  assert.equal(getBalance('0xTESTA'), 0);
});

test('sync: full state exposes contracts and logs; wallet history has calls and internal items', async () => {
  await send(alice, '0xTESTA', 10, { method: 'pay', args: [alice.address, 4] });
  mineBlock();
  const full = buildFullState();
  assert.equal(full.contracts.find((c) => c.address === '0xTESTA').name, 'ContratoA');
  assert.equal(full.accounts.find((a) => a.address === '0xTESTA').contract, true);
  assert.ok(Array.isArray(full.contractLogs));
  const w = buildWalletState(alice.address);
  assert.equal(w.contracts.find((c) => c.address === '0xTESTA').me.addr, alice.address);
  assert.equal(w.history.find((h) => h.call).call.method, 'pay');
  const internal = w.history.find((h) => h.internal);
  assert.equal(internal.amount, 4);
  assert.equal(internal.fromNick, 'ContratoA');
  assert.match(internal.hash, /^int-/);
});
