// Slide 13: mainnet-fork testing. The worker is a private copy of the live network; the attack runs there.
// The "Red real intacta" case is added by the main thread (server/lab/index.js) after comparing the real state.
import { CATALOG } from '../catalog.js';
import { state, createSystemTx, getBalance, SYSTEM } from '../../state.js';
import { setDifficulty, getDifficulty } from '../../miner.js';
import { getContract } from '../../contracts/engine.js';
import { BANK } from '../../contracts/bank.js';
import { ATTACKER, setAttackEnabled, launchAttack } from '../../contracts/attacker.js';
import { forkAccount, mineAll, queue } from '../kit.js';

const META = CATALOG.find((s) => s.id === 'fork');
const SEED_THRESHOLD = 30; // below this the bank has too little to show a reentrancy
const ATTACK_AMOUNT = 10;

export default {
  ...META,
  async run(ctx) {
    const knownHashes = new Set(state.txStatus.keys());
    const realBlocks = state.chain.length - 1;
    const people = [...state.accounts.values()].filter((a) => !a.system).length;
    const bankAtFork = getBalance(BANK);
    ctx.progress('paso 1/4');
    await ctx.check('Fork creado', true,
      `altura ${realBlocks} · ${people} cuentas · banco con ${bankAtFork} · dificultad ${getDifficulty()}`);

    setDifficulty(1); // fork only
    ctx.progress('paso 2/4');
    const addresses = [];
    const ana = forkAccount(ctx.rng, 'Ana', 100);
    const beto = forkAccount(ctx.rng, 'Beto', 100);
    addresses.push(ana, beto);
    mineAll();
    await ctx.check('Actores solo del fork', true, 'FORK-Ana y FORK-Beto con 100 monedas, inexistentes en la red real');

    ctx.progress('paso 3/4');
    if (getBalance(BANK) < SEED_THRESHOLD) {
      queue(createSystemTx(BANK, 20, { from: ana, call: { method: 'depositar', args: [] } }));
      queue(createSystemTx(BANK, 20, { from: beto, call: { method: 'depositar', args: [] } }));
      mineAll();
      await ctx.check('Banco sembrado en el fork', getBalance(BANK) >= SEED_THRESHOLD,
        `el banco estaba casi vacío: Ana y Beto depositan 20 cada uno → ${getBalance(BANK)}`);
    } else {
      await ctx.check('Banco con fondos', true, `se usa el saldo copiado: ${getBalance(BANK)}`);
    }

    ctx.progress('paso 4/4');
    setAttackEnabled(true);
    const bankBefore = getBalance(BANK);
    const hackerBefore = getBalance(SYSTEM.HACKER);
    const launched = launchAttack({ amount: ATTACK_AMOUNT });
    mineAll();
    const bankAfter = getBalance(BANK);
    const loot = getBalance(SYSTEM.HACKER) - hackerBefore + ATTACK_AMOUNT; // what came back to the hacker
    const drained = bankBefore - bankAfter;
    const rounds = getContract(ATTACKER).storage.rounds;
    await ctx.check('Ataque de reentrada en el fork', launched.ok && drained > 0,
      `el banco pasó de ${bankBefore} a ${bankAfter} · ${rounds} reentradas · el Hacker sacó ${Math.max(0, loot)} con ${ATTACK_AMOUNT}`);

    // Everything the fork created, so the main thread can prove none of it exists in the real network.
    const txHashes = [...state.txStatus.keys()].filter((h) => !knownHashes.has(h));
    ctx.mark({ addresses, txHashes });
    ctx.summary(`El fork perdió ${drained} monedas en el banco; la red real no se toca`);
  },
};
