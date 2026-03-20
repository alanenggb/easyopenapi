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
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn get_gcloud_token() -> Result<String, String> {
    use tokio::process::Command;
    
    // Tentar encontrar o gcloud no PATH
    let gcloud_cmd = find_gcloud_command().await?;
    
    let output = Command::new(&gcloud_cmd)
        .args(&["auth", "print-identity-token"])
        .output()
        .await
        .map_err(|e| format!("Failed to execute gcloud command '{}': {}", gcloud_cmd, e))?;

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

async fn find_gcloud_command() -> Result<String, String> {
    use tokio::process::Command;
    use std::env;
    
    // Tentar diferentes caminhos onde o gcloud pode estar instalado
    let mut possible_paths = vec![
        "gcloud".to_string(), // No PATH
        r"C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd".to_string(),
        r"C:\Program Files\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd".to_string(),
    ];
    
    // Tentar obter o username do ambiente
    if let Ok(username) = env::var("USERNAME") {
        let user_path = format!(r"C:\Users\{}\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd", username);
        possible_paths.push(user_path);
    }
    
    for path in possible_paths {
        // Verificar se o comando existe tentando executar --version
        if let Ok(output) = Command::new(&path).arg("--version").output().await {
            if output.status.success() {
                return Ok(path);
            }
        }
    }
    
    Err("gcloud command not found. Please ensure Google Cloud SDK is installed and in PATH.".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, get_gcloud_token, fetch_openapi_spec])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
