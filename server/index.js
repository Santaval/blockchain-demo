import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { PORT } from './config.js';
import { startMiner } from './miner.js';
import { attachSync } from './sync.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Routes first so /pantalla and /admin are not redirected by the static dir handler.
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'wallet', 'index.html')));
app.get('/pantalla', (_req, res) => res.sendFile(path.join(publicDir, 'pantalla', 'index.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(publicDir, 'admin', 'index.html')));

app.use(express.static(publicDir));

attachSync(io);

server.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}`);
  startMiner();
});
