use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tauri::{AppHandle, Emitter};
use rand::Rng;

// Default relay server — can be overridden via env var FLASH_RELAY_URL
const DEFAULT_RELAY: &str = "wss://flash-transfer-7vj7.onrender.com";

fn relay_url() -> String {
    std::env::var("FLASH_RELAY_URL").unwrap_or_else(|_| DEFAULT_RELAY.to_string())
}

fn random_code() -> String {
    let mut rng = rand::thread_rng();
    let chars: Vec<char> = "abcdefghjkmnpqrstuvwxyz23456789".chars().collect();
    (0..6).map(|_| chars[rng.gen_range(0..chars.len())]).collect()
}

#[derive(Clone, Serialize, Deserialize)]
pub struct RelayStatus {
    pub code: String,
    pub connected: bool,
    pub message: String,
}

lazy_static::lazy_static! {
    static ref RELAY_SHUTDOWN: Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>> =
        Arc::new(Mutex::new(None));
}

#[tauri::command]
pub async fn generate_relay_code(app: AppHandle, file_path: String) -> Result<String, String> {
    disconnect_relay().await.ok();

    let code = random_code();
    let relay_url = relay_url();
    let code_clone = code.clone();
    let app_clone = app.clone();

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    *RELAY_SHUTDOWN.lock().await = Some(shutdown_tx);

    tokio::spawn(async move {
        let url = format!("{}/ws?code={}&role=sender", relay_url, code_clone);
        let _ = app_clone.emit("relay-status", RelayStatus {
            code: code_clone.clone(),
            connected: false,
            message: "Connecting to relay...".to_string(),
        });

        match connect_async(&url).await {
            Ok((ws_stream, _)) => {
                let _ = app_clone.emit("relay-status", RelayStatus {
                    code: code_clone.clone(),
                    connected: false,
                    message: "Waiting for receiver...".to_string(),
                });

                let (mut write, mut read) = ws_stream.split();
                let mut shutdown_rx = shutdown_rx;

                loop {
                    tokio::select! {
                        _ = &mut shutdown_rx => break,
                        msg = read.next() => {
                            match msg {
                                Some(Ok(Message::Text(text))) => {
                                    if text == "PEER_CONNECTED" {
                                        let _ = app_clone.emit("relay-peer-connected", ());
                                        // Now stream the file via WebSocket
                                        if let Err(e) = stream_file_via_ws(&file_path, &mut write, app_clone.clone()).await {
                                            let _ = app_clone.emit("transfer-error",
                                                crate::transfer::TransferErrorEvent { message: e });
                                        }
                                        break;
                                    }
                                }
                                Some(Ok(Message::Binary(data))) => {
                                    // Relay sends back file data (shouldn't happen for sender)
                                    log::debug!("Sender received {} bytes unexpectedly", data.len());
                                }
                                Some(Err(e)) => {
                                    let _ = app_clone.emit("transfer-error",
                                        crate::transfer::TransferErrorEvent { message: e.to_string() });
                                    break;
                                }
                                None => break,
                                _ => {}
                            }
                        }
                    }
                }
            }
            Err(e) => {
                let _ = app_clone.emit("transfer-error", crate::transfer::TransferErrorEvent {
                    message: format!("Cannot connect to relay: {}. Check internet connection.", e),
                });
            }
        }
    });

    Ok(code)
}

#[tauri::command]
pub async fn join_relay_room(app: AppHandle, code: String) -> Result<(), String> {
    disconnect_relay().await.ok();

    let relay_url = relay_url();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    *RELAY_SHUTDOWN.lock().await = Some(shutdown_tx);

    tokio::spawn(async move {
        let url = format!("{}/ws?code={}&role=receiver", relay_url, code);
        let save_dir = crate::transfer::get_save_dir();
        std::fs::create_dir_all(&save_dir).ok();

        match connect_async(&url).await {
            Ok((ws_stream, _)) => {
                let _ = app.emit("relay-status", RelayStatus {
                    code: code.clone(),
                    connected: true,
                    message: "Connected! Waiting for file...".to_string(),
                });

                let (_, mut read) = ws_stream.split();
                let mut shutdown_rx = shutdown_rx;

                // First message: file metadata JSON
                let mut file_name = String::new();
                let mut file_size: u64 = 0;
                let mut out_file: Option<tokio::fs::File> = None;
                let mut bytes_received: u64 = 0;
                let start = std::time::Instant::now();

                loop {
                    tokio::select! {
                        _ = &mut shutdown_rx => break,
                        msg = read.next() => {
                            match msg {
                                Some(Ok(Message::Text(text))) => {
                                    // Metadata: {"name":"file.txt","size":12345}
                                    if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&text) {
                                        file_name = meta["name"].as_str().unwrap_or("received_file").to_string();
                                        file_size = meta["size"].as_u64().unwrap_or(0);
                                        let path = save_dir.join(&file_name);
                                        out_file = tokio::fs::OpenOptions::new()
                                            .create(true).write(true).truncate(true)
                                            .open(&path).await.ok();
                                        // Notify UI to show receive progress overlay
                                        let _ = app.emit("receive-start", crate::transfer::ReceiveStartEvent {
                                            file_name: file_name.clone(),
                                            total_bytes: file_size,
                                        });
                                    }
                                }
                                Some(Ok(Message::Binary(data))) => {
                                    if let Some(ref mut f) = out_file {
                                        use tokio::io::AsyncWriteExt;
                                        if f.write_all(&data).await.is_ok() {
                                            bytes_received += data.len() as u64;
                                            let elapsed = start.elapsed().as_secs_f64();
                                            let speed = if elapsed > 0.0 { bytes_received as f64 / elapsed / 1_000_000.0 } else { 0.0 };
                                            let pct = if file_size > 0 { bytes_received as f64 / file_size as f64 * 100.0 } else { 0.0 };
                                            let eta = if speed > 0.0 { (file_size - bytes_received) as f64 / (speed * 1_000_000.0) } else { 0.0 };

                                            let _ = app.emit("transfer-progress", crate::transfer::ProgressEvent {
                                                file_name: file_name.clone(),
                                                bytes_done: bytes_received,
                                                total_bytes: file_size,
                                                speed_mbps: speed,
                                                eta_secs: eta,
                                                percent: pct,
                                            });

                                            if bytes_received >= file_size {
                                                let _ = app.emit("transfer-done", crate::transfer::TransferDoneEvent {
                                                    file_name: file_name.clone(),
                                                    save_path: save_dir.join(&file_name).to_string_lossy().to_string(),
                                                    total_bytes: file_size,
                                                    elapsed_secs: elapsed,
                                                    avg_speed_mbps: speed,
                                                });
                                                break;
                                            }
                                        }
                                    }
                                }
                                Some(Err(e)) => {
                                    let _ = app.emit("transfer-error",
                                        crate::transfer::TransferErrorEvent { message: e.to_string() });
                                    break;
                                }
                                None => break,
                                _ => {}
                            }
                        }
                    }
                }
            }
            Err(e) => {
                let _ = app.emit("transfer-error", crate::transfer::TransferErrorEvent {
                    message: format!("Cannot join room '{}': {}. Check code and internet.", code, e),
                });
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn disconnect_relay() -> Result<(), String> {
    let mut guard = RELAY_SHUTDOWN.lock().await;
    if let Some(tx) = guard.take() {
        let _ = tx.send(());
    }
    Ok(())
}

async fn stream_file_via_ws(
    file_path: &str,
    write: &mut (impl SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    app: AppHandle,
) -> Result<(), String> {
    use tokio::io::AsyncReadExt;

    let path = std::path::Path::new(file_path);
    let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
    let file_size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();

    // Send metadata
    let meta = serde_json::json!({"name": file_name, "size": file_size}).to_string();
    write.send(Message::Text(meta)).await.map_err(|e| e.to_string())?;

    let mut file = tokio::fs::File::open(path).await.map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 256 * 1024]; // 256KB chunks for WS
    let mut bytes_sent: u64 = 0;
    let start = std::time::Instant::now();

    loop {
        let n = file.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 { break; }

        write.send(Message::Binary(buf[..n].to_vec())).await.map_err(|e| e.to_string())?;
        bytes_sent += n as u64;

        let elapsed = start.elapsed().as_secs_f64();
        let speed = if elapsed > 0.0 { bytes_sent as f64 / elapsed / 1_000_000.0 } else { 0.0 };
        let pct = bytes_sent as f64 / file_size as f64 * 100.0;
        let eta = if speed > 0.0 { (file_size - bytes_sent) as f64 / (speed * 1_000_000.0) } else { 0.0 };

        let _ = app.emit("transfer-progress", crate::transfer::ProgressEvent {
            file_name: file_name.clone(),
            bytes_done: bytes_sent,
            total_bytes: file_size,
            speed_mbps: speed,
            eta_secs: eta,
            percent: pct,
        });
    }

    let elapsed = start.elapsed().as_secs_f64();
    let avg_speed = if elapsed > 0.0 { file_size as f64 / elapsed / 1_000_000.0 } else { 0.0 };

    let _ = app.emit("transfer-done", crate::transfer::TransferDoneEvent {
        file_name: file_name.clone(),
        save_path: String::new(),
        total_bytes: file_size,
        elapsed_secs: elapsed,
        avg_speed_mbps: avg_speed,
    });

    Ok(())
}
