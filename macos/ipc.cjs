'use strict';
const fs = require('node:fs');
const net = require('node:net');

// Each local client request owns one socket. Closing it cancels a pending wait.
function listen(call) {
  const socketName = 'bridge.sock';
  // The native host already holds the exclusive profile lock.
  fs.rmSync(socketName, { force: true });
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '',
      started = false;
    socket.on('error', () => socket.destroy());
    socket.on('data', async (chunk) => {
      if (started) return;
      buffer += chunk;
      if (buffer.length > 65536) return socket.destroy();
      if (!buffer.includes('\n')) return;
      started = true;
      try {
        const { name, args } = JSON.parse(buffer.trim());
        const value = await call(name, args, () => !socket.destroyed);
        if (!socket.destroyed) socket.end(JSON.stringify({ value }) + '\n');
      } catch (e) {
        if (!socket.destroyed) socket.end(JSON.stringify({ error: e.message }) + '\n');
      }
    });
  });
  server.listen(socketName, () => fs.chmodSync(socketName, 0o600));
}
module.exports = { listen };
