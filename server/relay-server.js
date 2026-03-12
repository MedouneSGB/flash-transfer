/**
 * Flash⚡Transfer — Relay Server
 * Hébergeable sur Render.com (free tier)
 *
 * Déploiement:
 *   1. Push ce dossier sur GitHub
 *   2. Créer un service Web sur render.com
 *   3. Build command: npm install
 *   4. Start command: node relay-server.js
 */

const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8765;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
    return;
  }
  res.writeHead(404);
  res.end('Flash⚡Transfer Relay Server');
});

const wss = new WebSocketServer({ server });

// rooms: Map<code, { sender: WebSocket|null, receiver: WebSocket|null }>
const rooms = new Map();

// Cleanup stale rooms after 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (room.createdAt && now - room.createdAt > 10 * 60 * 1000) {
      if (room.sender?.readyState === WebSocket.OPEN) room.sender.close();
      if (room.receiver?.readyState === WebSocket.OPEN) room.receiver.close();
      rooms.delete(code);
      console.log(`[relay] Room ${code} expired`);
    }
  }
}, 60 * 1000);

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost`);
  const code = url.searchParams.get('code');
  const role = url.searchParams.get('role'); // 'sender' | 'receiver'

  if (!code || !role) {
    ws.send(JSON.stringify({ error: 'Missing code or role' }));
    ws.close();
    return;
  }

  console.log(`[relay] ${role} joined room: ${code}`);

  if (!rooms.has(code)) {
    rooms.set(code, { sender: null, receiver: null, createdAt: Date.now() });
  }

  const room = rooms.get(code);
  room[role] = ws;

  // Notify sender when receiver joins
  if (role === 'receiver' && room.sender?.readyState === WebSocket.OPEN) {
    room.sender.send('PEER_CONNECTED');
    console.log(`[relay] Room ${code}: peer connected, relay active`);
  }
  // If sender joins after receiver, notify
  if (role === 'sender' && room.receiver?.readyState === WebSocket.OPEN) {
    ws.send('PEER_CONNECTED');
  }

  ws.on('message', (data, isBinary) => {
    // Relay all messages to the other peer
    const peer = role === 'sender' ? room.receiver : room.sender;
    if (peer?.readyState === WebSocket.OPEN) {
      peer.send(data, { binary: isBinary });
    }
  });

  ws.on('close', () => {
    console.log(`[relay] ${role} left room: ${code}`);
    const peer = role === 'sender' ? room.receiver : room.sender;
    if (peer?.readyState === WebSocket.OPEN) {
      try { peer.send('PEER_DISCONNECTED'); } catch {}
      peer.close();
    }
    rooms.delete(code);
  });

  ws.on('error', (err) => {
    console.error(`[relay] Error in room ${code} (${role}):`, err.message);
  });
});

server.listen(PORT, () => {
  console.log(`⚡ Flash⚡Transfer Relay Server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});
