use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::net::UdpSocket;
use tokio::sync::Mutex;
use tauri::{AppHandle, Emitter};

const DISCOVERY_PORT: u16 = 45678;
const BROADCAST_INTERVAL_MS: u64 = 2000;
const PEER_TIMEOUT_MS: u64 = 6000;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct PeerInfo {
    pub name: String,
    pub ip: String,
    pub port: u16,
}

#[derive(Clone, Serialize, Deserialize)]
struct BroadcastMessage {
    r#type: String,
    name: String,
    ip: String,
    port: u16,
}

lazy_static::lazy_static! {
    static ref SHUTDOWN_TX: Arc<Mutex<Option<tokio::sync::broadcast::Sender<()>>>> =
        Arc::new(Mutex::new(None));
}

#[tauri::command]
pub async fn start_lan_discovery(app: AppHandle, name: String) -> Result<(), String> {
    // Stop any existing discovery
    stop_lan_discovery().await.ok();

    let (shutdown_tx, _) = tokio::sync::broadcast::channel::<()>(1);
    *SHUTDOWN_TX.lock().await = Some(shutdown_tx.clone());

    let local_ip = local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string());

    // ── Broadcaster ──────────────────────────────────────────────────────
    {
        let name = name.clone();
        let local_ip = local_ip.clone();
        let mut rx = shutdown_tx.subscribe();

        tokio::spawn(async move {
            let sock = match UdpSocket::bind("0.0.0.0:0").await {
                Ok(s) => s,
                Err(e) => { log::error!("Broadcaster socket error: {}", e); return; }
            };
            sock.set_broadcast(true).ok();

            let msg = serde_json::to_string(&BroadcastMessage {
                r#type: "flash-peer".to_string(),
                name: name.clone(),
                ip: local_ip.clone(),
                port: 45679,
            }).unwrap_or_default();
            let msg_bytes = msg.as_bytes();

            let mut interval = tokio::time::interval(
                tokio::time::Duration::from_millis(BROADCAST_INTERVAL_MS)
            );

            loop {
                tokio::select! {
                    _ = rx.recv() => break,
                    _ = interval.tick() => {
                        let _ = sock.send_to(msg_bytes, "255.255.255.255:45678").await;
                        // Also try common subnet broadcasts
                        let _ = sock.send_to(msg_bytes, "192.168.1.255:45678").await;
                        let _ = sock.send_to(msg_bytes, "192.168.0.255:45678").await;
                        let _ = sock.send_to(msg_bytes, "10.0.0.255:45678").await;
                        let _ = sock.send_to(msg_bytes, "10.69.2.255:45678").await;
                    }
                }
            }
        });
    }

    // ── Listener ─────────────────────────────────────────────────────────
    {
        let local_ip_clone = local_ip.clone();
        let app = app.clone();
        let mut rx = shutdown_tx.subscribe();

        tokio::spawn(async move {
            let sock = match UdpSocket::bind(format!("0.0.0.0:{}", DISCOVERY_PORT)).await {
                Ok(s) => s,
                Err(e) => {
                    log::error!("Listener socket error: {}", e);
                    return;
                }
            };
            sock.set_broadcast(true).ok();

            let mut buf = vec![0u8; 1024];
            // Track peers with last-seen timestamp
            let peers: Arc<Mutex<std::collections::HashMap<String, (PeerInfo, std::time::Instant)>>> =
                Arc::new(Mutex::new(std::collections::HashMap::new()));

            // Stale peer reaper
            {
                let peers = Arc::clone(&peers);
                let app = app.clone();
                tokio::spawn(async move {
                    let mut interval = tokio::time::interval(
                        tokio::time::Duration::from_millis(2000)
                    );
                    loop {
                        interval.tick().await;
                        let mut map = peers.lock().await;
                        let before = map.len();
                        map.retain(|_, (_, last_seen)| {
                            last_seen.elapsed().as_millis() < PEER_TIMEOUT_MS as u128
                        });
                        if map.len() != before {
                            let peer_list: Vec<PeerInfo> = map.values().map(|(p, _)| p.clone()).collect();
                            let _ = app.emit("peers-updated", peer_list);
                        }
                    }
                });
            }

            loop {
                tokio::select! {
                    _ = rx.recv() => break,
                    result = sock.recv_from(&mut buf) => {
                        match result {
                            Ok((len, addr)) => {
                                let sender_ip = addr.ip().to_string();
                                // Ignore own broadcasts
                                if sender_ip == local_ip_clone { continue; }

                                if let Ok(msg) = serde_json::from_slice::<BroadcastMessage>(&buf[..len]) {
                                    if msg.r#type != "flash-peer" { continue; }

                                    let peer = PeerInfo {
                                        name: msg.name,
                                        ip: sender_ip.clone(),
                                        port: msg.port,
                                    };

                                    let mut map = peers.lock().await;
                                    map.insert(sender_ip, (peer, std::time::Instant::now()));
                                    let peer_list: Vec<PeerInfo> = map.values().map(|(p, _)| p.clone()).collect();
                                    let _ = app.emit("peers-updated", peer_list);
                                }
                            }
                            Err(_) => break,
                        }
                    }
                }
            }
        });
    }

    Ok(())
}

#[tauri::command]
pub async fn stop_lan_discovery() -> Result<(), String> {
    let mut guard = SHUTDOWN_TX.lock().await;
    if let Some(tx) = guard.take() {
        let _ = tx.send(());
    }
    Ok(())
}
