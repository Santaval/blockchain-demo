import { connect, bindStatus } from '/shared/socket.js';

const socket = connect('wallet');
bindStatus(socket, document.getElementById('status'));
socket.on('state', (s) => console.log('state', s));
