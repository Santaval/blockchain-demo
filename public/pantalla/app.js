import { connect, bindStatus } from '/shared/socket.js';

const socket = connect('pantalla');
bindStatus(socket, document.getElementById('status'));
socket.on('state:full', (s) => console.log('state:full', s));
