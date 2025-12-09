
const WebSocket = require('ws');

function createServer(port, onMessage) {
  const wss = new WebSocket.Server({ port });
  wss.on('connection', ws => {
    ws.on('message', data => {
      try { onMessage(JSON.parse(data.toString()), ws); } catch {}
    });
  });
  return wss;
}

function connectToPeers(urls, onOpen, onMessage) {
  const sockets = new Map();
  urls.forEach(url => {
    const ws = new WebSocket(url);
    ws.on('open', () => onOpen && onOpen(ws, url));
    ws.on('message', data => {
      try { onMessage(JSON.parse(data.toString()), ws, url); } catch {}
    });
    ws.on('close', () => sockets.delete(url));
    ws.on('error', () => {});
    sockets.set(url, ws);
  });
  return sockets;
}

function broadcast(wss, msg) {
  const payload = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

module.exports = {
  createServer,
  connectToPeers,
  broadcast,
  send
};
