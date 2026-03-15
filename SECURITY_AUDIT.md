# Flash Transfer — Audit de Securite Complet

**Date :** 2026-03-15
**Auditeur :** Security Review Agent
**Perimetre :** Backend Rust (Tauri), Frontend JS, Serveur Relay Node.js, Version Web

---

## Resume Executif

L'audit a identifie **4 vulnerabilites critiques**, **3 problemes de severite haute** et **5 de severite moyenne**. Tous les correctifs critiques et haute severite ont ete appliques dans ce commit.

---

## Vulnerabilites Trouvees et Corrigees

### CRITIQUE — Path Traversal dans le Recepteur de Fichiers
- **Fichier :** `src-tauri/src/transfer.rs:428`, `src-tauri/src/relay_client.rs:147`
- **Risque :** Un attaquant peut envoyer un nom de fichier tel que `../../.bashrc` ou `../../../etc/passwd`. Le recepteur ecrit directement dans `save_dir.join(file_name)` sans sanitisation, permettant l'ecrasement arbitraire de fichiers sur le systeme.
- **Correctif :** Extraction uniquement du composant final du chemin via `Path::file_name()` + rejet des noms vides/`.`/`..`.

### CRITIQUE — XSS via Nom de Peer (LAN)
- **Fichier :** `src/app.js:259-268`
- **Risque :** Les noms de peers recus par broadcast UDP sont injectes dans `innerHTML` sans echappement. Un attaquant sur le meme LAN peut diffuser un nom contenant `<script>...</script>` ou `<img onerror=...>` pour executer du code arbitraire dans l'application Tauri.
- **Correctif :** Echappement HTML via `escapeHtml()` pour tous les champs provenant du reseau.

### CRITIQUE — Injection de Commande dans open_browser_url
- **Fichier :** `src-tauri/src/oauth_server.rs:87-88`
- **Risque :** Sur Windows, `cmd /C start "" <url>` est vulnerable a l'injection de metacaracteres shell. Une URL malformee comme `http://x" & calc.exe & "` peut executer des commandes arbitraires.
- **Correctif :** Validation stricte du schema URL (http/https uniquement) + remplacement par `rundll32 url.dll,FileProtocolHandler` qui ne passe pas par le shell.

### CRITIQUE — CSP Desactivee
- **Fichier :** `src-tauri/tauri.conf.json:24`
- **Risque :** `"csp": null` desactive completement la Content Security Policy. Combinee avec les XSS ci-dessus, cela permet le chargement de scripts externes, l'exfiltration de donnees, et l'execution de code arbitraire.
- **Correctif :** CSP stricte activee : `default-src 'self'` avec des exceptions specifiques pour Supabase, le relay, et les images Google.

### HAUTE — Allocation Memoire Non Bornee (OOM)
- **Fichier :** `src-tauri/src/transfer.rs:415`
- **Risque :** `name_len` est lu comme u32 depuis le reseau et utilise directement pour allouer un buffer (`vec![0u8; name_len]`). Un attaquant peut envoyer `name_len = 4294967295` pour provoquer un OOM crash.
- **Correctif :** Limite a 1024 octets + limite de taille de fichier a 100 Go.

### HAUTE — Codes de Transfert Previsibles (Web)
- **Fichier :** `website/js/transfer.js:60`
- **Risque :** `Math.random()` n'est pas cryptographiquement securise. Les codes de session sont previsibles, permettant a un attaquant de deviner un code et intercepter un transfert.
- **Correctif :** Utilisation de `crypto.getRandomValues()` (Web Crypto API).

### HAUTE — Serveur Relay Sans Protection
- **Fichier :** `server/relay-server.js`
- **Risque :** Aucune limitation de debit, validation d'entree ou plafond de salles. Un attaquant peut creer des milliers de salles, saturer la memoire, ou brute-forcer les codes.
- **Correctif :** Rate limiting par IP (5 connexions max), validation du format des codes, plafond de 500 salles, et limite de taille des messages WebSocket (512 Ko).

### MOYENNE — XSS dans les Toasts
- **Fichier :** `src/app.js:96`
- **Risque :** La fonction `toast()` utilise `innerHTML` avec des messages qui incluent parfois des donnees reseau non sanitisees.
- **Correctif :** Echappement HTML du message dans la fonction toast.

### MOYENNE — Fuite Memoire ObjectURL
- **Fichier :** `website/js/transfer.js:719`
- **Risque :** Les `URL.createObjectURL()` ne sont jamais revoques, causant une fuite memoire croissante a chaque transfert.
- **Correctif :** Tracking et revocation des URLs dans `showFileGallery()`.

### MOYENNE — Validation d'IP Absente
- **Fichier :** `src/app.js:1018`
- **Risque :** Le champ IP directe accepte n'importe quelle chaine, qui est passee directement aux commandes Tauri. Un format invalide pourrait provoquer des comportements inattendus.
- **Correctif :** Validation regex IPv4 avant envoi.

---

## Observations Additionnelles (Non Corrigees — A Traiter)

### 1. Transferts LAN Non Chiffres
Tous les transferts TCP (ports 45679/45680) sont en clair. Sur un reseau compromis (attaque MITM, WiFi public), les fichiers et messages sont interceptables. **Recommandation :** Implementer TLS mutuel ou un echange Diffie-Hellman avec verification de fingerprint.

### 2. Cle Supabase en Dur
- **Fichier :** `src/app.js:106`
- La cle `anon` Supabase est exposee dans le code source. Bien que ce soit le comportement attendu pour les cles `anon` (elles sont publiques par design), les Row Level Security (RLS) de Supabase doivent etre correctement configurees.

### 3. PeerJS Charge depuis CDN Non Epingle
- **Fichier :** `website/transfer.html:12`
- `https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js` — risque de supply chain si unpkg est compromis. **Recommandation :** Heberger le fichier localement ou utiliser un hash SRI.

### 4. Broadcast UDP sur Sous-Reseaux en Dur
- **Fichier :** `src-tauri/src/lan_discovery.rs:73-77`
- Les broadcasts sont envoyes a des sous-reseaux specifiques (192.168.0/1.255, 10.0.0.255, 10.69.2.255). **Recommandation :** Calculer l'adresse de broadcast dynamiquement a partir de l'interface reseau.

### 5. Port OAuth Fixe (7432)
- **Fichier :** `src-tauri/src/oauth_server.rs:5`
- Si le port est deja utilise, l'authentification echoue silencieusement. **Recommandation :** Port dynamique avec callback URL adapte.

### 6. Aucune Verification d'Integrite des Fichiers
- Les fichiers transferes ne sont pas verifies (pas de checksum SHA-256). Une corruption reseau passerait inapercue. **Recommandation :** Ajouter un hash dans le protocole de transfert.

### 7. Pas de Limitation Connexions Simultanees (Tauri)
- Les ports 45679/45680 acceptent un nombre illimite de connexions TCP simultanees. **Recommandation :** Semaphore tokio pour limiter la concurrence.

### 8. `open_file` / `open_folder` Sans Validation de Chemin
- **Fichier :** `src-tauri/src/transfer.rs:78-104`
- Ces commandes Tauri acceptent un chemin arbitraire du frontend. Un XSS pourrait les exploiter pour ouvrir des fichiers sensibles. La CSP ajoutee attenue ce risque, mais une validation que le chemin est dans le repertoire de telechargement serait plus robuste.

---

## Architecture — Points Positifs

- Utilisation de Tauri v2 (surface d'attaque reduite vs Electron)
- Transferts P2P (pas de stockage serveur)
- Systeme de demande/acceptation avant transfert LAN
- Timeout sur les salles relay (10 min)
- Utilisation de `set_nodelay(true)` pour les performances TCP
- Build CI/CD avec verification multi-plateforme

---

## Priorites de Remediation

| Priorite | Action | Effort |
|----------|--------|--------|
| P0 | ~~Path traversal~~ | ✅ Fait |
| P0 | ~~XSS peer name~~ | ✅ Fait |
| P0 | ~~Command injection~~ | ✅ Fait |
| P0 | ~~CSP activee~~ | ✅ Fait |
| P1 | ~~OOM protection~~ | ✅ Fait |
| P1 | ~~CSPRNG codes~~ | ✅ Fait |
| P1 | ~~Rate limiting relay~~ | ✅ Fait |
| P2 | Chiffrement TLS LAN | Moyen |
| P2 | SRI pour PeerJS CDN | Faible |
| P2 | Checksums fichiers | Moyen |
| P3 | Broadcast dynamique | Faible |
| P3 | Port OAuth dynamique | Faible |
