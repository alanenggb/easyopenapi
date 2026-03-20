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
    use std::env;

    #[cfg(target_os = "windows")]
    {
        let output = Command::new("cmd")
            .args(&["/C", "gcloud auth print-identity-token"])
            .output()
            .await
            .map_err(|e| format!("Failed to execute gcloud: {}", e))?;
        return gcloud_output_to_token(output);
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
        .invoke_handler(tauri::generate_handler![greet, get_gcloud_token, fetch_openapi_spec])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
