// messaging.rs — Canal de contrôle TCP 45680
// Gère : messages texte + demandes de fichiers (file-request / accept / decline)

use lazy_static::lazy_static;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub const CONTROL_PORT: u16 = 45680;

// Requests en attente d'une réponse de l'utilisateur local
lazy_static! {
    static ref PENDING: Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>> =
        Mutex::new(HashMap::new());
}

// ─── Event types ─────────────────────────────────────────────────────────────

#[derive(Clone, Serialize, Deserialize)]
pub struct ChatMessageEvent {
    pub sender_name: String,
    pub sender_ip: String,
    pub text: String,
    pub timestamp: u64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct FileInfo {
    pub name: String,
    pub size: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct FileRequestEvent {
    pub request_id: String,
    pub sender_name: String,
    pub sender_ip: String,
    pub files: Vec<FileInfo>,
}

// ─── Internal wire protocol ───────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct Wire {
    #[serde(rename = "type")]
    typ: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sender_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    files: Option<Vec<FileInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    timestamp: Option<u64>,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn gen_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..8).map(|_| format!("{:x}", rng.gen::<u8>())).collect()
}

async fn read_msg(s: &mut TcpStream) -> Result<String, String> {
    let mut lb = [0u8; 4];
    s.read_exact(&mut lb).await.map_err(|e| e.to_string())?;
    let len = u32::from_be_bytes(lb) as usize;
    if len > 2_000_000 {
        return Err("Message trop grand".to_string());
    }
    let mut buf = vec![0u8; len];
    s.read_exact(&mut buf).await.map_err(|e| e.to_string())?;
    String::from_utf8(buf).map_err(|e| e.to_string())
}

async fn write_msg(s: &mut TcpStream, json: &str) -> Result<(), String> {
    let b = json.as_bytes();
    s.write_all(&(b.len() as u32).to_be_bytes())
        .await
        .map_err(|e| e.to_string())?;
    s.write_all(b).await.map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Listener (démarré au boot) ───────────────────────────────────────────────

pub async fn start_control_listener(app: AppHandle) {
    match TcpListener::bind(format!("0.0.0.0:{}", CONTROL_PORT)).await {
        Ok(listener) => {
            log::info!("Control listener OK port {}", CONTROL_PORT);
            loop {
                match listener.accept().await {
                    Ok((stream, addr)) => {
                        let app2 = app.clone();
                        let ip = addr.ip().to_string();
                        tokio::spawn(async move {
                            if let Err(e) = handle_control(stream, ip, app2).await {
                                log::debug!("Control: {}", e);
                            }
                        });
                    }
                    Err(e) => {
                        log::error!("Control accept: {}", e);
                        break;
                    }
                }
            }
        }
        Err(e) => log::warn!("Control port {} occupé: {}", CONTROL_PORT, e),
    }
}

async fn handle_control(mut s: TcpStream, sender_ip: String, app: AppHandle) -> Result<(), String> {
    s.set_nodelay(true).ok();
    let json = read_msg(&mut s).await?;
    let msg: Wire = serde_json::from_str(&json).map_err(|e| e.to_string())?;

    match msg.typ.as_str() {
        "message" => {
            let _ = app.emit(
                "chat-message",
                ChatMessageEvent {
                    sender_name: msg.sender_name.unwrap_or_else(|| sender_ip.clone()),
                    sender_ip,
                    text: msg.text.unwrap_or_default(),
                    timestamp: msg.timestamp.unwrap_or_else(now_ms),
                },
            );
        }
        "file-request" => {
            let rid = msg.request_id.unwrap_or_else(gen_id);
            let files = msg.files.unwrap_or_default();

            let _ = app.emit(
                "file-request",
                FileRequestEvent {
                    request_id: rid.clone(),
                    sender_name: msg.sender_name.unwrap_or_else(|| sender_ip.clone()),
                    sender_ip,
                    files,
                },
            );

            // Crée un canal pour attendre la réponse utilisateur (60 s max)
            let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
            PENDING.lock().unwrap().insert(rid.clone(), tx);

            let accepted = tokio::time::timeout(tokio::time::Duration::from_secs(60), rx)
                .await
                .map(|r| r.unwrap_or(false))
                .unwrap_or(false);

            // Renvoie la réponse à l'envoyeur
            let resp = serde_json::json!({
                "type": if accepted { "accept" } else { "decline" },
                "request_id": rid
            })
            .to_string();
            write_msg(&mut s, &resp).await.ok();
        }
        _ => {}
    }
    Ok(())
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

/// Envoie un message texte à un peer LAN
#[tauri::command]
pub async fn send_chat_message(
    ip: String,
    text: String,
    sender_name: String,
) -> Result<(), String> {
    let mut s = tokio::time::timeout(
        tokio::time::Duration::from_secs(5),
        TcpStream::connect(format!("{}:{}", ip, CONTROL_PORT)),
    )
    .await
    .map_err(|_| format!("Timeout: {} injoignable", ip))?
    .map_err(|e| format!("Connexion refusée ({}). L'app doit être ouverte.", e))?;

    s.set_nodelay(true).ok();
    let msg = serde_json::json!({
        "type": "message",
        "text": text,
        "sender_name": sender_name,
        "timestamp": now_ms()
    })
    .to_string();
    write_msg(&mut s, &msg).await
}

/// Envoie une demande de fichiers et attend accept/decline (retourne true si accepté)
#[tauri::command]
pub async fn send_file_request(
    ip: String,
    files: Vec<FileInfo>,
    sender_name: String,
) -> Result<bool, String> {
    let rid = gen_id();

    let mut s = tokio::time::timeout(
        tokio::time::Duration::from_secs(5),
        TcpStream::connect(format!("{}:{}", ip, CONTROL_PORT)),
    )
    .await
    .map_err(|_| format!("Timeout: {} injoignable", ip))?
    .map_err(|e| format!("Connexion refusée ({}). L'app doit être ouverte.", e))?;

    s.set_nodelay(true).ok();
    let msg = serde_json::json!({
        "type": "file-request",
        "request_id": rid,
        "sender_name": sender_name,
        "files": files
    })
    .to_string();
    write_msg(&mut s, &msg).await?;

    // Attend la réponse (65 s)
    let resp = tokio::time::timeout(
        tokio::time::Duration::from_secs(65),
        read_msg(&mut s),
    )
    .await
    .map_err(|_| "Le destinataire n'a pas répondu dans les délais.".to_string())?
    .map_err(|e| e)?;

    let v: serde_json::Value = serde_json::from_str(&resp).unwrap_or_default();
    Ok(v["type"].as_str() == Some("accept"))
}

/// Répond à une demande de fichiers entrants (appelé depuis le frontend)
#[tauri::command]
pub async fn respond_to_file_request(
    request_id: String,
    accepted: bool,
) -> Result<(), String> {
    let tx = PENDING.lock().unwrap().remove(&request_id);
    if let Some(tx) = tx {
        tx.send(accepted).ok();
    }
    Ok(())
}
