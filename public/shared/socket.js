// Connects to the server with a role (wallet | pantalla | admin).
// Relies on the global `io` from /socket.io/socket.io.js.
export function connect(role) {
  return io({ query: { role } });
}

// Shows "Conectado"/"Desconectado" in the given element.
export function bindStatus(socket, el) {
  const set = (ok) => {
    el.textContent = ok ? 'Conectado' : 'Desconectado';
    el.dataset.connected = String(ok);
  };
  set(socket.connected);
  socket.on('connect', () => set(true));
  socket.on('disconnect', () => set(false));
}
