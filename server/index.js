import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { PORT } from './config.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ROLES = ['wallet', 'pantalla', 'admin'];

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Routes first so /pantalla and /admin are not redirected by the static dir handler.
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'wallet', 'index.html')));
app.get('/pantalla', (_req, res) => res.sendFile(path.join(publicDir, 'pantalla', 'index.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(publicDir, 'admin', 'index.html')));

app.use(express.static(publicDir));

io.on('connection', (socket) => {
  const role = socket.handshake.query.role;
  if (!ROLES.includes(role)) {
    socket.disconnect(true);
    return;
  }
  socket.join(role);
  console.log(`[socket] ${socket.id} connected as ${role}`);
  socket.on('disconnect', () => console.log(`[socket] ${socket.id} (${role}) disconnected`));
});

server.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
