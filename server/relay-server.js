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
const MAX_ROOMS = 500;           // Limit total active rooms
const MAX_CONNECTIONS_PER_IP = 5; // Rate limit per IP
const ipConnections = new Map();  // ip → count

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
    return;
  }
  res.writeHead(404);
  res.end('Flash⚡Transfer Relay Server');
});

const wss = new WebSocketServer({ server, maxPayload: 512 * 1024 }); // 512KB max WS message

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
  // Rate limiting by IP
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const currentCount = ipConnections.get(clientIp) || 0;
  if (currentCount >= MAX_CONNECTIONS_PER_IP) {
    ws.send(JSON.stringify({ error: 'Too many connections from this IP' }));
    ws.close();
    return;
  }
  ipConnections.set(clientIp, currentCount + 1);
  ws.on('close', () => {
    const c = ipConnections.get(clientIp) || 1;
    if (c <= 1) ipConnections.delete(clientIp);
    else ipConnections.set(clientIp, c - 1);
  });

  const url = new URL(req.url, `http://localhost`);
  const code = url.searchParams.get('code');
  const role = url.searchParams.get('role'); // 'sender' | 'receiver'

  if (!code || !role || !['sender', 'receiver'].includes(role)) {
    ws.send(JSON.stringify({ error: 'Missing or invalid code/role' }));
    ws.close();
    return;
  }

  // Validate code format (alphanumeric, 4-12 chars)
  if (!/^[a-zA-Z0-9]{4,12}$/.test(code)) {
    ws.send(JSON.stringify({ error: 'Invalid code format' }));
    ws.close();
    return;
  }

  // Limit total rooms
  if (!rooms.has(code) && rooms.size >= MAX_ROOMS) {
    ws.send(JSON.stringify({ error: 'Server at capacity, try again later' }));
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
