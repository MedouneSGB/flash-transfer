/* Flash⚡Transfer — App Logic */

const { invoke, event } = window.__TAURI__;
const { listen } = window.__TAURI__.event;
const { open } = window.__TAURI__.dialog;

// ── State ────────────────────────────────────────────────────────────────
let state = {
  peers: [],
  selectedPeer: null,
  selectedFileLan: null,
  selectedFileCode: null,
  selectedFileIp: null,
  currentTransfer: null,
  relayCode: null,
  localIp: null,
  publicIp: null,
};

// ── Utils ────────────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function formatSpeed(mbps) {
  if (mbps < 1) return (mbps * 1000).toFixed(0) + ' KB/s';
  if (mbps > 1000) return (mbps / 1000).toFixed(1) + ' GB/s';
  return mbps.toFixed(1) + ' MB/s';
}

function formatEta(secs) {
  if (secs <= 0 || !isFinite(secs)) return '--';
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
    el.style.animation = 'none';
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
  document.getElementById('progressBar').style.width = pct.toFixed(1) + '%';
  document.getElementById('progPercent').textContent = pct.toFixed(1) + '%';
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
    const panelId = 'tab-' + tab.dataset.tab;
    document.getElementById(panelId).classList.add('active');
  });
});

// Sub-tabs within internet cards
document.querySelectorAll('.internet-card').forEach(card => {
  card.querySelectorAll('.sub-tab').forEach(st => {
    st.addEventListener('click', () => {
      card.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
      card.querySelectorAll('.sub-panel').forEach(p => p.classList.remove('active'));
      st.classList.add('active');
      const panelId = 'sub-' + st.dataset.subtab;
      document.getElementById(panelId).classList.add('active');
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
    const { file_name, save_path, avg_speed_mbps, elapsed_secs } = event.payload;
    const speed = avg_speed_mbps > 0 ? ` • ${formatSpeed(avg_speed_mbps)}` : '';
    const loc = save_path ? ` → ${save_path}` : '';
    toast(`✓ ${file_name} transféré${speed}${loc}`, 'success', 6000);
    state.currentTransfer = null;
  });

  await listen('transfer-error', (event) => {
    hideProgress();
    toast(event.payload.message, 'error', 8000);
    state.currentTransfer = null;
  });

  await listen('receiver-started', () => {
    document.getElementById('statusDot').classList.remove('inactive');
  });

  await listen('relay-status', (event) => {
    const { code, connected, message } = event.payload;
    document.getElementById('codeHint').textContent = message;
  });

  await listen('relay-peer-connected', () => {
    document.getElementById('codeHint').textContent = '⚡ Destinataire connecté! Envoi en cours...';
    toast('Destinataire connecté!', 'success');
  });
}

// ── Peers rendering ───────────────────────────────────────────────────────
function renderPeers() {
  const list = document.getElementById('peersList');
  document.getElementById('peerCount').textContent = state.peers.length;

  if (state.peers.length === 0) {
    list.innerHTML = `
      <div class="no-peers">
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
    </div>
  `).join('');

  list.querySelectorAll('.peer-card').forEach(card => {
    card.addEventListener('click', () => {
      state.selectedPeer = {
        ip: card.dataset.ip,
        port: parseInt(card.dataset.port),
        name: card.dataset.name,
      };
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

// ── File selection helpers ────────────────────────────────────────────────
function setupFilePicker(btnId, inputId, zone, nameId, sizeId, key, clearId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  const clearBtn = document.getElementById(clearId);
  const dropZone = document.getElementById(zone);
  const generate = document.getElementById('btnGenerateCode');

  function setFile(file) {
    state[key] = file;
    document.getElementById(nameId).textContent = file.name;
    document.getElementById(sizeId).textContent = formatBytes(file.size);
    document.querySelector(`#${zone}`).style.display = 'none';
    document.querySelector(`#selected${key.replace('selectedF', 'F').replace('selected', '')}`).style.display = 'flex';

    // Expose correct selected file
    if (key === 'selectedFileCode') {
      const el = document.getElementById('selectedFileCode');
      const dropEl = document.getElementById('dropZoneCode');
      el.style.display = 'flex';
      dropEl.style.display = 'none';
      if (generate) { generate.disabled = false; }
    } else if (key === 'selectedFileLan') {
      document.getElementById('selectedFileLan').style.display = 'flex';
      document.getElementById('dropZoneLan').style.display = 'none';
      updatePeerTarget();
    } else if (key === 'selectedFileIp') {
      document.getElementById('selectedFileIp').style.display = 'flex';
      document.getElementById('dropZoneIp').style.display = 'none';
    }
  }

  btn.addEventListener('click', async () => {
    const path = await open({ multiple: false, title: 'Sélectionner un fichier' });
    if (path) {
      // Tauri returns file path as string
      const name = path.split(/[\\/]/).pop();
      const fakeFile = { name, path, size: 0 };
      // Get real file size
      try {
        const meta = await invoke('get_file_size', { path }).catch(() => 0);
        fakeFile.size = meta || 0;
      } catch {}
      state[key] = fakeFile;
      document.getElementById(nameId).textContent = name;
      document.getElementById(sizeId).textContent = fakeFile.size > 0 ? formatBytes(fakeFile.size) : 'Calcul...';
      if (key === 'selectedFileLan') {
        document.getElementById('selectedFileLan').style.display = 'flex';
        document.getElementById('dropZoneLan').style.display = 'none';
        updatePeerTarget();
      } else if (key === 'selectedFileCode') {
        document.getElementById('selectedFileCode').style.display = 'flex';
        document.getElementById('dropZoneCode').style.display = 'none';
        if (generate) generate.disabled = false;
      } else if (key === 'selectedFileIp') {
        document.getElementById('selectedFileIp').style.display = 'flex';
        document.getElementById('dropZoneIp').style.display = 'none';
      }
    }
  });

  clearBtn.addEventListener('click', () => {
    state[key] = null;
    if (key === 'selectedFileLan') {
      document.getElementById('selectedFileLan').style.display = 'none';
      document.getElementById('dropZoneLan').style.display = 'flex';
      updatePeerTarget();
    } else if (key === 'selectedFileCode') {
      document.getElementById('selectedFileCode').style.display = 'none';
      document.getElementById('dropZoneCode').style.display = 'flex';
      document.getElementById('codeDisplay').style.display = 'none';
      if (generate) generate.disabled = true;
    } else if (key === 'selectedFileIp') {
      document.getElementById('selectedFileIp').style.display = 'none';
      document.getElementById('dropZoneIp').style.display = 'flex';
    }
  });

  // Drag and drop
  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        const f = files[0];
        const pathEntry = e.dataTransfer.items[0]?.getAsFile();
        // We'll use the file path approach via Tauri webview
        state[key] = { name: f.name, path: f.path || f.name, size: f.size };
        document.getElementById(nameId).textContent = f.name;
        document.getElementById(sizeId).textContent = formatBytes(f.size);
        if (key === 'selectedFileLan') {
          document.getElementById('selectedFileLan').style.display = 'flex';
          document.getElementById('dropZoneLan').style.display = 'none';
          updatePeerTarget();
        } else if (key === 'selectedFileCode') {
          document.getElementById('selectedFileCode').style.display = 'flex';
          document.getElementById('dropZoneCode').style.display = 'none';
          if (generate) generate.disabled = false;
        } else if (key === 'selectedFileIp') {
          document.getElementById('selectedFileIp').style.display = 'flex';
          document.getElementById('dropZoneIp').style.display = 'none';
        }
      }
    });
    dropZone.addEventListener('click', () => btn.click());
  }
}

// ── LAN Send ──────────────────────────────────────────────────────────────
document.getElementById('btnSendLan').addEventListener('click', async () => {
  if (!state.selectedFileLan || !state.selectedPeer) return;
  showProgress(state.selectedFileLan.name, `Envoi à ${state.selectedPeer.name}...`);
  try {
    await invoke('send_file', {
      ip: state.selectedPeer.ip,
      filePath: state.selectedFileLan.path,
    });
  } catch (e) {
    hideProgress();
    toast(e.toString(), 'error');
  }
});

// ── Code relay send ────────────────────────────────────────────────────────
document.getElementById('btnGenerateCode').addEventListener('click', async () => {
  if (!state.selectedFileCode) return;
  try {
    const code = await invoke('generate_relay_code', {
      filePath: state.selectedFileCode.path,
    });
    document.getElementById('codeValue').textContent = code;
    document.getElementById('codeDisplay').style.display = 'flex';
    document.getElementById('codeHint').textContent = 'En attente du destinataire...';
    showProgress(state.selectedFileCode.name, 'Connexion relay...');
    toast(`Code généré: ${code}`, 'info', 8000);
  } catch (e) {
    toast(e.toString(), 'error');
  }
});

document.getElementById('btnCopyCode').addEventListener('click', () => {
  const code = document.getElementById('codeValue').textContent;
  navigator.clipboard.writeText(code).then(() => toast('Code copié!', 'info', 2000));
});

// ── Code relay receive ────────────────────────────────────────────────────
document.getElementById('btnJoinCode').addEventListener('click', async () => {
  const code = document.getElementById('codeInputField').value.trim();
  if (!code || code.length < 4) { toast('Entre un code valide', 'error'); return; }
  showProgress('En attente...', 'Connexion au relay...');
  try {
    await invoke('join_relay_room', { code });
  } catch (e) {
    hideProgress();
    toast(e.toString(), 'error');
  }
});

// ── IP direct send ────────────────────────────────────────────────────────
document.getElementById('btnSendIp').addEventListener('click', async () => {
  const ip = document.getElementById('destIpInput').value.trim();
  if (!state.selectedFileIp) { toast('Sélectionne un fichier', 'error'); return; }
  if (!ip) { toast('Entre l\'IP du destinataire', 'error'); return; }
  showProgress(state.selectedFileIp.name, `Envoi direct à ${ip}...`);
  try {
    await invoke('send_file', { ip, filePath: state.selectedFileIp.path });
  } catch (e) {
    hideProgress();
    toast(e.toString(), 'error');
  }
});

// ── Copy IP ────────────────────────────────────────────────────────────────
document.getElementById('btnCopyIp').addEventListener('click', () => {
  if (state.publicIp) {
    navigator.clipboard.writeText(`${state.publicIp}:45679`)
      .then(() => toast('IP copiée!', 'info', 2000));
  }
});
document.getElementById('btnCopyIp2').addEventListener('click', () => {
  if (state.publicIp) {
    navigator.clipboard.writeText(`${state.publicIp}:45679`)
      .then(() => toast('IP copiée!', 'info', 2000));
  }
});

// ── Cancel transfer ────────────────────────────────────────────────────────
document.getElementById('btnCancelTransfer').addEventListener('click', async () => {
  await invoke('disconnect_relay').catch(() => {});
  hideProgress();
  toast('Transfert annulé', 'info');
});

// ── Open folder ────────────────────────────────────────────────────────────
document.getElementById('btnOpenFolder').addEventListener('click', async () => {
  await invoke('open_download_folder');
});

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  await initTauriListeners();

  // Setup file pickers
  setupFilePicker('selectFileLan', 'fileInputLan', 'dropZoneLan', 'fileNameLan', 'fileSizeLan', 'selectedFileLan', 'clearFileLan');
  setupFilePicker('selectFileCode', 'fileInputCode', 'dropZoneCode', 'fileNameCode', 'fileSizeCode', 'selectedFileCode', 'clearFileCode');
  setupFilePicker('selectFileIp', 'fileInputIp', 'dropZoneIp', 'fileNameIp', 'fileSizeIp', 'selectedFileIp', 'clearFileIp');

  // Start receiver
  try {
    await invoke('start_receiver');
  } catch (e) {
    console.warn('Receiver start error:', e);
  }

  // Get local IP and start LAN discovery
  try {
    state.localIp = await invoke('get_local_ip');
    const hostname = state.localIp;
    document.getElementById('deviceName').textContent = hostname;
    await invoke('start_lan_discovery', { name: `Flash@${hostname}` });
  } catch (e) {
    console.warn('LAN discovery error:', e);
  }

  // Get public IP (async)
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
