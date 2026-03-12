/* Flash⚡Transfer — App Logic (Tauri 2) */

// ── Tauri 2 API ──────────────────────────────────────────────────────────
const invoke = window.__TAURI__.core.invoke;
const { listen } = window.__TAURI__.event;
const { open: openDialog } = window.__TAURI__.dialog;

// ── State ────────────────────────────────────────────────────────────────
const state = {
  peers: [],
  selectedPeer: null,
  selectedFileLan: null,
  selectedFileCode: null,
  selectedFileIp: null,
  publicIp: null,
  localIp: null,
};

// ── Utils ────────────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function formatSpeed(mbps) {
  if (!mbps || mbps <= 0) return '0 MB/s';
  if (mbps < 1) return (mbps * 1000).toFixed(0) + ' KB/s';
  if (mbps > 1000) return (mbps / 1000).toFixed(1) + ' GB/s';
  return mbps.toFixed(1) + ' MB/s';
}

function formatEta(secs) {
  if (!secs || secs <= 0 || !isFinite(secs)) return '--';
  if (secs < 60) return Math.ceil(secs) + 's';
  if (secs < 3600) return Math.floor(secs / 60) + 'm ' + Math.ceil(secs % 60) + 's';
  return Math.floor(secs / 3600) + 'h ' + Math.floor((secs % 3600) / 60) + 'm';
}

function toast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', info: '⚡' };
  el.innerHTML = `<span>${icons[type] || '⚡'}</span><span>${message}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(120%)';
    el.style.transition = 'all 0.2s';
    setTimeout(() => el.remove(), 200);
  }, duration);
}

function showProgress(fileName, mode) {
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
  document.getElementById('progressBar').style.width = Math.min(pct, 100).toFixed(1) + '%';
  document.getElementById('progPercent').textContent = Math.min(pct, 100).toFixed(1) + '%';
  document.getElementById('progSpeed').textContent = formatSpeed(speed);
  document.getElementById('progEta').textContent = formatEta(eta);
  document.getElementById('progBytes').textContent = formatBytes(done) + ' / ' + formatBytes(total);
}

function hideProgress() {
  document.getElementById('progressOverlay').style.display = 'none';
}

// ── Tab switching ────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// Sub-tabs
document.querySelectorAll('.internet-card').forEach(card => {
  card.querySelectorAll('.sub-tab').forEach(st => {
    st.addEventListener('click', () => {
      card.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
      card.querySelectorAll('.sub-panel').forEach(p => p.classList.remove('active'));
      st.classList.add('active');
      document.getElementById('sub-' + st.dataset.subtab).classList.add('active');
    });
  });
});

// ── Tauri Events ─────────────────────────────────────────────────────────
async function initTauriListeners() {
  await listen('peers-updated', (event) => {
    state.peers = event.payload;
    renderPeers();
  });

  await listen('transfer-progress', (event) => {
    const { file_name, bytes_done, total_bytes, speed_mbps, eta_secs, percent } = event.payload;
    updateProgress(percent, speed_mbps, eta_secs, bytes_done, total_bytes);
  });

  await listen('transfer-done', (event) => {
    hideProgress();
    const { file_name, save_path, avg_speed_mbps } = event.payload;
    const speed = avg_speed_mbps > 0 ? ` • ${formatSpeed(avg_speed_mbps)}` : '';
    const loc = save_path ? ` → ${save_path}` : '';
    toast(`✓ ${file_name} transféré${speed}${loc}`, 'success', 6000);
  });

  await listen('transfer-error', (event) => {
    hideProgress();
    toast(event.payload.message, 'error', 8000);
  });

  await listen('receiver-started', () => {
    document.getElementById('statusDot').classList.remove('inactive');
  });

  await listen('relay-status', (event) => {
    document.getElementById('codeHint').textContent = event.payload.message;
  });

  await listen('relay-peer-connected', () => {
    document.getElementById('codeHint').textContent = '⚡ Destinataire connecté ! Envoi en cours...';
    showProgress(state.selectedFileCode?.name || '...', 'Envoi via relay...');
    toast('Destinataire connecté !', 'success');
  });
}

// ── Peers ─────────────────────────────────────────────────────────────────
function renderPeers() {
  const list = document.getElementById('peersList');
  document.getElementById('peerCount').textContent = state.peers.length;

  if (state.peers.length === 0) {
    list.innerHTML = `<div class="no-peers">
      <div class="scan-anim">📡</div>
      <p>Scan en cours...</p>
      <p class="hint">Les appareils avec Flash⚡Transfer apparaîtront ici</p>
    </div>`;
    return;
  }

  list.innerHTML = state.peers.map(peer => `
    <div class="peer-card${state.selectedPeer?.ip === peer.ip ? ' selected' : ''}"
         data-ip="${peer.ip}" data-port="${peer.port}" data-name="${peer.name}">
      <div class="peer-left">
        <div class="peer-avatar">💻</div>
        <div>
          <div class="peer-name">${peer.name}</div>
          <div class="peer-ip">${peer.ip}</div>
        </div>
      </div>
      <div class="peer-online"></div>
    </div>`).join('');

  list.querySelectorAll('.peer-card').forEach(card => {
    card.addEventListener('click', () => {
      state.selectedPeer = { ip: card.dataset.ip, port: parseInt(card.dataset.port), name: card.dataset.name };
      renderPeers();
      updatePeerTarget();
    });
  });
}

function updatePeerTarget() {
  const target = document.getElementById('peerTarget');
  if (state.selectedPeer && state.selectedFileLan) {
    target.style.display = 'flex';
    document.getElementById('targetName').textContent = state.selectedPeer.name;
  } else {
    target.style.display = 'none';
  }
}

// ── File selection (Tauri 2 dialog) ──────────────────────────────────────
async function pickFile() {
  try {
    const path = await openDialog({
      multiple: false,
      title: 'Sélectionner un fichier',
    });
    if (!path) return null;
    // Tauri 2 returns string path
    const filePath = typeof path === 'string' ? path : path[0];
    const name = filePath.replace(/\\/g, '/').split('/').pop();
    const size = await invoke('get_file_size', { path: filePath }).catch(() => 0);
    return { name, path: filePath, size };
  } catch (e) {
    console.error('File picker error:', e);
    toast('Erreur sélection fichier: ' + e, 'error');
    return null;
  }
}

function setSelectedFile(key, file) {
  state[key] = file;

  const configs = {
    selectedFileLan:  { nameEl: 'fileNameLan',  sizeEl: 'fileSizeLan',  dropId: 'dropZoneLan',  selId: 'selectedFileLan'  },
    selectedFileCode: { nameEl: 'fileNameCode', sizeEl: 'fileSizeCode', dropId: 'dropZoneCode', selId: 'selectedFileCode' },
    selectedFileIp:   { nameEl: 'fileNameIp',   sizeEl: 'fileSizeIp',   dropId: 'dropZoneIp',   selId: 'selectedFileIp'   },
  };

  const cfg = configs[key];
  if (!cfg) return;

  if (file) {
    document.getElementById(cfg.nameEl).textContent = file.name;
    document.getElementById(cfg.sizeEl).textContent = file.size > 0 ? formatBytes(file.size) : '';
    document.getElementById(cfg.dropId).style.display = 'none';
    document.getElementById(cfg.selId).style.display = 'flex';
    if (key === 'selectedFileCode') {
      document.getElementById('btnGenerateCode').disabled = false;
    }
    if (key === 'selectedFileLan') updatePeerTarget();
  } else {
    document.getElementById(cfg.dropId).style.display = 'flex';
    document.getElementById(cfg.selId).style.display = 'none';
    if (key === 'selectedFileCode') {
      document.getElementById('btnGenerateCode').disabled = true;
      document.getElementById('codeDisplay').style.display = 'none';
    }
    if (key === 'selectedFileLan') updatePeerTarget();
  }
}

function setupDropZone(dropId, key) {
  const zone = document.getElementById(dropId);
  if (!zone) return;

  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const f = files[0];
      // Tauri webview exposes the real path via f.path (Tauri-specific)
      const filePath = f.path || f.name;
      setSelectedFile(key, { name: f.name, path: filePath, size: f.size });
    }
  });
}

// ── Button wiring ─────────────────────────────────────────────────────────

// LAN file select
document.getElementById('selectFileLan').addEventListener('click', async () => {
  const file = await pickFile();
  if (file) setSelectedFile('selectedFileLan', file);
});
document.getElementById('clearFileLan').addEventListener('click', () => setSelectedFile('selectedFileLan', null));
setupDropZone('dropZoneLan', 'selectedFileLan');

// LAN send
document.getElementById('btnSendLan').addEventListener('click', async () => {
  if (!state.selectedFileLan || !state.selectedPeer) return;
  showProgress(state.selectedFileLan.name, `Envoi à ${state.selectedPeer.name}...`);
  try {
    await invoke('send_file', { ip: state.selectedPeer.ip, filePath: state.selectedFileLan.path });
  } catch (e) { hideProgress(); toast(String(e), 'error'); }
});

// Code relay — file select
document.getElementById('selectFileCode').addEventListener('click', async () => {
  const file = await pickFile();
  if (file) setSelectedFile('selectedFileCode', file);
});
document.getElementById('clearFileCode').addEventListener('click', () => setSelectedFile('selectedFileCode', null));
setupDropZone('dropZoneCode', 'selectedFileCode');

// Code relay — generate
document.getElementById('btnGenerateCode').addEventListener('click', async () => {
  if (!state.selectedFileCode) return;
  try {
    const code = await invoke('generate_relay_code', { filePath: state.selectedFileCode.path });
    document.getElementById('codeValue').textContent = code;
    document.getElementById('codeDisplay').style.display = 'flex';
    document.getElementById('codeHint').textContent = 'En attente du destinataire...';
    toast(`Code généré : ${code}`, 'info', 10000);
  } catch (e) { toast(String(e), 'error'); }
});

// Code relay — copy code
document.getElementById('btnCopyCode').addEventListener('click', () => {
  const code = document.getElementById('codeValue').textContent;
  navigator.clipboard.writeText(code).then(() => toast('Code copié !', 'info', 2000));
});

// Code relay — join
document.getElementById('btnJoinCode').addEventListener('click', async () => {
  const code = document.getElementById('codeInputField').value.trim().toLowerCase();
  if (!code || code.length < 4) { toast('Entre un code valide', 'error'); return; }
  showProgress('En attente...', 'Connexion au relay...');
  try {
    await invoke('join_relay_room', { code });
  } catch (e) { hideProgress(); toast(String(e), 'error'); }
});

// IP directe — file select
document.getElementById('selectFileIp').addEventListener('click', async () => {
  const file = await pickFile();
  if (file) setSelectedFile('selectedFileIp', file);
});
document.getElementById('clearFileIp').addEventListener('click', () => setSelectedFile('selectedFileIp', null));
setupDropZone('dropZoneIp', 'selectedFileIp');

// IP directe — send
document.getElementById('btnSendIp').addEventListener('click', async () => {
  const ip = document.getElementById('destIpInput').value.trim();
  if (!state.selectedFileIp) { toast('Sélectionne un fichier', 'error'); return; }
  if (!ip) { toast("Entre l'IP du destinataire", 'error'); return; }
  showProgress(state.selectedFileIp.name, `Envoi direct à ${ip}...`);
  try {
    await invoke('send_file', { ip, filePath: state.selectedFileIp.path });
  } catch (e) { hideProgress(); toast(String(e), 'error'); }
});

// Copy public IP
function copyPublicIp() {
  if (state.publicIp) {
    navigator.clipboard.writeText(`${state.publicIp}:45679`)
      .then(() => toast('IP copiée !', 'info', 2000));
  }
}
document.getElementById('btnCopyIp').addEventListener('click', copyPublicIp);
document.getElementById('btnCopyIp2').addEventListener('click', copyPublicIp);

// Cancel transfer
document.getElementById('btnCancelTransfer').addEventListener('click', async () => {
  await invoke('disconnect_relay').catch(() => {});
  hideProgress();
  toast('Transfert annulé', 'info');
});

// Open download folder
document.getElementById('btnOpenFolder').addEventListener('click', async () => {
  await invoke('open_download_folder').catch(e => toast(String(e), 'error'));
});

// Manual firewall config button
document.getElementById('btnFirewall').addEventListener('click', async () => {
  try {
    const msg = await invoke('configure_firewall');
    toast('🛡 ' + msg, 'success', 5000);
  } catch (e) {
    toast('Firewall : ' + String(e) + ' — Lance l\'app en admin.', 'error', 8000);
  }
});

// ── Firewall helper ──────────────────────────────────────────────────────
async function applyFirewallRules() {
  try {
    const msg = await invoke('configure_firewall');
    console.info('Firewall:', msg);
  } catch (e) {
    // Non-fatal: show hint to run as admin if rules couldn't be applied
    console.warn('Firewall config failed (not admin?):', e);
    toast(
      'Pare-feu : Lance l\'app en tant qu\'administrateur pour ouvrir les ports automatiquement, ou ouvre le port TCP 45679 manuellement.',
      'info',
      10000
    );
  }
}

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
  await initTauriListeners();

  // Apply Windows firewall rules (silent if already OK / non-admin)
  applyFirewallRules();

  // Start receiver
  invoke('start_receiver').catch(e => {
    console.warn('Receiver error:', e);
    toast('Erreur démarrage receiver : ' + e, 'error', 8000);
  });

  // Local IP + LAN discovery
  invoke('get_local_ip').then(ip => {
    state.localIp = ip;
    document.getElementById('deviceName').textContent = `Flash@${ip}`;
    invoke('start_lan_discovery', { name: `Flash@${ip}` }).catch(console.warn);
  }).catch(console.warn);

  // Public IP
  invoke('get_public_ip').then(ip => {
    state.publicIp = ip;
    document.getElementById('myPublicIp').textContent = ip;
    document.getElementById('myPublicIp2').textContent = ip;
  }).catch(() => {
    document.getElementById('myPublicIp').textContent = 'N/A';
    document.getElementById('myPublicIp2').textContent = 'N/A';
  });
}

window.addEventListener('DOMContentLoaded', init);
