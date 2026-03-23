# ⚡ Flash Transfer

> Transfert de fichiers ultra-rapide entre appareils — LAN & Internet, sans cloud, sans compte

![Flash Transfer](https://img.shields.io/badge/version-1.3.2-FFD700?style=for-the-badge&logo=lightning&logoColor=black)
![Tauri](https://img.shields.io/badge/Tauri_2-0D0D0D?style=for-the-badge&logo=tauri&logoColor=FFD700)
![Rust](https://img.shields.io/badge/Rust-0D0D0D?style=for-the-badge&logo=rust&logoColor=FFD700)
![Platform](https://img.shields.io/badge/Windows_%7C_macOS_%7C_Linux-0D0D0D?style=for-the-badge&logoColor=FFD700)

---

## Aperçu

Flash Transfer est une application desktop **cross-platform** qui permet d'envoyer des fichiers instantanément entre deux machines, que ce soit sur le même réseau local ou via Internet — sans passer par le cloud, sans créer de compte.

- **Thème** jaune électrique `#FFD700` sur fond noir `#0D0D0D`
- **Backend** Rust (Tauri 2) pour des performances maximales
- **Protocole** TCP multi-stream parallèle (N streams = CPU cores × 2)
- **Binaire léger** ~10 MB (vs ~200 MB pour Electron)
- **Intégration** Google OAuth via Supabase (pseudonyme + authentification optionnelle)

---

## Fonctionnalités

### 📡 Mode LAN (même réseau)
- Découverte automatique des appareils via UDP broadcast (port 45678)
- Détection en temps réel (mise à jour toutes les 2 s, timeout à 6 s)
- **Chat** intégré entre pairs (messages texte + fichiers)
- Transfert TCP multi-stream : N streams parallèles = (CPU cores × 2).min(16).max(2)
- Chunks de 64 MB, buffers de 4–8 MB par stream
- Vérification d'intégrité SHA-256 post-transfert
- **Objectif : >400 MB/s sur réseau Gigabit**

### 🌐 Mode Internet
**Code de partage** (relay WebSocket, fonctionne partout) :
1. L'envoyeur sélectionne un fichier → génère un code 6 caractères (ex : `a7k2p9`)
2. Le destinataire entre le code → connexion automatique via serveur relay
3. Transfert relayé via WebSocket (`wss://flash-transfer-7vj7.onrender.com`)

**IP directe** (vitesse maximale, P2P) :
1. L'envoyeur affiche son IP publique (détection via `api.ipify.org`) + port `45679`
2. Le destinataire se connecte directement via TCP
3. Même protocole multi-stream que le mode LAN

### 🌍 Mode Web (sans installation)
- Interface web complète disponible depuis un navigateur
- Transferts P2P via **WebRTC** (PeerJS) avec fallback relay
- Partage par QR code (scan + génération intégrés)
- Aucune installation requise, aucun fichier stocké côté serveur

### Transfert commun
- Drag & drop de fichiers
- Dossiers supportés (zip automatique)
- Fichiers multiples (envoi séquentiel)
- Dialogue d'approbation avant réception de chaque fichier
- Barre de progression : `%, MB/s, ETA`
- Sauvegarde automatique dans `~/Downloads/FlashTransfer/`
- Notifications toast succès/erreur (auto-dismiss 4 s)
- Limite : jusqu'à **1 Go** (web), **100 Go** (app desktop)

---

## Stack technique

| Composant | Technologie |
|---|---|
| Framework desktop | **Tauri 2** |
| Backend réseau | **Rust + tokio** (async I/O) |
| Découverte LAN | UDP broadcast (`tokio::net::UdpSocket`, port 45678) |
| Transfert fichier | TCP multi-stream (port 45679) |
| Messagerie/contrôle | TCP length-prefixed JSON (port 45680) |
| Relay internet | WebSocket (`tokio-tungstenite`) |
| Authentification | Google OAuth via Supabase (port local 7432) |
| Interface desktop | HTML + CSS + Vanilla JS + Tauri API |
| Interface web | HTML + CSS + Vanilla JS + WebRTC (PeerJS) |
| QR code | `jsQR` (scan) + `qrcode-gen` (génération) |
| Packaging | `tauri build` → `.msi` / `.dmg` / `.AppImage` / `.deb` |

---

## Architecture

```
flash-transfer/
├── src/                         # Frontend desktop (HTML/CSS/JS)
│   ├── index.html               # Interface SPA (sidebar LAN / Internet / Settings)
│   ├── style.css                # Thème jaune #FFD700 / noir #0D0D0D
│   ├── app.js                   # Logique UI + appels Tauri invoke() (1200 lignes)
│   ├── jsQR.js                  # Scanner QR code
│   ├── qrcode-gen.js            # Générateur QR code
│   └── supabase.umd.js          # SDK Supabase (Google OAuth)
├── src-tauri/                   # Backend Rust
│   └── src/
│       ├── lib.rs               # Entry point, commandes Tauri, firewall Windows
│       ├── transfer.rs          # Moteur TCP multi-stream + SHA-256 (692 lignes)
│       ├── lan_discovery.rs     # Découverte UDP broadcast (171 lignes)
│       ├── relay_client.rs      # Client WebSocket relay (296 lignes)
│       ├── messaging.rs         # Canal de contrôle TCP + chat (258 lignes)
│       └── oauth_server.rs      # Serveur OAuth local port 7432 (164 lignes)
├── server/
│   ├── relay-server.js          # Serveur relay WebSocket Node.js
│   └── package.json             # Dépendance : ws v8
├── website/                     # Site web + mode transfert navigateur
│   ├── index.html               # Page d'accueil marketing
│   ├── transfer.html            # Interface transfert WebRTC
│   ├── css/style.css
│   └── js/transfer.js           # Logique WebRTC + PeerJS
├── .github/workflows/
│   └── release.yml              # CI/CD : build multi-plateforme sur tag v*
├── render.yaml                  # Config déploiement Render.com
├── run.bat                      # Lancer en dev (Windows)
└── build.bat                    # Build production (Windows)
```

---

## Protocole de transfert TCP

```
Header par stream :
  [8 bytes]  Taille totale du fichier
  [4 bytes]  Longueur du nom de fichier
  [4 bytes]  Index du chunk (identifie le stream)
  [8 bytes]  Offset dans le fichier
  [8 bytes]  Longueur du chunk
  [N bytes]  Nom du fichier
  [data...]  Données binaires

Réponse récepteur :
  [3 bytes]  "ACK"
```

**N streams parallèles** = `(CPU cores × 2).min(16).max(2)` — chaque stream envoie un chunk de 64 MB en simultané. Le récepteur reconstruit le fichier depuis les parties reçues, puis vérifie le hash SHA-256.

**Ports utilisés :**

| Port | Protocole | Usage |
|------|-----------|-------|
| 45678 | UDP | Découverte LAN (broadcast) |
| 45679 | TCP | Transfert de fichiers |
| 45680 | TCP | Messagerie / canal de contrôle |
| 7432  | TCP | OAuth callback local |

---

## Prérequis

### Windows
- [Node.js](https://nodejs.org) v18+
- [Rust](https://rustup.rs) (stable)
- Visual Studio 2019/2022 Build Tools (workload C++)
- Windows SDK 10.0.22621+

### macOS
- Xcode Command Line Tools : `xcode-select --install`
- Node.js + Rust

### Linux
```bash
sudo apt install libwebkit2gtk-4.1-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev libgtk-3-dev patchelf
```

---

## Installation & lancement

```bash
git clone https://github.com/MedouneSGB/flash-transfer
cd flash-transfer
npm install
```

### Windows
```bat
run.bat        # Mode développement
build.bat      # Build production → .exe / .msi
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
├── nsis/          → Flash Transfer_1.3.2_x64-setup.exe  (Windows)
├── msi/           → Flash Transfer_1.3.2_x64.msi        (Windows)
├── dmg/           → Flash Transfer_1.3.2_x64.dmg        (macOS Intel)
├── dmg/           → Flash Transfer_1.3.2_aarch64.dmg    (macOS Apple Silicon)
├── appimage/      → flash-transfer_1.3.2_amd64.AppImage (Linux)
└── deb/           → flash-transfer_1.3.2_amd64.deb      (Linux)
```

### CI/CD automatique

Le workflow GitHub Actions (`.github/workflows/release.yml`) se déclenche sur chaque tag `v*` et produit les binaires pour **Windows, macOS Intel, macOS Apple Silicon et Linux** en parallèle.

```bash
git tag v1.3.2
git push origin v1.3.2
```

---

## Serveur relay (mode Internet)

Serveur WebSocket Node.js minimal gérant les salles de connexion entre envoyeur et destinataire.

**Caractéristiques :**
- Max 500 salles simultanées, expiration après 10 minutes d'inactivité
- Rate limiting : 5 connexions par IP
- Health check : `GET /health` → `{ status: "ok", rooms: N }`
- Payload max : 512 KB par message WebSocket
- Codes valides : 4–12 caractères alphanumériques

### Déploiement gratuit sur Render.com

1. Fork ce repo
2. Sur [render.com](https://render.com) → **New Web Service**
3. **Root Directory** : `server`
4. **Build command** : `npm install`
5. **Start command** : `node relay-server.js`
6. Copie l'URL générée et configure-la dans l'app

### Lancement local
```bash
cd server
npm install
node relay-server.js
# ⚡ Flash⚡Transfer Relay Server running on port 8765
```

---

## Sécurité

- **CSP** stricte sur la fenêtre Tauri (scripts, styles, connexions limités aux origines connues)
- **Validation des chemins** (canonicalisation) pour les fichiers reçus et ouverts
- **Échappement HTML** dans le chat et les noms de pairs (anti-XSS)
- **Sémaphore** : max 32 connexions TCP simultanées en réception
- **SHA-256** : vérification d'intégrité après chaque transfert
- **Rate limiting** sur le relay (5 conn/IP)
- **Firewall Windows** : règles `netsh` automatiques au premier lancement (ports 45678, 45679, 45680)

> **Note :** Les transferts LAN sont non chiffrés (TCP brut). Pour des données sensibles sur réseau non sûr, utiliser le mode relay (WebSocket) ou un VPN.

---

## Licence

MIT — Libre d'utilisation, modification et distribution.
