'use strict';

// ═══════════════════════════════════════════
//  Flash Transfer — Web Transfer (PeerJS)
//
//  2 modes:
//   send — select files, then connect to receiver (scan/code)
//   recv — show own QR/code, and/or scan sender's QR/code
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
]);
const ACCEPTED_EXT = ['.txt', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.png', '.jpg', '.jpeg'];
const MAX_BYTES    = 25 * 1024 * 1024;
const CHUNK_SIZE   = 64 * 1024;

// ── State ──────────────────────────────────
let peer      = null;
let conn      = null;
let mode      = null;  // 'send' | 'recv'

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

// Relay fallback for PeerJS mode
let relayFallbackWs   = null; // secondary relay WS that listens alongside PeerJS
let relayFallbackCode = null;

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
  if (mime === 'text/plain'       || name.endsWith('.txt'))   return '📃';
  return '📁';
}

function canPreview(mime) {
  return /^image\//.test(mime) || mime === 'application/pdf' || mime === 'text/plain';
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function validateFile(file) {
  const ext = ('.' + file.name.split('.').pop()).toLowerCase();
  if (!ACCEPTED_MIME.has(file.type) && !ACCEPTED_EXT.includes(ext))
    return `Format non autorisé — acceptés : ${ACCEPTED_EXT.join(', ')}`;
  if (file.size === 0)       return 'Le fichier est vide.';
  if (file.size > MAX_BYTES) return `Trop volumineux (${fmtSize(file.size)}) — max 25 Mo.`;
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

function resetAll() {
  destroyPeer();
  closeRelayFallback();
  // Close relay WebSocket if active
  if (typeof closeRelay === 'function') closeRelay();
  stopQRScanner();
  stopRecvQRScanner();
  selectedFiles = []; sendQueue = []; currentSendIdx = 0;
  totalSendBytes = 0; sentBytes = 0;
  recvFiles = []; currentRecvIdx = -1;
  totalRecvExpected = 0; totalRecvSize = 0; totalRecvBytes = 0;
}

function closeRelayFallback() {
  if (relayFallbackWs) { try { relayFallbackWs.close(); } catch (_) {} relayFallbackWs = null; }
  relayFallbackCode = null;
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
    const text = code.data.trim();
    const clean = text.replace(/[^a-zA-Z0-9]/g, '');
    if (clean.length >= 4 && clean.length <= 12) {
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
    const text = code.data.trim();
    const clean = text.replace(/[^a-zA-Z0-9]/g, '');
    if (clean.length >= 4 && clean.length <= 12) {
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
  showBlock('stepConnect');              // toujours visible au reset
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

  // Initialise peer (QR + code générés en arrière-plan, visibles via panneaux)
  const myCode = genCode();
  document.getElementById('sendCodeDisplay').innerHTML = '<div class="code-spinner"></div>';

  peer = new Peer(myCode, { debug: 0, config: ICE_CONFIG });

  peer.on('open', id => {
    document.getElementById('sendCodeDisplay').innerHTML = `<span class="code-chars">${myCode}</span>`;
    const copyBtn = document.getElementById('btnCopySendCode');
    if (copyBtn) copyBtn.disabled = false;
    generateQRCode(id, 'qrCanvasSend');

    // Also listen on relay as fallback (lowercase version of same code)
    startSendRelayFallback(myCode.toLowerCase());
  });

  // Receiver may connect to us
  peer.on('connection', c => {
    if (connectedOnce) { try { c.close(); } catch (_) {} return; }
    connectedOnce = true;
    conn = c;
    closeRelayFallback(); // PeerJS connected, no need for relay fallback
    onSendConnected();
    c.on('close', () => {
      if (!sendStarted) {
        peerReady = false; connectedOnce = false; conn = null;
        updateSendBtn(); showBlock('stepConnect'); hide('btnSend');
        toast('Connexion fermée.');
      }
    });
    c.on('error', e => {
      toast('Erreur connexion : ' + e.message);
      if (!sendStarted) {
        peerReady = false; connectedOnce = false; conn = null;
        updateSendBtn(); showBlock('stepConnect'); hide('btnSend');
      }
    });
  });

  peer.on('disconnected', () => {
    if (peer && !peer.destroyed) peer.reconnect();
  });

  peer.on('error', err => {
    if (err.type === 'unavailable-id') { destroyPeer(); initSend(); }
    else if (err.type === 'peer-unavailable') {
      toast('Destinataire introuvable. Vérifiez le code.');
      hide('sendConnStatus');
      hideError('connectError');
    } else {
      toast('Erreur PeerJS : ' + err.message);
    }
  });
}

// Sender initiates connection to receiver
function connectToOther(rawCode) {
  // Relay code detection: Tauri codes contain only lowercase letters + digits
  // PeerJS codes contain only uppercase letters + digits
  const trimmed = rawCode.trim();
  if (/^[a-z0-9]{4,12}$/.test(trimmed)) {
    relaySendTo(trimmed);
    return;
  }
  const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) { showError('connectError', 'Code invalide (6 caractères attendus).'); return; }
  if (!peer) return;

  if (peer.disconnected) {
    peer.reconnect();
    setTimeout(() => connectToOther(rawCode), 800);
    return;
  }

  showFlex('sendConnStatus');
  setText('sendConnText', 'Connexion en cours…');
  hideError('connectError');

  conn = peer.connect(code, { reliable: true, serialization: 'raw' });

  conn.on('open', () => {
    hide('sendConnStatus');
    onSendConnected();
    toast('Destinataire connecté !', 'success');
  });
  conn.on('close', () => {
    if (!sendStarted) {
      peerReady = false; conn = null;
      hide('sendConnStatus'); showBlock('stepConnect'); updateSendBtn();
      toast('Connexion fermée par le destinataire.');
    }
  });
  conn.on('error', e => {
    toast('Erreur : ' + e.message);
    peerReady = false; conn = null;
    hide('sendConnStatus'); showBlock('stepConnect'); updateSendBtn();
  });

  setTimeout(() => {
    if (conn && !conn.open && !peerReady) {
      // PeerJS timed out — fallback to relay
      toast('Connexion directe échouée, bascule sur le relay…', 'success');
      setText('sendConnText', 'Bascule sur le relay…');
      try { conn.close(); } catch (_) {}
      conn = null;
      relaySendTo(code.toLowerCase());
    }
  }, 8000);
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
}

function removeFile(idx) {
  selectedFiles.splice(idx, 1);
  renderFileList();
  updateSendBtn();
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

  conn.send(JSON.stringify({ __ft: 'count', total: sendQueue.length, totalBytes: totalSendBytes }));
  sendNextFile();
}

function sendNextFile() {
  if (currentSendIdx >= sendQueue.length) {
    conn.send(JSON.stringify({ __ft: 'all-done' }));
    hide('sendProgress');
    const n = sendQueue.length;
    setText('sendDoneName', `${n} fichier${n > 1 ? 's' : ''} envoyé${n > 1 ? 's' : ''} avec succès !`);
    showFlex('sendDone');
    return;
  }

  const file = sendQueue[currentSendIdx];
  conn.send(JSON.stringify({
    __ft: 'meta',
    name: file.name, size: file.size, mime: file.type,
    index: currentSendIdx, total: sendQueue.length,
  }));

  let offset = 0;
  const reader = new FileReader();

  reader.onload = e => {
    try { conn.send(e.target.result); }
    catch (err) { toast('Erreur envoi : ' + err.message); return; }
    const bytes = e.target.result.byteLength;
    offset    += bytes;
    sentBytes += bytes;
    updateSendProgress(file);
    if (offset < file.size) {
      reader.readAsArrayBuffer(file.slice(offset, offset + CHUNK_SIZE));
    } else {
      conn.send(JSON.stringify({ __ft: 'done', index: currentSendIdx }));
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
  setText('sendProgPct',   pct + '%');
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

  showBlock('stepRecvConnect');          // toujours visible au reset
  hide('recvConnStatus'); hide('recvProgress'); hide('recvGallery');
  hideError('recvConnectError');
  ['panelRecvQR', 'panelRecvScan', 'panelRecvEnter'].forEach(hide);
  ['btnToggleRecvQR', 'btnRecvScanQR', 'btnToggleRecvEnter'].forEach(id => {
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

  // Initialise peer (QR + code générés en arrière-plan, visibles via panneaux)
  const myCode = genCode();
  document.getElementById('recvCodeDisplay').innerHTML = '<div class="code-spinner"></div>';
  setText('recvQRStatus', 'Initialisation…');

  peer = new Peer(myCode, { debug: 0, config: ICE_CONFIG });

  peer.on('open', id => {
    setText('recvQRStatus', '⏳ En attente de l\'expéditeur…');
    document.getElementById('recvCodeDisplay').innerHTML = `<span class="code-chars">${myCode}</span>`;
    const copyBtn = document.getElementById('btnCopyRecvCode');
    if (copyBtn) copyBtn.disabled = false;
    generateQRCode(id, 'qrCanvas');

    // Also listen on relay as fallback (lowercase version of same code)
    startRecvRelayFallback(myCode.toLowerCase());
  });

  // Sender may connect to us
  peer.on('connection', c => {
    if (connectedOnce) { try { c.close(); } catch (_) {} return; }
    connectedOnce = true;
    conn = c;
    closeRelayFallback(); // PeerJS connected, no need for relay fallback
    setupRecvConn(c);
  });

  peer.on('disconnected', () => {
    if (peer && !peer.destroyed) peer.reconnect();
  });

  peer.on('error', err => {
    if (err.type === 'unavailable-id') { destroyPeer(); initRecv(); }
    else if (err.type === 'peer-unavailable') {
      toast('Expéditeur introuvable. Vérifiez le code.');
      hide('recvConnStatus');
      showBlock('stepRecvConnect');
      hideError('recvConnectError');
    } else {
      toast('Erreur : ' + err.message);
    }
  });
}

// Receiver initiates connection to sender
function connectToOtherAsRecv(rawCode) {
  // Relay code detection: Tauri codes are lowercase
  const trimmed = rawCode.trim();
  if (/^[a-z0-9]{4,12}$/.test(trimmed)) {
    relayReceiveFrom(trimmed);
    return;
  }
  const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) { showError('recvConnectError', 'Code invalide (6 caractères attendus).'); return; }
  if (!peer) return;

  if (peer.disconnected) {
    peer.reconnect();
    setTimeout(() => connectToOtherAsRecv(rawCode), 800);
    return;
  }

  hide('stepRecvConnect');
  showFlex('recvConnStatus');
  setText('recvConnIcon', '⏳');
  setText('recvConnText', 'Connexion en cours…');
  hideError('recvConnectError');

  conn = peer.connect(code, { reliable: true, serialization: 'raw' });

  conn.on('open', () => setupRecvConn(conn));
  conn.on('error', e => {
    toast('Erreur : ' + e.message);
    showBlock('stepRecvConnect'); hide('recvConnStatus');
  });

  setTimeout(() => {
    if (conn && !conn.open && totalRecvBytes === 0) {
      // PeerJS timed out — fallback to relay
      toast('Connexion directe échouée, bascule sur le relay…', 'success');
      setText('recvConnText', 'Bascule sur le relay…');
      try { conn.close(); } catch (_) {}
      conn = null;
      relayReceiveFrom(code.toLowerCase());
    }
  }, 8000);
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
//  FILE GALLERY (receive)
// ═══════════════════════════════════════════
// Track ObjectURLs to revoke them on cleanup
let activeObjectURLs = [];

function showFileGallery() {
  // Revoke any previously created ObjectURLs
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
//  RELAY FALLBACK — listen on relay alongside PeerJS
//
//  When initRecv()/initSend() opens a PeerJS peer with code ABCDEF,
//  we also connect to the relay server with code "abcdef" (lowercase).
//  If the other side falls back to relay (e.g. PeerJS timeout),
//  it will connect to the same relay room and data flows.
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
    // If PeerJS already connected, ignore relay
    if (connectedOnce && conn) return;

    if (typeof event.data === 'string') {
      if (event.data === 'PEER_CONNECTED') {
        // Sender connected via relay — switch to relay mode
        destroyPeer(); // kill PeerJS, relay wins
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

  relayFallbackWs.onerror = () => {}; // silent — it's just a fallback
}

function startSendRelayFallback(code) {
  closeRelayFallback();
  relayFallbackCode = code;
  try {
    relayFallbackWs = new WebSocket(`${RELAY_URL}/ws?code=${code}&role=sender`);
    relayFallbackWs.binaryType = 'arraybuffer';
  } catch (_) { return; }

  relayFallbackWs.onmessage = (evt) => {
    // If PeerJS already connected, ignore relay
    if (peerReady && conn) return;

    if (typeof evt.data === 'string' && evt.data === 'PEER_CONNECTED') {
      // Receiver connected via relay — switch to relay mode
      destroyPeer(); // kill PeerJS, relay wins
      peerReady = true;
      hide('sendConnStatus');
      hide('stepConnect');
      stopQRScanner();
      showBlock('btnSend');
      updateSendBtn();
      toast('Connecté via relay !', 'success');

      // Override doSend to use relay
      const origBtn = document.getElementById('btnSend');
      if (origBtn) {
        origBtn.removeEventListener('click', doSend);
        origBtn.addEventListener('click', doSendViaRelayFallback);
      }
    }
  };

  relayFallbackWs.onerror = () => {}; // silent
}

async function doSendViaRelayFallback() {
  if (!relayFallbackWs || relayFallbackWs.readyState !== WebSocket.OPEN || selectedFiles.length === 0 || sendStarted) return;
  sendStarted = true;
  const btn = document.getElementById('btnSend');
  if (btn) btn.disabled = true;

  const pb = document.getElementById('sendProgress');
  pb.style.display = 'flex'; pb.classList.add('show');

  const totalFiles = selectedFiles.length;
  const totalAllBytes = selectedFiles.reduce((s, f) => s + f.size, 0);
  let totalSent = 0;
  const tStart = Date.now();

  for (let fi = 0; fi < totalFiles; fi++) {
    const file = selectedFiles[fi];
    relayFallbackWs.send(JSON.stringify({ name: file.name, size: file.size }));

    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(offset + RELAY_CHUNK, file.size);
      const chunk = file.slice(offset, end);
      const buf = await chunk.arrayBuffer();
      while (relayFallbackWs.bufferedAmount > 1024 * 1024) {
        await new Promise(r => setTimeout(r, 50));
      }
      relayFallbackWs.send(buf);
      offset = end;
      totalSent += buf.byteLength;

      const pct = Math.min(100, Math.round(totalSent / totalAllBytes * 100));
      const elapsed = (Date.now() - tStart) / 1000 || 0.001;
      setText('sendProgPct', pct + '%');
      document.getElementById('sendProgFill').style.width = pct + '%';
      setText('sendProgLabel', `Fichier ${fi + 1}/${totalFiles} — ${file.name}`);
      setText('sendProgSub', `${fmtSize(totalSent)} / ${fmtSize(totalAllBytes)}  ·  ${fmtSpeed(totalSent / elapsed)}`);
    }
  }

  hide('sendProgress');
  setText('sendDoneName', `${totalFiles} fichier${totalFiles > 1 ? 's' : ''} envoyé${totalFiles > 1 ? 's' : ''} !`);
  showFlex('sendDone');
}

// ═══════════════════════════════════════════
//  RELAY MODE (Desktop ↔ Website)
// ═══════════════════════════════════════════
const RELAY_URL = 'wss://flash-transfer-7vj7.onrender.com';
const RELAY_CHUNK = 256 * 1024; // 256KB chunks (same as desktop)

let relayWs            = null;
let relaySelectedFiles = [];
let relaySendStarted   = false;
let relayPeerReady     = false;

// ── Relay: teardown ──
function destroyRelay() {
  relaySendStarted = false;
  relayPeerReady   = false;
  try { if (relayWs) relayWs.close(); } catch (_) {}
  relayWs = null;
}

function resetRelay() {
  destroyRelay();
  relaySelectedFiles = [];
}

// ── Relay: genCode (lowercase like desktop) ──
function genRelayCode() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => chars[b % chars.length]).join('');
}

// ── Relay Send: file handling ──
function handleRelayFiles(files) {
  let hadError = false;
  for (const file of files) {
    if (relaySelectedFiles.some(f => f.name === file.name && f.size === file.size)) continue;
    const err = validateFile(file);
    if (err) { showError('relayFileError', err); hadError = true; continue; }
    relaySelectedFiles.push(file);
  }
  if (!hadError) hideError('relayFileError');
  renderRelayFileList();
  updateRelaySendBtn();
}

function removeRelayFile(idx) {
  relaySelectedFiles.splice(idx, 1);
  renderRelayFileList();
  updateRelaySendBtn();
}

function renderRelayFileList() {
  const list = document.getElementById('relayFileListEl');
  list.innerHTML = '';
  relaySelectedFiles.forEach((f, i) => {
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
    item.querySelector('.file-remove-btn').addEventListener('click', () => removeRelayFile(i));
    list.appendChild(item);
  });
}

function updateRelaySendBtn() {
  const btn = document.getElementById('btnRelaySend');
  if (!btn) return;
  btn.disabled = !(relayPeerReady && relaySelectedFiles.length > 0 && !relaySendStarted);
  const n = relaySelectedFiles.length;
  btn.textContent = n <= 1
    ? `Envoyer${n === 1 ? ' 1 fichier' : ''} via relay ⚡`
    : `Envoyer ${n} fichiers via relay ⚡`;
}

// ── Relay Send: init ──
function initRelaySend() {
  showScreen('screenDesktopSend');
  resetRelay();

  // Reset UI
  hide('btnRelaySend');
  hide('relaySendProgress');
  hide('relaySendDone');
  hideError('relayFileError');
  document.getElementById('relayFileListEl').innerHTML = '';
  document.getElementById('btnCopyRelaySendCode').disabled = true;
  document.getElementById('relaySendCodeDisplay').innerHTML = '<div class="code-spinner"></div>';
  setText('relaySendStatus', 'Connexion au serveur relay...');
  showBlock('stepRelaySendConnect');

  const myCode = genRelayCode();

  relayWs = new WebSocket(`${RELAY_URL}/ws?code=${myCode}&role=sender`);
  relayWs.binaryType = 'arraybuffer';

  relayWs.onopen = () => {
    document.getElementById('relaySendCodeDisplay').innerHTML = `<span class="code-chars code-chars-lower">${myCode}</span>`;
    document.getElementById('btnCopyRelaySendCode').disabled = false;
    setText('relaySendStatus', 'En attente de l\'app desktop...');
  };

  relayWs.onmessage = (evt) => {
    if (typeof evt.data === 'string') {
      if (evt.data === 'PEER_CONNECTED') {
        relayPeerReady = true;
        setText('relaySendStatus', 'App desktop connectée !');
        showBlock('btnRelaySend');
        updateRelaySendBtn();
        toast('App desktop connectée !', 'success');
      } else if (evt.data === 'PEER_DISCONNECTED') {
        relayPeerReady = false;
        if (!relaySendStarted) {
          hide('btnRelaySend');
          setText('relaySendStatus', 'App desktop déconnectée.');
          toast('App desktop déconnectée.');
        }
      } else {
        // Check for error JSON
        try {
          const msg = JSON.parse(evt.data);
          if (msg.error) toast('Erreur relay : ' + msg.error);
        } catch (_) {}
      }
    }
  };

  relayWs.onerror = () => {
    toast('Impossible de se connecter au serveur relay.');
    setText('relaySendStatus', 'Erreur de connexion.');
  };

  relayWs.onclose = () => {
    if (!relaySendStarted) {
      setText('relaySendStatus', 'Connexion fermée.');
    }
  };
}

// ── Relay Send: stream files ──
async function doRelaySend() {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN || relaySelectedFiles.length === 0 || !relayPeerReady || relaySendStarted) return;
  relaySendStarted = true;
  document.getElementById('btnRelaySend').disabled = true;
  hide('stepRelaySendConnect');

  const pb = document.getElementById('relaySendProgress');
  pb.style.display = 'flex'; pb.classList.add('show');

  const totalBytes = relaySelectedFiles.reduce((s, f) => s + f.size, 0);
  let sentBytes = 0;
  const tStart = Date.now();

  for (let fi = 0; fi < relaySelectedFiles.length; fi++) {
    const file = relaySelectedFiles[fi];

    // Send metadata JSON
    relayWs.send(JSON.stringify({ name: file.name, size: file.size }));

    // Stream file in chunks
    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(offset + RELAY_CHUNK, file.size);
      const chunk = file.slice(offset, end);
      const buf = await chunk.arrayBuffer();

      // Wait if WS bufferedAmount is too high (backpressure)
      while (relayWs.bufferedAmount > 1024 * 1024) {
        await new Promise(r => setTimeout(r, 50));
      }

      relayWs.send(buf);
      offset = end;
      sentBytes += buf.byteLength;

      // Update progress
      const pct = Math.min(100, Math.round(sentBytes / totalBytes * 100));
      const elapsed = (Date.now() - tStart) / 1000 || 0.001;
      setText('relaySendProgPct', pct + '%');
      document.getElementById('relaySendProgFill').style.width = pct + '%';
      setText('relaySendProgLabel', `Fichier ${fi + 1}/${relaySelectedFiles.length} — ${file.name}`);
      setText('relaySendProgSub', `${fmtSize(sentBytes)} / ${fmtSize(totalBytes)}  ·  ${fmtSpeed(sentBytes / elapsed)}`);
    }
  }

  // Done
  hide('relaySendProgress');
  const n = relaySelectedFiles.length;
  setText('relaySendDoneName', `${n} fichier${n > 1 ? 's' : ''} envoyé${n > 1 ? 's' : ''} !`);
  showFlex('relaySendDone');
}

// ── Relay Receive: init ──
function initRelayRecv() {
  showScreen('screenDesktopRecv');
  resetRelay();

  // Reset UI
  showBlock('stepRelayRecvConnect');
  hide('relayRecvConnStatus');
  hide('relayRecvProgress');
  hide('relayRecvGallery');
  hideError('relayRecvError');
  document.getElementById('relayRecvCodeInput').value = '';
  document.getElementById('relayGalleryList').innerHTML = '';
}

// ── Relay Receive: connect ──
function connectRelayRecv(rawCode) {
  const code = rawCode.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (code.length < 4 || code.length > 12) {
    showError('relayRecvError', 'Code invalide (4-12 caractères alphanumériques).');
    return;
  }

  hide('stepRelayRecvConnect');
  showFlex('relayRecvConnStatus');
  setText('relayRecvConnIcon', '⏳');
  setText('relayRecvConnText', 'Connexion au relay...');
  hideError('relayRecvError');

  relayWs = new WebSocket(`${RELAY_URL}/ws?code=${code}&role=receiver`);
  relayWs.binaryType = 'arraybuffer';

  let fileName = '';
  let fileSize = 0;
  let receivedBytes = 0;
  let chunks = [];
  const tStart = Date.now();

  relayWs.onopen = () => {
    setText('relayRecvConnIcon', '⚡');
    setText('relayRecvConnText', 'Connecté — en attente du fichier...');
  };

  relayWs.onmessage = (evt) => {
    if (typeof evt.data === 'string') {
      // Could be PEER_CONNECTED, PEER_DISCONNECTED, metadata JSON, or error
      if (evt.data === 'PEER_CONNECTED') {
        setText('relayRecvConnText', 'Expéditeur connecté — en attente du fichier...');
        return;
      }
      if (evt.data === 'PEER_DISCONNECTED') {
        if (receivedBytes === 0) {
          toast('L\'expéditeur s\'est déconnecté.');
          showBlock('stepRelayRecvConnect');
          hide('relayRecvConnStatus');
        }
        return;
      }

      try {
        const msg = JSON.parse(evt.data);
        if (msg.error) {
          toast('Erreur relay : ' + msg.error);
          showBlock('stepRelayRecvConnect');
          hide('relayRecvConnStatus');
          return;
        }
        if (msg.name && msg.size !== undefined) {
          fileName = msg.name;
          fileSize = msg.size;
          receivedBytes = 0;
          chunks = [];
          hide('relayRecvConnStatus');
          const pb = document.getElementById('relayRecvProgress');
          pb.style.display = 'flex'; pb.classList.add('show');
          setText('relayRecvProgLabel', `Réception — ${fileName}`);
        }
      } catch (_) {}
    } else {
      // Binary data: file chunk
      const buf = evt.data instanceof ArrayBuffer ? evt.data : new Uint8Array(evt.data).buffer;
      chunks.push(buf);
      receivedBytes += buf.byteLength;

      const pct = Math.min(100, Math.round(receivedBytes / (fileSize || 1) * 100));
      const elapsed = (Date.now() - tStart) / 1000 || 0.001;
      setText('relayRecvProgPct', pct + '%');
      document.getElementById('relayRecvProgFill').style.width = pct + '%';
      setText('relayRecvProgSub', `${fmtSize(receivedBytes)} / ${fmtSize(fileSize)}  ·  ${fmtSpeed(receivedBytes / elapsed)}`);

      if (receivedBytes >= fileSize) {
        // File complete
        hide('relayRecvProgress');
        const blob = new Blob(chunks);
        showRelayRecvGallery(fileName, fileSize, blob);
      }
    }
  };

  relayWs.onerror = () => {
    toast('Impossible de se connecter au relay.');
    showBlock('stepRelayRecvConnect');
    hide('relayRecvConnStatus');
  };

  relayWs.onclose = () => {
    if (receivedBytes > 0 && receivedBytes < fileSize) {
      toast('Connexion perdue pendant le transfert.');
    }
  };
}

// ── Relay Receive: gallery ──
function showRelayRecvGallery(name, size, blob) {
  const mime = blob.type || guessMime(name);
  setText('relayGalleryCount', '✅ Fichier reçu !');
  const list = document.getElementById('relayGalleryList');
  list.innerHTML = '';

  const icon   = fileIcon(name, mime);
  const objUrl = URL.createObjectURL(blob);
  const prev   = canPreview(mime);

  const div = document.createElement('div');
  div.className = 'gallery-item';
  div.innerHTML = `
    <div class="gallery-item-info">
      <span class="gallery-item-icon">${icon}</span>
      <div class="gallery-item-meta">
        <span class="gallery-item-name">${escHtml(name)}</span>
        <span class="gallery-item-size">${fmtSize(size)}</span>
      </div>
    </div>
    <div class="gallery-item-btns">
      <button class="btn-ga btn-dl">⬇ Télécharger</button>
      ${prev ? '<button class="btn-ga btn-prev">👁 Aperçu</button>' : ''}
    </div>
    ${prev ? '<div class="gallery-preview relay-gprev" style="display:none"></div>' : ''}
  `;

  div.querySelector('.btn-dl').addEventListener('click', () => downloadBlob(blob, name));
  if (prev) {
    div.querySelector('.btn-prev').addEventListener('click', () => {
      const pEl = div.querySelector('.relay-gprev');
      if (pEl.style.display !== 'none') { pEl.style.display = 'none'; pEl.innerHTML = ''; return; }
      pEl.innerHTML = '';
      if (/^image\//.test(mime)) {
        const img = document.createElement('img');
        img.src = objUrl; img.className = 'preview-img';
        pEl.appendChild(img);
      } else if (mime === 'application/pdf') {
        const ifr = document.createElement('iframe');
        ifr.src = objUrl; ifr.className = 'preview-pdf';
        pEl.appendChild(ifr);
      } else if (mime === 'text/plain') {
        blob.text().then(t => {
          const pre = document.createElement('pre');
          pre.className = 'preview-text'; pre.textContent = t;
          pEl.appendChild(pre);
        });
      }
      pEl.style.display = 'block';
    });
  }

  list.appendChild(div);
  showBlock('relayRecvGallery');
  toast('Fichier reçu !', 'success');
}

function guessMime(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    pdf: 'application/pdf', txt: 'text/plain',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  };
  return map[ext] || 'application/octet-stream';
}

// ═══════════════════════════════════════════
//  INIT
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

  // ── Send: conn action grid (3 boutons) ──
  setupConnActions([
    { btnId: 'btnToggleSendQR',    panelId: 'panelSendQR' },
    { btnId: 'btnScanQR',          panelId: 'panelSendScan', onOpen: startQRScanner, onClose: stopQRScanner },
    { btnId: 'btnToggleSendEnter', panelId: 'panelSendEnter' },
  ]);

  // ── Copier code envoi ──
  document.getElementById('btnCopySendCode').addEventListener('click', () => {
    const code = document.querySelector('#sendCodeDisplay .code-chars')?.textContent;
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => toast('Code copié !', 'success'))
      .catch(() => {
        const ta = document.createElement('textarea');
        ta.value = code; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
        toast('Code copié !', 'success');
      });
  });
  document.getElementById('btnStopScan').addEventListener('click', stopQRScanner);

  // ── Send: connect to receiver by code ──
  document.getElementById('btnConnect').addEventListener('click', () => {
    connectToOther(document.getElementById('sendCodeInput').value.trim());
  });
  document.getElementById('sendCodeInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btnConnect').click();
  });
  document.getElementById('sendCodeInput').addEventListener('input', e => {
    e.target.value = e.target.value.replace(/[^a-zA-Z0-9]/g, '');
  });

  // ── Recv: conn action grid (3 boutons) ──
  setupConnActions([
    { btnId: 'btnToggleRecvQR',    panelId: 'panelRecvQR' },
    { btnId: 'btnRecvScanQR',      panelId: 'panelRecvScan', onOpen: startRecvQRScanner, onClose: stopRecvQRScanner },
    { btnId: 'btnToggleRecvEnter', panelId: 'panelRecvEnter' },
  ]);

  // ── Copier code réception ──
  document.getElementById('btnCopyRecvCode').addEventListener('click', () => {
    const code = document.querySelector('#recvCodeDisplay .code-chars')?.textContent;
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => toast('Code copié !', 'success'))
      .catch(() => {
        const ta = document.createElement('textarea');
        ta.value = code; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
        toast('Code copié !', 'success');
      });
  });
  document.getElementById('btnRecvStopScan').addEventListener('click', stopRecvQRScanner);

  // ── Recv: connect to sender by code ──
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

  // ── New transfer ──
  document.getElementById('btnNewTransfer').addEventListener('click', initRecv);
  document.getElementById('btnNewSend').addEventListener('click', () => {
    resetAll(); showScreen('screenMode');
  });

  // ── Desktop relay mode ──
  document.getElementById('btnModeDesktop').addEventListener('click', () => showScreen('screenDesktop'));
  document.getElementById('btnDesktopBack').addEventListener('click', () => { resetRelay(); showScreen('screenMode'); });
  document.getElementById('btnDesktopSend').addEventListener('click', initRelaySend);
  document.getElementById('btnDesktopRecv').addEventListener('click', initRelayRecv);

  document.getElementById('btnDesktopSendBack').addEventListener('click', () => { resetRelay(); showScreen('screenDesktop'); });
  document.getElementById('btnDesktopRecvBack').addEventListener('click', () => { resetRelay(); showScreen('screenDesktop'); });

  // Relay send: file input
  document.getElementById('relayFileInput').addEventListener('change', e => {
    if (e.target.files.length) handleRelayFiles(Array.from(e.target.files));
    e.target.value = '';
  });

  // Relay send: drag & drop
  const rdz = document.getElementById('relayDropzone');
  rdz.addEventListener('dragover',  e => { e.preventDefault(); rdz.classList.add('dragover'); });
  rdz.addEventListener('dragleave', ()  => rdz.classList.remove('dragover'));
  rdz.addEventListener('drop', e => {
    e.preventDefault(); rdz.classList.remove('dragover');
    const files = Array.from(e.dataTransfer.files);
    if (files.length) handleRelayFiles(files);
  });

  // Relay send: send button
  document.getElementById('btnRelaySend').addEventListener('click', doRelaySend);

  // Relay send: copy code
  document.getElementById('btnCopyRelaySendCode').addEventListener('click', () => {
    const code = document.querySelector('#relaySendCodeDisplay .code-chars')?.textContent;
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => toast('Code copié !', 'success'))
      .catch(() => {
        const ta = document.createElement('textarea');
        ta.value = code; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
        toast('Code copié !', 'success');
      });
  });

  // Relay send: new transfer
  document.getElementById('btnNewRelaySend').addEventListener('click', () => { resetRelay(); showScreen('screenDesktop'); });

  // Relay recv: connect button
  document.getElementById('btnRelayRecvConnect').addEventListener('click', () => {
    connectRelayRecv(document.getElementById('relayRecvCodeInput').value);
  });
  document.getElementById('relayRecvCodeInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btnRelayRecvConnect').click();
  });

  // Relay recv: new transfer
  document.getElementById('btnNewRelayRecv').addEventListener('click', () => { resetRelay(); showScreen('screenDesktop'); });

  showScreen('screenMode');
});

// ═══════════════════════════════════════════
//  RELAY BRIDGE — Web ↔ Tauri Desktop
//
//  Tauri uses lowercase codes via a WebSocket relay.
//  PeerJS uses uppercase codes via WebRTC.
//  This bridge lets the website talk to Tauri apps
//  by detecting the code format and routing accordingly.
//  (Uses shared RELAY_URL, RELAY_CHUNK, relayWs from above)
// ═══════════════════════════════════════════

let relayMode = null; // 'send' | 'recv' | null

function isRelayCode(code) {
  // Tauri codes are lowercase alphanumeric; PeerJS codes are uppercase
  return /^[a-z0-9]{4,12}$/.test(code);
}

function closeRelay() {
  if (relayWs) { try { relayWs.close(); } catch (_) {} relayWs = null; }
  relayMode = null;
}

// ── Relay: receive file from Tauri sender ──────────
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
          // Finalize if in progress
          if (fileName && chunks.length > 0) {
            finalizeRelayFile(fileName, fileSize, chunks);
          }
          hide('recvProgress');
          showFileGallery();
        } else {
          toast('L\'expéditeur s\'est déconnecté.');
          showBlock('stepRecvConnect'); hide('recvConnStatus');
        }
        return;
      }
      // JSON metadata from Tauri: {"name":"file.txt","size":12345}
      try {
        const meta = JSON.parse(event.data);
        if (meta.name && meta.size !== undefined) {
          // Finalize previous file if any
          if (fileName && chunks.length > 0) {
            finalizeRelayFile(fileName, fileSize, chunks);
          }
          fileName = meta.name;
          fileSize = meta.size;
          chunks = [];
          bytesRecv = 0;
          tStart = Date.now();
          hide('recvConnStatus');
          showFlex('recvProgress');
          setText('recvProgLabel', `Réception — ${meta.name}`);
          setText('recvProgPct', '0%');
          document.getElementById('recvProgFill').style.width = '0';
        }
      } catch (_) {}

    } else {
      // Binary chunk
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
  };
  const mime = mimeMap[ext] || 'application/octet-stream';
  const blob = new Blob(chunks, { type: mime });
  recvFiles.push({ meta: { name, size, mime }, blob });
}

// ── Relay: send file to Tauri receiver ──────────
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

  relayWs.onopen = () => {
    setText('sendConnText', 'En attente du destinataire…');
  };

  relayWs.onmessage = async (event) => {
    if (typeof event.data === 'string' && event.data === 'PEER_CONNECTED') {
      hide('sendConnStatus');
      toast('Destinataire connecté !', 'success');

      // Stream files
      const pb = document.getElementById('sendProgress');
      pb.style.display = 'flex'; pb.classList.add('show');

      const totalFiles = selectedFiles.length;
      const totalAllBytes = selectedFiles.reduce((s, f) => s + f.size, 0);
      let totalSent = 0;
      const tStart = Date.now();

      for (let fi = 0; fi < totalFiles; fi++) {
        const file = selectedFiles[fi];
        // Send metadata JSON — Tauri protocol
        relayWs.send(JSON.stringify({ name: file.name, size: file.size }));

        let offset = 0;
        while (offset < file.size) {
          const end = Math.min(offset + RELAY_CHUNK, file.size);
          const chunk = file.slice(offset, end);
          const buf = await chunk.arrayBuffer();
          relayWs.send(buf);
          offset = end;
          totalSent += buf.byteLength;

          const pct = Math.min(100, Math.round(totalSent / totalAllBytes * 100));
          const elapsed = (Date.now() - tStart) / 1000 || 0.001;
          setText('sendProgPct', pct + '%');
          document.getElementById('sendProgFill').style.width = pct + '%';
          setText('sendProgLabel', `Fichier ${fi + 1}/${totalFiles} — ${file.name}`);
          setText('sendProgSub', `${fmtSize(totalSent)} / ${fmtSize(totalAllBytes)}  ·  ${fmtSpeed(totalSent / elapsed)}`);
          await new Promise(r => setTimeout(r, 0));
        }
      }

      hide('sendProgress');
      setText('sendDoneName', `${totalFiles} fichier${totalFiles > 1 ? 's' : ''} envoyé${totalFiles > 1 ? 's' : ''} !`);
      showFlex('sendDone');
      closeRelay();
    }
  };

  relayWs.onerror = () => {
    toast('Erreur de connexion au relay.');
    hide('sendConnStatus');
    sendStarted = false;
    if (btn) btn.disabled = false;
  };
}
