// Lab worker: a private copy of the node. Fresh module instances, so nothing here can touch the real state.
// Receives a snapshot of the live network, loads it, and runs the requested suites one after another,
// reloading the snapshot before each one so every suite starts from the same fork.
import { parentPort, workerData } from 'node:worker_threads';
import '../contracts/index.js'; // registers the contracts in this instance
import { state, importSnapshot } from '../state.js';
import { importStorages } from '../contracts/engine.js';
import { setDifficulty } from '../miner.js';
import { createRng, deriveSeed } from './rng.js';
import { runSuite } from './runner.js';
import { suiteById } from './suites/index.js';
import { sleep } from './kit.js';

const { snapshot, storages, difficulty, suiteIds, seed, paceScale = 1 } = workerData;
const report = (msg) => parentPort.postMessage(msg);
const pace = (ms) => (ms > 0 && paceScale > 0 ? sleep(ms * paceScale) : undefined);

function loadFork() {
  importSnapshot(snapshot);
  importStorages(storages);
  setDifficulty(difficulty);
  // Real pending txs are not part of the fork: suites start from an empty mempool.
  for (const tx of state.mempool) state.txStatus.delete(tx.hash);
  state.mempool.length = 0;
}

try {
  for (const id of suiteIds) {
    loadFork();
    await runSuite(suiteById(id), { report, rng: createRng(deriveSeed(seed, id)), pace });
  }
  report({ type: 'done' });
} catch (err) {
  report({ type: 'fatal', message: String(err?.message ?? err) });
}
