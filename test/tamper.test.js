import './helpers/no-mine-pause.js';
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as wc from '../public/shared/wallet-crypto.js';
import { state, events, reset, registerWallet } from '../server/state.js';
import { mineBlock, mineBlockAnimated, mineNow, isMining, isTampered, validateChain, setDifficulty, startMiner, stopMiner, isMinerRunning } from '../server/miner.js';
import { tamper, remine, restore } from '../server/tamper.js';

setDifficulty(2);

async function addWallet(nick) {
  const kp = await wc.generateKeyPair();
  registerWallet(nick, await wc.exportPublicKeyHex(kp.publicKey));
}

// Chain with 3 mined blocks (one faucet tx each).
async function buildChain() {
  for (const n of ['Ana', 'Beto', 'Caro']) { await addWallet(n); mineBlock(); }
}
const validFlags = () => validateChain().map((v) => v.valid);
const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); };

beforeEach(() => { reset(); stopMiner(); });
afterEach(() => { stopMiner(); setDifficulty(2); });

test('tampering breaks block k and every later block', async () => {
  await buildChain();
  assert.deepEqual(validFlags(), [true, true, true, true]);
  assert.deepEqual(tamper({ block: 2, tx: 0, amount: 999 }), { ok: true });
  assert.deepEqual(validFlags(), [true, true, false, false]);
  const v = validateChain();
  assert.equal(v[2].reason, 'Hash no coincide');
  assert.equal(v[3].reason, 'Bloque anterior inválido');
});

test('tamper validates its input', async () => {
  await buildChain();
  assert.equal(tamper({ block: 0, tx: 0, amount: 5 }).ok, false);
  assert.equal(tamper({ block: 9, tx: 0, amount: 5 }).ok, false);
  assert.equal(tamper({ block: 1, tx: 5, amount: 5 }).ok, false);
  assert.equal(tamper({ block: 1, tx: 0, amount: 0 }).ok, false);
  assert.equal(tamper({ block: 1, tx: 0, amount: 1.5 }).ok, false);
  assert.equal(isTampered(), false);
});

test('remine makes block k valid but k+1 fails on prevHash; restore gives the original back', async () => {
  await buildChain();
  const original = structuredClone(state.chain);
  tamper({ block: 2, tx: 0, amount: 999 });
  const done = new Promise((r) => events.once('block:remined', r));
  assert.equal(remine({ block: 2 }).ok, true);
  assert.equal(remine({ block: 2 }).ok, false); // already re-mining
  await done;
  assert.deepEqual(validFlags(), [true, true, true, false]);
  assert.equal(validateChain()[3].reason, 'prevHash no coincide con el bloque anterior');

  assert.deepEqual(restore(), { ok: true });
  assert.deepEqual(state.chain, original);
  assert.deepEqual(validFlags(), [true, true, true, true]);
  assert.equal(isTampered(), false);
  assert.equal(restore().ok, false);
});

test('remine requires a tampered chain', async () => {
  await buildChain();
  assert.equal(remine({ block: 1 }).ok, false);
});

test('tampering pauses the miner; restore resumes only if it was running', async () => {
  await buildChain();
  startMiner();
  tamper({ block: 1, tx: 0, amount: 7 });
  assert.equal(isMinerRunning(), false);
  restore();
  assert.equal(isMinerRunning(), true);

  stopMiner();
  tamper({ block: 1, tx: 0, amount: 7 });
  restore();
  assert.equal(isMinerRunning(), false);
});

test('no mining while tampered, and an in-flight run aborts without committing', async () => {
  setDifficulty(5);
  await addWallet('Ana');
  const run = mineBlockAnimated();
  assert.equal(isMining(), true);
  const before = state.chain.length;
  setDifficulty(2);
  mineBlock(); // not tampered yet: confirm to have a block to tamper with
  assert.equal(state.chain.length, before + 1);
  await addWallet('Beto');
  setDifficulty(5);
  const run2 = mineBlockAnimated();
  tamper({ block: 1, tx: 0, amount: 5 });
  assert.equal(await run, null);
  assert.equal(await run2, null);
  assert.equal(state.chain.length, before + 1);
  assert.equal(isMining(), false);
  assert.equal(mineBlock(), null);
  assert.equal(await mineNow(), null);
});

test('reset clears the tamper state', async () => {
  await buildChain();
  tamper({ block: 1, tx: 0, amount: 7 });
  reset();
  assert.equal(isTampered(), false);
  assert.equal(restore().ok, false);
});

test('remine in flight is aborted by restore', async () => {
  await buildChain();
  tamper({ block: 1, tx: 0, amount: 7 });
  setDifficulty(5);
  remine({ block: 1 });
  assert.equal(isMining(), true);
  restore();
  await until(() => !isMining());
  assert.deepEqual(validFlags(), [true, true, true, true]);
});
