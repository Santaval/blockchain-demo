import './helpers/no-mine-pause.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server } from 'socket.io';
import { io as ioc } from 'socket.io-client';
import { ADMIN_PASSWORD } from '../server/config.js';
import { state, reset, createSystemTx, getBalance, SYSTEM } from '../server/state.js';
import { setDifficulty, mineBlock, validateChain } from '../server/miner.js';
import { getContract } from '../server/contracts/engine.js';
import '../server/contracts/index.js';
import { BANK } from '../server/contracts/bank.js';
import { attachSync } from '../server/sync.js';
import { getPanel } from '../server/admin.js';
import { runSuite } from '../server/lab/runner.js';
import { createRng, deriveSeed } from '../server/lab/rng.js';
import { validateChainB } from '../server/lab/client-b.js';
import { queue } from '../server/lab/kit.js';
import { suiteById } from '../server/lab/suites/index.js';
import { CATALOG } from '../server/lab/catalog.js';
import { runLab, clearLab, getLabState, isLabRunning, labFinished } from '../server/lab/index.js';

setDifficulty(1);

// Fresh network with a few blocks that carry transactions.
function freshNetwork() {
  reset();
  setDifficulty(1);
  for (let i = 1; i <= 3; i++) { queue(createSystemTx(SYSTEM.PRESENTADOR, i)); mineBlock(); }
}

const run = (id, seed = 1, options = {}) =>
  runSuite(suiteById(id), { rng: createRng(deriveSeed(seed, id)), pace: async () => {}, options });

beforeEach(freshNetwork);

test('catalog matches the suites', () => {
  assert.deepEqual(CATALOG.map((s) => s.id), ['spec', 'multicliente', 'fuzz-red', 'bft', 'fork', 'invariantes']);
  for (const meta of CATALOG) assert.equal(suiteById(meta.id).name, meta.name);
  assert.equal(CATALOG.find((s) => s.id === 'invariantes').expectFail, true);
});

test('rng is reproducible and different suites get different streams', () => {
  const a = createRng(7); const b = createRng(7);
  assert.deepEqual([a.next(), a.int(1, 9), a.pick(['x', 'y', 'z'])], [b.next(), b.int(1, 9), b.pick(['x', 'y', 'z'])]);
  assert.notEqual(deriveSeed(7, 'spec'), deriveSeed(7, 'bft'));
});

test('spec: every vector gets its expected verdict', async () => {
  const res = await run('spec');
  const wrong = res.cases.filter((c) => !c.ok);
  assert.deepEqual(wrong, []);
  assert.ok(res.cases.length >= 30);
  assert.equal(res.status, 'pass');
});

test('multicliente: client B agrees with A on a valid chain and on tampered ones', async () => {
  const res = await run('multicliente');
  assert.equal(res.status, 'pass', JSON.stringify(res.cases.filter((c) => !c.ok)));
  assert.match(res.cases[0].detail, /^\d+\/\d+ bloques coinciden/);

  const chain = structuredClone(state.chain);
  assert.deepEqual(validateChainB(chain), validateChain(chain));
  chain[2].txs[0].amount += 500;
  const a = validateChain(chain);
  const b = validateChainB(chain);
  assert.deepEqual(b, a);
  assert.equal(b.findIndex((v) => !v.valid), 2);
});

test('fuzz-red: no crashes and nothing accepted that should be rejected', async () => {
  const res = await run('fuzz-red', 3);
  assert.equal(res.status, 'pass', JSON.stringify(res.cases.filter((c) => !c.ok)));
  assert.match(res.summary, /^300 mensajes · 0 caídas · 0 aceptados indebidamente$/);
});

test('bft: the three expected outcomes', async () => {
  const res = await run('bft');
  assert.equal(res.status, 'pass', JSON.stringify(res.cases.filter((c) => !c.ok)));
  const names = res.cases.map((c) => c.name);
  assert.ok(names.includes('Caso 1 · Nadie lo finaliza'));
  assert.ok(names.includes('Caso 2 · Cambio de líder: gana el bloque honesto'));
  assert.ok(names.includes('Caso 3 · Vivacidad: sin acuerdo'));
});

test('fork: the attack drains the bank inside the copy', async () => {
  const res = await run('fork');
  assert.equal(res.status, 'pass', JSON.stringify(res.cases.filter((c) => !c.ok)));
  assert.match(res.cases.at(-1).detail, /el banco pasó de \d+ a \d+/);
});

test('invariantes: finds the bank solvency violation, deterministically', async () => {
  const res = await run('invariantes', 1);
  assert.equal(res.status, 'fail');
  assert.match(res.summary, /^¡Encontró el bug! «Banco solvente»/);
  const bad = res.cases.find((c) => !c.ok);
  assert.match(bad.name, /Banco solvente/);
  assert.match(bad.detail, /Últimos pasos/);
  assert.equal(res.cases.filter((c) => !c.ok).length, 1);

  freshNetwork();
  const again = await run('invariantes', 1);
  assert.equal(again.summary, res.summary);
});

test('invariantes: finds nothing when the attack is out of the step mix', async () => {
  const res = await run('invariantes', 1, { noAttack: true });
  assert.equal(res.status, 'pass', JSON.stringify(res.cases.filter((c) => !c.ok)));
  assert.match(res.summary, /^200 pasos sin violaciones/);
});

test('runner reports progress, cases and errors', async () => {
  const seen = [];
  const res = await runSuite(
    { id: 'x', async run(ctx) { ctx.progress('paso 1/2'); await ctx.check('uno', true, 'ok'); throw new Error('boom'); } },
    { report: (m) => seen.push(m.type), rng: createRng(1) },
  );
  assert.equal(res.status, 'fail');
  assert.deepEqual(seen, ['suite', 'progress', 'case', 'case', 'summary', 'suiteEnd']);
  assert.equal(res.cases.at(-1).name, 'Error inesperado');
});

test('runLab: fork leaves the real network untouched and a second run is refused', async () => {
  reset();
  setDifficulty(1);
  for (let i = 1; i <= 3; i++) { queue(createSystemTx(SYSTEM.PRESENTADOR, i)); mineBlock(); }
  const before = JSON.stringify([state.chain.map((b) => b.hash), [...state.balances], getContract(BANK).storage, [...state.accounts.keys()]]);
  const bankBefore = getBalance(BANK);

  const started = runLab('fork', { seed: 5, paceScale: 0 });
  assert.equal(started.ok, true);
  assert.equal(started.seed, 5);
  assert.equal(isLabRunning(), true);
  assert.deepEqual(runLab('all'), { ok: false, reason: 'Ya hay pruebas corriendo' });
  assert.equal(getLabState().running, true);

  await labFinished();
  assert.equal(isLabRunning(), false);
  const lab = getLabState();
  assert.equal(lab.running, false);
  assert.equal(lab.seed, 5);
  const fork = lab.suites.find((s) => s.id === 'fork');
  assert.equal(fork.status, 'pass', JSON.stringify(fork.cases));
  const intact = fork.cases.find((c) => c.name === 'Red real intacta');
  assert.equal(intact.ok, true);
  assert.match(intact.detail, /el banco real sigue en 0/);
  assert.equal(lab.real.intact, true);
  assert.equal(lab.suites.filter((s) => s.status === 'pending').length, 5);

  const after = JSON.stringify([state.chain.map((b) => b.hash), [...state.balances], getContract(BANK).storage, [...state.accounts.keys()]]);
  assert.equal(after, before);
  assert.equal(getBalance(BANK), bankBefore);
  assert.equal(state.mempool.length, 0);

  assert.deepEqual(runLab('nope'), { ok: false, reason: 'Suite desconocida' });
  assert.equal(runLab('bft', { seed: -1 }).ok, false);
});

test('runLab: clearLab cancels a running lab and reset clears results', async () => {
  assert.equal(runLab('invariantes', { seed: 2 }).ok, true);
  clearLab();
  assert.equal(isLabRunning(), false);
  assert.equal(getLabState().running, false);
  assert.ok(getLabState().suites.every((s) => s.status === 'pending'));
  assert.equal(runLab('bft', { seed: 2, paceScale: 0 }).ok, true);
  await labFinished();
  assert.equal(getLabState().suites.find((s) => s.id === 'bft').status, 'pass');
  reset();
  assert.ok(getLabState().suites.every((s) => s.status === 'pending'));
});

test('admin: lab-run / lab-clear need login, switch the panel and refuse concurrent runs', async () => {
  const server = http.createServer();
  const io = new Server(server);
  const detach = attachSync(io);
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const clients = [];
  const connect = (role) => { const c = ioc(url, { query: { role }, forceNew: true }); clients.push(c); return c; };
  const emit = (c, ev, data) => new Promise((r) => c.emit(ev, data, r));
  try {
    const anon = connect('admin');
    assert.deepEqual(await emit(anon, 'admin:lab-run', { suite: 'bft' }), { ok: false, reason: 'No autorizado' });
    assert.deepEqual(await emit(anon, 'admin:lab-clear', {}), { ok: false, reason: 'No autorizado' });

    const admin = connect('admin');
    assert.deepEqual(await emit(admin, 'admin:login', { password: ADMIN_PASSWORD }), { ok: true });
    assert.deepEqual(await emit(admin, 'admin:lab-run', { suite: 'nope' }), { ok: false, reason: 'Suite desconocida' });
    const ok = await emit(admin, 'admin:lab-run', { suite: 'invariantes', seed: 9 });
    assert.deepEqual(ok, { ok: true, seed: 9 });
    assert.equal(getPanel(), 'pruebas');
    assert.deepEqual(await emit(admin, 'admin:lab-run', { suite: 'all' }), { ok: false, reason: 'Ya hay pruebas corriendo' });
    assert.deepEqual(await emit(admin, 'admin:lab-clear', {}), { ok: true });
    assert.equal(isLabRunning(), false);
    assert.deepEqual(await emit(admin, 'admin:panel', { panel: 'qr' }), { ok: true });
  } finally {
    clients.forEach((c) => c.close());
    detach();
    await io.close();
  }
});
