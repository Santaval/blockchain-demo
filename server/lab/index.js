// Lab controller (main thread). Runs the suites in a worker thread that holds a private copy of the network,
// keeps the results in `labState` (sent to the screens inside state:full) and checks the real network was not touched.
import { Worker } from 'node:worker_threads';
import { state, events, exportSnapshot } from '../state.js';
import { getDifficulty } from '../miner.js';
import { exportStorages, getContract } from '../contracts/engine.js';
import { sha256Hex } from '../crypto.js';
import { BANK } from '../contracts/bank.js';
import { ATTACKER } from '../contracts/attacker.js';
import { CATALOG, SUITE_IDS } from './catalog.js';

export { CATALOG, SUITE_IDS };
const CASES_KEPT = 40; // last N cases per suite, to keep state:full small
const RUN_TIMEOUT_MS = 120000;

const blankSuite = (meta) => ({
  id: meta.id, name: meta.name, slides: meta.slides, description: meta.description, expectFail: meta.expectFail,
  status: 'pending', progress: '', cases: [], casesTotal: 0, casesFailed: 0, summary: '',
});
const freshLab = () => ({
  running: false, seed: null, startedAt: null, finishedAt: null, real: null,
  suites: CATALOG.map(blankSuite),
});

let lab = freshLab();
let run = null; // { id, worker, timer, resolve, done, before, markers, suiteIds }
let runSeq = 0;
let idle = Promise.resolve();

export const getLabState = () => lab;
export const isLabRunning = () => run !== null;
export const labFinished = () => idle; // resolves when the current run (if any) ends
const changed = () => events.emit('state:changed');
const suiteOf = (id) => lab.suites.find((s) => s.id === id);

// --- Real network checks ---------------------------------------------------------------------------------------

const bankSignature = () => JSON.stringify([state.balances.get(BANK), getContract(BANK).storage.deposits, getContract(ATTACKER).storage]);

// sha256 over tip hash + sorted balances (Infinity as '∞') + contract storages.
function realFingerprint() {
  const balances = [...state.balances].map(([a, v]) => [a, v === Infinity ? '∞' : v]).sort((x, y) => (x[0] < y[0] ? -1 : 1));
  const tip = state.chain[state.chain.length - 1];
  return {
    height: state.chain.length - 1,
    tipHash: tip.hash,
    bank: state.balances.get(BANK) ?? 0,
    bankSig: bankSignature(),
    fingerprint: sha256Hex(JSON.stringify([tip.hash, balances, exportStorages()])),
  };
}
const publicFp = ({ height, bank, fingerprint }) => ({ height, bank, fingerprint: fingerprint.slice(0, 12) });

// The real chain keeps mining during a run, so the check cannot compare whole-state hashes. What it can prove:
//  1. history intact: the block that was the tip when the run started still has the same hash;
//  2. nothing the fork created (accounts, tx hashes) exists in the real state;
//  3. the bank and attacker contracts are unchanged, unless a real block after the start touched them.
function verifyReal(before, markers) {
  const issues = [];
  if (state.chain[before.height]?.hash !== before.tipHash) issues.push('el historial cambió');
  for (const address of markers.addresses) if (state.accounts.has(address)) issues.push(`la cuenta ${address} del fork existe en la red real`);
  for (const hash of markers.txHashes) if (state.txStatus.has(hash)) issues.push('una transacción del fork existe en la red real');
  const touched = state.chain.slice(before.height + 1).some((b) =>
    b.txs.some((t) => [t.from, t.to].some((a) => a === BANK || a === ATTACKER)));
  if (!touched && bankSignature() !== before.bankSig) issues.push('el banco cambió sin ningún bloque real que lo toque');
  const grew = state.chain.length - 1 - before.height;
  const bank = state.balances.get(BANK) ?? 0;
  return {
    intact: issues.length === 0,
    bank,
    detail: issues.length === 0
      ? `el banco real sigue en ${bank}${grew > 0 ? ` · la red real minó ${grew} bloque(s) mientras tanto` : ''}`
      : issues.join('; '),
  };
}

function checkReal(final) {
  const r = verifyReal(run.before, run.markers);
  lab.real = { ...lab.real, intact: r.intact, after: publicFp(realFingerprint()), note: r.detail };
  return r;
}

// --- Run lifecycle ---------------------------------------------------------------------------------------------

function addCase(s, entry) {
  s.casesTotal++;
  if (!entry.ok) s.casesFailed++;
  s.cases.push(entry);
  if (s.cases.length > CASES_KEPT) s.cases.splice(0, s.cases.length - CASES_KEPT);
}

function finish() {
  if (!run) return;
  const current = run;
  clearTimeout(current.timer);
  run = null;
  if (lab.real) {
    // final check against whatever the real network looks like now
    const r = verifyReal(current.before, current.markers);
    lab.real = { ...lab.real, intact: r.intact, after: publicFp(realFingerprint()), note: r.detail };
    const fork = suiteOf('fork');
    if (!r.intact && fork && current.suiteIds.includes('fork') && fork.status === 'pass') {
      addCase(fork, { name: 'Red real intacta', ok: false, detail: r.detail });
      fork.status = 'fail';
    }
  }
  lab.running = false;
  lab.finishedAt = Date.now();
  current.worker.terminate().catch(() => {});
  current.resolve();
  changed();
}

function failRunning(message) {
  for (const id of run?.suiteIds ?? []) {
    const s = suiteOf(id);
    if (s && s.status === 'running') {
      addCase(s, { name: 'Error del laboratorio', ok: false, detail: message });
      s.status = 'fail';
      s.summary = message;
    }
  }
  finish();
}

function onMessage(runId, msg) {
  if (!run || run.id !== runId) return;
  const s = suiteOf(msg.id);
  switch (msg.type) {
    case 'suite':
      if (s) { s.status = 'running'; s.progress = ''; }
      break;
    case 'progress':
      if (s) s.progress = msg.text;
      break;
    case 'case':
      if (s) addCase(s, { name: msg.name, ok: msg.ok, detail: msg.detail });
      break;
    case 'summary':
      if (s) s.summary = msg.text;
      break;
    case 'markers':
      run.markers.addresses.push(...msg.addresses);
      run.markers.txHashes.push(...msg.txHashes);
      break;
    case 'suiteEnd':
      if (!s) break;
      s.status = msg.status;
      if (msg.id === 'fork') {
        const r = checkReal();
        addCase(s, { name: 'Red real intacta', ok: r.intact, detail: r.detail });
        if (!r.intact) s.status = 'fail';
        else if (msg.status === 'pass') s.summary = `${s.summary} · red real intacta`.replace(/^ · /, '');
      }
      break;
    case 'done':
      finish();
      return;
    case 'fatal':
      failRunning(msg.message);
      return;
    default:
      return;
  }
  changed();
}

// suite: 'all' or a suite id. Returns { ok, seed } | { ok: false, reason }. Progress arrives through getLabState().
export function runLab(suite = 'all', { seed, paceScale = 1 } = {}) {
  if (run) return { ok: false, reason: 'Ya hay pruebas corriendo' };
  const ids = suite === 'all' ? [...SUITE_IDS] : SUITE_IDS.includes(suite) ? [suite] : null;
  if (!ids) return { ok: false, reason: 'Suite desconocida' };
  if (seed !== undefined && seed !== null && !(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff)) {
    return { ok: false, reason: 'La semilla debe ser un entero entre 0 y 4294967295' };
  }
  const usedSeed = seed ?? Math.floor(Math.random() * 100000);

  const before = realFingerprint();
  const id = ++runSeq;
  let worker;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: { snapshot: exportSnapshot(), storages: exportStorages(), difficulty: getDifficulty(), suiteIds: ids, seed: usedSeed, paceScale },
    });
  } catch (err) {
    return { ok: false, reason: `No se pudo iniciar el laboratorio: ${err.message}` };
  }
  let resolve;
  idle = new Promise((r) => { resolve = r; });
  run = { id, worker, resolve, before, suiteIds: ids, markers: { addresses: [], txHashes: [] }, timer: null };
  run.timer = setTimeout(() => failRunning('Tiempo máximo del laboratorio agotado'), RUN_TIMEOUT_MS);
  run.timer.unref();

  lab.suites = lab.suites.map((s) => (ids.includes(s.id) ? blankSuite(CATALOG.find((m) => m.id === s.id)) : s));
  Object.assign(lab, { running: true, seed: usedSeed, startedAt: Date.now(), finishedAt: null });
  lab.real = { intact: null, before: publicFp(before), after: null, note: '' };

  worker.on('message', (msg) => onMessage(id, msg));
  worker.on('error', (err) => { if (run?.id === id) failRunning(`Error en el laboratorio: ${err?.message ?? err}`); });
  worker.on('exit', (code) => { if (run?.id === id) failRunning(`El laboratorio terminó antes de tiempo (código ${code})`); });
  changed();
  return { ok: true, seed: usedSeed };
}

// Clears every result; an ongoing run is cancelled (its worker is terminated).
export function clearLab() {
  if (run) {
    clearTimeout(run.timer);
    run.worker.terminate().catch(() => {});
    run.resolve();
    run = null;
  }
  lab = freshLab();
  changed();
}

events.on('reset', clearLab);
