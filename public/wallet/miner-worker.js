// Mining worker: hashes prefix + nonce in throttled batches so every phone has the same, visible pace.
import { sha256Hex } from '/shared/sha256.js';

const BATCH_MS = 100;
let timer = null;
let token = 0; // invalidates a running loop when a new job or stop arrives

const zeros = (hex) => hex.length - hex.replace(/^0+/, '').length;

function stop() {
  token++;
  clearTimeout(timer);
  timer = null;
}

function start(job) {
  stop();
  const mine = token;
  const target = '0'.repeat(job.difficulty);
  const batch = Math.max(1, Math.ceil(job.rate / (1000 / BATCH_MS)));
  let nonce = 0;
  let best = '';
  let bestZeros = -1;

  const step = () => {
    if (mine !== token) return;
    let latest = '';
    for (let i = 0; i < batch; i++) {
      latest = sha256Hex(job.prefix + String(nonce));
      const z = zeros(latest);
      if (z > bestZeros) { bestZeros = z; best = latest; }
      if (latest.startsWith(target)) {
        token++;
        self.postMessage({ type: 'found', round: job.round, nonce, hash: latest });
        return;
      }
      nonce++;
    }
    self.postMessage({ type: 'progress', round: job.round, tried: nonce, nonce: nonce - 1, hash: latest, best });
    timer = setTimeout(step, BATCH_MS);
  };
  timer = setTimeout(step, 0);
}

self.onmessage = ({ data }) => {
  if (data?.type === 'job') start(data.job);
  else if (data?.type === 'stop') stop();
};
