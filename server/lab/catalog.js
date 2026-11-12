// Static metadata of the suites. Kept apart from the suite code so the main thread never loads the suites.
export const CATALOG = [
  {
    id: 'spec', name: 'Spec tests', slides: '4–6', expectFail: false,
    description: 'Vectores de consenso y de ejecución: cada uno con su veredicto esperado.',
  },
  {
    id: 'multicliente', name: 'Compatibilidad multi-cliente', slides: '7', expectFail: false,
    description: 'Un segundo cliente, escrito aparte, valida la misma cadena y debe coincidir bloque por bloque.',
  },
  {
    id: 'fuzz-red', name: 'Fuzzing de red', slides: '8', expectFail: false,
    description: 'Cientos de mensajes basura y transacciones mutadas contra un servidor real de la copia.',
  },
  {
    id: 'bft', name: 'Tolerancia bizantina (BFT)', slides: '9', expectFail: false,
    description: 'Cuatro nodos, uno traidor: quórum de 2f+1 y el límite n ≥ 3f+1.',
  },
  {
    id: 'fork', name: 'Fork de la red en vivo', slides: '13', expectFail: false,
    description: 'Copia la red real, ataca el banco en la copia y comprueba que la red real no se tocó.',
  },
  {
    id: 'invariantes', name: 'Fuzzing de contratos + invariantes', slides: '14–15', expectFail: true,
    description: 'Secuencias aleatorias sobre los contratos; tras cada paso revisa invariantes hasta romper una.',
  },
];
export const SUITE_IDS = CATALOG.map((s) => s.id);
