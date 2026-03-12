# ⚡ Flash Transfer

> Transfert de fichiers ultra-rapide entre appareils — LAN & Internet

![Flash Transfer](https://img.shields.io/badge/version-1.0.0-FFD700?style=for-the-badge&logo=lightning&logoColor=black)
![Tauri](https://img.shields.io/badge/Tauri_2-0D0D0D?style=for-the-badge&logo=tauri&logoColor=FFD700)
![Rust](https://img.shields.io/badge/Rust-0D0D0D?style=for-the-badge&logo=rust&logoColor=FFD700)
![Platform](https://img.shields.io/badge/Windows_%7C_macOS_%7C_Linux-0D0D0D?style=for-the-badge&logoColor=FFD700)

---

## Aperçu

Flash Transfer est une application desktop **cross-platform** qui permet d'envoyer des fichiers instantanément entre deux machines, que ce soit sur le même réseau local ou via Internet.

- **Thème** jaune électrique `#FFD700` sur fond noir `#0D0D0D`
- **Backend** Rust (Tauri 2) pour des performances maximales
- **Protocole** TCP multi-stream parallèle (inspiration Java FastFileSender)
- **Binaire léger** ~10 MB (vs ~200 MB pour Electron)

---

## Fonctionnalités

### 📡 Mode LAN (même réseau)
- Découverte automatique des appareils via UDP broadcast
- Détection en temps réel (mise à jour toutes les 2s)
- Transfert TCP multi-stream : N streams parallèles = CPU cores × 2
- Chunks de 64 MB, buffers de 8 MB par stream
- **Objectif : >400 MB/s sur réseau Gigabit**

### 🌐 Mode Internet
**Code de partage** (relay, fonctionne partout) :
1. L'envoyeur sélectionne un fichier → génère un code court (ex: `f7x9k2`)
2. Le destinataire entre le code → connexion automatique via serveur relay
3. Transfert relayé via WebSocket

**IP directe** (vitesse maximale, P2P) :
1. L'envoyeur communique son IP publique + port `45679`
2. Le destinataire se connecte directement
3. Transfert TCP direct sans intermédiaire

### Transfert commun
- Drag & drop de fichiers
- Dossiers supportés (zip automatique)
- Fichiers multiples (envoi séquentiel)
- Barre de progression : `%, MB/s, ETA`
- Sauvegarde dans `~/Downloads/FlashTransfer/`
- Notifications toast succès/erreur

---

## Stack technique

| Composant | Technologie |
|---|---|
| Framework desktop | **Tauri 2** |
| Backend réseau | **Rust + tokio** (async I/O) |
| Découverte LAN | UDP broadcast (`tokio::net::UdpSocket`) |
| Relay internet | WebSocket (`tokio-tungstenite`) |
| Interface | HTML + CSS + Vanilla JS |
| Packaging | `tauri build` → .exe / .dmg / .AppImage |

---

## Prérequis

### Windows
- [Node.js](https://nodejs.org) v18+
- [Rust](https://rustup.rs) (stable)
- Visual Studio 2019/2022 Build Tools (C++ workload)
- Windows SDK 10.0.22621+

### macOS
- Xcode Command Line Tools : `xcode-select --install`
- Node.js + Rust

### Linux
```bash
sudo apt install libwebkit2gtk-4.1-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

---

## Installation & lancement

```bash
git clone https://github.com/MedouneSGB/flash-transfer
cd flash-transfer
npm install
```

### Windows (via script)
```bat
run.bat        # Mode développement
build.bat      # Build production → .exe
```

### macOS / Linux
```bash
npm run dev    # Mode développement
npm run build  # Build production
```

---

## Build production

```bash
npm run build
```

Les installeurs générés se trouvent dans :
```
src-tauri/target/release/bundle/
├── nsis/          → Flash Transfer_1.0.0_x64-setup.exe  (Windows)
├── dmg/           → Flash Transfer_1.0.0_x64.dmg        (macOS)
└── appimage/      → flash-transfer_1.0.0_amd64.AppImage (Linux)
```

---

## Serveur relay (mode Internet code)

Le serveur relay est un serveur WebSocket Node.js minimal (~80 lignes).

### Déploiement gratuit sur Render.com

1. Fork ce repo
2. Sur [render.com](https://render.com) → New Web Service
3. Connecte ton repo GitHub
4. **Root Directory** : `server`
5. **Build command** : `npm install`
6. **Start command** : `node relay-server.js`
7. Copie l'URL générée (ex: `wss://flash-transfer-relay.onrender.com`)
8. Configure dans l'app via la variable d'env `FLASH_RELAY_URL`

### Lancement local
```bash
cd server
npm install
node relay-server.js
# ⚡ Flash⚡Transfer Relay Server running on port 8765
```

---

## Architecture

```
flash-transfer/
├── src/                         # Frontend HTML/CSS/JS
│   ├── index.html               # Interface SPA (onglets LAN / Internet)
│   ├── style.css                # Thème jaune #FFD700 / noir #0D0D0D
│   └── app.js                   # Logique UI + appels Tauri invoke()
├── src-tauri/                   # Backend Rust
│   └── src/
│       ├── lib.rs               # Point d'entrée + commands Tauri
│       ├── transfer.rs          # Moteur TCP multi-stream
│       ├── lan_discovery.rs     # Découverte UDP broadcast
│       └── relay_client.rs      # Client WebSocket relay
├── server/
│   └── relay-server.js          # Serveur relay WebSocket
├── run.bat                      # Lancer en dev (Windows)
└── build.bat                    # Build production (Windows)
```

---

## Protocole de transfert TCP

```
Header envoyé par stream :
[8 bytes] Taille totale du fichier
[4 bytes] Longueur du nom de fichier
[4 bytes] Index du chunk
[8 bytes] Offset dans le fichier
[8 bytes] Longueur du chunk
[N bytes] Nom du fichier
[data...] Données binaires

Réponse récepteur :
[3 bytes] "ACK"
```

N streams parallèles (= CPU cores × 2, max 16) envoient chacun une partie du fichier simultanément. Le récepteur assemble les `.partN` dans le bon ordre.

---

## Licence

MIT — Libre d'utilisation, modification et distribution.
