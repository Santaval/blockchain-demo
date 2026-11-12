// Registers every contract of the demo: each contract file adds one import and one registerContract() line here.
import { registerContract } from './engine.js';
import voting from './voting.js';
import auction from './auction.js';

registerContract(voting);
registerContract(auction);
