/* Flash⚡Transfer — App Logic v2 (chat UX) */

// ── Tauri 2 API ────────────────────────────────────────────────────────────
const invoke   = window.__TAURI__.core.invoke;
const { listen } = window.__TAURI__.event;
const { open: openDialog } = window.__TAURI__.dialog;

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  peers:            [],
  selectedPeer:     null,         // { ip, port, name }
  conversations:    {},           // ip → [msg, ...]
  pendingAttach:    [],           // [{name, path, size}]  fichiers à envoyer
  pendingRequest:   null,         // { requestId, senderName, senderIp, files }
  progressBubbles:  {},           // fileName → { msgId, direction, ip }
  receivedFiles:    [],
  localIp:          null,
  publicIp:         null,
  senderName:       'Flash@...',
  // Internet mode
  selectedFileCode: null,
  selectedFileIp:   null,
  isInternetProgress: false,      // true = progress overlay for internet mode
};

// ── Utils ──────────────────────────────────────────────────────────────────
function formatBytes(b) {
  if (!b || b === 0) return '0 B';
  if (b < 1024)        return b + ' B';
  if (b < 1048576)     return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824)  return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
function formatSpeed(mbps) {
  if (!mbps || mbps <= 0) return '0 MB/s';
  if (mbps < 1)   return (mbps * 1000).toFixed(0) + ' KB/s';
  if (mbps > 1000) return (mbps / 1000).toFixed(1) + ' GB/s';
  return mbps.toFixed(1) + ' MB/s';
}
function formatEta(s) {
  if (!s || s <= 0 || !isFinite(s)) return '--';
  if (s < 60)   return Math.ceil(s) + 's';
  if (s < 3600) return Math.floor(s/60) + 'm ' + Math.ceil(s%60) + 's';
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
}
function formatDate(tsMs) {
  const d = new Date(tsMs);
  return d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});
}
function timeLabel(tsMs) {
  const d = new Date(tsMs);
  return d.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});
}
function fileIcon(ext) {
  const m = {
    pdf:'📕', doc:'📝', docx:'📝', xls:'📊', xlsx:'📊', ppt:'📊', pptx:'📊',
    png:'🖼', jpg:'🖼', jpeg:'🖼', gif:'🖼', svg:'🖼', webp:'🖼',
    mp4:'🎬', mov:'🎬', avi:'🎬', mkv:'🎬',
    mp3:'🎵', wav:'🎵', flac:'🎵',
    zip:'📦', rar:'📦', '7z':'📦', tar:'📦', gz:'📦',
    exe:'⚙', msi:'⚙', dmg:'⚙', pkg:'⚙',
    txt:'📄', md:'📄', json:'📄', csv:'📄', xml:'📄',
  };
  return m[ext?.toLowerCase()] || '📄';
}

// ── Toast ──────────────────────────────────────────────────────────────────
function savePseudo() {
  const input = document.getElementById('pseudoInput');
  const hint  = document.getElementById('pseudoHint');
  const val   = input.value.trim().replace(/[^a-zA-Z0-9_\-\.À-ÿ ]/g, '').slice(0, 24);
  input.value = val;
  if (!val) {
    localStorage.removeItem('ft_pseudo');
    state.senderName = `Flash@${state.localIp}`;
    hint.textContent = 'Pseudonyme réinitialisé.';
  } else {
    localStorage.setItem('ft_pseudo', val);
    state.senderName = `${val}@${state.localIp}`;
    hint.textContent = `✓ Affiché comme : ${state.senderName}`;
  }
  document.getElementById('deviceName').textContent = state.senderName;
  // Redémarre la discovery avec le nouveau nom
  if (state.localIp) {
    invoke('start_lan_discovery', { name: state.senderName }).catch(console.warn);
  }
  setTimeout(() => { hint.textContent = ''; }, 3000);
}

function toast(msg, type = 'info', ms = 4000) {
  const c = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success:'✅', error:'❌', info:'⚡' };
  el.innerHTML = `<span>${icons[type]||'⚡'}</span><span>${msg}</span>`;
  c.appendChild(el);
  setTimeout(() => {
    el.style.cssText += 'opacity:0;transform:translateX(120%);transition:all .2s';
    setTimeout(() => el.remove(), 200);
  }, ms);
}

// ── Sidebar mode tabs ──────────────────────────────────────────────────────
document.querySelectorAll('.smode').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.smode').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.sidebar-content').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('sc-' + btn.dataset.mode).classList.add('active');
  });
});

// Sub-tabs (code relay send/recv)
document.querySelectorAll('.sub-tab').forEach(st => {
  st.addEventListener('click', () => {
    const parent = st.closest('.inet-section');
    parent.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
    parent.querySelectorAll('.sub-panel').forEach(p => p.classList.remove('active'));
    st.classList.add('active');
    document.getElementById('sub-' + st.dataset.subtab).classList.add('active');
  });
});

// Main tabs (Chat / Fichiers reçus)
document.querySelectorAll('.mtab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mtab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.main-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('mp-' + btn.dataset.mtab).classList.add('active');
    if (btn.dataset.mtab === 'files') loadReceivedFiles();
  });
});

// ── Peers ──────────────────────────────────────────────────────────────────
function renderPeers() {
  const list = document.getElementById('peersList');
  document.getElementById('peerCount').textContent = state.peers.length;

  if (state.peers.length === 0) {
    list.innerHTML = `<div class="no-peers">
      <div class="scan-anim">📡</div>
      <p>Scan en cours…</p>
      <p class="hint">Les appareils Flash⚡Transfer apparaîtront ici</p>
    </div>`;
    return;
  }

  list.innerHTML = state.peers.map(p => `
    <div class="peer-card${state.selectedPeer?.ip === p.ip ? ' selected' : ''}"
         data-ip="${p.ip}" data-name="${p.name}">
      <div class="peer-avatar">💻</div>
      <div>
        <div class="peer-name">${p.name}</div>
        <div class="peer-ip">${p.ip}</div>
      </div>
      <div class="peer-online"></div>
    </div>`).join('');

  list.querySelectorAll('.peer-card').forEach(card => {
    card.addEventListener('click', () => {
      const peer = state.peers.find(p => p.ip === card.dataset.ip);
      if (peer) selectPeer(peer);
    });
  });
}

function selectPeer(peer) {
  state.selectedPeer = peer;
  renderPeers();

  // Assure qu'on est sur l'onglet Chat
  document.querySelectorAll('.mtab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.main-panel').forEach(p => p.classList.remove('active'));
  document.querySelector('[data-mtab="chat"]').classList.add('active');
  document.getElementById('mp-chat').classList.add('active');

  // Cache l'état vide, affiche les messages et l'input
  document.getElementById('chatEmpty').style.display = 'none';
  document.getElementById('messages').style.display = 'flex';
  document.getElementById('chatInputBar').style.display = 'flex';

  renderConversation(peer.ip);
}

// ── Conversation (chat messages) ───────────────────────────────────────────
function ensureConv(ip) {
  if (!state.conversations[ip]) state.conversations[ip] = [];
  return state.conversations[ip];
}

function addMsg(ip, msgObj) {
  ensureConv(ip).push(msgObj);
  if (state.selectedPeer?.ip === ip) {
    renderConversation(ip);
  }
}

function renderConversation(ip) {
  const msgs = state.conversations[ip] || [];
  const container = document.getElementById('messages');
  container.innerHTML = '';

  for (const m of msgs) {
    let el;
    switch (m.type) {
      case 'text':    el = buildTextBubble(m);           break;
      case 'system':  el = buildSystemMsg(m);            break;
      case 'progress':el = buildProgressBubble(m);       break;
      case 'done':    el = buildDoneBubble(m);           break;
      case 'req-sent':el = buildReqSentBubble(m);        break;
      default: continue;
    }
    if (el) container.appendChild(el);
  }
  container.scrollTop = container.scrollHeight;
}

function buildTextBubble(m) {
  const div = document.createElement('div');
  div.className = `msg ${m.direction}`;
  div.dataset.msgId = m.id;

  const avatarHtml = m.direction === 'in'
    ? `<div class="msg-avatar">💻</div>` : '';
  const senderHtml = m.direction === 'in'
    ? `<div class="msg-sender">${m.sender || ''}</div>` : '';

  div.innerHTML = `${avatarHtml}
    <div class="msg-content">
      ${senderHtml}
      <div class="bubble-text">${escapeHtml(m.text)}</div>
      <div class="msg-time">${timeLabel(m.ts)}</div>
    </div>`;
  return div;
}

function buildSystemMsg(m) {
  const div = document.createElement('div');
  div.className = 'msg-system';
  div.textContent = m.text;
  return div;
}

function buildProgressBubble(m) {
  const div = document.createElement('div');
  div.className = `msg ${m.direction}`;
  div.dataset.msgId = m.id;

  const icon = fileIcon(m.fileName.split('.').pop());
  div.innerHTML = `
    ${m.direction === 'in' ? '<div class="msg-avatar">💻</div>' : ''}
    <div class="msg-content">
      <div class="bubble-progress">
        <div class="bp-header">
          <span class="bp-icon">${icon}</span>
          <div>
            <div class="bp-name">${escapeHtml(m.fileName)}</div>
            <div class="bp-size">${formatBytes(m.totalBytes)}</div>
          </div>
        </div>
        <div class="bp-bar-wrap"><div class="bp-bar" style="width:${m.progress||0}%"></div></div>
        <div class="bp-stats">${(m.progress||0).toFixed(1)}% • ${formatSpeed(m.speed||0)}</div>
      </div>
    </div>`;
  return div;
}

function buildDoneBubble(m) {
  const div = document.createElement('div');
  div.className = `msg ${m.direction}`;
  div.dataset.msgId = m.id;

  const icon = fileIcon(m.fileName.split('.').pop());
  div.innerHTML = `
    ${m.direction === 'in' ? '<div class="msg-avatar">💻</div>' : ''}
    <div class="msg-content">
      <div class="bubble-file-done">
        <span class="bfd-check">✓</span>
        <div class="bfd-info">
          <div class="bfd-name">${escapeHtml(m.fileName)}</div>
          <div class="bfd-meta">${formatBytes(m.totalBytes)}${m.speed ? ' • ' + formatSpeed(m.speed) : ''}</div>
        </div>
        ${m.savePath ? `<button class="bfd-open ft-btn" title="Ouvrir" data-path="${escapeAttr(m.savePath)}">📂</button>` : ''}
      </div>
      <div class="msg-time">${timeLabel(m.ts)}</div>
    </div>`;

  const openBtn = div.querySelector('.bfd-open');
  if (openBtn) {
    openBtn.addEventListener('click', () => invoke('open_file', { path: openBtn.dataset.path }));
  }
  return div;
}

function buildReqSentBubble(m) {
  const div = document.createElement('div');
  div.className = `msg ${m.direction}`;
  div.dataset.msgId = m.id;

  const statusClass = m.status === 'accepted' ? 'accepted' : m.status === 'declined' ? 'declined' : '';
  const icon = m.status === 'accepted' ? '✓' : m.status === 'declined' ? '✗' : '⏳';
  const text = m.status === 'accepted' ? 'Accepté — transfert en cours…'
             : m.status === 'declined' ? 'Refusé'
             : 'Demande envoyée…';

  const filesHtml = (m.files || []).map(f =>
    `<span class="chip-name">${escapeHtml(f.name)}</span> (${formatBytes(f.size)})`
  ).join(', ');

  div.innerHTML = `
    <div class="msg-content">
      <div class="bubble-file-req ${statusClass}">
        <span class="bfr-spinner">${icon}</span>
        <div class="bfr-text"><strong>${escapeHtml(filesHtml)}</strong><br>${text}</div>
      </div>
      <div class="msg-time">${timeLabel(m.ts)}</div>
    </div>`;
  return div;
}

function updateMsgInConv(ip, msgId, patch) {
  const conv = state.conversations[ip] || [];
  const idx = conv.findIndex(m => m.id === msgId);
  if (idx >= 0) {
    Object.assign(conv[idx], patch);
    if (state.selectedPeer?.ip === ip) renderConversation(ip);
  }
}

function escapeHtml(s)  { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escapeAttr(s)  { return String(s).replace(/"/g,'&quot;'); }

// ── File picker util ───────────────────────────────────────────────────────
async function pickFile(multiple = false) {
  const result = await openDialog({ multiple, title: 'Sélectionner un fichier' });
  if (!result) return null;
  const paths = Array.isArray(result) ? result : [result];
  const files = [];
  for (const p of paths) {
    const name = p.replace(/\\/g, '/').split('/').pop();
    const size = await invoke('get_file_size', { path: p }).catch(() => 0);
    files.push({ name, path: p, size });
  }
  return files;
}

// ── Attachments (LAN chat) ─────────────────────────────────────────────────
function renderAttachments() {
  const bar  = document.getElementById('attachmentsBar');
  const list = document.getElementById('attachmentsList');

  if (state.pendingAttach.length === 0) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  list.innerHTML = state.pendingAttach.map((f, i) => `
    <div class="attach-chip">
      <span>${fileIcon(f.name.split('.').pop())}</span>
      <span class="chip-name" title="${escapeAttr(f.name)}">${escapeHtml(f.name)}</span>
      <span class="chip-size">${formatBytes(f.size)}</span>
      <button class="chip-rm" data-idx="${i}">✕</button>
    </div>`).join('');

  list.querySelectorAll('.chip-rm').forEach(btn => {
    btn.addEventListener('click', () => {
      state.pendingAttach.splice(parseInt(btn.dataset.idx), 1);
      renderAttachments();
    });
  });
}

document.getElementById('btnAttach').addEventListener('click', async () => {
  const files = await pickFile(true);
  if (files) {
    state.pendingAttach.push(...files);
    renderAttachments();
  }
});

document.getElementById('btnClearAttach').addEventListener('click', () => {
  state.pendingAttach = [];
  renderAttachments();
});

// ── Send (chat input) ──────────────────────────────────────────────────────
async function handleSend() {
  if (!state.selectedPeer) return;
  const peer = state.selectedPeer;
  const input = document.getElementById('chatTextInput');
  const text  = input.value.trim();

  if (state.pendingAttach.length > 0) {
    // Envoyer des fichiers
    const files = [...state.pendingAttach];
    state.pendingAttach = [];
    renderAttachments();
    await sendFiles(peer, files);
  } else if (text) {
    // Envoyer un message texte
    input.value = '';
    await sendTextMessage(peer, text);
  }
}

document.getElementById('btnSend').addEventListener('click', handleSend);
document.getElementById('chatTextInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
});

// ── Send text message ──────────────────────────────────────────────────────
async function sendTextMessage(peer, text) {
  // Affiche localement
  const msgId = 'msg-' + Date.now();
  addMsg(peer.ip, { id: msgId, type: 'text', direction: 'out', text, ts: Date.now() });

  try {
    await invoke('send_chat_message', {
      ip: peer.ip, text, senderName: state.senderName
    });
  } catch (e) {
    // Marque comme erreur
    updateMsgInConv(peer.ip, msgId, { text: text + ' ⚠ Non délivré : ' + e });
    toast('Envoi échoué : ' + e, 'error');
  }
}

// ── Send files (with file request) ────────────────────────────────────────
async function sendFiles(peer, files) {
  const reqMsgId = 'req-' + Date.now();
  addMsg(peer.ip, {
    id: reqMsgId, type: 'req-sent', direction: 'out',
    files: files.map(f => ({ name: f.name, size: f.size })),
    status: 'waiting', ts: Date.now(),
  });

  let accepted = false;
  try {
    accepted = await invoke('send_file_request', {
      ip: peer.ip,
      files: files.map(f => ({ name: f.name, size: f.size })),
      senderName: state.senderName,
    });
  } catch (e) {
    updateMsgInConv(peer.ip, reqMsgId, { status: 'declined' });
    toast('Demande échouée : ' + e, 'error');
    return;
  }

  if (!accepted) {
    updateMsgInConv(peer.ip, reqMsgId, { status: 'declined' });
    addMsg(peer.ip, { id: 'sys-' + Date.now(), type: 'system', text: '✗ Transfert refusé' });
    return;
  }

  updateMsgInConv(peer.ip, reqMsgId, { status: 'accepted' });

  // Envoie les fichiers un par un
  for (const f of files) {
    const progId = 'prog-' + Date.now() + '-' + f.name;
    state.progressBubbles[f.name] = { msgId: progId, direction: 'out', ip: peer.ip };
    addMsg(peer.ip, {
      id: progId, type: 'progress', direction: 'out',
      fileName: f.name, totalBytes: f.size, progress: 0, speed: 0,
    });

    try {
      await invoke('send_file', { ip: peer.ip, filePath: f.path });
    } catch (e) {
      delete state.progressBubbles[f.name];
      addMsg(peer.ip, { id: 'err-' + Date.now(), type: 'system', text: '⚠ Erreur : ' + e });
      toast('Erreur transfert : ' + e, 'error');
    }
  }
}

// ── Tauri event listeners ──────────────────────────────────────────────────
async function initListeners() {

  // Peers LAN découverts
  await listen('peers-updated', e => {
    state.peers = e.payload;
    renderPeers();
  });

  // Message texte reçu
  await listen('chat-message', e => {
    const { sender_name, sender_ip, text, timestamp } = e.payload;
    addMsg(sender_ip, {
      id: 'in-' + Date.now(), type: 'text', direction: 'in',
      sender: sender_name, text, ts: timestamp || Date.now(),
    });
    // Notification si pas sélectionné
    if (state.selectedPeer?.ip !== sender_ip) {
      toast(`💬 ${sender_name}: ${text.slice(0, 60)}`, 'info', 5000);
    }
  });

  // Demande de fichier(s) entrante
  await listen('file-request', e => {
    const { request_id, sender_name, sender_ip, files } = e.payload;
    state.pendingRequest = { requestId: request_id, senderName: sender_name, senderIp: sender_ip, files };
    showFileRequestOverlay(state.pendingRequest);
  });

  // Début de réception d'un fichier (LAN ou IP direct)
  await listen('receive-start', e => {
    const { file_name, total_bytes } = e.payload;

    if (state.isInternetProgress) {
      // Mode internet: utilise l'overlay
      showProgress(file_name, `📥 Réception… (${formatBytes(total_bytes)})`, true);
      return;
    }

    // Mode LAN: cherche d'où vient le fichier
    // On ne connaît pas l'IP exacte ici, on l'ajoute à la conv du peer sélectionné
    // ou on crée une "conv inconnue"
    const ip = state.pendingRequest?.senderIp || state.selectedPeer?.ip || '__unknown__';
    const progId = 'recv-' + Date.now() + '-' + file_name;
    state.progressBubbles[file_name] = { msgId: progId, direction: 'in', ip };
    addMsg(ip, {
      id: progId, type: 'progress', direction: 'in',
      fileName: file_name, totalBytes: total_bytes, progress: 0, speed: 0,
    });
    // Ouvre la conversation si on est sur ce peer
    if (state.selectedPeer?.ip === ip) {
      document.getElementById('chatEmpty').style.display = 'none';
      document.getElementById('messages').style.display = 'flex';
      document.getElementById('chatInputBar').style.display = 'flex';
    }
  });

  // Progression transfert
  await listen('transfer-progress', e => {
    const { file_name, bytes_done, total_bytes, speed_mbps, eta_secs, percent } = e.payload;

    if (state.isInternetProgress) {
      updateProgress(percent, speed_mbps, eta_secs, bytes_done, total_bytes);
      return;
    }

    const info = state.progressBubbles[file_name];
    if (!info) return;
    updateMsgInConv(info.ip, info.msgId, {
      progress: percent, speed: speed_mbps, totalBytes: total_bytes,
    });
  });

  // Transfert terminé
  await listen('transfer-done', e => {
    const { file_name, save_path, total_bytes, avg_speed_mbps } = e.payload;

    if (state.isInternetProgress) {
      hideProgress();
      state.isInternetProgress = false;
      const icon = save_path ? '📥' : '📤';
      toast(`${icon} ${file_name} transféré — ${formatSpeed(avg_speed_mbps)}`, 'success', 6000);
      return;
    }

    const info = state.progressBubbles[file_name];
    if (info) {
      delete state.progressBubbles[file_name];
      // Remplace la bulle progress par une bulle done
      const conv = state.conversations[info.ip] || [];
      const idx = conv.findIndex(m => m.id === info.msgId);
      if (idx >= 0) {
        conv[idx] = {
          id: info.msgId, type: 'done', direction: info.direction,
          fileName: file_name, totalBytes: total_bytes,
          speed: avg_speed_mbps, savePath: save_path || '',
          ts: Date.now(),
        };
        if (state.selectedPeer?.ip === info.ip) renderConversation(info.ip);
      }
    }

    if (save_path) {
      toast(`📥 ${file_name} reçu — ${formatSpeed(avg_speed_mbps)}`, 'success', 5000);
      // Badge sur l'onglet fichiers reçus
      updateFilesBadge();
    }
  });

  // Erreur de transfert
  await listen('transfer-error', e => {
    if (state.isInternetProgress) {
      hideProgress();
      state.isInternetProgress = false;
    }
    toast(e.payload.message, 'error', 8000);
  });

  // Récepteur démarré
  await listen('receiver-started', () => {
    document.getElementById('statusDot').classList.remove('inactive');
  });

  // Relay internet
  await listen('relay-status', e => {
    document.getElementById('codeHint').textContent = e.payload.message;
  });
  await listen('relay-peer-connected', () => {
    document.getElementById('codeHint').textContent = '⚡ Connecté ! Envoi en cours…';
    state.isInternetProgress = true;
    showProgress(state.selectedFileCode?.name || '…', 'Envoi via relay…');
    toast('Destinataire connecté !', 'success');
  });
}

// ── File Request Overlay (incoming) ───────────────────────────────────────
function showFileRequestOverlay({ senderName, files }) {
  document.getElementById('frSenderName').textContent = senderName;
  const list = document.getElementById('frFilesList');
  list.innerHTML = files.map(f => `
    <div class="fr-file-item">
      <span class="fr-file-icon">${fileIcon(f.name.split('.').pop())}</span>
      <span class="fr-file-name">${escapeHtml(f.name)}</span>
      <span class="fr-file-size">${formatBytes(f.size)}</span>
    </div>`).join('');
  document.getElementById('fileRequestOverlay').style.display = 'flex';
}

document.getElementById('btnAcceptFiles').addEventListener('click', async () => {
  if (!state.pendingRequest) return;
  const { requestId, senderIp, senderName, files } = state.pendingRequest;
  document.getElementById('fileRequestOverlay').style.display = 'none';

  // Ajoute une bulle dans la conv de cet envoyeur
  addMsg(senderIp, {
    id: 'sys-' + Date.now(), type: 'system',
    text: `✓ Accepté — réception de ${files.length} fichier(s) de ${senderName}`,
  });

  await invoke('respond_to_file_request', { requestId, accepted: true }).catch(console.error);
  state.pendingRequest = null;
});

document.getElementById('btnDeclineFiles').addEventListener('click', async () => {
  if (!state.pendingRequest) return;
  const { requestId } = state.pendingRequest;
  document.getElementById('fileRequestOverlay').style.display = 'none';
  await invoke('respond_to_file_request', { requestId, accepted: false }).catch(console.error);
  state.pendingRequest = null;
});

// ── Internet progress overlay ──────────────────────────────────────────────
function showProgress(fileName, mode, isReceive = false) {
  document.getElementById('progFileName').textContent = fileName;
  document.getElementById('progMode').textContent = mode;
  document.getElementById('progressBar').style.width = '0%';
  document.getElementById('progPercent').textContent = '0%';
  document.getElementById('progSpeed').textContent = '0 MB/s';
  document.getElementById('progEta').textContent = '--';
  document.getElementById('progBytes').textContent = '';
  document.getElementById('progressOverlay').style.display = 'flex';
}
function updateProgress(pct, speed, eta, done, total) {
  document.getElementById('progressBar').style.width = Math.min(pct,100).toFixed(1)+'%';
  document.getElementById('progPercent').textContent = Math.min(pct,100).toFixed(1)+'%';
  document.getElementById('progSpeed').textContent = formatSpeed(speed);
  document.getElementById('progEta').textContent = formatEta(eta);
  document.getElementById('progBytes').textContent = formatBytes(done)+' / '+formatBytes(total);
}
function hideProgress() {
  document.getElementById('progressOverlay').style.display = 'none';
}

document.getElementById('btnCancelTransfer').addEventListener('click', async () => {
  await invoke('disconnect_relay').catch(() => {});
  hideProgress();
  state.isInternetProgress = false;
  toast('Transfert annulé', 'info');
});

// ── Fichiers reçus tab ─────────────────────────────────────────────────────
async function loadReceivedFiles() {
  state.receivedFiles = await invoke('get_received_files').catch(() => []);
  renderFilesTable();
  updateFilesBadge();
}

function updateFilesBadge() {
  invoke('get_received_files').then(files => {
    const badge = document.getElementById('filesBadge');
    if (files.length > 0) {
      badge.textContent = files.length;
      badge.style.display = 'inline';
    } else {
      badge.style.display = 'none';
    }
  }).catch(() => {});
}

function renderFilesTable() {
  const files = state.receivedFiles;
  const empty = document.getElementById('filesEmpty');
  const wrap  = document.getElementById('filesTableWrap');

  if (files.length === 0) {
    empty.style.display = 'flex';
    wrap.style.display  = 'none';
    return;
  }
  empty.style.display = 'none';
  wrap.style.display  = 'block';

  document.getElementById('filesTableBody').innerHTML = files.map(f => `
    <tr>
      <td>
        <span style="margin-right:6px">${fileIcon(f.ext)}</span>
        <span class="ft-name" title="${escapeAttr(f.path)}">${escapeHtml(f.name)}</span>
      </td>
      <td><span class="ft-ext">${escapeHtml(f.ext || '?')}</span></td>
      <td><span class="ft-size">${formatBytes(f.size)}</span></td>
      <td><span class="ft-sender">${escapeHtml(f.sender_ip)}</span></td>
      <td><span class="ft-date">${formatDate(f.received_at)}</span></td>
      <td class="ft-actions">
        <button class="ft-btn ft-open-file" title="Ouvrir le fichier" data-action="open-file" data-path="${escapeAttr(f.path)}">📄 Fichier</button>
        <button class="ft-btn ft-open-folder" title="Ouvrir le dossier" data-action="open-folder" data-path="${escapeAttr(f.path)}">📂 Dossier</button>
        <button class="ft-btn ft-delete" title="Supprimer" data-action="delete" data-id="${escapeAttr(f.id)}" data-path="${escapeAttr(f.path)}">🗑</button>
      </td>
    </tr>`).join('');

  document.querySelectorAll('[data-action="open-file"]').forEach(btn => {
    btn.addEventListener('click', () => invoke('open_file', { path: btn.dataset.path }).catch(e => toast(String(e), 'error')));
  });
  document.querySelectorAll('[data-action="open-folder"]').forEach(btn => {
    btn.addEventListener('click', () => invoke('open_folder', { path: btn.dataset.path }).catch(e => toast(String(e), 'error')));
  });
  document.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await invoke('delete_received_file', { id: btn.dataset.id, path: btn.dataset.path }).catch(console.error);
      await loadReceivedFiles();
    });
  });
}

document.getElementById('btnRefreshFiles').addEventListener('click', loadReceivedFiles);

// ── Internet mode (code relay) ─────────────────────────────────────────────
document.getElementById('selectFileCode').addEventListener('click', async () => {
  const files = await pickFile(false);
  if (files && files[0]) {
    state.selectedFileCode = files[0];
    document.getElementById('fileNameCode').textContent = files[0].name;
    document.getElementById('fileSizeCode').textContent = formatBytes(files[0].size);
    document.getElementById('selectedFileCode').style.display = 'flex';
    document.getElementById('btnGenerateCode').disabled = false;
  }
});
document.getElementById('clearFileCode').addEventListener('click', () => {
  state.selectedFileCode = null;
  document.getElementById('selectedFileCode').style.display = 'none';
  document.getElementById('codeDisplay').style.display = 'none';
  document.getElementById('btnGenerateCode').disabled = true;
});
document.getElementById('btnGenerateCode').addEventListener('click', async () => {
  if (!state.selectedFileCode) return;
  try {
    const code = await invoke('generate_relay_code', { filePath: state.selectedFileCode.path });
    document.getElementById('codeValue').textContent = code;
    document.getElementById('codeDisplay').style.display = 'flex';
    document.getElementById('codeHint').textContent = 'En attente du destinataire…';
    toast(`Code généré : ${code}`, 'info', 10000);
  } catch(e) { toast(String(e), 'error'); }
});
document.getElementById('btnCopyCode').addEventListener('click', () => {
  const code = document.getElementById('codeValue').textContent;
  navigator.clipboard.writeText(code).then(() => toast('Code copié !', 'info', 2000));
});
document.getElementById('btnJoinCode').addEventListener('click', async () => {
  const code = document.getElementById('codeInputField').value.trim().toLowerCase();
  if (!code || code.length < 4) { toast('Entre un code valide', 'error'); return; }
  state.isInternetProgress = true;
  showProgress('En attente…', 'Connexion au relay…');
  try {
    await invoke('join_relay_room', { code });
  } catch(e) { hideProgress(); state.isInternetProgress = false; toast(String(e), 'error'); }
});

// ── Internet mode (IP direct) ──────────────────────────────────────────────
document.getElementById('selectFileIp').addEventListener('click', async () => {
  const files = await pickFile(false);
  if (files && files[0]) {
    state.selectedFileIp = files[0];
    document.getElementById('fileNameIp').textContent = files[0].name;
    document.getElementById('fileSizeIp').textContent = formatBytes(files[0].size);
    document.getElementById('selectedFileIp').style.display = 'flex';
  }
});
document.getElementById('clearFileIp').addEventListener('click', () => {
  state.selectedFileIp = null;
  document.getElementById('selectedFileIp').style.display = 'none';
});
document.getElementById('btnSendIp').addEventListener('click', async () => {
  const ip = document.getElementById('destIpInput').value.trim();
  if (!state.selectedFileIp) { toast('Sélectionne un fichier', 'error'); return; }
  if (!ip) { toast("Entre l'IP du destinataire", 'error'); return; }
  state.isInternetProgress = true;
  showProgress(state.selectedFileIp.name, `Envoi direct à ${ip}…`);
  try {
    await invoke('send_file', { ip, filePath: state.selectedFileIp.path });
  } catch(e) { hideProgress(); state.isInternetProgress = false; toast(String(e), 'error'); }
});
document.getElementById('btnCopyIp').addEventListener('click', () => {
  if (state.publicIp) navigator.clipboard.writeText(state.publicIp).then(() => toast('IP copiée !', 'info', 2000));
});

// ── Settings ───────────────────────────────────────────────────────────────
document.getElementById('btnOpenFolder').addEventListener('click', () =>
  invoke('open_download_folder').catch(e => toast(String(e), 'error'))
);
document.getElementById('btnFirewall').addEventListener('click', async () => {
  try {
    const msg = await invoke('configure_firewall');
    toast('🛡 ' + msg, 'success', 5000);
  } catch(e) {
    toast('Pare-feu : ' + e + ' — Lance l\'app en admin.', 'error', 8000);
  }
});

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  await initListeners();

  // Configure le pare-feu silencieusement
  invoke('configure_firewall').catch(() => {});

  // Démarre le récepteur de fichiers
  invoke('start_receiver').catch(e => {
    console.warn('Receiver:', e);
    toast('Erreur démarrage récepteur : ' + e, 'error', 8000);
  });

  // IP locale + découverte LAN
  invoke('get_local_ip').then(ip => {
    state.localIp = ip;
    // Pseudo sauvegardé ou par défaut Flash@IP
    const savedPseudo = localStorage.getItem('ft_pseudo');
    state.senderName = savedPseudo ? `${savedPseudo}@${ip}` : `Flash@${ip}`;
    document.getElementById('deviceName').textContent = state.senderName;
    // Pré-remplir le champ pseudo
    if (savedPseudo) document.getElementById('pseudoInput').value = savedPseudo;
    invoke('start_lan_discovery', { name: state.senderName }).catch(console.warn);
  }).catch(console.warn);

  // Sauvegarde pseudo
  document.getElementById('btnSavePseudo').addEventListener('click', savePseudo);
  document.getElementById('pseudoInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') savePseudo();
  });

  // IP publique
  invoke('get_public_ip').then(ip => {
    state.publicIp = ip;
    document.getElementById('myPublicIp').textContent = ip;
  }).catch(() => {
    document.getElementById('myPublicIp').textContent = 'N/A';
  });

  // Badge fichiers reçus
  updateFilesBadge();
}

window.addEventListener('DOMContentLoaded', init);
