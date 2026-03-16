use lazy_static::lazy_static;
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

// ─── Received files metadata ─────────────────────────────────────────────────

#[derive(Clone, Serialize, Deserialize)]
pub struct ReceivedFileMeta {
    pub id: String,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub ext: String,
    pub sender_ip: String,
    pub received_at: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn meta_json_path() -> PathBuf {
    get_save_dir().join(".received_files.json")
}

fn load_meta() -> Vec<ReceivedFileMeta> {
    let p = meta_json_path();
    if !p.exists() {
        return Vec::new();
    }
    let data = std::fs::read_to_string(&p).unwrap_or_default();
    serde_json::from_str(&data).unwrap_or_default()
}

fn save_meta(list: &[ReceivedFileMeta]) {
    let p = meta_json_path();
    if let Ok(json) = serde_json::to_string_pretty(list) {
        std::fs::write(&p, json).ok();
    }
}

fn append_meta(entry: ReceivedFileMeta) {
    let mut list = load_meta();
    list.push(entry);
    save_meta(&list);
}

#[tauri::command]
pub fn get_received_files() -> Vec<ReceivedFileMeta> {
    let mut list = load_meta();
    let before = list.len();
    list.retain(|m| std::path::Path::new(&m.path).exists());
    if list.len() != before {
        save_meta(&list);
    }
    list
}

#[tauri::command]
pub async fn delete_received_file(id: String, path: String) -> Result<(), String> {
    // SECURITY: Only allow deleting files inside the save directory
    let save_dir = get_save_dir().canonicalize().unwrap_or_else(|_| get_save_dir());
    if let Ok(canonical) = std::path::Path::new(&path).canonicalize() {
        if canonical.starts_with(&save_dir) {
            tokio::fs::remove_file(&canonical).await.ok();
        } else {
            return Err("Accès refusé : suppression hors du dossier FlashTransfer".to_string());
        }
    }
    let mut list = load_meta();
    list.retain(|m| m.id != id);
    save_meta(&list);
    Ok(())
}

/// SECURITY: Validate that the given path is inside the FlashTransfer download directory.
fn validate_path_in_save_dir(path: &str) -> Result<PathBuf, String> {
    let save_dir = get_save_dir().canonicalize().unwrap_or_else(|_| get_save_dir());
    let target = std::path::Path::new(path)
        .canonicalize()
        .map_err(|e| format!("Chemin invalide : {}", e))?;
    if !target.starts_with(&save_dir) {
        return Err(format!(
            "Accès refusé : le chemin doit être dans {}",
            save_dir.display()
        ));
    }
    Ok(target)
}

#[tauri::command]
pub async fn open_file(path: String) -> Result<(), String> {
    let validated = validate_path_in_save_dir(&path)?;
    let path_str = validated.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    { use std::os::windows::process::CommandExt;
      std::process::Command::new("explorer").arg(&path_str).creation_flags(0x08000000).spawn().ok(); }
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(&path_str).spawn().ok();
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open").arg(&path_str).spawn().ok();
    Ok(())
}

#[tauri::command]
pub async fn open_folder(path: String) -> Result<(), String> {
    let validated = validate_path_in_save_dir(&path)?;
    let path_str = validated.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    { use std::os::windows::process::CommandExt;
      std::process::Command::new("explorer")
          .args(["/select,", &path_str])
          .creation_flags(0x08000000)
          .spawn().ok(); }
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").args(["-R", &path_str]).spawn().ok();
    #[cfg(target_os = "linux")]
    { let p = std::path::Path::new(&path_str);
      std::process::Command::new("xdg-open").arg(p.parent().unwrap_or(p)).spawn().ok(); }
    Ok(())
}

/// Single port — the chunk index in the header identifies each stream.
const BASE_PORT: u16 = 45679;
const BUFFER_SIZE: usize = 4 * 1024 * 1024; // 4 MB read buffer

// ─── Shared receive-progress tracker ────────────────────────────────────────

struct RecvEntry {
    bytes_done: Arc<AtomicU64>,
    start: std::time::Instant,
    total: u64,
}

lazy_static! {
    /// Maps file_name → receive state, shared across concurrent chunk handlers.
    static ref RECV_TRACKER: Mutex<HashMap<String, RecvEntry>> =
        Mutex::new(HashMap::new());

    /// Limits concurrent incoming TCP connections to prevent resource exhaustion.
    static ref CONN_SEMAPHORE: Arc<tokio::sync::Semaphore> =
        Arc::new(tokio::sync::Semaphore::new(32));
}

// ─── Event types ────────────────────────────────────────────────────────────

#[derive(Clone, Serialize, Deserialize)]
pub struct ProgressEvent {
    pub file_name: String,
    pub bytes_done: u64,
    pub total_bytes: u64,
    pub speed_mbps: f64,
    pub eta_secs: f64,
    pub percent: f64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ReceiveStartEvent {
    pub file_name: String,
    pub total_bytes: u64,
    pub sender_ip: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct TransferDoneEvent {
    pub file_name: String,
    pub save_path: String,
    pub total_bytes: u64,
    pub elapsed_secs: f64,
    pub avg_speed_mbps: f64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub sha256: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct TransferErrorEvent {
    pub message: String,
}

pub struct ReceiverState {
    pub shutdown_tx: tokio::sync::broadcast::Sender<()>,
}

fn num_streams() -> usize {
    let cpus = num_cpus::get();
    (cpus * 2).min(16).max(2)
}

// ─── SEND ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn send_file(
    app: AppHandle,
    ip: String,
    file_path: String,
) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(format!("Fichier introuvable : {}", file_path));
    }

    let file_name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let file_size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    let n = num_streams();

    let bytes_sent = Arc::new(AtomicU64::new(0));
    let start = std::time::Instant::now();

    let chunk_size = (file_size + n as u64 - 1) / n as u64;
    let mut handles = Vec::new();

    for i in 0..n {
        let offset = i as u64 * chunk_size;
        if offset >= file_size {
            break;
        }
        let length = chunk_size.min(file_size - offset);
        let ip = ip.clone();
        let path = path.clone();
        let file_name = file_name.clone();
        let bytes_sent = Arc::clone(&bytes_sent);
        let app = app.clone();

        handles.push(tokio::spawn(async move {
            if i > 0 {
                tokio::time::sleep(tokio::time::Duration::from_millis(i as u64 * 20)).await;
            }
            send_chunk(&ip, BASE_PORT, &path, &file_name, file_size, offset, length, i, bytes_sent, app).await
        }));
    }

    // Progress reporter (sender side)
    let bytes_sent_prog = Arc::clone(&bytes_sent);
    let app_prog = app.clone();
    let file_name_prog = file_name.clone();
    let prog_handle = tokio::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_millis(100));
        loop {
            interval.tick().await;
            let done = bytes_sent_prog.load(Ordering::Relaxed);
            let elapsed = start.elapsed().as_secs_f64();
            let speed = if elapsed > 0.0 { done as f64 / elapsed / 1_000_000.0 } else { 0.0 };
            let eta = if speed > 0.0 { (file_size - done.min(file_size)) as f64 / (speed * 1_000_000.0) } else { 0.0 };
            let pct = if file_size > 0 { done as f64 / file_size as f64 * 100.0 } else { 0.0 };

            let _ = app_prog.emit("transfer-progress", ProgressEvent {
                file_name: file_name_prog.clone(),
                bytes_done: done,
                total_bytes: file_size,
                speed_mbps: speed,
                eta_secs: eta,
                percent: pct,
            });

            if done >= file_size { break; }
        }
    });

    let mut first_err: Option<String> = None;
    for h in handles {
        if let Err(e) = h.await.map_err(|e| e.to_string()).and_then(|r| r) {
            if first_err.is_none() {
                first_err = Some(e);
            }
        }
    }
    prog_handle.abort();

    if let Some(e) = first_err {
        let msg = if e.contains("Cannot connect") || e.contains("connection refused") {
            format!(
                "Connexion refusée à {}:{} — vérifie que l'app est ouverte chez le destinataire et que le port {} est autorisé dans son pare-feu.",
                ip, BASE_PORT, BASE_PORT
            )
        } else {
            e
        };
        let _ = app.emit("transfer-error", TransferErrorEvent { message: msg.clone() });
        return Err(msg);
    }

    let elapsed = start.elapsed().as_secs_f64();
    let avg_speed = if elapsed > 0.0 { file_size as f64 / elapsed / 1_000_000.0 } else { 0.0 };

    // Compute SHA-256 of sent file for integrity reference
    let hash = sha256_file(&path).await.unwrap_or_default();

    let _ = app.emit("transfer-done", TransferDoneEvent {
        file_name,
        save_path: String::new(),
        total_bytes: file_size,
        elapsed_secs: elapsed,
        avg_speed_mbps: avg_speed,
        sha256: hash,
    });

    Ok(())
}

async fn send_chunk(
    ip: &str,
    port: u16,
    path: &Path,
    file_name: &str,
    file_size: u64,
    offset: u64,
    length: u64,
    chunk_index: usize,
    bytes_sent: Arc<AtomicU64>,
    _app: AppHandle,
) -> Result<(), String> {
    let mut stream = None;
    for attempt in 0..15 {
        match TcpStream::connect(format!("{}:{}", ip, port)).await {
            Ok(s) => { stream = Some(s); break; }
            Err(_) => {
                if attempt < 14 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                }
            }
        }
    }
    let mut stream = stream.ok_or_else(|| format!("Cannot connect to {}:{}", ip, port))?;
    stream.set_nodelay(true).ok();

    let name_bytes = file_name.as_bytes();
    let mut header = Vec::with_capacity(32 + name_bytes.len());
    header.extend_from_slice(&file_size.to_be_bytes());
    header.extend_from_slice(&(name_bytes.len() as u32).to_be_bytes());
    header.extend_from_slice(&(chunk_index as u32).to_be_bytes());
    header.extend_from_slice(&offset.to_be_bytes());
    header.extend_from_slice(&length.to_be_bytes());
    header.extend_from_slice(name_bytes);
    stream.write_all(&header).await.map_err(|e| e.to_string())?;

    use tokio::io::AsyncSeekExt;
    let mut file = tokio::fs::File::open(path).await.map_err(|e| e.to_string())?;
    file.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| e.to_string())?;

    let mut buf = vec![0u8; BUFFER_SIZE];
    let mut remaining = length;

    while remaining > 0 {
        let to_read = (remaining as usize).min(buf.len());
        let n = file.read(&mut buf[..to_read]).await.map_err(|e| e.to_string())?;
        if n == 0 { break; }
        stream.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        bytes_sent.fetch_add(n as u64, Ordering::Relaxed);
        remaining -= n as u64;
    }

    let mut ack = [0u8; 3];
    stream.read_exact(&mut ack).await.map_err(|e| e.to_string())?;
    Ok(())
}

// ─── RECEIVE ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_receiver(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    let (shutdown_tx, _) = tokio::sync::broadcast::channel::<()>(1);
    let save_dir = get_save_dir();
    std::fs::create_dir_all(&save_dir).map_err(|e| e.to_string())?;

    let listener = match TcpListener::bind(format!("0.0.0.0:{}", BASE_PORT)).await {
        Ok(l) => l,
        Err(e) => {
            let msg = format!(
                "Impossible d'écouter sur le port {} : {}. Redémarre l'app.",
                BASE_PORT, e
            );
            let _ = app.emit("transfer-error", TransferErrorEvent { message: msg.clone() });
            return Err(msg);
        }
    };

    let app_clone = app.clone();
    let save_dir_clone = save_dir.clone();
    let mut shutdown_rx = shutdown_tx.subscribe();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => break,
                result = listener.accept() => {
                    match result {
                        Ok((stream, addr)) => {
                            log::info!("Incoming from {}", addr);
                            let save_dir = save_dir_clone.clone();
                            let app = app_clone.clone();
                            let sender_ip = addr.ip().to_string();
                            let sem = CONN_SEMAPHORE.clone();
                            tokio::spawn(async move {
                                // Acquire semaphore permit to limit concurrency
                                let _permit = match sem.acquire().await {
                                    Ok(p) => p,
                                    Err(_) => {
                                        log::error!("Connection semaphore closed");
                                        return;
                                    }
                                };
                                if let Err(e) = handle_incoming(stream, &save_dir, app, sender_ip).await {
                                    log::error!("Receive error: {}", e);
                                }
                                // _permit dropped here, releasing the slot
                            });
                        }
                        Err(_) => break,
                    }
                }
            }
        }
    });

    *state.receiver.lock().await = Some(ReceiverState { shutdown_tx });
    let _ = app.emit("receiver-started", ());
    Ok(())
}

#[tauri::command]
pub async fn stop_receiver(state: tauri::State<'_, crate::AppState>) -> Result<(), String> {
    let mut guard = state.receiver.lock().await;
    if let Some(recv) = guard.take() {
        let _ = recv.shutdown_tx.send(());
    }
    Ok(())
}

async fn handle_incoming(
    mut stream: TcpStream,
    save_dir: &Path,
    app: AppHandle,
    sender_ip: String,
) -> Result<(), String> {
    stream.set_nodelay(true).ok();

    // ── Read header ──────────────────────────────────────────────────────
    let mut buf8 = [0u8; 8];
    let mut buf4 = [0u8; 4];

    stream.read_exact(&mut buf8).await.map_err(|e| e.to_string())?;
    let file_size = u64::from_be_bytes(buf8);

    // SECURITY: Reject files larger than 100 GB to prevent disk exhaustion
    const MAX_FILE_SIZE: u64 = 100 * 1024 * 1024 * 1024; // 100 GB
    if file_size > MAX_FILE_SIZE {
        return Err(format!("File too large: {} bytes (max {} bytes)", file_size, MAX_FILE_SIZE));
    }

    stream.read_exact(&mut buf4).await.map_err(|e| e.to_string())?;
    let name_len = u32::from_be_bytes(buf4) as usize;

    stream.read_exact(&mut buf4).await.map_err(|e| e.to_string())?;
    let chunk_index = u32::from_be_bytes(buf4);

    stream.read_exact(&mut buf8).await.map_err(|e| e.to_string())?;
    let _offset = u64::from_be_bytes(buf8);

    stream.read_exact(&mut buf8).await.map_err(|e| e.to_string())?;
    let length = u64::from_be_bytes(buf8);

    if name_len > 1024 {
        return Err("File name too long (>1024 bytes)".to_string());
    }
    let mut name_buf = vec![0u8; name_len];
    stream.read_exact(&mut name_buf).await.map_err(|e| e.to_string())?;
    let raw_name = String::from_utf8_lossy(&name_buf).to_string();

    // SECURITY: Sanitize file name to prevent path traversal attacks.
    // Strip any directory components — only keep the final file name.
    let file_name = std::path::Path::new(&raw_name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| format!("received_{}", now_ms()));
    // Reject empty or dot-only names
    let file_name = if file_name.is_empty() || file_name == "." || file_name == ".." {
        format!("received_{}", now_ms())
    } else {
        file_name
    };

    // ── Register in global tracker (emit receive-start on first chunk) ───
    let bytes_arc = {
        let mut tracker = RECV_TRACKER.lock().unwrap();
        if !tracker.contains_key(&file_name) {
            // First chunk for this file: announce to the UI
            let _ = app.emit("receive-start", ReceiveStartEvent {
                file_name: file_name.clone(),
                total_bytes: file_size,
                sender_ip: sender_ip.clone(),
            });
            tracker.insert(file_name.clone(), RecvEntry {
                bytes_done: Arc::new(AtomicU64::new(0)),
                start: std::time::Instant::now(),
                total: file_size,
            });
        }
        tracker.get(&file_name).unwrap().bytes_done.clone()
    };

    // Snapshot start time (we'll re-read from tracker for accurate elapsed)
    let receive_start = std::time::Instant::now();
    let _ = receive_start; // may be unused if we don't measure per-chunk speed

    // ── Write chunk to temp file ─────────────────────────────────────────
    let temp_path = save_dir.join(format!("{}.part{}", file_name, chunk_index));
    let final_path = save_dir.join(&file_name);

    {
        use tokio::io::AsyncSeekExt;
        let mut temp_file = tokio::fs::OpenOptions::new()
            .create(true).write(true)
            .open(&temp_path).await.map_err(|e| e.to_string())?;
        temp_file.seek(std::io::SeekFrom::Start(0)).await.ok();

        let mut buf = vec![0u8; BUFFER_SIZE];
        let mut remaining = length;
        // Throttle: emit every ~150 ms worth of data
        let mut last_emit = std::time::Instant::now();

        while remaining > 0 {
            let to_read = (remaining as usize).min(buf.len());
            let n = stream.read(&mut buf[..to_read]).await.map_err(|e| e.to_string())?;
            if n == 0 { break; }
            temp_file.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
            remaining -= n as u64;

            let total_done = bytes_arc.fetch_add(n as u64, Ordering::Relaxed) + n as u64;

            // Emit progress at most every 150 ms to keep UI smooth
            if last_emit.elapsed().as_millis() >= 150 || remaining == 0 {
                last_emit = std::time::Instant::now();

                // Read elapsed from tracker
                let (elapsed, total) = {
                    let tracker = RECV_TRACKER.lock().unwrap();
                    if let Some(entry) = tracker.get(&file_name) {
                        (entry.start.elapsed().as_secs_f64(), entry.total)
                    } else {
                        (0.0, file_size)
                    }
                };

                let speed = if elapsed > 0.0 { total_done as f64 / elapsed / 1_000_000.0 } else { 0.0 };
                let capped = total_done.min(total);
                let eta = if speed > 0.0 { (total - capped) as f64 / (speed * 1_000_000.0) } else { 0.0 };
                let pct = if total > 0 { capped as f64 / total as f64 * 100.0 } else { 0.0 };

                let _ = app.emit("transfer-progress", ProgressEvent {
                    file_name: file_name.clone(),
                    bytes_done: capped,
                    total_bytes: total,
                    speed_mbps: speed,
                    eta_secs: eta,
                    percent: pct,
                });
            }
        }
        temp_file.flush().await.map_err(|e| e.to_string())?;
    }

    // ── ACK ──────────────────────────────────────────────────────────────
    stream.write_all(b"ACK").await.ok();

    // ── Check if all chunks present → assemble ───────────────────────────
    let n = num_streams() as u64;
    let per_chunk = (file_size + n - 1) / n;
    let chunks_expected = if per_chunk == 0 {
        1
    } else {
        (0..n).filter(|&i| i * per_chunk < file_size).count()
    };

    let all_present = !final_path.exists()
        && (0..chunks_expected).all(|i| {
            save_dir.join(format!("{}.part{}", file_name, i)).exists()
        });

    if all_present {
        // Capture timing before cleanup
        let (elapsed, total_done) = {
            let tracker = RECV_TRACKER.lock().unwrap();
            if let Some(entry) = tracker.get(&file_name) {
                (entry.start.elapsed().as_secs_f64(), entry.bytes_done.load(Ordering::Relaxed))
            } else {
                (0.0, file_size)
            }
        };

        assemble_file(&file_name, save_dir, file_size, chunks_expected, &final_path).await?;

        // Compute SHA-256 of received file for integrity verification
        let hash = sha256_file(&final_path).await.unwrap_or_default();
        log::info!("Received {} — SHA-256: {}", file_name, hash);

        // Clean up tracker
        RECV_TRACKER.lock().unwrap().remove(&file_name);

        // Persist metadata for "Fichiers reçus" tab
        let ext = std::path::Path::new(&file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("?")
            .to_uppercase();
        append_meta(ReceivedFileMeta {
            id: format!("{:x}", now_ms()),
            name: file_name.clone(),
            path: final_path.to_string_lossy().to_string(),
            size: file_size,
            ext,
            sender_ip: sender_ip.clone(),
            received_at: now_ms(),
        });

        let avg_speed = if elapsed > 0.0 { total_done as f64 / elapsed / 1_000_000.0 } else { 0.0 };

        let _ = app.emit("transfer-done", TransferDoneEvent {
            file_name: file_name.clone(),
            save_path: final_path.to_string_lossy().to_string(),
            total_bytes: file_size,
            elapsed_secs: elapsed,
            avg_speed_mbps: avg_speed,
            sha256: hash,
        });
    }

    Ok(())
}

async fn assemble_file(
    file_name: &str,
    save_dir: &Path,
    file_size: u64,
    chunks: usize,
    final_path: &Path,
) -> Result<(), String> {
    let mut out = tokio::fs::OpenOptions::new()
        .create(true).write(true).truncate(true)
        .open(final_path).await.map_err(|e| e.to_string())?;

    let mut buf = vec![0u8; BUFFER_SIZE];
    for i in 0..chunks {
        let part_path = save_dir.join(format!("{}.part{}", file_name, i));
        let mut part = tokio::fs::File::open(&part_path).await.map_err(|e| e.to_string())?;
        loop {
            let n = part.read(&mut buf).await.map_err(|e| e.to_string())?;
            if n == 0 { break; }
            out.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        }
        tokio::fs::remove_file(&part_path).await.ok();
    }

    out.flush().await.map_err(|e| e.to_string())?;
    log::info!("Assembled {} ({} bytes)", file_name, file_size);
    Ok(())
}

/// Compute SHA-256 hash of a file, returns hex string.
pub async fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = tokio::fs::File::open(path).await.map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024]; // 1 MB buffer
    loop {
        let n = file.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn get_save_dir() -> PathBuf {
    let base = dirs_next::download_dir()
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("FlashTransfer")
}
