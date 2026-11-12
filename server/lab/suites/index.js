import spec from './spec.js';
import multicliente from './multicliente.js';
import fuzzRed from './fuzz-red.js';
import bft from './bft.js';
import fork from './fork.js';
import invariantes from './invariantes.js';

// Same order as the talk.
export const SUITES = [spec, multicliente, fuzzRed, bft, fork, invariantes];
export const suiteById = (id) => SUITES.find((s) => s.id === id);
