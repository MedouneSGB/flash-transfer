'use strict';

// ═══════════════════════════════════════════
//  Flash Transfer — Web Transfer (WebSocket Relay)
//
//  Compatible with the Tauri desktop app.
//  Both use the same relay server + protocol.
// ═══════════════════════════════════════════

const RELAY_URL = 'wss://flash-transfer-7vj7.onrender.com';

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
const CHUNK_SIZE   = 256 * 1024; // 256KB — matches Tauri app

// ── State ──────────────────────────────────
let ws        = null;
let mode      = null;  // 'send' | 'recv'
let myCode    = '';

// Send side
let sendStarted    = false;
let selectedFiles  = [];

// Receive side
let recvFiles         = [];
let recvFileName      = '';
let recvFileSize      = 0;
let recvChunks        = [];
let recvBytes         = 0;
let recvStart         = 0;

// ── Utilities ───────────────────────────────
function genCode() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
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
  if (mime?.includes('word')      || /\.docx?$/.test(name))   return '📝';
  if (mime?.includes('excel')     || /\.xlsx?$/.test(name))   return '📊';
  if (/^image\//.test(mime))                                   return '🖼️';
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
function closeWs() {
  if (ws) {
    try { ws.close(); } catch (_) {}
    ws = null;
  }
}

function resetAll() {
  closeWs();
  stopQRScanner();
  stopRecvQRScanner();
  selectedFiles = [];
  sendStarted = false;
  recvFiles = []; recvFileName = ''; recvFileSize = 0;
  recvChunks = []; recvBytes = 0;
  myCode = '';
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
    const text = code.data.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (text.length === 6) {
      stopQRScanner();
      document.getElementById('sendCodeInput').value = text;
      toast('QR scanné : ' + text, 'success');
      connectToReceiver(text);
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
    const text = code.data.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (text.length === 6) {
      stopRecvQRScanner();
      document.getElementById('recvCodeInput').value = text;
      toast('QR scanné : ' + text, 'success');
      connectToSender(text);
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
  selectedFiles = []; sendStarted = false;
  updateSendBtn();

  // Generate code and connect to relay as sender
  myCode = genCode();
  document.getElementById('sendCodeDisplay').innerHTML = '<div class="code-spinner"></div>';

  ws = new WebSocket(`${RELAY_URL}/ws?code=${myCode}&role=sender`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    document.getElementById('sendCodeDisplay').innerHTML =
      `<span class="code-chars">${myCode.toUpperCase()}</span>`;
    const copyBtn = document.getElementById('btnCopySendCode');
    if (copyBtn) copyBtn.disabled = false;
    generateQRCode(myCode, 'qrCanvasSend');
  };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      if (event.data === 'PEER_CONNECTED') {
        onSendConnected();
      } else if (event.data === 'PEER_DISCONNECTED') {
        if (!sendStarted) {
          toast('Le destinataire s\'est déconnecté.');
        }
      }
    }
  };

  ws.onerror = () => {
    toast('Erreur de connexion au serveur relay.');
    document.getElementById('sendCodeDisplay').innerHTML =
      '<span style="color:var(--error-c);font-size:.9rem">Erreur relay</span>';
  };

  ws.onclose = () => {
    if (!sendStarted) {
      // Allow reconnect by re-init
    }
  };
}

// Sender connects to a receiver's code (sender joins receiver's room)
function connectToReceiver(rawCode) {
  const code = rawCode.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (code.length < 4) { showError('connectError', 'Code invalide (min 4 caractères).'); return; }

  // Close existing connection and join the receiver's room as sender
  closeWs();

  showFlex('sendConnStatus');
  setText('sendConnText', 'Connexion en cours…');
  hideError('connectError');

  ws = new WebSocket(`${RELAY_URL}/ws?code=${code}&role=sender`);
  ws.binaryType = 'arraybuffer';
  myCode = code;

  ws.onopen = () => {
    // If the receiver is already there, relay will send PEER_CONNECTED
    // Otherwise we wait
  };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      if (event.data === 'PEER_CONNECTED') {
        hide('sendConnStatus');
        onSendConnected();
        toast('Destinataire connecté !', 'success');
      } else if (event.data === 'PEER_DISCONNECTED') {
        if (!sendStarted) {
          toast('Le destinataire s\'est déconnecté.');
          hide('sendConnStatus');
          showBlock('stepConnect');
        }
      }
    }
  };

  ws.onerror = () => {
    toast('Impossible de se connecter au relay.');
    hide('sendConnStatus');
  };

  setTimeout(() => {
    if (ws && ws.readyState === WebSocket.OPEN && !sendStarted) {
      // Still waiting — the receiver might not be there yet, that's ok
    }
  }, 15000);
}

function onSendConnected() {
  hide('sendConnStatus');
  hide('stepConnect');
  stopQRScanner();
  showBlock('btnSend');
  updateSendBtn();
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
  const connected = ws && ws.readyState === WebSocket.OPEN;
  btn.disabled = !(connected && selectedFiles.length > 0 && !sendStarted);
  const n = selectedFiles.length;
  btn.textContent = n <= 1
    ? `Envoyer${n === 1 ? ' 1 fichier' : ''} ⚡`
    : `Envoyer ${n} fichiers ⚡`;
}

// ── Send logic (one file at a time via relay) ──
async function doSend() {
  if (!ws || selectedFiles.length === 0 || sendStarted) return;
  sendStarted = true;
  const btn = document.getElementById('btnSend');
  if (btn) btn.disabled = true;

  const pb = document.getElementById('sendProgress');
  pb.style.display = 'flex'; pb.classList.add('show');

  const totalFiles = selectedFiles.length;
  let totalSentBytes = 0;
  const totalAllBytes = selectedFiles.reduce((s, f) => s + f.size, 0);
  const tStart = Date.now();

  for (let fi = 0; fi < totalFiles; fi++) {
    const file = selectedFiles[fi];

    // Send metadata as JSON text — matches Tauri protocol
    ws.send(JSON.stringify({ name: file.name, size: file.size }));

    // Stream file in chunks
    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const chunk = file.slice(offset, end);
      const buf = await chunk.arrayBuffer();
      ws.send(buf);
      offset = end;
      totalSentBytes += buf.byteLength;

      // Update progress
      const pct = Math.min(100, Math.round(totalSentBytes / totalAllBytes * 100));
      const elapsed = (Date.now() - tStart) / 1000 || 0.001;
      setText('sendProgPct', pct + '%');
      document.getElementById('sendProgFill').style.width = pct + '%';
      setText('sendProgLabel', `Fichier ${fi + 1}/${totalFiles} — ${file.name}`);
      setText('sendProgSub', `${fmtSize(totalSentBytes)} / ${fmtSize(totalAllBytes)}  ·  ${fmtSpeed(totalSentBytes / elapsed)}`);

      // Small yield to keep UI responsive
      if (offset < file.size) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
  }

  hide('sendProgress');
  const n = totalFiles;
  setText('sendDoneName', `${n} fichier${n > 1 ? 's' : ''} envoyé${n > 1 ? 's' : ''} avec succès !`);
  showFlex('sendDone');
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
  ['panelRecvQR', 'panelRecvScan', 'panelRecvEnter'].forEach(hide);
  ['btnToggleRecvQR', 'btnRecvScanQR', 'btnToggleRecvEnter'].forEach(id => {
    const b = document.getElementById(id); if (b) b.classList.remove('active');
  });
  const copyRecvBtn = document.getElementById('btnCopyRecvCode');
  if (copyRecvBtn) copyRecvBtn.disabled = true;
  if (document.getElementById('recvCodeInput'))
    document.getElementById('recvCodeInput').value = '';
  recvFiles = []; recvFileName = ''; recvFileSize = 0;
  recvChunks = []; recvBytes = 0;
  setText('recvProgPct', '0%');
  document.getElementById('recvProgFill').style.width = '0';
  document.getElementById('galleryList').innerHTML    = '';

  // Generate code and connect as receiver
  myCode = genCode();
  document.getElementById('recvCodeDisplay').innerHTML = '<div class="code-spinner"></div>';
  setText('recvQRStatus', 'Connexion au relay…');

  ws = new WebSocket(`${RELAY_URL}/ws?code=${myCode}&role=receiver`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    setText('recvQRStatus', 'En attente de l\'expéditeur…');
    document.getElementById('recvCodeDisplay').innerHTML =
      `<span class="code-chars">${myCode.toUpperCase()}</span>`;
    const copyBtn = document.getElementById('btnCopyRecvCode');
    if (copyBtn) copyBtn.disabled = false;
    generateQRCode(myCode, 'qrCanvas');
  };

  ws.onmessage = (event) => handleRecvMessage(event);

  ws.onerror = () => {
    toast('Erreur de connexion au relay.');
    setText('recvQRStatus', 'Erreur — rechargez la page.');
  };

  ws.onclose = () => {
    if (recvBytes > 0 && recvBytes >= recvFileSize) return; // normal close after transfer
    // Unexpected close
  };
}

// Receiver connects to a sender's code
function connectToSender(rawCode) {
  const code = rawCode.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (code.length < 4) { showError('recvConnectError', 'Code invalide (min 4 caractères).'); return; }

  closeWs();
  hide('stepRecvConnect');
  showFlex('recvConnStatus');
  setText('recvConnIcon', '⏳');
  setText('recvConnText', 'Connexion en cours…');
  hideError('recvConnectError');

  ws = new WebSocket(`${RELAY_URL}/ws?code=${code}&role=receiver`);
  ws.binaryType = 'arraybuffer';
  myCode = code;

  ws.onopen = () => {
    setText('recvConnIcon', '⚡');
    setText('recvConnText', 'Connecté — en attente des fichiers…');
  };

  ws.onmessage = (event) => handleRecvMessage(event);

  ws.onerror = () => {
    toast('Impossible de se connecter au relay.');
    showBlock('stepRecvConnect'); hide('recvConnStatus');
  };

  setTimeout(() => {
    if (ws && ws.readyState === WebSocket.OPEN && recvBytes === 0 && recvFileSize === 0) {
      // Still waiting — normal, sender may not have started yet
    }
  }, 15000);
}

function handleRecvMessage(event) {
  if (typeof event.data === 'string') {
    // Control messages or JSON metadata
    if (event.data === 'PEER_CONNECTED') {
      hide('stepRecvConnect');
      stopRecvQRScanner();
      showFlex('recvConnStatus');
      setText('recvConnIcon', '⚡');
      setText('recvConnText', 'Connecté — en attente des fichiers…');
      return;
    }
    if (event.data === 'PEER_DISCONNECTED') {
      if (recvFileSize > 0 && recvBytes >= recvFileSize) return;
      // If we received files, show gallery anyway
      if (recvFiles.length > 0) {
        hide('recvProgress');
        showFileGallery();
        return;
      }
      toast('L\'expéditeur s\'est déconnecté.');
      return;
    }

    // Try parsing as JSON metadata — Tauri protocol: {"name":"file.txt","size":12345}
    try {
      const meta = JSON.parse(event.data);
      if (meta.name && meta.size !== undefined) {
        // If we had a previous file in progress, finalize it
        if (recvFileName && recvChunks.length > 0) {
          finalizeRecvFile();
        }

        recvFileName = meta.name;
        recvFileSize = meta.size;
        recvChunks   = [];
        recvBytes    = 0;
        recvStart    = Date.now();

        hide('recvConnStatus');
        showFlex('recvProgress');
        setText('recvProgLabel', `Réception — ${meta.name}`);
        setText('recvProgPct', '0%');
        document.getElementById('recvProgFill').style.width = '0';
      }
    } catch (_) {
      // Not JSON, ignore
    }

  } else {
    // Binary data — file chunk
    if (!recvFileName) return;

    const buf = event.data;
    recvChunks.push(buf);
    recvBytes += buf.byteLength;

    // Update progress
    const pct = Math.min(100, Math.round(recvBytes / (recvFileSize || 1) * 100));
    const elapsed = (Date.now() - recvStart) / 1000 || 0.001;
    setText('recvProgPct', pct + '%');
    document.getElementById('recvProgFill').style.width = pct + '%';
    setText('recvProgSub', `${fmtSize(recvBytes)} / ${fmtSize(recvFileSize)}  ·  ${fmtSpeed(recvBytes / elapsed)}`);

    // File complete?
    if (recvBytes >= recvFileSize) {
      finalizeRecvFile();
      hide('recvProgress');
      showFileGallery();
    }
  }
}

function finalizeRecvFile() {
  if (!recvFileName || recvChunks.length === 0) return;

  // Guess MIME type from extension
  const ext = recvFileName.split('.').pop().toLowerCase();
  const mimeMap = {
    'pdf': 'application/pdf',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'txt': 'text/plain',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
  };
  const mime = mimeMap[ext] || 'application/octet-stream';

  const blob = new Blob(recvChunks, { type: mime });
  recvFiles.push({
    meta: { name: recvFileName, size: recvFileSize, mime },
    blob,
  });

  // Reset for next file
  recvFileName = '';
  recvFileSize = 0;
  recvChunks   = [];
  recvBytes    = 0;
}

// ═══════════════════════════════════════════
//  FILE GALLERY (receive)
// ═══════════════════════════════════════════
let activeObjectURLs = [];

function showFileGallery() {
  activeObjectURLs.forEach(u => URL.revokeObjectURL(u));
  activeObjectURLs = [];

  const n = recvFiles.length;
  setText('galleryCount', `${n} fichier${n > 1 ? 's' : ''} reçu${n > 1 ? 's' : ''} !`);
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
      <button class="btn-ga btn-dl">Télécharger</button>
      ${prev ? '<button class="btn-ga btn-prev">Aperçu</button>' : ''}
      ${prev ? '<button class="btn-ga btn-prn">Imprimer</button>' : ''}
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
    connectToReceiver(document.getElementById('sendCodeInput').value.trim());
  });
  document.getElementById('sendCodeInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btnConnect').click();
  });
  document.getElementById('sendCodeInput').addEventListener('input', e => {
    e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '');
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
    connectToSender(document.getElementById('recvCodeInput').value.trim());
  });
  document.getElementById('recvCodeInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btnRecvConnect').click();
  });
  document.getElementById('recvCodeInput').addEventListener('input', e => {
    e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '');
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

  showScreen('screenMode');
});
