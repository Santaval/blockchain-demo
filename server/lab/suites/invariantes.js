// Slides 14-15: contract fuzzing + invariant testing. Random sequences over the fork; after every step the
// invariants are checked. The bank's reentrancy breaks "Banco solvente", and the fuzzer finds it on its own.
import { CATALOG } from '../catalog.js';
import { state, addAccount, createSystemTx, getBalance, SYSTEM } from '../../state.js';
import { setDifficulty } from '../../miner.js';
import { getContract } from '../../contracts/engine.js';
import { BANK } from '../../contracts/bank.js';
import { ATTACKER, setAttackEnabled } from '../../contracts/attacker.js';
import { VOTING } from '../../contracts/voting.js';
import { AUCTION } from '../../contracts/auction.js';
import { mineAll, queue, uniqueNick } from '../kit.js';

const META = CATALOG.find((s) => s.id === 'invariantes');
const DEFAULT_STEPS = 200;
const STEP_PACE_MS = 80;
const ATTACK_WARMUP = 8; // no attacks before this step: the bank needs depositors first
const START_COINS = 200;
const CONTRACTS = [BANK, ATTACKER, VOTING, AUCTION];

// Each invariant returns null when it holds, or a short description of the violation.
const INVARIANTS = [
  ['Banco solvente', () => {
    const owed = Object.values(getContract(BANK).storage.deposits).reduce((n, v) => n + v, 0);
    const balance = getBalance(BANK);
    return balance >= owed ? null : `el banco tiene ${balance} pero debe ${owed} a sus depositantes`;
  }],
  ['Conservación de monedas', (ctxInv) => {
    const total = circulating();
    return total === ctxInv.baseline ? null : `circulan ${total} monedas y deberían ser ${ctxInv.baseline}`;
  }],
  ['Votación coherente', () => {
    const s = getContract(VOTING).storage;
    const voters = new Set(s.votes.map((v) => v.address));
    if (voters.size !== s.votes.length) return `${s.votes.length} votos de solo ${voters.size} votantes distintos`;
    const counted = s.options.reduce((n, _, i) => n + s.votes.filter((v) => v.option === i).length, 0);
    return counted === s.votes.length ? null : `los conteos suman ${counted} y hay ${s.votes.length} votos`;
  }],
  ['Subasta cuadrada', () => {
    const s = getContract(AUCTION).storage;
    if (!s.open) return null;
    const held = getBalance(AUCTION);
    const bid = s.highest?.amount ?? 0;
    return held === bid ? null : `la subasta guarda ${held} y la mejor oferta es ${bid}`;
  }],
];

const bankOwed = () => Object.values(getContract(BANK).storage.deposits).reduce((n, v) => n + v, 0);

const circulating = () => {
  let total = 0;
  for (const [addr, bal] of state.balances) if (addr !== SYSTEM.SISTEMA) total += bal;
  return total;
};

export default {
  ...META,
  // options: { steps, noAttack }
  async run(ctx) {
    const { rng } = ctx;
    const steps = ctx.options.steps ?? DEFAULT_STEPS;
    setDifficulty(1);

    // Fresh contracts and coins so a previous (real) attack cannot colour the run; everything stays in the fork.
    for (const addr of CONTRACTS) {
      const c = getContract(addr);
      c.storage = c.def.init();
      state.balances.set(addr, 0);
    }
    const names = ['Ana', 'Beto', 'Carla', 'Dani'];
    const actors = names.map((name) => {
      let address;
      do address = '0xFORK' + rng.hex(6); while (state.accounts.has(address));
      addAccount({ address, nick: uniqueNick(`FORK-${name}`), pubKey: '' }, 0);
      queue(createSystemTx(address, START_COINS));
      return { name, address };
    });
    ctx.mark({ addresses: actors.map((a) => a.address) });
    mineAll();
    Object.assign(getContract(VOTING).storage, { question: '¿Lo aprobamos?', options: ['Sí', 'No', 'Quizá'], open: true, votes: [] });
    Object.assign(getContract(AUCTION).storage, { item: 'Pieza de prueba', endsAt: Date.now() + 3600e3, open: true });
    setAttackEnabled(true);

    const inv = { baseline: circulating() };
    const history = [];
    const pickAmount = (actor, max) => {
      const room = Math.min(getBalance(actor.address), max);
      return room >= 1 ? rng.int(1, room) : 0;
    };
    const base = [['depositar', 5], ['retirar', 2], ['votar', 2], ['ofertar', 3], ['transfer', 3]];
    const withAttack = [...base, ['atacar', 1.2]];

    const invNames = INVARIANTS.map(([name]) => name);
    ctx.viz({ step: 0, steps, invariants: invNames, bank: getBalance(BANK), owed: 0, ops: [], broken: null });
    let violation = null;
    let done = 0;
    for (let step = 1; step <= steps && !violation; step++) {
      const actor = rng.pick(actors);
      const op = rng.weighted(ctx.options.noAttack || step <= ATTACK_WARMUP ? base : withAttack);
      let label;
      if (op === 'depositar') {
        const amount = pickAmount(actor, 25);
        queue(createSystemTx(BANK, amount, { from: actor.address, call: { method: 'depositar', args: [] } }));
        label = `${actor.name} depositar(${amount})`;
      } else if (op === 'retirar') {
        queue(createSystemTx(BANK, 0, { from: actor.address, call: { method: 'retirar', args: [] } }));
        label = `${actor.name} retirar()`;
      } else if (op === 'atacar') {
        const amount = pickAmount(actor, 20);
        queue(createSystemTx(ATTACKER, amount, { from: actor.address, call: { method: 'atacar', args: [] } }));
        label = `${actor.name} atacar(${amount})`;
      } else if (op === 'votar') {
        const option = rng.int(0, 3); // 3 is out of range on purpose
        queue(createSystemTx(VOTING, 0, { from: actor.address, call: { method: 'votar', args: [option] } }));
        label = `${actor.name} votar(${option})`;
      } else if (op === 'ofertar') {
        const amount = pickAmount(actor, 60);
        queue(createSystemTx(AUCTION, amount, { from: actor.address, call: { method: 'ofertar', args: [] } }));
        label = `${actor.name} ofertar(${amount})`;
      } else {
        const to = rng.pick(actors.filter((a) => a !== actor));
        const amount = pickAmount(actor, 30);
        queue(createSystemTx(to.address, amount, { from: actor.address }));
        label = `${actor.name} → ${to.name} transfer(${amount})`;
      }
      mineAll();
      const status = [...state.txStatus.values()].at(-1);
      history.push(`${label}${status?.status === 'failed' ? ' (revierte)' : ''}`);
      done = step;
      ctx.progress(`paso ${step}/${steps}`);
      for (const [name, check] of INVARIANTS) {
        const problem = check(inv);
        if (problem) { violation = { name, problem, step }; break; }
      }
      ctx.viz({ step, bank: getBalance(BANK), owed: bankOwed(), ops: history.slice(-7), broken: violation });
      await ctx.pace(violation ? 0 : STEP_PACE_MS);
    }

    if (violation) {
      const tail = history.slice(-6).map((h, i, all) => `${violation.step - all.length + i + 1}. ${h}`).join('\n');
      await ctx.check(`Invariante violada: ${violation.name}`, false,
        `paso ${violation.step} · ${violation.problem}\nÚltimos pasos:\n${tail}`);
      for (const [name] of INVARIANTS) {
        if (name !== violation.name) await ctx.check(name, true, `se cumplió en los ${violation.step} pasos`);
      }
      ctx.summary(`¡Encontró el bug! «${violation.name}» se rompe en el paso ${violation.step}`);
    } else {
      for (const [name] of INVARIANTS) await ctx.check(name, true, `se cumplió en los ${done} pasos`);
      ctx.summary(`${done} pasos sin violaciones de invariantes`);
    }
  },
};
