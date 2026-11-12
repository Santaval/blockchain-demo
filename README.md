# Demo de blockchain y contratos inteligentes

Demo en vivo de 15 minutos: cada participante crea una wallet desde el celular y ve en el proyector cómo sus transacciones pasan por el mempool, se minan en bloques y ejecutan contratos inteligentes.

- **Real:** llaves ECDSA P-256 generadas en el navegador, firmas verificadas por el servidor, SHA-256, proof-of-work y encadenamiento de bloques.
- **Simulado:** la red. Un solo servidor hace de todos los nodos.
- **Fuera de alcance:** árbol de Merkle, comisiones/gas, múltiples nodos y forks, persistencia.

## Rutas

| Ruta | Para |
|---|---|
| `/` | Celulares (wallet) |
| `/pantalla` | Proyector |
| `/admin` | Control de la demo (protegido con `ADMIN_PASSWORD`) |

### El proyector es interactivo

- **Toca un nodo** del lienzo (Participantes, Mempool, Minero, un bloque o un contrato) para abrir su detalle a la derecha. Con un bloque abierto, las flechas ← → recorren la cadena; Esc vuelve a la vista que eligió el presentador.
- **Bloques anteriores:** los botones junto al registro de contratos desplazan la fila de bloques.
- **Panel Pruebas:** ocupa todo el escenario con una escena por técnica. Un clic en un paso (o las flechas) fija esa técnica; "Seguir en vivo" vuelve a la que está corriendo.
- **Tema:** el botón de contraste alterna automático, claro y oscuro (también `?tema=claro|oscuro|auto`).

## Stack

Node 20, Express, Socket.io, HTML + JS vanilla (sin build step), `qrcode` en el servidor. Despliegue con Dockerfile en Coolify, con HTTPS (obligatorio para Web Crypto).

## Variables de entorno

- `PORT` (por defecto 3000)
- `ADMIN_PASSWORD`
- `POOL_REWARD` (por defecto 10): monedas que gana el participante que encuentra un bloque
- `POOL_HASH_RATE` (por defecto 4000): hashes por segundo de cada celular minando
- `POOL_MAX_DIFFICULTY` (por defecto 4): por encima de esta dificultad los celulares dejan de minar y el servidor mina solo
- `POOL_TIMEOUT_MS` (por defecto 60000): si nadie encuentra el bloque en este tiempo, el servidor lo mina
- `PUBLIC_URL` (URL pública que codifica el QR; si no se define se deriva de la petición)

## Desarrollo

```bash
npm install
npm run dev
```
