use tauri::Manager;

#[tauri::command]
async fn fetch_openapi_spec(url: String, use_auth: bool) -> Result<serde_json::Value, String> {
    use reqwest::Client;
    
    let client = Client::new();
    let mut request = client.get(&url);
    
    if use_auth {
        // Tentar obter o token gcloud
        match get_gcloud_token().await {
            Ok(token) => {
                request = request
                    .header("Authorization", format!("Bearer {}", token))
                    .header("TokenPortal", token.clone());
            }
            Err(e) => {
                return Err(format!("Failed to get gcloud token: {}", e));
            }
        }
    }
    
    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;
    
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), status.canonical_reason().unwrap_or("Unknown")));
    }
    
    let json = response
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Failed to parse JSON response: {}", e))?;
    
    Ok(json)
}

#[tauri::command]
async fn toggle_devtools(webview: tauri::WebviewWindow) -> Result<(), String> {
    // Apenas abre os devtools (não há método confiável para fechar)
    webview.open_devtools();
    Ok(())
}

#[tauri::command]
async fn make_test_request(url: String, method: String, body: Option<String>, use_auth: bool) -> Result<serde_json::Value, String> {
    use reqwest::Client;
    
    let client = Client::new();
    let mut request = match method.as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        "PATCH" => client.patch(&url),
        _ => return Err(format!("Unsupported method: {}", method)),
    };
    
    // Adicionar headers de autenticação se necessário
    if use_auth {
        match get_gcloud_token().await {
            Ok(token) => {
                request = request
                    .header("Authorization", format!("Bearer {}", token))
                    .header("TokenPortal", token.clone());
            }
            Err(e) => {
                return Err(format!("Failed to get gcloud token: {}", e));
            }
        }
    }
    
    // Adicionar body se fornecido
    let request = if let Some(body_str) = body {
        request.header("Content-Type", "application/json").body(body_str)
    } else {
        request
    };
    
    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;
    
    let status = response.status();
    let status_code = status.as_u16();
    let status_text = status.canonical_reason().unwrap_or("Unknown");
    
    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    
    let response_data: serde_json::Value = if response_text.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str(&response_text).unwrap_or_else(|_| serde_json::Value::String(response_text))
    };
    
    // Headers vazios por enquanto, já que não podemos acessar depois de consumir o response
    let headers = std::collections::HashMap::<&str, &str>::new();
    
    let result = serde_json::json!({
        "status": status_code,
        "statusText": status_text,
        "headers": headers,
        "data": response_data
    });
    
    Ok(result)
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn get_gcloud_token() -> Result<String, String> {
    use tokio::process::Command;
    use std::env;

    #[cfg(target_os = "windows")]
    {
        use std::path::Path;
        
        // Caminhos onde o gcloud pode estar instalado no Windows
        let mut gcloud_candidates = vec![
            r"C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd".to_string(),
            r"C:\Program Files\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd".to_string(),
        ];
        
        // Tentar obter o username para caminho do AppData
        if let Ok(username) = env::var("USERNAME") {
            let user_path = format!(r"C:\Users\{}\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd", username);
            gcloud_candidates.push(user_path);
        }
        
        let mut diagnostics: Vec<String> = Vec::new();
        
        for gcloud_path in &gcloud_candidates {
            // Verifica se o arquivo existe antes de tentar executar
            if !Path::new(gcloud_path).exists() {
                continue;
            }
            
            // Executa o comando gcloud diretamente
            let result = Command::new(gcloud_path)
                .args(&["auth", "print-identity-token"])
                .output()
                .await;
                
            match result {
                Ok(output) if output.status.success() => {
                    return gcloud_output_to_token(output);
                }
                Ok(output) => {
                    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    diagnostics.push(format!(
                        "[{}] exit={} stdout='{}' stderr='{}'",
                        gcloud_path,
                        output.status.code().unwrap_or(-1),
                        stdout,
                        stderr
                    ));
                }
                Err(e) => {
                    diagnostics.push(format!("[{}] spawn error: {}", gcloud_path, e));
                }
            }
        }
        
        if diagnostics.is_empty() {
            Err(format!(
                "gcloud not found. Checked: {}. Ensure Google Cloud SDK is installed.",
                gcloud_candidates.join(", ")
            ))
        } else {
            Err(format!(
                "gcloud found but failed. Diagnostics: {}",
                diagnostics.join(" | ")
            ))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = env::var("HOME").unwrap_or_default();

        // Apps GUI no macOS não herdam o PATH do shell do usuário.
        // Usamos /bin/sh -c com PATH embutido inline: isso garante que
        // tanto o script do gcloud quanto o Python que ele invoca
        // internamente encontrem os binários necessários (via Homebrew etc.).
        let full_path = format!(
            "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/google-cloud-sdk/bin:{}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            home
        );

        // Caminhos onde o gcloud pode estar instalado
        let gcloud_candidates = vec![
            "/opt/homebrew/bin/gcloud".to_string(),
            "/usr/local/bin/gcloud".to_string(),
            format!("{}/google-cloud-sdk/bin/gcloud", home),
        ];

        let mut diagnostics: Vec<String> = Vec::new();

        for gcloud_path in &gcloud_candidates {
            // Verifica se o binário/symlink existe antes de tentar
            if !std::path::Path::new(gcloud_path).exists() {
                continue;
            }

            // Invoca via /bin/sh com PATH embutido. Isso contorna o problema
            // de o gcloud ser um shell script que precisa resolver symlinks
            // e encontrar o Python no PATH.
            let sh_cmd = format!(
                "PATH=\"{}\" \"{}\" auth print-identity-token",
                full_path, gcloud_path
            );

            let result = Command::new("/bin/sh")
                .args(&["-c", &sh_cmd])
                .output()
                .await;

            match result {
                Ok(output) if output.status.success() => {
                    return gcloud_output_to_token(output);
                }
                Ok(output) => {
                    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    diagnostics.push(format!(
                        "[{}] exit={} stdout='{}' stderr='{}'",
                        gcloud_path,
                        output.status.code().unwrap_or(-1),
                        stdout,
                        stderr
                    ));
                }
                Err(e) => {
                    diagnostics.push(format!("[{}] spawn error: {}", gcloud_path, e));
                }
            }
        }

        if diagnostics.is_empty() {
            Err(format!(
                "gcloud not found. Checked: {}. Ensure Google Cloud SDK is installed.",
                gcloud_candidates.join(", ")
            ))
        } else {
            Err(format!(
                "gcloud found but failed. Diagnostics: {}",
                diagnostics.join(" | ")
            ))
        }
    }
}

fn gcloud_output_to_token(output: std::process::Output) -> Result<String, String> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gcloud command failed: {}", stderr));
    }

    let token = String::from_utf8(output.stdout)
        .map_err(|e| format!("Failed to parse gcloud output: {}", e))?
        .trim()
        .to_string();

    if token.is_empty() {
        return Err("No token returned from gcloud".to_string());
    }

    Ok(token)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            
            // Restaurar posição e tamanho da janela ao iniciar
            let store_result = tauri_plugin_store::StoreBuilder::new(app, std::path::PathBuf::from(".window-state.json")).build();
            
            if let Ok(store) = store_result {
                if let Some(state) = store.get("window_state") {
                    if let Some(x) = state.get("x").and_then(|v: &serde_json::Value| v.as_f64()) {
                        if let Some(y) = state.get("y").and_then(|v: &serde_json::Value| v.as_f64()) {
                            if let Some(width) = state.get("width").and_then(|v: &serde_json::Value| v.as_f64()) {
                                if let Some(height) = state.get("height").and_then(|v: &serde_json::Value| v.as_f64()) {
                                    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: x as i32, y: y as i32 }));
                                    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: width as u32, height: height as u32 }));
                                }
                            }
                        }
                    }
                }
                
                // Salvar estado da janela quando mover ou redimensionar
                let store_clone = store.clone();
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    match event {
                        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                            if let Ok(pos) = window_clone.outer_position() {
                                if let Ok(size) = window_clone.outer_size() {
                                    let state = serde_json::json!({
                                        "x": pos.x,
                                        "y": pos.y,
                                        "width": size.width,
                                        "height": size.height
                                    });
                                    let _ = store_clone.set("window_state", state);
                                    let _ = store_clone.save();
                                }
                            }
                        }
                        _ => {}
                    }
                });
            }
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, get_gcloud_token, fetch_openapi_spec, make_test_request, toggle_devtools])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
