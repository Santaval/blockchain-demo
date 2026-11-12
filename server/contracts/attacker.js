// 0xATACANTE: deposits into the bank, withdraws, and re-enters retirar() from onReceive while the bank still has funds.
import { state, createSystemTx, getBalance, SYSTEM } from '../state.js';
import { getContract } from './engine.js';
import { BANK, queueSystemTx } from './bank.js';

export const ATTACKER = '0xATACANTE';
const MAX_ROUNDS = 30; // 2 engine frames per round, so well under the engine depth limit (200)

export default {
  address: ATTACKER, name: 'Atacante',
  init: () => ({ enabled: false, owner: null, deposit: 0, rounds: 0, attacking: false, lastLoot: 0 }),
  methods: {
    atacar(ctx) {
      const s = ctx.storage;
      // `enabled` only gates the wallet button; the admin launch comes from 0xHACKER and always works.
      if (!s.enabled && ctx.sender !== SYSTEM.HACKER) throw new Error('Ataque deshabilitado');
      if (ctx.value <= 0) throw new Error('Debes enviar monedas para atacar');
      Object.assign(s, { owner: ctx.sender, deposit: ctx.value, rounds: 0, attacking: true });
      ctx.call(BANK, 'depositar', [], ctx.value);
      ctx.call(BANK, 'retirar');
      s.attacking = false;
      const loot = ctx.balance();
      s.lastLoot = loot;
      if (loot > 0) ctx.transfer(s.owner, loot);
      ctx.log(`Ataque terminado: ${s.rounds} reentradas, botín ${loot} para ${ctx.nick(s.owner)}`);
    },
  },
  onReceive(ctx) {
    const s = ctx.storage;
    if (!s.attacking || ctx.sender !== BANK || s.rounds >= MAX_ROUNDS || ctx.balance(BANK) < s.deposit) return;
    s.rounds++;
    ctx.log(`Reentrada #${s.rounds} · banco: ${ctx.balance(BANK)}`);
    ctx.call(BANK, 'retirar');
  },
  view: (s) => ({ enabled: s.enabled, rounds: s.rounds, lastLoot: s.lastLoot, owner: s.owner }),
  active: (s) => s.enabled,
};

// Admin helpers (off-chain config). Both return { ok, reason? }.
export function setAttackEnabled(enabled) {
  if (typeof enabled !== 'boolean') return { ok: false, reason: 'Valor inválido' };
  getContract(ATTACKER).storage.enabled = enabled;
  return { ok: true };
}

const pendingOutgoing = (addr) => state.mempool.filter((t) => t.from === addr).reduce((n, t) => n + t.amount, 0);

// Launches the attack from 0xHACKER, funding it first (SISTEMA -> HACKER) if it cannot cover `amount`.
export function launchAttack({ amount = 10 } = {}) {
  if (!Number.isInteger(amount) || amount < 1 || amount > 1000) return { ok: false, reason: 'El monto debe ser un entero de 1 a 1000' };
  const pending = pendingOutgoing(SYSTEM.HACKER);
  const missing = amount - (getBalance(SYSTEM.HACKER) - pending);
  if (missing > 0) queueSystemTx(createSystemTx(SYSTEM.HACKER, missing));
  queueSystemTx(createSystemTx(ATTACKER, amount, { from: SYSTEM.HACKER, call: { method: 'atacar', args: [] } }));
  return { ok: true };
}
