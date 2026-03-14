use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const OAUTH_PORT: u16 = 7432;

/// Démarre le mini-serveur HTTP OAuth (non-bloquant — spawn en tâche de fond)
#[tauri::command]
pub async fn start_oauth_server(app: AppHandle) -> Result<(), String> {
    tokio::spawn(async move {
        if let Err(e) = run_oauth_server(app).await {
            eprintln!("[oauth] server error: {}", e);
        }
    });
    Ok(())
}

async fn run_oauth_server(app: AppHandle) -> Result<(), String> {
    let listener = TcpListener::bind(format!("127.0.0.1:{}", OAUTH_PORT))
        .await
        .map_err(|e| format!("Port {} indisponible: {}", OAUTH_PORT, e))?;

    // Attend une connexion (timeout 120 s)
    let (mut stream, _) =
        tokio::time::timeout(tokio::time::Duration::from_secs(120), listener.accept())
            .await
            .map_err(|_| "OAuth timeout (120s)".to_string())?
            .map_err(|e| e.to_string())?;

    // Lit la requête HTTP
    let mut buf = vec![0u8; 8192];
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    let request = String::from_utf8_lossy(&buf[..n]).to_string();

    let code  = extract_param(&request, "code");
    let error = extract_param(&request, "error");

    // Réponse HTML au navigateur
    let (title, body) = if code.is_some() {
        (
            "Connexion réussie — Flash Transfer",
            r#"<h2>⚡ Connexion réussie !</h2>
               <p>Retournez dans l'application <strong>Flash Transfer</strong>.</p>"#,
        )
    } else {
        (
            "Erreur — Flash Transfer",
            r#"<h2>❌ Échec de connexion</h2>
               <p>Veuillez réessayer depuis l'application.</p>"#,
        )
    };

    let html = format!(
        r#"<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title>{title}</title>
<style>body{{font-family:system-ui,sans-serif;text-align:center;padding:60px 20px;
background:#111;color:#eee}}h2{{color:#F5C842;margin-bottom:12px}}
p{{color:#aaa;font-size:15px}}</style></head>
<body>{body}<script>setTimeout(()=>window.close(),2500);</script></body></html>"#
    );

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    stream.write_all(response.as_bytes()).await.ok();
    stream.flush().await.ok();

    // Émet le résultat vers le frontend
    if let Some(c) = code {
        let _ = app.emit("oauth-code", c);
    } else {
        let _ = app.emit("oauth-error", error.unwrap_or_else(|| "unknown".to_string()));
    }

    Ok(())
}

/// Ouvre une URL dans le navigateur système (multi-plateforme)
#[tauri::command]
pub async fn open_browser_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn extract_param(request: &str, param: &str) -> Option<String> {
    let first_line = request.lines().next()?;
    let path = first_line.split_whitespace().nth(1)?;
    let query = path.split('?').nth(1)?;
    for kv in query.split('&') {
        let mut parts = kv.splitn(2, '=');
        if parts.next()? == param {
            return Some(url_decode(parts.next().unwrap_or("")));
        }
    }
    None
}

fn url_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.bytes().peekable();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let h1 = chars.next().unwrap_or(b'0') as char;
            let h2 = chars.next().unwrap_or(b'0') as char;
            if let Ok(n) = u8::from_str_radix(&format!("{h1}{h2}"), 16) {
                out.push(n as char);
                continue;
            }
        } else if b == b'+' {
            out.push(' ');
            continue;
        }
        out.push(b as char);
    }
    out
}
