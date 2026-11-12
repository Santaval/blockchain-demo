// 0xBANCO: a deliberately buggy bank. retirar() sends the money BEFORE zeroing the deposit (reentrancy, The DAO 2016).
import { state, events, createSystemTx, getBalance } from '../state.js';

export const BANK = '0xBANCO';

export default {
  address: BANK, name: 'Banco',
  init: () => ({ deposits: {} }),
  methods: {
    depositar(ctx) {
      if (ctx.value <= 0) throw new Error('Debes enviar monedas para depositar');
      const d = ctx.storage.deposits;
      d[ctx.sender] = (d[ctx.sender] ?? 0) + ctx.value;
      ctx.log(`${ctx.nick(ctx.sender)} depositó ${ctx.value}`);
    },
    retirar(ctx) {
      const d = ctx.storage.deposits;
      const amount = d[ctx.sender] ?? 0;
      if (amount <= 0) throw new Error('No tienes depósito');
      // Logged before the transfer because the transfer may re-enter this method (log order = cascade order).
      ctx.log(`Retiro de ${ctx.nick(ctx.sender)}: ${amount} · quedan ${ctx.balance() - amount}`);
      // BUG: the money leaves first and the deposit is zeroed afterwards. If the receiver is a contract,
      // its onReceive can call retirar() again while deposits[sender] is still unchanged.
      ctx.transfer(ctx.sender, amount);
      d[ctx.sender] = 0;
    },
  },
  view: (s) => ({
    balance: getBalance(BANK),
    depositors: Object.entries(s.deposits).filter(([, amount]) => amount > 0)
      .map(([address, amount]) => ({ address, nick: state.accounts.get(address)?.nick ?? address, amount })),
  }),
  viewFor: (s, address) => ({ myDeposit: s.deposits[address] ?? 0 }),
  active: () => true,
};

// Pushes a system tx into the mempool (pending), like the auction close timer does.
export function queueSystemTx(tx) {
  state.mempool.push(tx);
  state.txStatus.set(tx.hash, { status: 'pending' });
  events.emit('mempool:add', tx);
}

// Admin helper: SISTEMA deposits `amount` into the bank so the demo works with few participants.
export function seedBank({ amount } = {}) {
  if (!Number.isInteger(amount) || amount < 1 || amount > 1000) return { ok: false, reason: 'El monto debe ser un entero de 1 a 1000' };
  queueSystemTx(createSystemTx(BANK, amount, { call: { method: 'depositar', args: [] } }));
  return { ok: true };
}
