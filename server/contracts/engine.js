// Contract engine: registry, execution at mining time, snapshot/revert, logs and internal transfers.
import { state, events, getBalance, addAccount } from '../state.js';

const MAX_DEPTH = 200;
const LOG_LIMIT = 60;
const TRANSFER_LIMIT = 200;

const registry = new Map(); // address -> { def, storage }
let logs = [];
let internalTransfers = [];

const addContractAccount = (def) =>
  addAccount({ address: def.address, nick: def.name, pubKey: '', system: true, contract: true }, 0);

export function registerContract(def) {
  registry.set(def.address, { def, storage: def.init() });
  addContractAccount(def);
}

// state.reset() clears accounts: give every contract fresh storage and re-add its account.
events.on('reset', () => {
  logs = [];
  internalTransfers = [];
  for (const c of registry.values()) {
    c.storage = c.def.init();
    addContractAccount(c.def);
  }
});

// Storage copy of every contract, for forking the node in the lab.
export const exportStorages = () => Object.fromEntries([...registry].map(([addr, c]) => [addr, structuredClone(c.storage)]));
export function importStorages(storages) {
  for (const [addr, storage] of Object.entries(storages ?? {})) {
    if (registry.has(addr)) registry.get(addr).storage = structuredClone(storage);
  }
}

export const isContract = (addr) => registry.has(addr);
export const getContract = (addr) => registry.get(addr);
export const getLogs = () => logs;
export const getInternalTransfers = () => internalTransfers;

function move(from, to, amount, msg) {
  if (getBalance(from) < amount) throw new Error(msg);
  state.balances.set(from, getBalance(from) - amount); // Infinity - n stays Infinity
  state.balances.set(to, getBalance(to) + amount);
}

// Runs one frame: `method` (or onReceive when method is null) of the contract at `address`.
function invoke(run, address, method, args, sender, value, depth) {
  if (depth > MAX_DEPTH) throw new Error(`Profundidad máxima de llamadas (${MAX_DEPTH})`);
  const { def, storage } = registry.get(address);
  const { tx, time, block } = run;
  const ctx = {
    sender, origin: tx.from, value, time, self: address, storage,
    balance: (addr = address) => getBalance(addr),
    nick: (addr) => state.accounts.get(addr)?.nick ?? addr,
    log: (message) => run.logs.push({ contract: address, message: String(message), time, block, tx: tx.hash }),
    transfer(to, amount) {
      if (!Number.isInteger(amount) || amount <= 0) throw new Error('Monto inválido');
      move(address, to, amount, 'Saldo insuficiente del contrato');
      run.transfers.push({ from: address, to, amount, contract: address, tx: tx.hash, block, time });
      if (registry.has(to)) invoke(run, to, null, [], address, amount, depth + 1);
    },
    call(contract, callMethod, callArgs = [], callValue = 0) {
      if (!registry.has(contract)) throw new Error('El destinatario no es un contrato');
      if (!Number.isInteger(callValue) || callValue < 0) throw new Error('Monto inválido');
      move(address, contract, callValue, 'Saldo insuficiente del contrato');
      return invoke(run, contract, callMethod, callArgs, address, callValue, depth + 1);
    },
  };
  if (method === null) return def.onReceive?.(ctx);
  if (!Object.hasOwn(def.methods ?? {}, method)) throw new Error(`Método desconocido: ${method}`);
  return def.methods[method](ctx, ...(Array.isArray(args) ? args : []));
}

function pushLog(entry) {
  logs.push(entry);
  if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
  events.emit('contract:log', entry);
}

// Applies a tx that targets a contract. Returns { ok: true } | { ok: false, reason }; reverts everything on failure.
export function executeTx(tx, { time = Date.now(), block = state.chain.length } = {}) {
  if (!registry.has(tx.to)) return { ok: false, reason: 'El destinatario no es un contrato' };
  const balances = new Map(state.balances);
  const storages = new Map([...registry].map(([addr, c]) => [addr, structuredClone(c.storage)]));
  const run = { tx, time, block, logs: [], transfers: [] };
  try {
    move(tx.from, tx.to, tx.amount, 'Saldo insuficiente');
    if (tx.call) invoke(run, tx.to, tx.call.method, tx.call.args, tx.from, tx.amount, 0);
    else if (tx.amount > 0 || registry.get(tx.to).def.onReceive) invoke(run, tx.to, null, [], tx.from, tx.amount, 0);
  } catch (err) {
    state.balances.clear();
    for (const [addr, bal] of balances) state.balances.set(addr, bal);
    for (const [addr, storage] of storages) registry.get(addr).storage = storage;
    const reason = err.message;
    pushLog({ contract: tx.to, message: `Revertido: ${reason}`, time, block, tx: tx.hash });
    return { ok: false, reason };
  }
  run.logs.forEach(pushLog);
  internalTransfers.push(...run.transfers);
  if (internalTransfers.length > TRANSFER_LIMIT) internalTransfers.splice(0, internalTransfers.length - TRANSFER_LIMIT);
  return { ok: true };
}

const entry = (c) => ({
  address: c.def.address, name: c.def.name, balance: getBalance(c.def.address),
  active: !!c.def.active(c.storage), view: c.def.view(c.storage),
});

export const contractsView = () => [...registry.values()].map(entry);

export function contractsViewFor(address) {
  return [...registry.values()].map((c) => {
    const item = entry(c);
    if (c.def.viewFor) item.me = c.def.viewFor(c.storage, address);
    return item;
  });
}
