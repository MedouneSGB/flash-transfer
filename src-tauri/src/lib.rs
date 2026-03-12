mod transfer;
mod lan_discovery;
mod relay_client;

use tauri::Manager;
use std::sync::Arc;
use tokio::sync::Mutex;
use transfer::ReceiverState;

pub struct AppState {
    pub receiver: Arc<Mutex<Option<ReceiverState>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            receiver: Arc::new(Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            transfer::start_receiver,
            transfer::send_file,
            transfer::stop_receiver,
            lan_discovery::start_lan_discovery,
            lan_discovery::stop_lan_discovery,
            relay_client::generate_relay_code,
            relay_client::join_relay_room,
            relay_client::disconnect_relay,
            get_local_ip,
            get_public_ip,
            get_file_size,
            open_download_folder,
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.set_title("Flash⚡Transfer").unwrap();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Flash⚡Transfer");
}

#[tauri::command]
fn get_local_ip() -> String {
    match local_ip_address::local_ip() {
        Ok(ip) => ip.to_string(),
        Err(_) => "127.0.0.1".to_string(),
    }
}

#[tauri::command]
async fn get_public_ip() -> String {
    match reqwest::get("https://api.ipify.org").await {
        Ok(resp) => resp.text().await.unwrap_or_else(|_| "unavailable".to_string()),
        Err(_) => "unavailable".to_string(),
    }
}

#[tauri::command]
fn get_file_size(path: String) -> u64 {
    std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
}

#[tauri::command]
async fn open_download_folder() -> Result<(), String> {
    let home = dirs_next::download_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let folder = home.join("FlashTransfer");
    std::fs::create_dir_all(&folder).ok();

    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer").arg(&folder).spawn().ok();
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(&folder).spawn().ok();
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open").arg(&folder).spawn().ok();

    Ok(())
}
