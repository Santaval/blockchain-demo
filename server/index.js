import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import QRCode from 'qrcode';
import { Server } from 'socket.io';
import { PORT, PUBLIC_URL } from './config.js';
import './contracts/index.js'; // registers the demo contracts
import { startMiner } from './miner.js';
import { attachSync } from './sync.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Public URL: env override, otherwise derived from the request (trust proxy for Coolify).
const originOf = (req) => `${req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`;

const qrCache = new Map(); // url -> svg
async function qrSvg(url) {
  if (!qrCache.has(url)) qrCache.set(url, await QRCode.toString(url, { type: 'svg', margin: 1 }));
  return qrCache.get(url);
}

export function createApp({ publicUrl: fixedUrl = PUBLIC_URL } = {}) {
  const publicUrl = (req) => fixedUrl || originOf(req);
  const app = express();
  app.set('trust proxy', true);

  // Routes first so /pantalla and /admin are not redirected by the static dir handler.
  app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'wallet', 'index.html')));
  app.get('/pantalla', (_req, res) => res.sendFile(path.join(publicDir, 'pantalla', 'index.html')));
  app.get('/admin', (_req, res) => res.sendFile(path.join(publicDir, 'admin', 'index.html')));
  app.get('/api/info', (req, res) => res.json({ url: publicUrl(req) }));
  app.get('/qr.svg', async (req, res, next) => {
    try {
      res.type('image/svg+xml').send(await qrSvg(publicUrl(req)));
    } catch (err) {
      next(err);
    }
  });

  app.use(express.static(publicDir));
  return app;
}

export function startServer(port = PORT) {
  const server = http.createServer(createApp());
  const io = new Server(server);
  attachSync(io);
  server.listen(port, () => {
    console.log(`Servidor en http://localhost:${port}`);
    startMiner();
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();
