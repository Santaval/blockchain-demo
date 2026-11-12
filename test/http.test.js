import './helpers/no-mine-pause.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { reset } from '../server/state.js';
import { buildFullState } from '../server/sync.js';
import { mineBlock } from '../server/miner.js';

let server, base;
before(async () => {
  reset();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('/qr.svg returns an SVG', async () => {
  const res = await fetch(`${base}/qr.svg`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await res.text(), /<svg/);
});

test('/api/info derives the url from the request when PUBLIC_URL is unset', async () => {
  const info = await (await fetch(`${base}/api/info`, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'demo.example.com' } })).json();
  assert.equal(info.url, 'https://demo.example.com');
});

test('/api/info honors PUBLIC_URL', async () => {
  const s = createApp({ publicUrl: 'https://publica.example.com' }).listen(0);
  await new Promise((r) => s.once('listening', r));
  try {
    const info = await (await fetch(`http://127.0.0.1:${s.address().port}/api/info`)).json();
    assert.equal(info.url, 'https://publica.example.com');
  } finally {
    s.close();
  }
});

test('full state exposes lastBlockStatus and the system flag', () => {
  const full = buildFullState();
  assert.ok(Array.isArray(full.lastBlockStatus));
  assert.ok(full.accounts.some((a) => a.system === true));
  mineBlock();
  assert.ok(Array.isArray(buildFullState().lastBlockStatus));
});
