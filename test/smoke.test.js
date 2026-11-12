import test from 'node:test';
import assert from 'node:assert/strict';
import * as config from '../server/config.js';

test('config defaults', () => {
  assert.equal(config.PORT, 3000);
  assert.equal(config.MINE_INTERVAL_MS, 12000);
  assert.equal(config.DIFFICULTY, 4);
  assert.equal(config.MAX_TXS_PER_BLOCK, 25);
  assert.equal(config.FAUCET_AMOUNT, 100);
});
