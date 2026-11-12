// Testing lab on the projector. While the "Pruebas" panel is up the stage shows one scene per suite (drawn from the
// structured `viz` data each suite reports) and the inspector lists the cases of the suite in focus.
// The focus follows the run on its own; clicking a step (or the arrow keys) pins another suite.
import { el } from './graph.js';
import { icon } from '/shared/icons.js';

const SUITE_ICON = { spec: 'clipboard', multicliente: 'copy', 'fuzz-red': 'shuffle', bft: 'shield', fork: 'fork', invariantes: 'scale' };
const STATUS_ICON = { pending: 'circle', running: 'spinner', pass: 'check', fail: 'x' };
const BANK = '0xBANCO';

const h = (tag, cls, ...kids) => {
  const e = el(tag, cls);
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
  return e;
};
const mark = (ok) => icon(ok ? 'check' : 'x', ok ? 'm-ok' : 'm-bad');
const pct = (a, b) => `${b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0}%`;
const bar = (cls, a, b) => {
  const fill = el('i');
  fill.style.width = pct(a, b);
  return h('div', `bar ${cls || ''}`, fill);
};
const isBug = (su) => su.expectFail && su.status === 'fail';
const fmtElapsed = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

// ---------- focus ----------

let pinned = null; // suite id picked by hand
let pinnedRun; // lab.startedAt the pin belongs to: a new run releases it

function autoFocus(lab) {
  const suites = lab.suites || [];
  const running = suites.find((x) => x.status === 'running');
  if (running) return running.id;
  const done = suites.filter((x) => x.status === 'pass' || x.status === 'fail');
  if (!done.length) return null;
  return (done.find(isBug) || done[done.length - 1]).id; // the bug found is the moment to stay on
}
export function labFocus(lab) {
  if (pinnedRun !== lab.startedAt) { pinned = null; pinnedRun = lab.startedAt; }
  return pinned ?? autoFocus(lab);
}
export function setLabFocus(lab, id) {
  pinnedRun = lab.startedAt;
  pinned = id;
}
export function moveLabFocus(lab, delta) {
  const ids = (lab.suites || []).map((x) => x.id);
  const at = ids.indexOf(labFocus(lab));
  setLabFocus(lab, ids[Math.max(0, Math.min(ids.length - 1, (at < 0 ? (delta > 0 ? -1 : ids.length) : at) + delta))]);
}
export const clearLabFocus = () => { pinned = null; };

// ---------- progress ----------

function suitePct(su) {
  if (su.status === 'pass' || su.status === 'fail') return 100;
  if (su.status !== 'running') return 0;
  const m = /(\d+)\/(\d+)/.exec(su.progress || '');
  return m ? (Number(m[1]) / Number(m[2])) * 100 : 5;
}

export function tickLab() {
  const e = document.querySelector('.lab-elapsed[data-started-at]');
  if (e) e.textContent = fmtElapsed(Date.now() - Number(e.dataset.startedAt));
}

// ---------- scenes ----------

const KIND_LABEL = { consenso: 'Consenso · bloques y cadena', validación: 'Validación · transacciones', ejecución: 'Ejecución · saldos tras minar' };

function sceneSpec(su) {
  const vectors = su.viz?.vectors || [];
  const done = su.casesTotal;
  const kept = su.cases || [];
  const caseAt = (i) => kept[i - (done - kept.length)];
  const groups = new Map();
  vectors.forEach((v, i) => {
    if (!groups.has(v.kind)) groups.set(v.kind, []);
    groups.get(v.kind).push({ ...v, i });
  });
  const cols = h('div', 'sp-cols');
  for (const [kind, items] of groups) {
    const ul = el('ul', 'sp-list');
    let passed = 0;
    for (const v of items) {
      const c = v.i < done ? caseAt(v.i) : null;
      const state = c ? (c.ok ? 'ok' : 'bad') : v.i === done && su.status === 'running' ? 'now' : 'todo';
      if (state === 'ok') passed++;
      ul.appendChild(h('li', `sp-item ${state}`, c ? mark(c.ok) : icon(state === 'now' ? 'spinner' : 'circle'), el('span', null, v.name)));
    }
    cols.appendChild(h('div', 'sp-group', el('div', 'lbl', `${KIND_LABEL[kind] || kind} · ${passed}/${items.length}`), ul));
  }
  const last = kept[kept.length - 1];
  const foot = last
    ? h('div', `sc-note ${last.ok ? '' : 'bad'}`, el('b', null, last.name), ` ${last.ok ? last.detail : '· ' + last.detail}`)
    : el('div', 'sc-note', 'Cada vector trae su veredicto esperado: el nodo tiene que dar exactamente ese.');
  return [cols, foot];
}

function sceneMulti(su) {
  const v = su.viz || {};
  const total = v.total || 0;
  const checked = v.checked || 0;
  const n = Math.min(total, 60);
  const lane = (who, what) => {
    const cells = el('div', 'mc-cells');
    for (let j = 0; j < n; j++) {
      const block = Math.ceil(((j + 1) * total) / n) - 1; // last block this cell stands for
      const state = block >= checked ? 'todo' : v.badFrom != null && block >= v.badFrom ? 'bad' : 'ok';
      cells.appendChild(el('i', state));
    }
    return h('div', 'mc-lane', h('div', 'mc-who', el('b', null, who), el('small', null, what)), cells);
  };
  const same = (v.agree ?? 0) === checked;
  const eq = h('div', 'mc-eq', h('span', `chip ${same ? 'c-ok' : 'c-bad'}`, mark(same), ` ${v.agree ?? 0}/${total} veredictos idénticos`),
    el('span', 'muted', v.badFrom != null ? `ambos ven la cadena inválida desde #${v.badFrom}` : checked ? 'ambos dan la cadena por válida' : ''));
  const table = h('div', 'mc-muts', h('div', 'mc-row head', el('span', null, 'Cadena manipulada'), el('span', null, 'Cliente A'), el('span', null, 'Cliente B'), el('span')));
  for (const m of v.muts || []) {
    table.appendChild(h('div', 'mc-row', el('b', null, m.name), el('span', 'chip c-bad', m.a), el('span', 'chip c-bad', m.b), mark(m.ok)));
  }
  if (!(v.muts || []).length) table.appendChild(el('div', 'muted', 'Después: cuatro cadenas manipuladas que los dos deben rechazar por el mismo motivo.'));
  return [lane('Cliente A', 'validateChain del servidor'), eq, lane('Cliente B', 'otro código, mismo protocolo'), table];
}

function sceneFuzz(su) {
  const v = su.viz || {};
  const stat = (label, value, cls) => h('div', `fz-stat ${cls || ''}`, el('b', null, String(value)), el('small', null, label));
  const zero = (n) => (n ? 'bad' : 'ok');
  const stats = h('div', 'fz-stats',
    stat('mensajes enviados', `${v.sent ?? 0}/${v.total ?? 300}`),
    stat('rechazados por el servidor', v.rejected ?? 0),
    stat('aceptados indebidamente', v.accepted ?? 0, zero(v.accepted)),
    stat('caídas del servidor', v.crashes ?? 0, zero(v.crashes)),
    stat('controles de vida', `${v.controlsOk ?? 0}/${v.controlsTotal ?? 0}`, (v.controlsOk ?? 0) === (v.controlsTotal ?? 0) ? 'ok' : 'bad'));
  const feed = el('ul', 'fz-feed mono');
  for (const m of v.recent || []) feed.appendChild(h('li', null, el('b', null, m.event), el('span', null, m.what)));
  if (!(v.recent || []).length) feed.appendChild(el('li', 'muted', 'Esperando el primer mensaje…'));
  return [stats, bar('', v.sent ?? 0, v.total ?? 300),
    h('div', 'fz-box', el('div', 'lbl', 'Últimos mensajes contra el servidor de la copia · evento y contenido'), feed)];
}

function sceneBft(su) {
  const v = su.viz || {};
  const scenes = v.scenes || [];
  const grid = el('div', 'bf-grid');
  for (let i = 0; i < 4; i++) {
    const sc = scenes[i];
    if (!sc) { grid.appendChild(el('div', 'bf-scene todo', 'En espera')); continue; }
    const nodes = el('div', 'bf-nodes');
    for (const n of sc.nodes) {
      nodes.appendChild(h('div', `bf-node ${n.byz ? 'byz' : ''}`, el('div', 'bf-dot', n.id), el('small', null, n.byz ? `traidor · ${n.vote}` : n.vote)));
    }
    const pips = el('div', 'bf-pips');
    for (let k = 0; k < sc.quorum; k++) pips.appendChild(el('i', k < sc.votes ? 'on' : ''));
    grid.appendChild(h('div', 'bf-scene', el('div', 'bf-title', sc.title), nodes,
      h('div', 'bf-tally', pips, el('span', null, `${sc.votes} de ${sc.quorum} votos`),
        h('span', `chip ${sc.good ? 'c-ok' : 'c-bad'}`, mark(sc.good), ` ${sc.result}`))));
  }
  const rule = el('div', 'sc-note', `n = ${v.n ?? 4} nodos · quórum 2f + 1 = ${v.quorum ?? 3} votos · tolera f = ${v.f ?? 1} traidor (n ≥ 3f + 1)`);
  return [rule, grid];
}

function sceneFork(su, s, lab) {
  const v = su.viz || {};
  const realBank = (s.contracts || []).find((c) => c.address === BANK)?.view?.balance ?? lab.real?.before?.bank ?? 0;
  const max = Math.max(1, Number(realBank) || 0, v.bankBefore ?? 0, v.forkBank ?? 0, v.bankAtFork ?? 0);
  const real = h('div', 'fk-lane real',
    el('div', 'lbl', 'Red real · sigue en vivo'),
    h('div', 'fk-num', String(realBank), el('small', null, ' en el banco')),
    bar('ok', Number(realBank) || 0, max),
    el('div', 'muted', `altura ${s.height ?? '-'} · nadie la toca`));
  const copy = h('div', `fk-lane copy ${v.attacked ? 'hit' : ''}`,
    el('div', 'lbl', 'Fork · copia privada'),
    h('div', 'fk-num', v.attacked ? el('s', null, String(v.bankBefore)) : null, String(v.forkBank ?? '-'), el('small', null, ' en el banco')),
    bar(v.attacked ? 'bad' : 'ok', v.forkBank ?? 0, max),
    el('div', v.attacked ? 'fk-loss' : 'muted', v.attacked
      ? `de ${v.bankBefore} a ${v.forkBank} · ${v.rounds} reentradas · el Hacker puso ${v.stake} y sacó ${v.loot}`
      : v.height != null ? `copiada en la altura ${v.height} · ${v.accounts} cuentas` : 'copiando la red…'));
  const steps = el('ul', 'fk-steps');
  for (const c of su.cases || []) steps.appendChild(h('li', c.ok ? 'ok' : 'bad', mark(c.ok), el('b', null, c.name), el('span', null, c.detail)));
  return [h('div', 'fk-lanes', real, icon('fork', 'fk-arrow'), copy), steps];
}

function sceneInv(su, s, lab) {
  const v = su.viz || {};
  const broken = v.broken;
  const max = Math.max(1, v.bank ?? 0, v.owed ?? 0);
  const short = (v.owed ?? 0) > (v.bank ?? 0);
  const meterRow = (label, value, cls) => h('div', 'iv-row', el('span', null, label), bar(cls, value, max), el('b', null, String(value)));
  const invs = el('ul', 'iv-invs');
  for (const name of v.invariants || []) {
    const bad = broken?.name === name;
    invs.appendChild(h('li', bad ? 'bad' : 'ok', mark(!bad), el('span', null, name)));
  }
  const left = h('div', 'iv-left',
    h('div', 'iv-prog', el('b', null, `Paso ${v.step ?? 0} de ${v.steps ?? 200}`), bar(broken ? 'bad' : '', v.step ?? 0, v.steps ?? 200)),
    h('div', `iv-meter ${short ? 'short' : ''}`, el('div', 'lbl', 'Invariante «Banco solvente»: lo que tiene ≥ lo que debe'),
      meterRow('Tiene', v.bank ?? 0, short ? 'bad' : 'ok'), meterRow('Debe', v.owed ?? 0, 'neutral'),
      short ? el('div', 'iv-gap', `Faltan ${v.owed - v.bank} monedas`) : null),
    h('div', null, el('div', 'lbl', 'Se revisan tras cada paso'), invs));
  const ops = el('ol', 'iv-ops mono');
  const list = v.ops || [];
  list.forEach((op, i) => {
    const li = h('li', i === list.length - 1 ? (broken ? 'culprit' : 'now') : '', el('span', 'n', `${(v.step ?? list.length) - list.length + i + 1}.`), op);
    ops.appendChild(li);
  });
  if (!list.length) ops.appendChild(el('li', 'muted', 'Preparando actores y contratos…'));
  const right = h('div', 'iv-right', el('div', 'lbl', `Secuencia aleatoria · semilla ${lab.seed ?? '-'}`), ops);
  const out = [h('div', 'iv-grid', left, right)];
  if (broken) {
    out.push(h('div', 'iv-bug', icon('alert'), h('div', null,
      el('b', null, `Bug encontrado en el paso ${broken.step}: se rompe «${broken.name}»`), el('div', null, broken.problem))));
  }
  return out;
}

const SCENES = { spec: sceneSpec, multicliente: sceneMulti, 'fuzz-red': sceneFuzz, bft: sceneBft, fork: sceneFork, invariantes: sceneInv };

// ---------- stage ----------

function statusChip(su) {
  if (isBug(su)) return h('span', 'chip c-ok', icon('check'), ' Bug encontrado');
  const [text, cls, ic] = {
    pending: ['En espera', 'c-neutral', null], running: ['Corriendo', 'c-running', null],
    pass: ['Pasó', 'c-ok', 'check'], fail: ['Falló', 'c-bad', 'x'],
  }[su.status] || ['En espera', 'c-neutral', null];
  return h('span', `chip ${cls}`, ic ? icon(ic) : null, ic ? ` ${text}` : text);
}

/** Draws the whole lab stage. `root` handles its clicks by delegation (see initLabStage). */
export function renderLabStage(s, root) {
  const lab = s.lab;
  root.replaceChildren();
  if (!lab) return void root.appendChild(el('div', 'placeholder', 'Sin laboratorio'));
  const suites = lab.suites || [];
  const started = !!lab.startedAt;
  const focusId = labFocus(lab);

  const chips = el('div', 'lab-chips');
  if (lab.running) chips.appendChild(el('span', 'chip c-running', 'Corriendo'));
  else if (started) chips.appendChild(el('span', 'chip c-info', 'Terminado'));
  if (started && lab.seed != null) chips.appendChild(el('span', 'chip c-neutral', `Semilla ${lab.seed}`));
  if (started) {
    const t = el('span', 'chip c-neutral lab-elapsed', fmtElapsed((lab.finishedAt || Date.now()) - lab.startedAt));
    if (lab.running) t.dataset.startedAt = String(lab.startedAt);
    chips.appendChild(t);
  }
  if (lab.real?.intact === true) chips.appendChild(h('span', 'chip c-ok', icon('check'), ' Red real intacta'));
  else if (lab.real?.intact === false) chips.appendChild(h('span', 'chip c-bad', icon('x'), ' La red real cambió'));
  if (pinned && lab.running) {
    const live = h('button', 'chip c-info lab-live', 'Seguir en vivo');
    live.type = 'button';
    live.dataset.live = '1';
    chips.appendChild(live);
  }
  root.appendChild(h('div', 'lab-top',
    h('div', 'lab-ttl', icon('flask'), h('div', null, el('b', null, 'Laboratorio de pruebas'),
      el('small', null, 'Todo corre en un fork: una copia privada de la red. La red real sigue minando.'))),
    chips));

  const steps = el('div', 'lab-steps');
  suites.forEach((su, i) => {
    const b = el('button', `lab-step st-${su.status}${isBug(su) ? ' bug' : ''}${su.id === focusId ? ' on' : ''}`);
    b.type = 'button';
    b.dataset.suite = su.id;
    const fill = el('i');
    fill.style.width = `${suitePct(su)}%`;
    const foot = su.status === 'running' ? su.progress : isBug(su) ? 'bug encontrado' : su.status === 'pass' ? 'pasó' : su.status === 'fail' ? 'falló' : `diap. ${su.slides}`;
    b.append(
      h('div', 'ls-top', el('span', 'ls-n', String(i + 1)), icon(isBug(su) ? 'check' : STATUS_ICON[su.status] || 'circle', 'ls-st')),
      el('div', 'ls-name', su.name),
      h('div', 'ls-bar', fill),
      el('div', 'ls-foot', foot || ''));
    steps.appendChild(b);
  });
  root.appendChild(steps);

  const scene = el('div', 'lab-scene');
  const su = suites.find((x) => x.id === focusId);
  if (!su) {
    scene.classList.add('intro');
    scene.appendChild(el('div', 'intro-ttl', 'Seis técnicas de prueba, una por una'));
    scene.appendChild(el('div', 'muted', 'El presentador las lanza desde el admin. Toca una para ver qué demuestra.'));
    const grid = el('div', 'intro-grid');
    for (const x of suites) {
      const card = h('button', 'intro-card', h('div', 'ic', icon(SUITE_ICON[x.id] || 'flask')),
        h('div', null, el('b', null, x.name), el('small', null, `diap. ${x.slides}`), el('p', null, x.description)));
      card.type = 'button';
      card.dataset.suite = x.id;
      grid.appendChild(card);
    }
    scene.appendChild(grid);
  } else {
    scene.appendChild(h('div', 'sc-head', h('div', 'ic', icon(SUITE_ICON[su.id] || 'flask')),
      h('div', 'sc-ttl', el('b', null, su.name), el('small', null, su.description)), statusChip(su)));
    const body = el('div', `sc-body sc-${su.id}`);
    if (su.status === 'pending' && !su.viz) {
      body.classList.add('waiting');
      body.appendChild(el('div', 'placeholder', started && lab.running ? 'En espera de su turno' : 'Todavía no se ha corrido'));
    } else body.append(...SCENES[su.id](su, s, lab));
    scene.appendChild(body);
    if (su.summary && su.status !== 'running' && !su.viz?.broken) { // the bug banner already says it
      scene.appendChild(h('div', `sc-summary ${isBug(su) || su.status === 'pass' ? 'ok' : 'bad'}`, el('span', 'lbl', 'Resultado'), el('b', null, su.summary)));
    }
  }
  root.appendChild(scene);
}

/** One listener for the whole stage: the content is rebuilt several times per second while a run is going. */
export function initLabStage(root, { getState, rerender }) {
  root.addEventListener('pointerdown', (e) => {
    const lab = getState()?.lab;
    if (!lab) return;
    const target = e.target.closest?.('[data-suite], [data-live]');
    if (!target) return;
    if (target.dataset.live) pinned = null;
    else setLabFocus(lab, target.dataset.suite);
    rerender();
  });
}

// ---------- inspector ----------

export function renderLabInspector(s, body) {
  const lab = s.lab;
  if (!lab) return void body.appendChild(el('div', 'placeholder', 'Sin laboratorio'));
  const suites = lab.suites || [];
  const su = suites.find((x) => x.id === labFocus(lab));
  const main = el('div', 'li');
  if (!su) {
    main.appendChild(el('h3', null, 'Cómo leer esta pantalla'));
    const ul = el('ul', 'li-plan');
    const guide = [
      ['list', 'Arriba, las seis técnicas', 'Corren en orden. La barra avanza y al final cada una queda en verde o en rojo.'],
      ['screen', 'En el centro, la escena', 'Lo que la técnica está haciendo ahora mismo, dibujado con sus números reales.'],
      ['check', 'Aquí, los casos', 'Cada comprobación con su resultado, la más reciente abajo.'],
      ['fork', 'Todo pasa en un fork', 'Una copia privada de la red. Al terminar se comprueba que la red real no cambió.'],
      ['hash', 'La semilla', 'Con la misma semilla la corrida se repite idéntica: una falla se puede reproducir.'],
    ];
    for (const [ic, title, text] of guide) ul.appendChild(h('li', null, icon(ic), h('div', null, el('b', null, title), el('span', null, text))));
    main.appendChild(ul);
    return void body.appendChild(main);
  }
  const failed = su.casesFailed || 0;
  main.appendChild(h('div', 'li-head', el('b', null, su.name),
    el('span', 'muted', `${su.casesTotal} ${su.casesTotal === 1 ? 'caso' : 'casos'} · ${failed} ${failed === 1 ? 'falla' : 'fallas'}`)));
  const ul = el('ul', 'li-cases');
  const cases = (su.cases || []).slice(-7);
  for (const c of cases) {
    const first = String(c.detail || '').split('\n')[0];
    ul.appendChild(h('li', c.ok ? 'ok' : 'bad', mark(c.ok), h('div', null, el('b', null, c.name), first ? el('span', null, first) : null)));
  }
  if (!cases.length) ul.appendChild(el('li', 'more', su.status === 'running' ? 'Corriendo…' : 'Sin casos todavía'));
  main.appendChild(ul);
  if (lab.real && lab.real.intact != null) {
    const ok = lab.real.intact === true;
    main.appendChild(h('div', `li-foot ${ok ? 'ok' : 'bad'}`, mark(ok),
      el('span', null, ok ? `Red real intacta · ${lab.real.note || ''}` : `La red real cambió · ${lab.real.note || ''}`)));
  }
  body.appendChild(main);
}
