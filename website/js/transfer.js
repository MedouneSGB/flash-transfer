'use strict';

// ═══════════════════════════════════════════
//  Flash Transfer — Web Transfer v2 (PeerJS)
//
//  4 modes:
//   sendCode — sender shows own code/QR, receiver dials in
//   sendScan — sender scans receiver's QR / enters their code
//   recvCode — receiver enters sender's code
//   recvQR   — receiver shows own QR, sender scans & sends
// ═══════════════════════════════════════════

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
let subMode   = null;  // 'sendCode' | 'sendScan' | 'recvCode' | 'recvQR'

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
let recvFiles         = [];   // Array<{meta, chunks, bytes, blob}>
let currentRecvIdx    = -1;
let totalRecvExpected = 0;
let totalRecvSize     = 0;
let totalRecvBytes    = 0;

// ── Utilities ───────────────────────────────
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.random() * chars.length | 0]).join('');
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
  stopQRScanner();
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
//  QR CODE — scan (send-scan mode)
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
    showBlock('qrScannerWrap');
    video.addEventListener('loadedmetadata', () => {
      const sc = document.getElementById('qrScanCanvas');
      sc.width  = video.videoWidth  || 640;
      sc.height = video.videoHeight || 480;
      scanQRFrame(video, sc);
    }, { once: true });
  } catch (e) {
    toast('Caméra non disponible : ' + e.message);
  }
}

function scanQRFrame(video, canvas) {
  if (!qrScanStream) return;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const img  = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
  if (code && code.data) {
    const text = code.data.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
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
  hide('qrScannerWrap');
}

// ═══════════════════════════════════════════
//  SEND — shared helpers
// ═══════════════════════════════════════════
function resetSendShared() {
  hide('stepFiles'); hide('btnSend'); hide('sendProgress'); hide('sendDone');
  hide('sendConnStatus');
  const fl = document.getElementById('fileListEl');
  if (fl) fl.innerHTML = '';
  hideError('fileError');
  selectedFiles = []; sendQueue = []; sendStarted = false; peerReady = false;
  updateSendBtn();
}

function onSendConnected() {
  peerReady = true;
  hide('sendConnStatus');
  showBlock('stepFiles');
  showBlock('btnSend');
  setText('stepFilesLabel',
    subMode === 'sendCode'
      ? 'Destinataire connecté — sélectionnez vos fichiers'
      : '2 — Sélectionnez les fichiers à envoyer');
  updateSendBtn();
}

// ═══════════════════════════════════════════
//  SEND MODE A — "Envoyer par code" (show MY code, receiver dials in)
// ═══════════════════════════════════════════
function initSendCode() {
  subMode = 'sendCode';
  showScreen('screenSend');
  setText('sendTitle', 'Envoyer par code');
  resetAll();
  resetSendShared();

  showBlock('stepSendCode');
  hide('stepSendScan');

  const code = genCode();
  document.getElementById('sendCodeDisplay').innerHTML = `<span class="code-chars">${code}</span>`;
  setText('sendStatus', 'Initialisation…');

  peer = new Peer(code, { debug: 0 });

  peer.on('open', id => {
    setText('sendStatus', '⏳ En attente du destinataire…');
    generateQRCode(id, 'qrCanvasSend');
  });

  peer.on('connection', c => {
    if (connectedOnce) { try { c.close(); } catch (_) {} return; }
    connectedOnce = true;
    conn = c;
    c.on('open', () => onSendConnected());
    c.on('close', () => {
      if (!sendStarted) { peerReady = false; setText('sendStatus', '❌ Connexion fermée.'); updateSendBtn(); }
    });
    c.on('error', e => toast('Erreur connexion : ' + e.message));
  });

  peer.on('error', err => {
    if (err.type === 'unavailable-id') { destroyPeer(); initSendCode(); }
    else toast('Erreur PeerJS : ' + err.message);
  });
}

// ═══════════════════════════════════════════
//  SEND MODE B — "Envoyer par scan" (scan receiver's QR)
// ═══════════════════════════════════════════
function initSendScan() {
  subMode = 'sendScan';
  showScreen('screenSend');
  setText('sendTitle', 'Envoyer par scan QR');
  resetAll();
  resetSendShared();

  hide('stepSendCode');
  showBlock('stepSendScan');

  if (document.getElementById('sendCodeInput'))
    document.getElementById('sendCodeInput').value = '';
  hideError('connectError');

  peer = new Peer({ debug: 0 });
  peer.on('error', err => {
    if (err.type === 'peer-unavailable') {
      toast('Destinataire introuvable. Vérifiez le code.');
      showBlock('stepSendScan'); hide('sendConnStatus'); hideError('connectError');
    } else {
      toast('Erreur PeerJS : ' + err.message);
    }
  });
}

function connectToReceiver(rawCode) {
  const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) { showError('connectError', 'Code invalide (6 caractères attendus).'); return; }
  if (!peer) return;

  hide('stepSendScan');
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
      peerReady = false;
      toast('Connexion fermée par le destinataire.');
      showBlock('stepSendScan'); hide('sendConnStatus');
    }
  });
  conn.on('error', e => {
    toast('Erreur : ' + e.message);
    showBlock('stepSendScan'); hide('sendConnStatus');
  });

  setTimeout(() => {
    if (conn && !conn.open && !peerReady) {
      toast('Délai dépassé. Vérifiez le code.');
      showBlock('stepSendScan'); hide('sendConnStatus');
    }
  }, 10000);
}

// ═══════════════════════════════════════════
//  FILE SELECTION (multi — both send modes)
// ═══════════════════════════════════════════
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

// ═══════════════════════════════════════════
//  SEND LOGIC — multi-file queue (both send modes)
// ═══════════════════════════════════════════
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
//  RECEIVE — shared helpers
// ═══════════════════════════════════════════
function resetRecvShared() {
  hide('recvConnStatus'); hide('recvProgress'); hide('recvGallery');
  hideError('recvConnectError');
  recvFiles = []; currentRecvIdx = -1;
  totalRecvExpected = 0; totalRecvSize = 0; totalRecvBytes = 0;
  setText('recvProgPct', '0%');
  document.getElementById('recvProgFill').style.width = '0';
  document.getElementById('galleryList').innerHTML    = '';
}

function setupRecvConn(c) {
  hide('stepRecvQR'); hide('stepRecvCode');
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
    // Binary chunk
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
//  RECEIVE MODE A — "Recevoir par QR" (show MY QR, sender scans)
// ═══════════════════════════════════════════
function initRecvQR() {
  subMode = 'recvQR';
  showScreen('screenRecv');
  setText('recvTitle', 'Recevoir par QR code');
  resetAll();
  resetRecvShared();

  showBlock('stepRecvQR');
  hide('stepRecvCode');
  document.getElementById('qrCanvas').style.display = 'none';
  document.getElementById('recvCodeDisplay').innerHTML = '<div class="code-spinner"></div>';
  setText('recvQRStatus', 'Initialisation…');

  const code = genCode();
  peer = new Peer(code, { debug: 0 });

  peer.on('open', id => {
    setText('recvQRStatus', '⏳ En attente de l\'expéditeur…');
    document.getElementById('recvCodeDisplay').innerHTML = `<span class="code-chars">${code}</span>`;
    generateQRCode(id, 'qrCanvas');
  });

  peer.on('connection', c => {
    if (connectedOnce) { try { c.close(); } catch (_) {} return; }
    connectedOnce = true;
    conn = c;
    setupRecvConn(c);
  });

  peer.on('error', err => {
    if (err.type === 'unavailable-id') { destroyPeer(); initRecvQR(); }
    else toast('Erreur : ' + err.message);
  });
}

// ═══════════════════════════════════════════
//  RECEIVE MODE B — "Recevoir par code" (enter sender's code)
// ═══════════════════════════════════════════
function initRecvCode() {
  subMode = 'recvCode';
  showScreen('screenRecv');
  setText('recvTitle', 'Recevoir par code');
  resetAll();
  resetRecvShared();

  hide('stepRecvQR');
  showBlock('stepRecvCode');
  if (document.getElementById('recvCodeInput'))
    document.getElementById('recvCodeInput').value = '';
  hideError('recvConnectError');

  peer = new Peer({ debug: 0 });
  peer.on('error', err => {
    if (err.type === 'peer-unavailable') {
      toast('Code introuvable. Vérifiez le code ou demandez à l\'expéditeur de recharger.');
      showBlock('stepRecvCode'); hide('recvConnStatus'); hideError('recvConnectError');
    } else {
      toast('Erreur : ' + err.message);
    }
  });
}

function connectToSender(rawCode) {
  const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) { showError('recvConnectError', 'Code invalide (6 caractères attendus).'); return; }
  if (!peer) return;

  hide('stepRecvCode');
  showFlex('recvConnStatus');
  setText('recvConnIcon', '⏳');
  setText('recvConnText', 'Connexion en cours…');
  hideError('recvConnectError');

  conn = peer.connect(code, { reliable: true, serialization: 'raw' });

  conn.on('open', () => setupRecvConn(conn));
  conn.on('error', e => {
    toast('Erreur : ' + e.message);
    showBlock('stepRecvCode'); hide('recvConnStatus');
  });

  setTimeout(() => {
    if (conn && !conn.open && totalRecvBytes === 0) {
      toast('Délai dépassé. Vérifiez le code.');
      showBlock('stepRecvCode'); hide('recvConnStatus');
    }
  }, 10000);
}

// ═══════════════════════════════════════════
//  FILE GALLERY (both receive modes)
// ═══════════════════════════════════════════
function showFileGallery() {
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
//  INIT
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {

  // ── Mode selection ──
  document.getElementById('btnSendCode').addEventListener('click', initSendCode);
  document.getElementById('btnSendScan').addEventListener('click', initSendScan);
  document.getElementById('btnRecvCode').addEventListener('click', initRecvCode);
  document.getElementById('btnRecvQR').addEventListener('click',   initRecvQR);

  // ── Back buttons ──
  document.getElementById('btnSendBack').addEventListener('click', () => {
    stopQRScanner(); resetAll(); showScreen('screenMode');
  });
  document.getElementById('btnRecvBack').addEventListener('click', () => {
    resetAll(); showScreen('screenMode');
  });

  // ── QR scanner (send-scan mode) ──
  document.getElementById('btnScanQR').addEventListener('click', startQRScanner);
  document.getElementById('btnStopScan').addEventListener('click', stopQRScanner);

  // ── Connect to receiver (send-scan mode) ──
  document.getElementById('btnConnect').addEventListener('click', () => {
    connectToReceiver(document.getElementById('sendCodeInput').value.trim());
  });
  document.getElementById('sendCodeInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btnConnect').click();
  });
  document.getElementById('sendCodeInput').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  // ── Connect to sender (recv-code mode) ──
  document.getElementById('btnRecvConnect').addEventListener('click', () => {
    connectToSender(document.getElementById('recvCodeInput').value.trim());
  });
  document.getElementById('recvCodeInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btnRecvConnect').click();
  });
  document.getElementById('recvCodeInput').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  // ── File input (multi) ──
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

  // ── New transfer buttons ──
  document.getElementById('btnNewTransfer').addEventListener('click', () => {
    // Re-init same recv sub-mode
    subMode === 'recvQR' ? initRecvQR() : initRecvCode();
  });
  document.getElementById('btnNewSend').addEventListener('click', () => {
    resetAll(); showScreen('screenMode');
  });

  showScreen('screenMode');
});
