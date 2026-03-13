mod transfer;
mod lan_discovery;
mod relay_client;
mod messaging;

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
            // Transfer
            transfer::start_receiver,
            transfer::send_file,
            transfer::stop_receiver,
            transfer::get_received_files,
            transfer::delete_received_file,
            transfer::open_file,
            // LAN discovery
            lan_discovery::start_lan_discovery,
            lan_discovery::stop_lan_discovery,
            // Internet relay
            relay_client::generate_relay_code,
            relay_client::join_relay_room,
            relay_client::disconnect_relay,
            // Messaging (LAN chat + file requests)
            messaging::send_chat_message,
            messaging::send_file_request,
            messaging::respond_to_file_request,
            // Utilities
            get_local_ip,
            get_public_ip,
            get_file_size,
            open_download_folder,
            configure_firewall,
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.set_title("Flash⚡Transfer").unwrap();

            try_configure_firewall();

            // Démarre le canal de contrôle pour les messages et demandes de fichiers
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                messaging::start_control_listener(handle).await;
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Flash⚡Transfer");
}

fn try_configure_firewall() {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        // Nettoie les anciennes règles (silencieux — pas de fenêtre console)
        let _ = std::process::Command::new("netsh")
            .args(["advfirewall", "firewall", "delete", "rule", "name=FlashTransfer-TCP"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let _ = std::process::Command::new("netsh")
            .args(["advfirewall", "firewall", "delete", "rule", "name=FlashTransfer-UDP"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let _ = std::process::Command::new("netsh")
            .args(["advfirewall", "firewall", "delete", "rule", "name=FlashTransfer-CTRL"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        // TCP 45679 — transfert de fichiers
        let _ = std::process::Command::new("netsh")
            .args([
                "advfirewall", "firewall", "add", "rule",
                "name=FlashTransfer-TCP", "dir=in", "action=allow",
                "protocol=TCP", "localport=45679",
                "profile=private,domain",
                "description=Flash Transfer file port",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        // TCP 45680 — canal de contrôle (messages + file requests)
        let _ = std::process::Command::new("netsh")
            .args([
                "advfirewall", "firewall", "add", "rule",
                "name=FlashTransfer-CTRL", "dir=in", "action=allow",
                "protocol=TCP", "localport=45680",
                "profile=private,domain",
                "description=Flash Transfer control port",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        // UDP 45678 — découverte LAN
        let _ = std::process::Command::new("netsh")
            .args([
                "advfirewall", "firewall", "add", "rule",
                "name=FlashTransfer-UDP", "dir=in", "action=allow",
                "protocol=UDP", "localport=45678",
                "profile=private,domain",
                "description=Flash Transfer LAN discovery",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
}

#[tauri::command]
async fn configure_firewall() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        try_configure_firewall();
        return Ok("Règles pare-feu appliquées (TCP 45679, TCP 45680, UDP 45678).".to_string());
    }
    #[cfg(not(target_os = "windows"))]
    Ok("Aucune config pare-feu nécessaire sur ce système.".to_string())
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
    let folder = transfer::get_save_dir();
    std::fs::create_dir_all(&folder).ok();
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer").arg(&folder).spawn().ok();
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(&folder).spawn().ok();
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open").arg(&folder).spawn().ok();
    Ok(())
}
