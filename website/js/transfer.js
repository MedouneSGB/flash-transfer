'use strict';

// ═══════════════════════════════════════════
//  Flash Transfer — Web Transfer (PeerJS)
//  Formats: txt, pdf, doc/docx, xls/xlsx, png, jpg
//  Max size: 25 MB · Chunks: 64 KB
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

const ACCEPTED_EXT  = ['.txt', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.png', '.jpg', '.jpeg'];
const MAX_BYTES     = 25 * 1024 * 1024;   // 25 MB
const CHUNK_SIZE    = 64 * 1024;           // 64 KB

// ── State ──────────────────────────────────
let peer         = null;
let conn         = null;
let mode         = null;   // 'send' | 'recv'
let selectedFile = null;
let peerReady    = false;
let sendStarted  = false;

let recvMeta     = null;
let recvChunks   = [];
let recvBytes    = 0;

// ── Utilities ──────────────────────────────
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.random() * chars.length | 0]).join('');
}

function fmtSize(b) {
  if (b < 1024)        return b + ' o';
  if (b < 1048576)     return (b / 1024).toFixed(1) + ' Ko';
  return (b / 1048576).toFixed(1) + ' Mo';
}

function fmtSpeed(bps) {
  if (bps < 1024)     return bps.toFixed(0) + ' o/s';
  if (bps < 1048576)  return (bps / 1024).toFixed(0) + ' Ko/s';
  return (bps / 1048576).toFixed(1) + ' Mo/s';
}

function fileIcon(name, mime) {
  if (mime === 'application/pdf'  || name.endsWith('.pdf'))            return '📄';
  if (mime.includes('word')       || /\.docx?$/.test(name))           return '📝';
  if (mime.includes('excel')      || /\.xlsx?$/.test(name))           return '📊';
  if (/^image\//.test(mime))                                           return '🖼️';
  if (mime === 'text/plain'       || name.endsWith('.txt'))            return '📃';
  return '📁';
}

function validateFile(file) {
  const ext = ('.' + file.name.split('.').pop()).toLowerCase();
  if (!ACCEPTED_MIME.has(file.type) && !ACCEPTED_EXT.includes(ext))
    return `Format non autorisé.\nAcceptés : ${ACCEPTED_EXT.join(', ')}`;
  if (file.size === 0)        return 'Le fichier est vide.';
  if (file.size > MAX_BYTES)  return `Trop volumineux (${fmtSize(file.size)}) — maximum 25 Mo.`;
  return null;
}

// ── Toast ──────────────────────────────────
function toast(msg, type = 'error') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = 'toast show toast-' + type;
  el.style.display = 'block';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.style.display = 'none';
    el.className = 'toast';
  }, 4500);
}

// ── Screen helpers ─────────────────────────
function showScreen(id) {
  document.querySelectorAll('.t-screen').forEach(s => {
    s.classList.remove('active');
    s.style.display = 'none';
  });
  const el = document.getElementById(id);
  el.style.display = 'flex';
  el.classList.add('active');
}

function setVisible(id, show) {
  const el = document.getElementById(id);
  if (!el) return;
  if (typeof show === 'string') {
    el.className = el.className.replace(/\bshow\b/g, '').trim();
    if (show === 'show') el.classList.add('show');
  } else {
    el.style.display = show ? '' : 'none';
  }
}

function showError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  el.style.display = 'block';
}

function hideError(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = '';
  el.classList.remove('show');
  el.style.display = 'none';
}

// ── Teardown ───────────────────────────────
function destroyPeer() {
  sendStarted = false;
  peerReady   = false;
  try { if (conn) conn.close(); } catch (_) {}
  try { if (peer) peer.destroy(); } catch (_) {}
  conn = null; peer = null;
}

function resetAll() {
  destroyPeer();
  selectedFile = null; recvMeta = null; recvChunks = []; recvBytes = 0;
  const fi = document.getElementById('fileInput');
  if (fi) fi.value = '';
}

// ═══════════════════════════════════════════
//  QR CODE
// ═══════════════════════════════════════════
function generateQRCode(text) {
  const canvas = document.getElementById('qrCanvas');
  if (!canvas || typeof qrcode === 'undefined') return;
  try {
    const qr = qrcode(0, 'L');
    qr.addData(text);
    qr.make();
    const size = qr.getModuleCount();
    const cellSize = Math.max(2, Math.floor(160 / size));
    canvas.width  = size * cellSize;
    canvas.height = size * cellSize;
    const ctx = canvas.getContext('2d');
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        ctx.fillStyle = qr.isDark(row, col) ? '#000000' : '#ffffff';
        ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
      }
    }
    canvas.style.display = 'block';
  } catch(e) { console.warn('QR gen error:', e); }
}

let qrScanStream = null;
let qrScanAnimFrame = null;

async function startQRScanner() {
  const wrap  = document.getElementById('qrScannerWrap');
  const video = document.getElementById('qrVideo');
  const scanCanvas = document.getElementById('qrScanCanvas');
  try {
    qrScanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }
    });
    video.srcObject = qrScanStream;
    wrap.style.display = 'flex';
    video.addEventListener('loadedmetadata', () => {
      scanCanvas.width  = video.videoWidth  || 640;
      scanCanvas.height = video.videoHeight || 480;
      scanQRFrame(video, scanCanvas);
    }, { once: true });
  } catch(e) {
    toast('Caméra non disponible : ' + e.message);
  }
}

function scanQRFrame(video, canvas) {
  if (!qrScanStream) return;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'dontInvert',
  });
  if (code && code.data) {
    const text = code.data.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (text.length === 6) {
      stopQRScanner();
      document.getElementById('codeInput').value = text;
      toast('QR scanné : ' + text, 'success');
      document.getElementById('btnConnect').click();
      return;
    }
  }
  qrScanAnimFrame = requestAnimationFrame(() => scanQRFrame(video, canvas));
}

function stopQRScanner() {
  if (qrScanStream) {
    qrScanStream.getTracks().forEach(t => t.stop());
    qrScanStream = null;
  }
  if (qrScanAnimFrame) {
    cancelAnimationFrame(qrScanAnimFrame);
    qrScanAnimFrame = null;
  }
  document.getElementById('qrScannerWrap').style.display = 'none';
}

// ═══════════════════════════════════════════
//  SEND MODE
// ═══════════════════════════════════════════
function initSend() {
  mode = 'send';
  showScreen('screenSend');
  resetSendUI();

  const code = genCode();
  document.getElementById('sendCodeDisplay').innerHTML =
    `<span class="code-chars">${code}</span>`;

  setSendStatus('Connexion en cours…');

  peer = new Peer(code, { debug: 0 });

  peer.on('open', id => {
    setSendStatus('⏳ En attente du destinataire…');
    generateQRCode(id);
  });

  peer.on('connection', c => {
    conn = c;
    c.on('open', () => {
      peerReady = true;
      setSendStatus('✅ Destinataire connecté !');
      updateSendBtn();
      // If file already selected, enable send immediately
      if (selectedFile) updateSendBtn();
    });
    c.on('close', () => {
      if (!sendStarted) {
        peerReady = false;
        setSendStatus('❌ Connexion fermée.');
        updateSendBtn();
      }
    });
    c.on('error', e => toast('Erreur connexion : ' + e.message));
  });

  peer.on('error', err => {
    if (err.type === 'unavailable-id') {
      destroyPeer(); initSend(); // retry with new code
    } else {
      toast('Erreur PeerJS : ' + err.message);
    }
  });
}

function setSendStatus(msg) {
  const el = document.getElementById('sendStatus');
  if (el) el.textContent = msg;
}

function updateSendBtn() {
  const btn = document.getElementById('btnSend');
  if (!btn) return;
  btn.disabled = !(peerReady && selectedFile && !sendStarted);
}

function resetSendUI() {
  document.getElementById('fileInput').value = '';
  document.getElementById('filePreview').style.display = 'none';
  document.getElementById('dropzone').style.display  = 'block';
  document.getElementById('btnSend').disabled = true;
  document.getElementById('sendProgress').classList.remove('show');
  document.getElementById('sendProgress').style.display = 'none';
  hideError('fileError');
  setSendStatus('Initialisation…');
  document.getElementById('sendCodeDisplay').innerHTML = '<div class="code-spinner"></div>';
  const qrC = document.getElementById('qrCanvas');
  if (qrC) qrC.style.display = 'none';
  sendStarted = false; peerReady = false;
}

function doSend() {
  if (!conn || !selectedFile || !peerReady || sendStarted) return;
  sendStarted = true;
  document.getElementById('btnSend').disabled = true;

  const progBlock = document.getElementById('sendProgress');
  progBlock.classList.add('show');
  progBlock.style.display = 'flex';

  // Send metadata
  conn.send(JSON.stringify({
    __ft: 'meta',
    name: selectedFile.name,
    size: selectedFile.size,
    mime: selectedFile.type,
  }));

  let offset = 0;
  const tStart = Date.now();
  const reader = new FileReader();

  function updateProg() {
    const pct     = Math.round(offset / selectedFile.size * 100);
    const elapsed = (Date.now() - tStart) / 1000 || 0.001;
    const speed   = offset / elapsed;

    document.getElementById('sendProgPct').textContent   = pct + '%';
    document.getElementById('sendProgFill').style.width  = pct + '%';
    document.getElementById('sendProgLabel').textContent = 'Envoi en cours…';
    document.getElementById('sendProgSub').textContent   =
      `${fmtSize(offset)} / ${fmtSize(selectedFile.size)}  ·  ${fmtSpeed(speed)}`;
  }

  function sendChunk() {
    if (offset >= selectedFile.size) {
      conn.send(JSON.stringify({ __ft: 'done' }));
      document.getElementById('sendProgLabel').textContent = '✅ Fichier envoyé !';
      document.getElementById('sendProgPct').textContent   = '100%';
      document.getElementById('sendProgFill').style.width  = '100%';
      document.getElementById('sendProgSub').textContent   =
        `${selectedFile.name} — ${fmtSize(selectedFile.size)} · Terminé`;
      return;
    }
    reader.readAsArrayBuffer(selectedFile.slice(offset, offset + CHUNK_SIZE));
  }

  reader.onload = e => {
    try { conn.send(e.target.result); }
    catch (err) { toast('Erreur envoi : ' + err.message); return; }
    offset += e.target.result.byteLength;
    updateProg();
    setTimeout(sendChunk, 0);
  };

  reader.onerror = () => toast('Erreur de lecture du fichier.');
  sendChunk();
}

// ── File selection ──────────────────────────
function handleFile(file) {
  const err = validateFile(file);
  if (err) { showError('fileError', err); return; }
  hideError('fileError');
  selectedFile = file;

  document.getElementById('dropzone').style.display   = 'none';
  document.getElementById('filePreview').style.display = 'flex';
  document.getElementById('fileIcon').textContent      = fileIcon(file.name, file.type);
  document.getElementById('fileName').textContent      = file.name;
  document.getElementById('fileSize').textContent      = fmtSize(file.size);
  updateSendBtn();
}

// ═══════════════════════════════════════════
//  RECEIVE MODE
// ═══════════════════════════════════════════
function initRecv() {
  mode = 'recv';
  showScreen('screenRecv');
  resetRecvUI();

  peer = new Peer({ debug: 0 });
  peer.on('error', err => {
    if (err.type === 'peer-unavailable') {
      toast('Code introuvable. Vérifiez le code ou demandez à l\'expéditeur de recharger la page.');
      resetRecvConnect();
    } else {
      toast('Erreur : ' + err.message);
    }
  });
}

function resetRecvConnect() {
  document.getElementById('stepCodeInput').style.display = 'block';
  document.getElementById('recvStatus').classList.remove('show');
  document.getElementById('recvStatus').style.display = 'none';
}

function resetRecvUI() {
  document.getElementById('codeInput').value = '';
  hideError('connectError');
  document.getElementById('stepCodeInput').style.display = 'block';
  document.getElementById('recvStatus').classList.remove('show');
  document.getElementById('recvStatus').style.display = 'none';
  document.getElementById('recvProgress').classList.remove('show');
  document.getElementById('recvProgress').style.display = 'none';
  document.getElementById('recvDone').classList.remove('show');
  document.getElementById('recvDone').style.display = 'none';
  recvMeta = null; recvChunks = []; recvBytes = 0;
}

function connectToSender(rawCode) {
  const code = rawCode.toUpperCase().trim();
  if (!peer) return;

  document.getElementById('stepCodeInput').style.display = 'none';
  const statusEl = document.getElementById('recvStatus');
  statusEl.classList.add('show');
  statusEl.style.display = 'flex';
  document.getElementById('recvStatusText').textContent = 'Connexion en cours…';
  document.getElementById('recvStatusIcon').textContent = '⏳';

  // serialization:'raw' = envoie ArrayBuffer brut sans binarypack (évite la corruption)
  conn = peer.connect(code, { reliable: true, serialization: 'raw' });

  conn.on('open', () => {
    document.getElementById('recvStatusText').textContent = '⚡ Connecté — en attente du fichier…';
    document.getElementById('recvStatusIcon').textContent = '⚡';
  });

  conn.on('data', data => {
    if (typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch (_) { return; }

      if (msg.__ft === 'meta') {
        recvMeta   = msg;
        recvChunks = []; recvBytes = 0;

        document.getElementById('recvStatus').classList.remove('show');
        document.getElementById('recvStatus').style.display = 'none';
        const pb = document.getElementById('recvProgress');
        pb.classList.add('show'); pb.style.display = 'flex';
        document.getElementById('recvProgLabel').textContent = 'Réception de ' + msg.name + '…';

      } else if (msg.__ft === 'done') {
        // Reconstruction du fichier à partir des chunks
        const blob = new Blob(recvChunks, { type: recvMeta.mime || 'application/octet-stream' });
        downloadBlob(blob, recvMeta.name);
        showDone(recvMeta.name);
      }

    } else {
      // Chunk binaire — normaliser en ArrayBuffer quelle que soit le type reçu
      // (ArrayBuffer, Uint8Array, Buffer Node.js…)
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = data;
      } else if (ArrayBuffer.isView(data)) {
        buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      } else if (data instanceof Blob) {
        // Cas rare — lire de façon async
        data.arrayBuffer().then(ab => {
          recvChunks.push(ab);
          recvBytes += ab.byteLength;
          updateRecvProgress();
        });
        return;
      } else {
        return; // type inconnu, ignorer
      }
      recvChunks.push(buf);
      recvBytes += buf.byteLength;
      updateRecvProgress();
    }
  });

  conn.on('error', e => {
    toast('Erreur : ' + e.message);
    resetRecvConnect();
  });

  conn.on('close', () => {
    if (!recvMeta || recvBytes < (recvMeta?.size ?? 1)) {
      toast('Connexion fermée avant la fin du transfert.');
      resetRecvConnect();
    }
  });

  // 10s timeout if code doesn't exist (peer-unavailable fires on peer, not conn)
  setTimeout(() => {
    if (conn && !conn.open && recvBytes === 0 && !recvMeta) {
      toast('Impossible de se connecter. Vérifiez le code.');
      resetRecvConnect();
    }
  }, 10000);
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

function updateRecvProgress() {
  if (!recvMeta) return;
  const pct = Math.min(100, Math.round(recvBytes / recvMeta.size * 100));
  document.getElementById('recvProgPct').textContent  = pct + '%';
  document.getElementById('recvProgFill').style.width = pct + '%';
  document.getElementById('recvProgSub').textContent  =
    `${fmtSize(recvBytes)} / ${fmtSize(recvMeta.size)}`;
}

function showDone(filename) {
  document.getElementById('recvProgress').classList.remove('show');
  document.getElementById('recvProgress').style.display = 'none';
  const done = document.getElementById('recvDone');
  done.classList.add('show'); done.style.display = 'flex';
  document.getElementById('doneName').textContent = filename + ' reçu !';
}

// ═══════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {

  // ── Mode selection ──
  document.getElementById('btnSendMode').addEventListener('click', initSend);
  document.getElementById('btnRecvMode').addEventListener('click', initRecv);

  // ── Back buttons ──
  document.getElementById('btnSendBack').addEventListener('click', () => {
    resetAll(); resetSendUI();
    showScreen('screenMode');
  });
  document.getElementById('btnRecvBack').addEventListener('click', () => {
    stopQRScanner();
    resetAll(); resetRecvUI();
    showScreen('screenMode');
  });

  // ── File input (click) ──
  document.getElementById('fileInput').addEventListener('change', e => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });

  // ── Drag & Drop ──
  const dz = document.getElementById('dropzone');
  dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', ()  => dz.classList.remove('dragover'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  // ── Remove file ──
  document.getElementById('btnFileRemove').addEventListener('click', () => {
    selectedFile = null;
    document.getElementById('fileInput').value  = '';
    document.getElementById('filePreview').style.display = 'none';
    document.getElementById('dropzone').style.display   = 'block';
    hideError('fileError');
    updateSendBtn();
  });

  // ── Send button ──
  document.getElementById('btnSend').addEventListener('click', doSend);

  // ── Connect button (receive) ──
  document.getElementById('btnConnect').addEventListener('click', () => {
    const code = document.getElementById('codeInput').value.trim();
    if (!code || code.length < 6) {
      showError('connectError', 'Entrez un code valide (6 caractères).');
      return;
    }
    hideError('connectError');
    connectToSender(code);
  });

  // Enter key on code input
  document.getElementById('codeInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btnConnect').click();
  });

  // Auto-uppercase & filter invalid chars
  document.getElementById('codeInput').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  // ── QR scanner ──
  document.getElementById('btnScanQR').addEventListener('click', startQRScanner);
  document.getElementById('btnStopScan').addEventListener('click', stopQRScanner);

  // ── New transfer (receiver done state) ──
  document.getElementById('btnNewTransfer').addEventListener('click', () => {
    destroyPeer();
    initRecv();
  });

  // ── Show first screen ──
  showScreen('screenMode');
});
