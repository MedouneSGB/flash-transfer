use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const BASE_PORT: u16 = 45679;
const CHUNK_SIZE: u64 = 64 * 1024 * 1024; // 64 MB
const BUFFER_SIZE: usize = 8 * 1024 * 1024; // 8 MB

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
pub struct TransferDoneEvent {
    pub file_name: String,
    pub save_path: String,
    pub total_bytes: u64,
    pub elapsed_secs: f64,
    pub avg_speed_mbps: f64,
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

// ─── SEND ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn send_file(
    app: AppHandle,
    ip: String,
    file_path: String,
) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
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

    // Divide file into N chunks
    let chunk_size = (file_size + n as u64 - 1) / n as u64;
    let mut handles = Vec::new();

    for i in 0..n {
        let offset = i as u64 * chunk_size;
        if offset >= file_size {
            break;
        }
        let length = chunk_size.min(file_size - offset);
        let port = BASE_PORT + i as u16;
        let ip = ip.clone();
        let path = path.clone();
        let file_name = file_name.clone();
        let bytes_sent = Arc::clone(&bytes_sent);
        let app = app.clone();

        handles.push(tokio::spawn(async move {
            send_chunk(&ip, port, &path, &file_name, file_size, offset, length, i, bytes_sent, app).await
        }));
    }

    // Progress reporter
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
            let eta = if speed > 0.0 { (file_size - done) as f64 / (speed * 1_000_000.0) } else { 0.0 };
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

    for h in handles {
        h.await.map_err(|e| e.to_string())?.map_err(|e| e)?;
    }
    prog_handle.abort();

    let elapsed = start.elapsed().as_secs_f64();
    let avg_speed = if elapsed > 0.0 { file_size as f64 / elapsed / 1_000_000.0 } else { 0.0 };

    let _ = app.emit("transfer-done", TransferDoneEvent {
        file_name,
        save_path: String::new(),
        total_bytes: file_size,
        elapsed_secs: elapsed,
        avg_speed_mbps: avg_speed,
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
    // Retry logic for connection
    let mut stream = None;
    for attempt in 0..10 {
        match TcpStream::connect(format!("{}:{}", ip, port)).await {
            Ok(s) => { stream = Some(s); break; }
            Err(_) => {
                if attempt < 9 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
                }
            }
        }
    }
    let mut stream = stream.ok_or_else(|| format!("Cannot connect to {}:{}", ip, port))?;

    // Set TCP options for performance
    stream.set_nodelay(true).ok();

    let name_bytes = file_name.as_bytes();
    // Header: [8B fileSize][4B nameLen][4B chunkIndex][8B offset][8B length][name]
    let mut header = Vec::with_capacity(32 + name_bytes.len());
    header.extend_from_slice(&file_size.to_be_bytes());
    header.extend_from_slice(&(name_bytes.len() as u32).to_be_bytes());
    header.extend_from_slice(&(chunk_index as u32).to_be_bytes());
    header.extend_from_slice(&offset.to_be_bytes());
    header.extend_from_slice(&length.to_be_bytes());
    header.extend_from_slice(name_bytes);

    stream.write_all(&header).await.map_err(|e| e.to_string())?;

    // Send file data
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

    // Wait for ACK
    let mut ack = [0u8; 3];
    stream.read_exact(&mut ack).await.map_err(|e| e.to_string())?;

    Ok(())
}

// ─── RECEIVE ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_receiver(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    let (shutdown_tx, _) = tokio::sync::broadcast::channel::<()>(1);
    let n = num_streams();
    let save_dir = get_save_dir();
    std::fs::create_dir_all(&save_dir).map_err(|e| e.to_string())?;

    for i in 0..n {
        let port = BASE_PORT + i as u16;
        let save_dir = save_dir.clone();
        let app = app.clone();
        let mut shutdown_rx = shutdown_tx.subscribe();

        tokio::spawn(async move {
            let listener = match TcpListener::bind(format!("0.0.0.0:{}", port)).await {
                Ok(l) => l,
                Err(e) => {
                    let _ = app.emit("transfer-error", TransferErrorEvent { message: format!("Port {} busy: {}", port, e) });
                    return;
                }
            };

            loop {
                tokio::select! {
                    _ = shutdown_rx.recv() => break,
                    result = listener.accept() => {
                        match result {
                            Ok((stream, _)) => {
                                let save_dir = save_dir.clone();
                                let app = app.clone();
                                tokio::spawn(async move {
                                    if let Err(e) = handle_incoming(stream, &save_dir, app).await {
                                        log::error!("Receive error: {}", e);
                                    }
                                });
                            }
                            Err(_) => break,
                        }
                    }
                }
            }
        });
    }

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
) -> Result<(), String> {
    stream.set_nodelay(true).ok();

    // Read header
    let mut file_size_buf = [0u8; 8];
    stream.read_exact(&mut file_size_buf).await.map_err(|e| e.to_string())?;
    let file_size = u64::from_be_bytes(file_size_buf);

    let mut name_len_buf = [0u8; 4];
    stream.read_exact(&mut name_len_buf).await.map_err(|e| e.to_string())?;
    let name_len = u32::from_be_bytes(name_len_buf) as usize;

    let mut chunk_idx_buf = [0u8; 4];
    stream.read_exact(&mut chunk_idx_buf).await.map_err(|e| e.to_string())?;
    let chunk_index = u32::from_be_bytes(chunk_idx_buf);

    let mut offset_buf = [0u8; 8];
    stream.read_exact(&mut offset_buf).await.map_err(|e| e.to_string())?;
    let _offset = u64::from_be_bytes(offset_buf);

    let mut length_buf = [0u8; 8];
    stream.read_exact(&mut length_buf).await.map_err(|e| e.to_string())?;
    let length = u64::from_be_bytes(length_buf);

    let mut name_buf = vec![0u8; name_len];
    stream.read_exact(&mut name_buf).await.map_err(|e| e.to_string())?;
    let file_name = String::from_utf8_lossy(&name_buf).to_string();

    // Write chunk to temp file
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
        while remaining > 0 {
            let to_read = (remaining as usize).min(buf.len());
            let n = stream.read(&mut buf[..to_read]).await.map_err(|e| e.to_string())?;
            if n == 0 { break; }
            temp_file.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
            remaining -= n as u64;
        }
        temp_file.flush().await.map_err(|e| e.to_string())?;
    }

    // Send ACK
    stream.write_all(b"ACK").await.ok();

    // Check if all chunks received, then assemble
    let n = num_streams();
    let chunks_expected = ((file_size + CHUNK_SIZE - 1) / CHUNK_SIZE).min(n as u64) as usize;

    // Try to assemble: check all parts present
    let all_present = (0..chunks_expected).all(|i| {
        save_dir.join(format!("{}.part{}", file_name, i)).exists()
    });

    if all_present {
        assemble_file(&file_name, save_dir, file_size, chunks_expected, &final_path).await?;
        let _ = app.emit("transfer-done", TransferDoneEvent {
            file_name: file_name.clone(),
            save_path: final_path.to_string_lossy().to_string(),
            total_bytes: file_size,
            elapsed_secs: 0.0,
            avg_speed_mbps: 0.0,
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
    log::info!("Assembled {} ({} bytes) at {:?}", file_name, file_size, final_path);
    Ok(())
}

pub fn get_save_dir() -> PathBuf {
    let base = dirs_next::download_dir()
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("FlashTransfer")
}
