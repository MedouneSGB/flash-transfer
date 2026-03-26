'use strict';

// ═══════════════════════════════════════════
//  Flash Transfer — Web Transfer
//
//  Codes:
//   WABC123 → PeerJS WebRTC  (W prefix, uppercase)
//   Tabc123 → Relay WebSocket (T prefix, lowercase)
//
//  Le réconciliateur (reconcileCode) détecte le
//  préfixe W ou T et route vers le bon canal.
//  Rétrocompatible avec les codes sans préfixe.
// ═══════════════════════════════════════════

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.stunprotocol.org:3478' },
  ],
};

const ACCEPTED_MIME = new Set([
  'text/plain',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
  'application/zip',
  'application/x-zip-compressed',
  'application/vnd.rar',
  'application/x-rar-compressed',
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/x-msvideo',
  'video/x-matroska',
  'video/webm',
  'video/3gpp',
  'video/3gpp2',
]);
const ACCEPTED_EXT = ['.txt', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.png', '.jpg', '.jpeg', '.zip', '.rar',
  '.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.3gp', '.3g2'];
const MAX_BYTES    = 1024 * 1024 * 1024;
const CHUNK_SIZE   = 64 * 1024;
const RELAY_URL    = 'wss://flash-transfer-7vj7.onrender.com';
const RELAY_CHUNK  = 256 * 1024;

// ── State ──────────────────────────────────
let peer      = null;
let conn      = null;
let mode      = null; // 'send' | 'recv'

// Send side
let peerReady      = false;
let sendStarted    = false;
let selectedFiles  = [];
let sendQueue      = [];
let currentSendIdx = 0;
let totalSendBytes = 0;
let sentBytes      = 0;
let tSendStart     = 0;

// Receive side
let connectedOnce     = false;
let recvFiles         = [];
let currentRecvIdx    = -1;
let totalRecvExpected = 0;
let totalRecvSize     = 0;
let totalRecvBytes    = 0;

// Relay fallback (alongside PeerJS)
let relayFallbackWs   = null;
let relayFallbackCode = null;

// Relay bridge (direct relay to desktop)
let relayWs   = null;
let relayMode = null;

// ═══════════════════════════════════════════
//  CODE RECONCILIATEUR
//
//  Entrée : chaîne saisie par l'utilisateur
//  Sortie : { type: 'web'|'tauri', code: string } | null
//
//  W + 6 chars → PeerJS (web)
//  T + 6 chars → Relay  (Tauri / app desktop)
//  6 chars majuscules → PeerJS (rétrocompat)
//  6 chars minuscules → Relay  (rétrocompat)
// ═══════════════════════════════════════════
function reconcileCode(raw) {
  const s = raw.trim().replace(/[^a-zA-Z0-9]/g, '');
  if (!s || s.length < 4) return null;

  const firstUpper = s[0].toUpperCase();
  const rest = s.slice(1);

  // W prefix → PeerJS web code
  if (firstUpper === 'W') {
    if (rest.length < 4) return null;
    return { type: 'web', code: rest.toUpperCase().slice(0, 6) };
  }

  // T prefix → Tauri relay code
  if (firstUpper === 'T') {
    if (rest.length < 4) return null;
    return { type: 'tauri', code: rest.toLowerCase().slice(0, 6) };
  }

  // Legacy (no prefix) — 4-6 chars
  if (s.length > 6) return null;

  // All lowercase → relay (Tauri legacy)
  if (/^[a-z0-9]+$/.test(s)) return { type: 'tauri', code: s };

  // Otherwise → PeerJS web
  return { type: 'web', code: s.toUpperCase().slice(0, 6) };
}

// ── Utilities ───────────────────────────────
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => chars[b % chars.length]).join('');
}

function fmtSize(b) {
  if (b < 1024)    return b + ' o';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' Ko';
  return (b / 1048576).toFixed(1) + ' Mo';
}

function fmtSpeed(bps) {
  if (bps < 1024)    return bps.toFixed(0) + ' o/s';
  if (bps < 1048576) return (bps / 1024).toFixed(0) + ' Ko/s';
  return (bps / 1048576).toFixed(1) + ' Mo/s';
}

function fileIcon(name, mime) {
  if (mime === 'application/pdf'  || name.endsWith('.pdf'))   return '📄';
  if (mime.includes('word')       || /\.docx?$/.test(name))  return '📝';
  if (mime.includes('excel')      || /\.xlsx?$/.test(name))  return '📊';
  if (/^image\//.test(mime))                                  return '🖼️';
  if (/^video\//.test(mime) || /\.(mp4|mov|m4v|avi|mkv|webm|3gp|3g2)$/i.test(name)) return '🎬';
  if (mime === 'text/plain'       || name.endsWith('.txt'))   return '📃';
  return '📁';
}

function canPreview(mime) {
  return /^image\//.test(mime) || /^video\//.test(mime) || mime === 'application/pdf' || mime === 'text/plain';
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Détection réseau mobile ──────────────────
// Retourne true si l'appareil est probablement sur données mobiles
// ou sur une connexion trop lente pour établir WebRTC (CGNAT/opérateur).
// Basé sur Network Information API (Chrome/Android) — silencieux sinon.
function isLikelyCellular() {
  try {
    const nc = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!nc) return false;
    return nc.type === 'cellular'
        || nc.saveData === true
        || nc.effectiveType === 'slow-2g'
        || nc.effectiveType === '2g';
  } catch (_) { return false; }
}

function validateFile(file) {
  const ext = ('.' + file.name.split('.').pop()).toLowerCase();
  if (!ACCEPTED_MIME.has(file.type) && !ACCEPTED_EXT.includes(ext))
    return `Format non autorisé — acceptés : ${ACCEPTED_EXT.join(', ')}`;
  if (file.size === 0)       return 'Le fichier est vide.';
  if (file.size > MAX_BYTES) return `Trop volumineux (${fmtSize(file.size)}) — max 1 Go.`;
  return null;
}

// ── Toast ───────────────────────────────────
function toast(msg, type = 'error') {
  const el = document.getElementById('toast');
  el.textContent   = msg;
  el.className     = 'toast show toast-' + type;
  el.style.display = 'block';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.display = 'none'; el.className = 'toast'; }, 4500);
}

// ── DOM helpers ─────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.t-screen').forEach(s => {
    s.classList.remove('active');
    s.style.display = 'none';
  });
  const el = document.getElementById(id);
  el.style.display = 'flex';
  el.classList.add('active');
}

function hide(id)      { const e = document.getElementById(id); if (e) e.style.display = 'none'; }
function showFlex(id)  { const e = document.getElementById(id); if (e) e.style.display = 'flex'; }
function showBlock(id) { const e = document.getElementById(id); if (e) e.style.display = 'block'; }
function setText(id, t){ const e = document.getElementById(id); if (e) e.textContent = t; }

function showError(id, msg) {
  const e = document.getElementById(id);
  if (!e) return;
  e.textContent = msg; e.classList.add('show'); e.style.display = 'block';
}
function hideError(id) {
  const e = document.getElementById(id);
  if (!e) return;
  e.textContent = ''; e.classList.remove('show'); e.style.display = 'none';
}

// ── Teardown ────────────────────────────────
function destroyPeer() {
  peerReady = false; sendStarted = false; connectedOnce = false;
  try { if (conn) conn.close(); } catch (_) {}
  try { if (peer) peer.destroy(); } catch (_) {}
  conn = null; peer = null;
}

function closeRelayFallback() {
  if (relayFallbackWs) { try { relayFallbackWs.close(); } catch (_) {} relayFallbackWs = null; }
  relayFallbackCode = null;
}

function closeRelay() {
  if (relayWs) { try { relayWs.close(); } catch (_) {} relayWs = null; }
  relayMode = null;
}

function resetAll() {
  destroyPeer();
  closeRelayFallback();
  closeRelay();
  stopQRScanner();
  stopRecvQRScanner();
  selectedFiles = []; sendQueue = []; currentSendIdx = 0;
  totalSendBytes = 0; sentBytes = 0;
  recvFiles = []; currentRecvIdx = -1;
  totalRecvExpected = 0; totalRecvSize = 0; totalRecvBytes = 0;
}

// ═══════════════════════════════════════════
//  QR CODE — generate
// ═══════════════════════════════════════════
function generateQRCode(text, canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof qrcode === 'undefined') return;
  try {
    const qr = qrcode(1, 'L');
    qr.addData(text); qr.make();
    const size = qr.getModuleCount();
    const cell = Math.max(2, Math.floor(160 / size));
    canvas.width  = size * cell;
    canvas.height = size * cell;
    const ctx = canvas.getContext('2d');
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        ctx.fillStyle = qr.isDark(r, c) ? '#000' : '#fff';
        ctx.fillRect(c * cell, r * cell, cell, cell);
      }
    }
    canvas.style.display = 'block';
  } catch (e) { console.warn('QR gen:', e); }
}

// ═══════════════════════════════════════════
//  QR CODE — scanner (send side)
// ═══════════════════════════════════════════
let qrScanStream = null;
let qrScanAnim   = null;

async function startQRScanner() {
  const video = document.getElementById('qrVideo');
  try {
    qrScanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }
    });
    video.srcObject = qrScanStream;
    video.addEventListener('loadedmetadata', () => {
      const sc = document.getElementById('qrScanCanvas');
      sc.width  = video.videoWidth  || 640;
      sc.height = video.videoHeight || 480;
      scanQRFrame(video, sc);
    }, { once: true });
  } catch (e) {
    toast('Caméra non disponible : ' + e.message);
    stopQRScanner();
  }
}

function scanQRFrame(video, canvas) {
  if (!qrScanStream) return;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const img  = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
  if (code && code.data) {
    const clean = code.data.trim().replace(/[^a-zA-Z0-9]/g, '');
    if (clean.length >= 4 && clean.length <= 7) {
      stopQRScanner();
      document.getElementById('sendCodeInput').value = clean;
      toast('QR scanné : ' + clean, 'success');
      connectToOther(clean);
      return;
    }
  }
  qrScanAnim = requestAnimationFrame(() => scanQRFrame(video, canvas));
}

function stopQRScanner() {
  if (qrScanStream) { qrScanStream.getTracks().forEach(t => t.stop()); qrScanStream = null; }
  if (qrScanAnim)   { cancelAnimationFrame(qrScanAnim); qrScanAnim = null; }
  hide('panelSendScan');
  const btn = document.getElementById('btnScanQR');
  if (btn) btn.classList.remove('active');
}

// ═══════════════════════════════════════════
//  QR CODE — scanner (recv side)
// ═══════════════════════════════════════════
let recvQrScanStream = null;
let recvQrScanAnim   = null;

async function startRecvQRScanner() {
  const video = document.getElementById('recvQrVideo');
  try {
    recvQrScanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }
    });
    video.srcObject = recvQrScanStream;
    video.addEventListener('loadedmetadata', () => {
      const sc = document.getElementById('recvQrScanCanvas');
      sc.width  = video.videoWidth  || 640;
      sc.height = video.videoHeight || 480;
      scanRecvQRFrame(video, sc);
    }, { once: true });
  } catch (e) {
    toast('Caméra non disponible : ' + e.message);
    stopRecvQRScanner();
  }
}

function scanRecvQRFrame(video, canvas) {
  if (!recvQrScanStream) return;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const img  = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
  if (code && code.data) {
    const clean = code.data.trim().replace(/[^a-zA-Z0-9]/g, '');
    if (clean.length >= 4 && clean.length <= 7) {
      stopRecvQRScanner();
      document.getElementById('recvCodeInput').value = clean;
      toast('QR scanné : ' + clean, 'success');
      connectToOtherAsRecv(clean);
      return;
    }
  }
  recvQrScanAnim = requestAnimationFrame(() => scanRecvQRFrame(video, canvas));
}

function stopRecvQRScanner() {
  if (recvQrScanStream) { recvQrScanStream.getTracks().forEach(t => t.stop()); recvQrScanStream = null; }
  if (recvQrScanAnim)   { cancelAnimationFrame(recvQrScanAnim); recvQrScanAnim = null; }
  hide('panelRecvScan');
  const btn = document.getElementById('btnRecvScanQR');
  if (btn) btn.classList.remove('active');
}

// ═══════════════════════════════════════════
//  SEND MODE
// ═══════════════════════════════════════════
function initSend() {
  mode = 'send';
  showScreen('screenSend');
  resetAll();

  // Reset UI
  showBlock('stepConnect');
  hide('sendConnStatus');
  hide('btnSend');
  hide('sendProgress');
  hide('sendDone');
  hideError('fileError');
  hideError('connectError');
  ['panelSendQR', 'panelSendScan', 'panelSendEnter'].forEach(hide);
  ['btnToggleSendQR', 'btnScanQR', 'btnToggleSendEnter'].forEach(id => {
    const b = document.getElementById(id); if (b) b.classList.remove('active');
  });
  const copySendBtn = document.getElementById('btnCopySendCode');
  if (copySendBtn) copySendBtn.disabled = true;
  const fl = document.getElementById('fileListEl');
  if (fl) fl.innerHTML = '';
  if (document.getElementById('sendCodeInput'))
    document.getElementById('sendCodeInput').value = '';
  selectedFiles = []; sendQueue = []; sendStarted = false; peerReady = false;
  updateSendBtn();
  updateFileCountBadge();

  // Générer code PeerJS (6 chars) + afficher WABC123
  const myCode    = genCode();        // ex: ABC123
  const dispCode  = 'W' + myCode;     // ex: WABC123 (code affiché + partagé)
  document.getElementById('sendCodeDisplay').innerHTML = '<div class="code-spinner"></div>';

  peer = new Peer(myCode, { debug: 0, config: ICE_CONFIG });

  peer.on('open', () => {
    document.getElementById('sendCodeDisplay').innerHTML =
      `<span class="code-chars"><span class="code-prefix-letter">W</span>${myCode}</span>`;
    const copyBtn = document.getElementById('btnCopySendCode');
    if (copyBtn) { copyBtn.disabled = false; copyBtn.dataset.code = dispCode; }
    generateQRCode(dispCode, 'qrCanvasSend');
    // Écouter aussi en relay (fallback si PeerJS échoue ou si Tauri se connecte)
    startSendRelayFallback(myCode.toLowerCase());
  });

  peer.on('connection', c => {
    if (connectedOnce) { try { c.close(); } catch (_) {} return; }
    connectedOnce = true;
    conn = c;
    closeRelayFallback();
    onSendConnected();
    c.on('close', () => {
      if (!sendStarted) {
        peerReady = false; connectedOnce = false; conn = null;
        updateSendBtn(); showBlock('stepConnect'); hide('btnSend');
        toast('Connexion fermée.');
      }
    });
    c.on('error', e => {
      // Ignorer les erreurs de connexion fermée si le transfert est déjà terminé
      if (sendStarted && currentSendIdx >= sendQueue.length) return;
      toast('Erreur connexion : ' + e.message);
      if (!sendStarted) {
        peerReady = false; connectedOnce = false; conn = null;
        updateSendBtn(); showBlock('stepConnect'); hide('btnSend');
      }
    });
  });

  peer.on('disconnected', () => { if (peer && !peer.destroyed) peer.reconnect(); });

  peer.on('error', err => {
    if (err.type === 'unavailable-id') { destroyPeer(); initSend(); }
    else if (err.type === 'peer-unavailable') {
      toast('Destinataire introuvable. Vérifiez le code.');
      hide('sendConnStatus'); hideError('connectError');
    } else {
      toast('Erreur PeerJS : ' + err.message);
    }
  });
}

// Sender connects to receiver
function connectToOther(rawCode) {
  const parsed = reconcileCode(rawCode);
  if (!parsed) {
    showError('connectError', 'Code invalide — ex : WABC123 (web) ou Tabc123 (app desktop).');
    return;
  }

  if (parsed.type === 'tauri') {
    relaySendTo(parsed.code);
    return;
  }

  const code = parsed.code;
  if (code.length !== 6) { showError('connectError', 'Code invalide (6 caractères après le préfixe).'); return; }
  if (!peer) return;

  if (peer.disconnected) {
    peer.reconnect();
    setTimeout(() => connectToOther(rawCode), 800);
    return;
  }

  showFlex('sendConnStatus');
  setText('sendConnText', isLikelyCellular() ? 'Réseau mobile — connexion via relay…' : 'Connexion en cours…');
  hideError('connectError');
  startSendRace(code);
}

// ── Race : PeerJS vs Relay — le premier connecté gagne ──
function startSendRace(code) {
  const skipPeer = isLikelyCellular();
  let won        = false;
  let raceWs     = null;

  const winPeer = () => {
    if (won) return;
    won = true;
    if (raceWs) { try { raceWs.close(); } catch(_) {} raceWs = null; }
    onSendConnected();
    toast('Connecté !', 'success');
  };

  const winRelay = () => {
    if (won) return;
    won = true;
    // Fermer PeerJS silencieusement
    try { if (conn) conn.close(); } catch(_) {} conn = null;
    try { if (peer) peer.destroy(); } catch(_) {} peer = null;
    // Activer relay comme canal principal
    closeRelay();
    relayWs   = raceWs;
    raceWs    = null;
    relayMode = 'send';
    peerReady = true;
    hide('sendConnStatus');
    hide('stepConnect');
    stopQRScanner();
    showBlock('btnSend');
    updateSendBtn();
    toast('Connecté via relay ⚡', 'success');
  };

  // ── Bras 1 : PeerJS (ignoré si réseau mobile) ──
  if (!skipPeer && peer && !peer.disconnected) {
    conn = peer.connect(code, { reliable: true, serialization: 'raw' });
    conn.on('open', winPeer);
    conn.on('close', () => {
      if (!sendStarted && !won) {
        peerReady = false; conn = null;
        hide('sendConnStatus'); showBlock('stepConnect'); updateSendBtn();
      }
    });
    conn.on('error', () => { /* relay peut encore gagner */ });
  }

  // ── Bras 2 : Relay (toujours lancé en parallèle) ──
  try {
    raceWs = new WebSocket(`${RELAY_URL}/ws?code=${code.toLowerCase()}&role=sender`);
    raceWs.binaryType = 'arraybuffer';
    raceWs.onmessage  = (evt) => {
      if (typeof evt.data === 'string' && evt.data === 'PEER_CONNECTED') winRelay();
    };
    raceWs.onerror = () => { if (!won) raceWs = null; };
    raceWs.onclose = () => { if (!won) raceWs = null; };
  } catch(_) {}
}

function onSendConnected() {
  peerReady = true;
  hide('sendConnStatus');
  hide('stepConnect');
  stopQRScanner();
  showBlock('btnSend');
  updateSendBtn();
  toast('Destinataire connecté !', 'success');
}

// ── File selection ──────────────────────────
function handleFiles(files) {
  let hadError = false;
  for (const file of files) {
    if (selectedFiles.some(f => f.name === file.name && f.size === file.size)) continue;
    const err = validateFile(file);
    if (err) { showError('fileError', err); hadError = true; continue; }
    selectedFiles.push(file);
  }
  if (!hadError) hideError('fileError');
  renderFileList();
  updateSendBtn();
  updateFileCountBadge();
}

function removeFile(idx) {
  selectedFiles.splice(idx, 1);
  renderFileList();
  updateSendBtn();
  updateFileCountBadge();
}

function renderFileList() {
  const list = document.getElementById('fileListEl');
  list.innerHTML = '';
  selectedFiles.forEach((f, i) => {
    const item = document.createElement('div');
    item.className = 'file-list-item';
    item.innerHTML = `
      <span class="file-list-icon">${fileIcon(f.name, f.type)}</span>
      <div class="file-list-info">
        <span class="file-list-name">${escHtml(f.name)}</span>
        <span class="file-list-size">${fmtSize(f.size)}</span>
      </div>
      <button class="file-remove-btn" title="Retirer">✕</button>
    `;
    item.querySelector('.file-remove-btn').addEventListener('click', () => removeFile(i));
    list.appendChild(item);
  });
}

function updateFileCountBadge() {
  const badge = document.getElementById('sendFileCount');
  if (!badge) return;
  const n = selectedFiles.length;
  if (n > 0) {
    badge.textContent = n + ' fichier' + (n > 1 ? 's' : '');
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

function updateSendBtn() {
  const btn = document.getElementById('btnSend');
  if (!btn) return;
  btn.disabled = !(peerReady && selectedFiles.length > 0 && !sendStarted);
  const n = selectedFiles.length;
  btn.textContent = n <= 1
    ? `Envoyer${n === 1 ? ' 1 fichier' : ''} ⚡`
    : `Envoyer ${n} fichiers ⚡`;
}

// ── Send logic ──────────────────────────────
function doSend() {
  // Relay a gagné la race → on lui délègue directement
  if (!conn && relayWs && relayWs.readyState === WebSocket.OPEN && relayMode === 'send') {
    doSendViaWs(relayWs);
    return;
  }
  if (!conn || selectedFiles.length === 0 || !peerReady || sendStarted) return;
  sendStarted = true;
  const btn = document.getElementById('btnSend');
  if (btn) btn.disabled = true;

  sendQueue      = [...selectedFiles];
  totalSendBytes = sendQueue.reduce((s, f) => s + f.size, 0);
  sentBytes      = 0;
  currentSendIdx = 0;
  tSendStart     = Date.now();

  const pb = document.getElementById('sendProgress');
  pb.style.display = 'flex'; pb.classList.add('show');

  safeSend(JSON.stringify({ __ft: 'count', total: sendQueue.length, totalBytes: totalSendBytes }));
  sendNextFile();
}

function safeSend(data) {
  if (!conn || !conn.open) return;
  try { conn.send(data); } catch (_) {}
}

function sendNextFile() {
  if (currentSendIdx >= sendQueue.length) {
    safeSend(JSON.stringify({ __ft: 'all-done' }));
    hide('sendProgress');
    const n = sendQueue.length;
    setText('sendDoneName', `${n} fichier${n > 1 ? 's' : ''} envoyé${n > 1 ? 's' : ''} avec succès !`);
    showFlex('sendDone');
    return;
  }

  const file = sendQueue[currentSendIdx];
  safeSend(JSON.stringify({
    __ft: 'meta',
    name: file.name, size: file.size, mime: file.type,
    index: currentSendIdx, total: sendQueue.length,
  }));

  let offset = 0;
  const reader = new FileReader();

  reader.onload = e => {
    safeSend(e.target.result);
    const bytes = e.target.result.byteLength;
    offset    += bytes;
    sentBytes += bytes;
    updateSendProgress(file);
    if (offset < file.size) {
      reader.readAsArrayBuffer(file.slice(offset, offset + CHUNK_SIZE));
    } else {
      safeSend(JSON.stringify({ __ft: 'done', index: currentSendIdx }));
      currentSendIdx++;
      setTimeout(sendNextFile, 0);
    }
  };

  reader.onerror = () => toast('Erreur de lecture du fichier.');
  reader.readAsArrayBuffer(file.slice(0, CHUNK_SIZE));
}

function updateSendProgress(file) {
  const pct     = Math.min(100, Math.round(sentBytes / totalSendBytes * 100));
  const elapsed = (Date.now() - tSendStart) / 1000 || 0.001;
  setText('sendProgPct', pct + '%');
  document.getElementById('sendProgFill').style.width = pct + '%';
  setText('sendProgLabel', `Fichier ${currentSendIdx + 1}/${sendQueue.length} — ${file.name}`);
  setText('sendProgSub',   `${fmtSize(sentBytes)} / ${fmtSize(totalSendBytes)}  ·  ${fmtSpeed(sentBytes / elapsed)}`);
}

// ═══════════════════════════════════════════
//  RECEIVE MODE
// ═══════════════════════════════════════════
function initRecv() {
  mode = 'recv';
  showScreen('screenRecv');
  resetAll();

  showBlock('stepRecvConnect');
  hide('recvConnStatus'); hide('recvProgress'); hide('recvGallery');
  hideError('recvConnectError');
  ['panelRecvQR', 'panelRecvScan'].forEach(hide);
  ['btnToggleRecvQR', 'btnRecvScanQR'].forEach(id => {
    const b = document.getElementById(id); if (b) b.classList.remove('active');
  });
  const copyRecvBtn = document.getElementById('btnCopyRecvCode');
  if (copyRecvBtn) copyRecvBtn.disabled = true;
  if (document.getElementById('recvCodeInput'))
    document.getElementById('recvCodeInput').value = '';
  recvFiles = []; currentRecvIdx = -1;
  totalRecvExpected = 0; totalRecvSize = 0; totalRecvBytes = 0;
  setText('recvProgPct', '0%');
  document.getElementById('recvProgFill').style.width = '0';
  document.getElementById('galleryList').innerHTML    = '';

  // Générer code PeerJS (6 chars) + afficher WABC123
  const myCode   = genCode();
  const dispCode = 'W' + myCode;
  document.getElementById('recvCodeDisplay').innerHTML = '<div class="code-spinner"></div>';
  setText('recvQRStatus', 'Initialisation…');

  peer = new Peer(myCode, { debug: 0, config: ICE_CONFIG });

  peer.on('open', () => {
    setText('recvQRStatus', '⏳ En attente de l\'expéditeur…');
    document.getElementById('recvCodeDisplay').innerHTML =
      `<span class="code-chars"><span class="code-prefix-letter">W</span>${myCode}</span>`;
    const copyBtn = document.getElementById('btnCopyRecvCode');
    if (copyBtn) { copyBtn.disabled = false; copyBtn.dataset.code = dispCode; }
    generateQRCode(dispCode, 'qrCanvas');
    startRecvRelayFallback(myCode.toLowerCase());
  });

  peer.on('connection', c => {
    if (connectedOnce) { try { c.close(); } catch (_) {} return; }
    connectedOnce = true;
    conn = c;
    closeRelayFallback();
    setupRecvConn(c);
  });

  peer.on('disconnected', () => { if (peer && !peer.destroyed) peer.reconnect(); });

  peer.on('error', err => {
    if (err.type === 'unavailable-id') { destroyPeer(); initRecv(); }
    else if (err.type === 'peer-unavailable') {
      toast('Expéditeur introuvable. Vérifiez le code.');
      hide('recvConnStatus');
      showBlock('stepRecvConnect');
    } else {
      toast('Erreur : ' + err.message);
    }
  });
}

// Receiver connects to sender
function connectToOtherAsRecv(rawCode) {
  const parsed = reconcileCode(rawCode);
  if (!parsed) {
    showError('recvConnectError', 'Code invalide — ex : WABC123 (web) ou Tabc123 (app desktop).');
    return;
  }

  if (parsed.type === 'tauri') {
    relayReceiveFrom(parsed.code);
    return;
  }

  const code = parsed.code;
  if (code.length !== 6) { showError('recvConnectError', 'Code invalide (6 caractères après le préfixe).'); return; }
  if (!peer) return;

  if (peer.disconnected) {
    peer.reconnect();
    setTimeout(() => connectToOtherAsRecv(rawCode), 800);
    return;
  }

  hide('stepRecvConnect');
  showFlex('recvConnStatus');
  setText('recvConnIcon', '⏳');
  setText('recvConnText', isLikelyCellular() ? 'Réseau mobile — connexion via relay…' : 'Connexion en cours…');
  hideError('recvConnectError');
  startRecvRace(code);
}

// ── Race réception : PeerJS vs Relay ──
function startRecvRace(code) {
  const skipPeer = isLikelyCellular();
  let won    = false;
  let raceWs = null;

  const winPeer = () => {
    if (won) return;
    won = true;
    if (raceWs) { try { raceWs.close(); } catch(_) {} raceWs = null; }
    setupRecvConn(conn);
  };

  const winRelay = () => {
    if (won) return;
    won = true;
    try { if (conn) conn.close(); } catch(_) {} conn = null;
    try { if (peer) peer.destroy(); } catch(_) {} peer = null;
    closeRelay();
    relayWs   = raceWs;
    raceWs    = null;
    relayMode = 'recv';
    setText('recvConnIcon', '⚡');
    setText('recvConnText', 'Connecté via relay — réception…');
    setupRecvRelayWs(relayWs);
    toast('Connecté via relay ⚡', 'success');
  };

  // ── Bras 1 : PeerJS (ignoré si réseau mobile) ──
  if (!skipPeer && peer && !peer.disconnected) {
    conn = peer.connect(code, { reliable: true, serialization: 'raw' });
    conn.on('open', winPeer);
    conn.on('error', () => { /* relay peut encore gagner */ });
  }

  // ── Bras 2 : Relay (toujours lancé en parallèle) ──
  try {
    raceWs = new WebSocket(`${RELAY_URL}/ws?code=${code.toLowerCase()}&role=receiver`);
    raceWs.binaryType = 'arraybuffer';
    raceWs.onmessage  = (evt) => {
      if (typeof evt.data === 'string' && evt.data === 'PEER_CONNECTED') winRelay();
    };
    raceWs.onerror = () => { if (!won) raceWs = null; };
    raceWs.onclose = () => { if (!won) raceWs = null; };
  } catch(_) {}
}

function setupRecvConn(c) {
  hide('stepRecvConnect');
  stopRecvQRScanner();
  showFlex('recvConnStatus');
  setText('recvConnIcon', '⚡');
  setText('recvConnText', 'Connecté — en attente des fichiers…');

  c.on('data',  data => handleRecvData(data));
  c.on('close', () => {
    if (totalRecvSize > 0 && totalRecvBytes >= totalRecvSize) return;
    toast('L\'expéditeur s\'est déconnecté.');
  });
  c.on('error', e => toast('Erreur connexion : ' + e.message));
}

function handleRecvData(data) {
  if (typeof data === 'string') {
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }

    if (msg.__ft === 'count') {
      totalRecvExpected = msg.total;
      totalRecvSize     = msg.totalBytes || 0;
      hide('recvConnStatus');
      showFlex('recvProgress');
      setText('recvProgLabel', 'Réception en cours…');

    } else if (msg.__ft === 'meta') {
      currentRecvIdx = msg.index;
      recvFiles[currentRecvIdx] = { meta: msg, chunks: [], bytes: 0, blob: null };
      setText('recvProgLabel', `Fichier ${msg.index + 1}/${msg.total} — ${msg.name}`);

    } else if (msg.__ft === 'done') {
      const fi = recvFiles[msg.index];
      if (fi) fi.blob = new Blob(fi.chunks, { type: fi.meta.mime || 'application/octet-stream' });

    } else if (msg.__ft === 'all-done') {
      hide('recvProgress');
      showFileGallery();
    }

  } else {
    if (currentRecvIdx < 0 || !recvFiles[currentRecvIdx]) return;
    const fi = recvFiles[currentRecvIdx];
    let buf;
    if (data instanceof ArrayBuffer) {
      buf = data;
    } else if (ArrayBuffer.isView(data)) {
      buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    } else if (data instanceof Blob) {
      data.arrayBuffer().then(ab => {
        fi.chunks.push(ab); fi.bytes += ab.byteLength;
        totalRecvBytes += ab.byteLength; updateRecvProgress();
      });
      return;
    } else return;
    fi.chunks.push(buf); fi.bytes += buf.byteLength;
    totalRecvBytes += buf.byteLength;
    updateRecvProgress();
  }
}

function updateRecvProgress() {
  const pct = Math.min(100, Math.round(totalRecvBytes / (totalRecvSize || 1) * 100));
  setText('recvProgPct', pct + '%');
  document.getElementById('recvProgFill').style.width = pct + '%';
  setText('recvProgSub', `${fmtSize(totalRecvBytes)} / ${fmtSize(totalRecvSize)}`);
}

// ═══════════════════════════════════════════
//  FILE GALLERY
// ═══════════════════════════════════════════
let activeObjectURLs = [];

function showFileGallery() {
  activeObjectURLs.forEach(u => URL.revokeObjectURL(u));
  activeObjectURLs = [];

  const n = recvFiles.filter(Boolean).length;
  setText('galleryCount', `✅ ${n} fichier${n > 1 ? 's' : ''} reçu${n > 1 ? 's' : ''} !`);
  const list = document.getElementById('galleryList');
  list.innerHTML = '';
  recvFiles.forEach((fi, i) => { if (fi && fi.blob) list.appendChild(createGalleryItem(fi, i)); });
  showBlock('recvGallery');
}

function createGalleryItem(fi, i) {
  const { meta, blob } = fi;
  const icon   = fileIcon(meta.name, meta.mime);
  const objUrl = URL.createObjectURL(blob);
  activeObjectURLs.push(objUrl);
  const prev   = canPreview(meta.mime);

  const div = document.createElement('div');
  div.className = 'gallery-item';
  div.innerHTML = `
    <div class="gallery-item-info">
      <span class="gallery-item-icon">${icon}</span>
      <div class="gallery-item-meta">
        <span class="gallery-item-name">${escHtml(meta.name)}</span>
        <span class="gallery-item-size">${fmtSize(meta.size)}</span>
      </div>
    </div>
    <div class="gallery-item-btns">
      <button class="btn-ga btn-dl">⬇ Télécharger</button>
      ${prev ? '<button class="btn-ga btn-prev">👁 Aperçu</button>' : ''}
      ${prev ? '<button class="btn-ga btn-prn">🖨 Imprimer</button>' : ''}
    </div>
    ${prev ? `<div class="gallery-preview" id="gprev-${i}" style="display:none"></div>` : ''}
  `;

  div.querySelector('.btn-dl').addEventListener('click', () => downloadBlob(blob, meta.name));
  if (prev) {
    div.querySelector('.btn-prev').addEventListener('click', () => togglePreview(div, fi, i, objUrl));
    div.querySelector('.btn-prn').addEventListener('click',  () => printBlob(objUrl, meta.mime));
  }
  return div;
}

function togglePreview(div, fi, i, url) {
  const pEl = div.querySelector(`#gprev-${i}`);
  if (!pEl) return;
  if (pEl.style.display !== 'none') { pEl.style.display = 'none'; pEl.innerHTML = ''; return; }

  pEl.innerHTML = '';
  const { mime } = fi.meta;

  if (/^image\//.test(mime)) {
    const img = document.createElement('img');
    img.src = url; img.className = 'preview-img';
    pEl.appendChild(img);
  } else if (/^video\//.test(mime)) {
    const vid = document.createElement('video');
    vid.src = url; vid.className = 'preview-video';
    vid.controls = true; vid.autoplay = false;
    pEl.appendChild(vid);
  } else if (mime === 'application/pdf') {
    const ifr = document.createElement('iframe');
    ifr.src = url; ifr.className = 'preview-pdf';
    pEl.appendChild(ifr);
  } else if (mime === 'text/plain') {
    fi.blob.text().then(t => {
      const pre = document.createElement('pre');
      pre.className = 'preview-text'; pre.textContent = t;
      pEl.appendChild(pre);
    });
  }
  pEl.style.display = 'block';
}

function printBlob(url, mime) {
  if (mime === 'application/pdf' || /^image\//.test(mime)) {
    const win = window.open(url, '_blank');
    if (win) win.addEventListener('load', () => win.print());
  } else {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px';
    iframe.src = url;
    document.body.appendChild(iframe);
    iframe.onload = () => {
      iframe.contentWindow.print();
      setTimeout(() => iframe.remove(), 3000);
    };
  }
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

// ═══════════════════════════════════════════
//  CONN ACTION TOGGLE GRID
// ═══════════════════════════════════════════
function setupConnActions(actionMap) {
  actionMap.forEach(item => {
    const btn = document.getElementById(item.btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const wasActive = btn.classList.contains('active');
      actionMap.forEach(({ btnId: bId, panelId: pId, onClose: oc }) => {
        const b = document.getElementById(bId);
        const wasOpen = b && b.classList.contains('active');
        if (b) b.classList.remove('active');
        hide(pId);
        if (wasOpen && oc) oc();
      });
      if (!wasActive) {
        btn.classList.add('active');
        showBlock(item.panelId);
        if (item.onOpen) item.onOpen();
      }
    });
  });
}

// ═══════════════════════════════════════════
//  RELAY FALLBACK — écoute relay en parallèle du PeerJS
//  Code relay = code PeerJS en minuscules
// ═══════════════════════════════════════════
function startRecvRelayFallback(code) {
  closeRelayFallback();
  relayFallbackCode = code;
  try {
    relayFallbackWs = new WebSocket(`${RELAY_URL}/ws?code=${code}&role=receiver`);
    relayFallbackWs.binaryType = 'arraybuffer';
  } catch (_) { return; }

  let fileName = '', fileSize = 0, chunks = [], bytesRecv = 0, tStart = 0;

  relayFallbackWs.onmessage = (event) => {
    if (connectedOnce && conn) return;

    if (typeof event.data === 'string') {
      if (event.data === 'PEER_CONNECTED') {
        destroyPeer();
        connectedOnce = true;
        hide('stepRecvConnect');
        stopRecvQRScanner();
        showFlex('recvConnStatus');
        setText('recvConnIcon', '⚡');
        setText('recvConnText', 'Connecté via relay — en attente des fichiers…');
        return;
      }
      if (event.data === 'PEER_DISCONNECTED') {
        if (recvFiles.length > 0 || (bytesRecv > 0 && bytesRecv >= fileSize)) {
          if (fileName && chunks.length > 0) finalizeRelayFile(fileName, fileSize, chunks);
          hide('recvProgress');
          showFileGallery();
        } else if (connectedOnce) {
          toast('L\'expéditeur s\'est déconnecté.');
        }
        return;
      }
      try {
        const meta = JSON.parse(event.data);
        if (meta.error) return;
        if (meta.name && meta.size !== undefined) {
          if (fileName && chunks.length > 0) finalizeRelayFile(fileName, fileSize, chunks);
          fileName = meta.name; fileSize = meta.size;
          chunks = []; bytesRecv = 0; tStart = Date.now();
          hide('recvConnStatus');
          showFlex('recvProgress');
          setText('recvProgLabel', `Réception — ${meta.name}`);
          setText('recvProgPct', '0%');
          document.getElementById('recvProgFill').style.width = '0';
        }
      } catch (_) {}
    } else {
      if (!fileName) return;
      chunks.push(event.data);
      bytesRecv += event.data.byteLength;
      const pct = Math.min(100, Math.round(bytesRecv / (fileSize || 1) * 100));
      const elapsed = (Date.now() - tStart) / 1000 || 0.001;
      setText('recvProgPct', pct + '%');
      document.getElementById('recvProgFill').style.width = pct + '%';
      setText('recvProgSub', `${fmtSize(bytesRecv)} / ${fmtSize(fileSize)}  ·  ${fmtSpeed(bytesRecv / elapsed)}`);
      if (bytesRecv >= fileSize) {
        finalizeRelayFile(fileName, fileSize, chunks);
        fileName = ''; chunks = []; bytesRecv = 0;
        hide('recvProgress');
        showFileGallery();
      }
    }
  };

  relayFallbackWs.onerror = () => {};
}

function startSendRelayFallback(code) {
  closeRelayFallback();
  relayFallbackCode = code;
  try {
    relayFallbackWs = new WebSocket(`${RELAY_URL}/ws?code=${code}&role=sender`);
    relayFallbackWs.binaryType = 'arraybuffer';
  } catch (_) { return; }

  relayFallbackWs.onmessage = (evt) => {
    if (peerReady && conn) return;

    if (typeof evt.data === 'string' && evt.data === 'PEER_CONNECTED') {
      destroyPeer();
      peerReady = true;
      hide('sendConnStatus');
      hide('stepConnect');
      stopQRScanner();
      showBlock('btnSend');
      updateSendBtn();
      toast('Connecté via relay !', 'success');

      const origBtn = document.getElementById('btnSend');
      if (origBtn) {
        origBtn.removeEventListener('click', doSend);
        origBtn.addEventListener('click', doSendViaRelayFallback);
      }
    }
  };

  relayFallbackWs.onerror = () => {};
}

// ═══════════════════════════════════════════
//  ENVOI / RÉCEPTION GÉNÉRIQUE VIA WEBSOCKET
//  Partagé par : relay fallback, relay direct, race winner
// ═══════════════════════════════════════════

// Envoie tous les fichiers sélectionnés sur un WS déjà ouvert (post PEER_CONNECTED)
async function doSendViaWs(ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN || selectedFiles.length === 0 || sendStarted) return;
  sendStarted = true;
  const btn = document.getElementById('btnSend');
  if (btn) btn.disabled = true;

  const pb = document.getElementById('sendProgress');
  pb.style.display = 'flex'; pb.classList.add('show');

  const totalFiles    = selectedFiles.length;
  const totalAllBytes = selectedFiles.reduce((s, f) => s + f.size, 0);
  let totalSent = 0;
  const tStart  = Date.now();

  for (let fi = 0; fi < totalFiles; fi++) {
    const file = selectedFiles[fi];
    ws.send(JSON.stringify({ name: file.name, size: file.size }));
    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(offset + RELAY_CHUNK, file.size);
      const buf = await file.slice(offset, end).arrayBuffer();
      while (ws.bufferedAmount > 1024 * 1024)
        await new Promise(r => setTimeout(r, 50));
      ws.send(buf);
      offset    += buf.byteLength;
      totalSent += buf.byteLength;
      const pct     = Math.min(100, Math.round(totalSent / totalAllBytes * 100));
      const elapsed = (Date.now() - tStart) / 1000 || 0.001;
      setText('sendProgPct', pct + '%');
      document.getElementById('sendProgFill').style.width = pct + '%';
      setText('sendProgLabel', `Fichier ${fi + 1}/${totalFiles} — ${file.name}`);
      setText('sendProgSub',   `${fmtSize(totalSent)} / ${fmtSize(totalAllBytes)}  ·  ${fmtSpeed(totalSent / elapsed)}`);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  hide('sendProgress');
  const n = totalFiles;
  setText('sendDoneName', `${n} fichier${n > 1 ? 's' : ''} envoyé${n > 1 ? 's' : ''} !`);
  showFlex('sendDone');
  try { ws.close(); } catch(_) {}
}

// Configure la réception de fichiers sur un WS déjà connecté (post PEER_CONNECTED)
function setupRecvRelayWs(ws) {
  let fileName = '', fileSize = 0, chunks = [], bytesRecv = 0, tStart = 0;

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      if (event.data === 'PEER_DISCONNECTED') {
        if (recvFiles.length > 0 || (bytesRecv > 0 && bytesRecv >= fileSize)) {
          if (fileName && chunks.length > 0) finalizeRelayFile(fileName, fileSize, chunks);
          hide('recvProgress');
          showFileGallery();
        } else {
          toast('L\'expéditeur s\'est déconnecté.');
          showBlock('stepRecvConnect'); hide('recvConnStatus');
        }
        return;
      }
      try {
        const meta = JSON.parse(event.data);
        if (meta.name && meta.size !== undefined) {
          if (fileName && chunks.length > 0) finalizeRelayFile(fileName, fileSize, chunks);
          fileName = meta.name; fileSize = meta.size;
          chunks = []; bytesRecv = 0; tStart = Date.now();
          hide('recvConnStatus');
          showFlex('recvProgress');
          setText('recvProgLabel', `Réception — ${meta.name}`);
          setText('recvProgPct', '0%');
          document.getElementById('recvProgFill').style.width = '0';
        }
      } catch (_) {}
    } else {
      if (!fileName) return;
      chunks.push(event.data);
      bytesRecv += event.data.byteLength;
      const pct     = Math.min(100, Math.round(bytesRecv / (fileSize || 1) * 100));
      const elapsed = (Date.now() - tStart) / 1000 || 0.001;
      setText('recvProgPct', pct + '%');
      document.getElementById('recvProgFill').style.width = pct + '%';
      setText('recvProgSub', `${fmtSize(bytesRecv)} / ${fmtSize(fileSize)}  ·  ${fmtSpeed(bytesRecv / elapsed)}`);
      if (bytesRecv >= fileSize) {
        finalizeRelayFile(fileName, fileSize, chunks);
        fileName = ''; chunks = []; bytesRecv = 0;
        hide('recvProgress');
        showFileGallery();
      }
    }
  };
  ws.onerror = () => {
    toast('Erreur de connexion au relay.');
    showBlock('stepRecvConnect'); hide('recvConnStatus');
  };
}

async function doSendViaRelayFallback() {
  if (!relayFallbackWs || relayFallbackWs.readyState !== WebSocket.OPEN || selectedFiles.length === 0 || sendStarted) return;
  sendStarted = true;
  const btn = document.getElementById('btnSend');
  if (btn) btn.disabled = true;

  const pb = document.getElementById('sendProgress');
  pb.style.display = 'flex'; pb.classList.add('show');

  const totalFiles    = selectedFiles.length;
  const totalAllBytes = selectedFiles.reduce((s, f) => s + f.size, 0);
  let totalSent = 0;
  const tStart  = Date.now();

  for (let fi = 0; fi < totalFiles; fi++) {
    const file = selectedFiles[fi];
    relayFallbackWs.send(JSON.stringify({ name: file.name, size: file.size }));

    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(offset + RELAY_CHUNK, file.size);
      const buf = await file.slice(offset, end).arrayBuffer();
      while (relayFallbackWs.bufferedAmount > 1024 * 1024)
        await new Promise(r => setTimeout(r, 50));
      relayFallbackWs.send(buf);
      offset = end;
      totalSent += buf.byteLength;

      const pct     = Math.min(100, Math.round(totalSent / totalAllBytes * 100));
      const elapsed = (Date.now() - tStart) / 1000 || 0.001;
      setText('sendProgPct', pct + '%');
      document.getElementById('sendProgFill').style.width = pct + '%';
      setText('sendProgLabel', `Fichier ${fi + 1}/${totalFiles} — ${file.name}`);
      setText('sendProgSub',   `${fmtSize(totalSent)} / ${fmtSize(totalAllBytes)}  ·  ${fmtSpeed(totalSent / elapsed)}`);
    }
  }

  hide('sendProgress');
  setText('sendDoneName', `${totalFiles} fichier${totalFiles > 1 ? 's' : ''} envoyé${totalFiles > 1 ? 's' : ''} !`);
  showFlex('sendDone');
}

// ═══════════════════════════════════════════
//  RELAY BRIDGE — Web ↔ Tauri Desktop
//
//  relaySendTo(code)    : web envoie vers Tauri qui reçoit
//  relayReceiveFrom(code): web reçoit depuis Tauri qui envoie
// ═══════════════════════════════════════════

// ── Relay: envoyer vers Tauri ──
async function relaySendTo(code) {
  if (!selectedFiles.length) return;
  closeRelay();
  relayMode = 'send';
  sendStarted = true;
  const btn = document.getElementById('btnSend');
  if (btn) btn.disabled = true;

  hide('stepConnect');
  showFlex('sendConnStatus');
  setText('sendConnText', 'Connexion au relay…');

  relayWs = new WebSocket(`${RELAY_URL}/ws?code=${code}&role=sender`);
  relayWs.binaryType = 'arraybuffer';

  relayWs.onopen = () => setText('sendConnText', 'En attente du destinataire…');

  relayWs.onmessage = async (event) => {
    if (typeof event.data !== 'string' || event.data !== 'PEER_CONNECTED') return;

    hide('sendConnStatus');
    toast('Destinataire connecté !', 'success');

    const pb = document.getElementById('sendProgress');
    pb.style.display = 'flex'; pb.classList.add('show');

    const totalFiles    = selectedFiles.length;
    const totalAllBytes = selectedFiles.reduce((s, f) => s + f.size, 0);
    let totalSent = 0;
    const tStart  = Date.now();

    for (let fi = 0; fi < totalFiles; fi++) {
      const file = selectedFiles[fi];
      relayWs.send(JSON.stringify({ name: file.name, size: file.size }));

      let offset = 0;
      while (offset < file.size) {
        const end = Math.min(offset + RELAY_CHUNK, file.size);
        const buf = await file.slice(offset, end).arrayBuffer();
        relayWs.send(buf);
        offset = end;
        totalSent += buf.byteLength;

        const pct     = Math.min(100, Math.round(totalSent / totalAllBytes * 100));
        const elapsed = (Date.now() - tStart) / 1000 || 0.001;
        setText('sendProgPct', pct + '%');
        document.getElementById('sendProgFill').style.width = pct + '%';
        setText('sendProgLabel', `Fichier ${fi + 1}/${totalFiles} — ${file.name}`);
        setText('sendProgSub',   `${fmtSize(totalSent)} / ${fmtSize(totalAllBytes)}  ·  ${fmtSpeed(totalSent / elapsed)}`);
        await new Promise(r => setTimeout(r, 0));
      }
    }

    hide('sendProgress');
    setText('sendDoneName', `${totalFiles} fichier${totalFiles > 1 ? 's' : ''} envoyé${totalFiles > 1 ? 's' : ''} !`);
    showFlex('sendDone');
    closeRelay();
  };

  relayWs.onerror = () => {
    toast('Erreur de connexion au relay.');
    hide('sendConnStatus');
    sendStarted = false;
    if (btn) btn.disabled = false;
  };
}

// ── Relay: recevoir depuis Tauri ──
function relayReceiveFrom(code) {
  closeRelay();
  relayMode = 'recv';

  hide('stepRecvConnect');
  stopRecvQRScanner();
  showFlex('recvConnStatus');
  setText('recvConnIcon', '⏳');
  setText('recvConnText', 'Connexion au relay…');
  hideError('recvConnectError');

  relayWs = new WebSocket(`${RELAY_URL}/ws?code=${code}&role=receiver`);
  relayWs.binaryType = 'arraybuffer';

  let fileName = '', fileSize = 0, chunks = [], bytesRecv = 0, tStart = 0;

  relayWs.onopen = () => {
    setText('recvConnIcon', '⚡');
    setText('recvConnText', 'Connecté — en attente des fichiers…');
  };

  relayWs.onmessage = (event) => {
    if (typeof event.data === 'string') {
      if (event.data === 'PEER_CONNECTED') {
        setText('recvConnText', 'Expéditeur connecté — transfert imminent…');
        return;
      }
      if (event.data === 'PEER_DISCONNECTED') {
        if (recvFiles.length > 0 || (bytesRecv > 0 && bytesRecv >= fileSize)) {
          if (fileName && chunks.length > 0) finalizeRelayFile(fileName, fileSize, chunks);
          hide('recvProgress');
          showFileGallery();
        } else {
          toast('L\'expéditeur s\'est déconnecté.');
          showBlock('stepRecvConnect'); hide('recvConnStatus');
        }
        return;
      }
      try {
        const meta = JSON.parse(event.data);
        if (meta.name && meta.size !== undefined) {
          if (fileName && chunks.length > 0) finalizeRelayFile(fileName, fileSize, chunks);
          fileName = meta.name; fileSize = meta.size;
          chunks = []; bytesRecv = 0; tStart = Date.now();
          hide('recvConnStatus');
          showFlex('recvProgress');
          setText('recvProgLabel', `Réception — ${meta.name}`);
          setText('recvProgPct', '0%');
          document.getElementById('recvProgFill').style.width = '0';
        }
      } catch (_) {}

    } else {
      if (!fileName) return;
      chunks.push(event.data);
      bytesRecv += event.data.byteLength;
      const pct     = Math.min(100, Math.round(bytesRecv / (fileSize || 1) * 100));
      const elapsed = (Date.now() - tStart) / 1000 || 0.001;
      setText('recvProgPct', pct + '%');
      document.getElementById('recvProgFill').style.width = pct + '%';
      setText('recvProgSub', `${fmtSize(bytesRecv)} / ${fmtSize(fileSize)}  ·  ${fmtSpeed(bytesRecv / elapsed)}`);

      if (bytesRecv >= fileSize) {
        finalizeRelayFile(fileName, fileSize, chunks);
        fileName = ''; chunks = []; bytesRecv = 0;
        hide('recvProgress');
        showFileGallery();
      }
    }
  };

  relayWs.onerror = () => {
    toast('Erreur de connexion au relay.');
    showBlock('stepRecvConnect'); hide('recvConnStatus');
  };
}

function finalizeRelayFile(name, size, chunks) {
  const ext = name.split('.').pop().toLowerCase();
  const mimeMap = {
    'pdf':'application/pdf', 'doc':'application/msword',
    'docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls':'application/vnd.ms-excel',
    'xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'txt':'text/plain', 'png':'image/png', 'jpg':'image/jpeg', 'jpeg':'image/jpeg',
    'mp4':'video/mp4', 'mov':'video/quicktime', 'm4v':'video/x-m4v',
    'avi':'video/x-msvideo', 'mkv':'video/x-matroska',
    'webm':'video/webm', '3gp':'video/3gpp', '3g2':'video/3gpp2',
  };
  const mime = mimeMap[ext] || 'application/octet-stream';
  const blob = new Blob(chunks, { type: mime });
  recvFiles.push({ meta: { name, size, mime }, blob });
}

// ─ Utilitaire MIME ─
function guessMime(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    pdf: 'application/pdf', txt: 'text/plain',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v',
    avi: 'video/x-msvideo', mkv: 'video/x-matroska',
    webm: 'video/webm', '3gp': 'video/3gpp', '3g2': 'video/3gpp2',
  };
  return map[ext] || 'application/octet-stream';
}

// ═══════════════════════════════════════════
//  INIT (DOMContentLoaded)
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {

  // ── Mode selection ──
  document.getElementById('btnModeSend').addEventListener('click', initSend);
  document.getElementById('btnModeRecv').addEventListener('click', initRecv);

  // ── Back buttons ──
  document.getElementById('btnSendBack').addEventListener('click', () => {
    stopQRScanner(); resetAll(); showScreen('screenMode');
  });
  document.getElementById('btnRecvBack').addEventListener('click', () => {
    stopRecvQRScanner(); resetAll(); showScreen('screenMode');
  });

  // ── Send: conn actions ──
  setupConnActions([
    { btnId: 'btnToggleSendQR',    panelId: 'panelSendQR' },
    { btnId: 'btnScanQR',          panelId: 'panelSendScan', onOpen: startQRScanner, onClose: stopQRScanner },
    { btnId: 'btnToggleSendEnter', panelId: 'panelSendEnter' },
  ]);

  // ── Send: copier code ──
  document.getElementById('btnCopySendCode').addEventListener('click', () => {
    const btn  = document.getElementById('btnCopySendCode');
    const code = btn.dataset.code || document.querySelector('#sendCodeDisplay .code-chars')?.textContent;
    if (!code) return;
    navigator.clipboard.writeText(code)
      .then(() => toast('Code copié !', 'success'))
      .catch(() => {
        const ta = document.createElement('textarea');
        ta.value = code; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
        toast('Code copié !', 'success');
      });
  });

  document.getElementById('btnStopScan').addEventListener('click', stopQRScanner);

  // ── Send: connecter au destinataire ──
  document.getElementById('btnConnect').addEventListener('click', () => {
    connectToOther(document.getElementById('sendCodeInput').value.trim());
  });
  document.getElementById('sendCodeInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btnConnect').click();
  });
  document.getElementById('sendCodeInput').addEventListener('input', e => {
    e.target.value = e.target.value.replace(/[^a-zA-Z0-9]/g, '');
  });

  // ── Recv: conn actions ──
  setupConnActions([
    { btnId: 'btnToggleRecvQR',  panelId: 'panelRecvQR' },
    { btnId: 'btnRecvScanQR',    panelId: 'panelRecvScan', onOpen: startRecvQRScanner, onClose: stopRecvQRScanner },
  ]);

  // ── Recv: copier code ──
  document.getElementById('btnCopyRecvCode').addEventListener('click', () => {
    const btn  = document.getElementById('btnCopyRecvCode');
    const code = btn.dataset.code || document.querySelector('#recvCodeDisplay .code-chars')?.textContent;
    if (!code) return;
    navigator.clipboard.writeText(code)
      .then(() => toast('Code copié !', 'success'))
      .catch(() => {
        const ta = document.createElement('textarea');
        ta.value = code; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
        toast('Code copié !', 'success');
      });
  });

  document.getElementById('btnRecvStopScan').addEventListener('click', stopRecvQRScanner);

  // ── Recv: connecter à l'expéditeur ──
  document.getElementById('btnRecvConnect').addEventListener('click', () => {
    connectToOtherAsRecv(document.getElementById('recvCodeInput').value.trim());
  });
  document.getElementById('recvCodeInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btnRecvConnect').click();
  });
  document.getElementById('recvCodeInput').addEventListener('input', e => {
    e.target.value = e.target.value.replace(/[^a-zA-Z0-9]/g, '');
  });

  // ── File input ──
  document.getElementById('fileInput').addEventListener('change', e => {
    if (e.target.files.length) handleFiles(Array.from(e.target.files));
    e.target.value = '';
  });

  // ── Drag & drop ──
  const dz = document.getElementById('dropzone');
  dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', ()  => dz.classList.remove('dragover'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('dragover');
    const files = Array.from(e.dataTransfer.files);
    if (files.length) handleFiles(files);
  });

  // ── Send button ──
  document.getElementById('btnSend').addEventListener('click', doSend);

  // ── Nouveau transfert ──
  document.getElementById('btnNewTransfer').addEventListener('click', initRecv);
  document.getElementById('btnNewSend').addEventListener('click', () => {
    resetAll(); showScreen('screenMode');
  });

  showScreen('screenMode');
});
