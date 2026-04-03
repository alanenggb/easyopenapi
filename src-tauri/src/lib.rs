use tauri::Manager;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};

#[cfg(windows)]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

#[derive(Debug, Deserialize, Clone, Serialize)]
struct PostgresConfig {
    host: String,
    port: i32,
    db: String,
    schema: String,
    user: String,
    pw: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ValueSetRecord {
    id: String,
    name: String,
    config_id: String,
    endpoint_method: String,
    endpoint_path: String,
    path_params: serde_json::Value,
    query_params: serde_json::Value,
    body: String,
    created_at: chrono::DateTime<chrono::Utc>,
    user_account: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct TestResultRecord {
    id: String,
    name: String,
    config_id: String,
    endpoint_method: String,
    endpoint_path: String,
    request_data: serde_json::Value,
    response_data: serde_json::Value,
    timestamp: chrono::DateTime<chrono::Utc>,
    user_account: String,
}

#[tauri::command]
async fn fetch_openapi_spec(url: String, use_auth: bool, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use reqwest::Client;
    
    let client = Client::new();
    let mut request = client.get(&url);
    
    if use_auth {
        // Tentar obter o token gcloud
        match get_gcloud_token(app.clone()).await {
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
async fn make_test_request(url: String, method: String, body: Option<String>, use_auth: bool, headers: Option<std::collections::HashMap<String, String>>, app: tauri::AppHandle) -> Result<serde_json::Value, String> {
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
        match get_gcloud_token(app.clone()).await {
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
    
    // Adicionar headers personalizados
    if let Some(custom_headers) = headers {
        for (name, value) in custom_headers {
            request = request.header(&name, &value);
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
    
    // Coletar headers da resposta como um clone antes de consumir a response
    let response_headers: std::collections::HashMap<String, String> = response
        .headers()
        .iter()
        .filter_map(|(name, value)| value.to_str().ok().map(|v| (name.as_str().to_string(), v.to_string())))
        .collect();
    
    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    
    let response_data: serde_json::Value = if response_text.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str(&response_text).unwrap_or_else(|_| serde_json::Value::String(response_text))
    };
    
    let result = serde_json::json!({
        "status": status_code,
        "statusText": status_text,
        "headers": response_headers,
        "data": response_data
    });
    
    Ok(result)
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

use std::time::{SystemTime, UNIX_EPOCH};

#[tauri::command]
async fn get_gcloud_token(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_store::StoreBuilder;

    // Tentar carregar token cacheado
    let store_result = StoreBuilder::new(&app, std::path::PathBuf::from("app-data.json")).build();
    
    if let Ok(store) = store_result {
        if let Some(cached_data) = store.get("gcloud_token_cache") {
            if let Some(token) = cached_data.get("token").and_then(|v| v.as_str()) {
                if let Some(timestamp) = cached_data.get("timestamp").and_then(|v| v.as_u64()) {
                    let current_time = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map_err(|e| format!("Failed to get current time: {}", e))?;
                    
                    // Verificar se o token tem menos de 30 minutos (1800 segundos)
                    if current_time.as_secs() - timestamp < 1800 {
                        return Ok(token.to_string());
                    }
                }
            }
        }
    }

    // Se chegou aqui, precisa gerar novo token
    let new_token = generate_new_gcloud_token().await?;
    
    // Salvar novo token no cache com timestamp atual
    let store_result = StoreBuilder::new(&app, std::path::PathBuf::from("app-data.json")).build();
    if let Ok(store) = store_result {
        let current_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| format!("Failed to get current time: {}", e))?;
        
        let cache_data = serde_json::json!({
            "token": new_token,
            "timestamp": current_time.as_secs()
        });
        
        let _ = store.set("gcloud_token_cache", cache_data);
        let _ = store.save();
    }
    
    Ok(new_token)
}

#[tauri::command]
async fn get_gcloud_account() -> Result<String, String> {
    use tokio::process::Command;
    use std::env;

    #[cfg(target_os = "windows")]
    {
        use std::path::Path;
        
        let mut gcloud_candidates = vec![
            r"C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd".to_string(),
            r"C:\Program Files\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd".to_string(),
        ];
        
        if let Ok(username) = env::var("USERNAME") {
            let user_path = format!(r"C:\Users\{}\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd", username);
            gcloud_candidates.push(user_path);
        }
        
        for gcloud_path in &gcloud_candidates {
            if !Path::new(gcloud_path).exists() {
                continue;
            }
            
            let mut cmd = Command::new(gcloud_path);
            cmd.args(&["config", "get-value", "account"]);
            
            #[cfg(windows)]
            {
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            
            match cmd.output().await {
                Ok(output) if output.status.success() => {
                    let account = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if !account.is_empty() {
                        // Extract username before @
                        if let Some(username) = account.split('@').next() {
                            return Ok(username.to_string());
                        }
                        return Ok(account);
                    }
                }
                Ok(_) => continue,
                Err(_) => continue,
            }
        }
        
        Err("gcloud not found or not configured".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = env::var("HOME").unwrap_or_default();
        let gcloud_candidates = vec![
            "/opt/homebrew/bin/gcloud".to_string(),
            "/usr/local/bin/gcloud".to_string(),
            format!("{}/google-cloud-sdk/bin/gcloud", home),
        ];

        for gcloud_path in &gcloud_candidates {
            if !std::path::Path::new(gcloud_path).exists() {
                continue;
            }

            let result = Command::new(gcloud_path)
                .args(&["config", "get-value", "account"])
                .output()
                .await;

            match result {
                Ok(output) if output.status.success() => {
                    let account = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if !account.is_empty() {
                        // Extract username before @
                        if let Some(username) = account.split('@').next() {
                            return Ok(username.to_string());
                        }
                        return Ok(account);
                    }
                }
                Ok(_) => continue,
                Err(_) => continue,
            }
        }
        
        Err("gcloud not found or not configured".to_string())
    }
}

#[tauri::command]
async fn get_postgres_config(secret_name: String) -> Result<PostgresConfig, String> {
    use tokio::process::Command;
    
    #[cfg(target_os = "windows")]
    {
        use std::path::Path;
        
        let gcloud_candidates = vec![
            r"C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd".to_string(),
            r"C:\Program Files\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd".to_string(),
        ];
        
        for gcloud_path in &gcloud_candidates {
            if !Path::new(gcloud_path).exists() {
                continue;
            }
            
            let mut cmd = Command::new(gcloud_path);
            cmd.args(&[
                "secrets", "versions", "access", "latest",
                &format!("--secret={}", secret_name)
            ]);
            
            #[cfg(windows)]
            {
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
            
            let output = cmd.spawn()
                .map_err(|e| format!("Failed to spawn gcloud command: {}", e))?
                .wait_with_output()
                .await
                .map_err(|e| format!("Failed to wait for gcloud command: {}", e))?;
            
            if output.status.success() {
                let secret_json = String::from_utf8_lossy(&output.stdout);
                
                match serde_json::from_str::<PostgresConfig>(&secret_json) {
                    Ok(config) => return Ok(config),
                    Err(e) => return Err(format!("Failed to parse PostgreSQL config: {}", e)),
                }
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("Failed to access secret: {}", stderr));
            }
        }
        
        Err("gcloud not found".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let gcloud_candidates = vec![
            "/opt/homebrew/bin/gcloud".to_string(),
            "/usr/local/bin/gcloud".to_string(),
            format!("{}/google-cloud-sdk/bin/gcloud", home),
        ];

        for gcloud_path in &gcloud_candidates {
            if !std::path::Path::new(gcloud_path).exists() {
                continue;
            }

            let output = Command::new(gcloud_path)
                .args(&[
                    "secrets", "versions", "access", "latest",
                    &format!("--secret={}", secret_name)
                ])
                .output()
                .await;

            match output {
                Ok(result) if result.status.success() => {
                    let secret_json = String::from_utf8_lossy(&result.stdout);
                    
                    match serde_json::from_str::<PostgresConfig>(&secret_json) {
                        Ok(config) => return Ok(config),
                        Err(e) => return Err(format!("Failed to parse PostgreSQL config: {}", e)),
                    }
                }
                Ok(_) => continue,
                Err(_) => continue,
            }
        }
        
        Err("gcloud not found or not configured".to_string())
    }
}

async fn create_postgres_connection(config: &PostgresConfig) -> Result<PgPool, String> {
    let connection_string = format!(
        "postgres://{}:{}@{}:{}/{}?search_path={}",
        config.user, config.pw, config.host, config.port, config.db, config.schema
    );
    
    PgPool::connect(&connection_string)
        .await
        .map_err(|e| format!("Failed to connect to PostgreSQL: {}", e))
}

#[tauri::command]
async fn create_postgres_tables(secret_name: String) -> Result<String, String> {
    let config = get_postgres_config(secret_name).await?;
    let pool = create_postgres_connection(&config).await?;
    
    // Criar tabela de value sets
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS value_sets (
            id VARCHAR(255) PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            config_id VARCHAR(255) NOT NULL,
            endpoint_method VARCHAR(10) NOT NULL,
            endpoint_path VARCHAR(500) NOT NULL,
            path_params JSONB,
            query_params JSONB,
            body TEXT,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            user_account VARCHAR(255)
        )
    "#)
    .execute(&pool)
    .await
    .map_err(|e| format!("Failed to create value_sets table: {}", e))?;
    
    // Criar tabela de test results
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS test_results (
            id VARCHAR(255) PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            config_id VARCHAR(255) NOT NULL,
            endpoint_method VARCHAR(10) NOT NULL,
            endpoint_path VARCHAR(500) NOT NULL,
            request_data JSONB,
            response_data JSONB,
            timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            user_account VARCHAR(255)
        )
    "#)
    .execute(&pool)
    .await
    .map_err(|e| format!("Failed to create test_results table: {}", e))?;
    
    // Criar índices para melhor performance
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_value_sets_config_endpoint ON value_sets (config_id, endpoint_method, endpoint_path)")
        .execute(&pool)
        .await
        .map_err(|e| format!("Failed to create value_sets index: {}", e))?;
    
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_test_results_config_endpoint ON test_results (config_id, endpoint_method, endpoint_path)")
        .execute(&pool)
        .await
        .map_err(|e| format!("Failed to create test_results index: {}", e))?;
    
    Ok("PostgreSQL tables created successfully".to_string())
}

#[tauri::command]
async fn save_value_set_to_postgres(
    secret_name: String,
    config_id: String,
    endpoint_method: String,
    endpoint_path: String,
    value_set_data: serde_json::Value,
) -> Result<String, String> {
    // Obter conta do usuário
    let user_account = get_gcloud_account().await.unwrap_or_else(|_| "unknown".to_string());
    
    // Extrair dados do value set
    let set_name = value_set_data.get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("unnamed")
        .to_string();
    
    let new_uuid = uuid::Uuid::new_v4().to_string();
    let set_id = value_set_data.get("id")
        .and_then(|v| v.as_str())
        .unwrap_or(&new_uuid)
        .to_string();
    
    let default_json = serde_json::json!({});
    let path_params = value_set_data.get("pathParams").unwrap_or(&default_json);
    let query_params = value_set_data.get("queryParams").unwrap_or(&default_json);
    let body = value_set_data.get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    
    // Conectar ao PostgreSQL
    let config = get_postgres_config(secret_name).await?;
    let pool = create_postgres_connection(&config).await?;
    
    // Inserir ou atualizar value set
    sqlx::query(r#"
        INSERT INTO value_sets (id, name, config_id, endpoint_method, endpoint_path, path_params, query_params, body, user_account)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            path_params = EXCLUDED.path_params,
            query_params = EXCLUDED.query_params,
            body = EXCLUDED.body,
            user_account = EXCLUDED.user_account
    "#)
    .bind(&set_id)
    .bind(&set_name)
    .bind(&config_id)
    .bind(&endpoint_method)
    .bind(&endpoint_path)
    .bind(path_params)
    .bind(query_params)
    .bind(&body)
    .bind(&user_account)
    .execute(&pool)
    .await
    .map_err(|e| format!("Failed to save value set to PostgreSQL: {}", e))?;
    
    Ok(set_id)
}

#[tauri::command]
async fn list_postgres_value_sets(
    secret_name: String,
    config_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    // Conectar ao PostgreSQL
    let config = get_postgres_config(secret_name).await?;
    let pool = create_postgres_connection(&config).await?;
    
    // Buscar value sets do banco
    let rows = sqlx::query(r#"
        SELECT id, name, config_id, endpoint_method, endpoint_path, 
               path_params, query_params, body, created_at, user_account
        FROM value_sets 
        WHERE config_id = $1
        ORDER BY created_at DESC
    "#)
    .bind(&config_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("Failed to fetch value sets from PostgreSQL: {}", e))?;
    
    let mut results = Vec::new();
    for row in rows {
        let value_set = serde_json::json!({
            "id": row.get::<String, &str>("id"),
            "name": row.get::<String, &str>("name"),
            "configId": row.get::<String, &str>("config_id"),
            "endpoint": {
                "method": row.get::<String, &str>("endpoint_method"),
                "path": row.get::<String, &str>("endpoint_path")
            },
            "pathParams": row.get::<serde_json::Value, &str>("path_params"),
            "queryParams": row.get::<serde_json::Value, &str>("query_params"),
            "body": row.get::<String, &str>("body"),
            "createdAt": row.get::<chrono::DateTime<chrono::Utc>, &str>("created_at").to_rfc3339(),
            "userAccount": row.get::<String, &str>("user_account")
        });
        results.push(value_set);
    }
    
    Ok(results)
}

#[tauri::command]
async fn save_to_postgres(
    secret_name: String,
    config_id: String,
    endpoint_method: String,
    endpoint_path: String,
    result_data: serde_json::Value,
) -> Result<String, String> {
    // Obter conta do usuário
    let user_account = get_gcloud_account().await.unwrap_or_else(|_| "unknown".to_string());
    
    // Extrair dados do resultado
    let result_name = result_data.get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("unnamed")
        .to_string();
    
    let new_uuid = uuid::Uuid::new_v4().to_string();
    let result_id = result_data.get("id")
        .and_then(|v| v.as_str())
        .unwrap_or(&new_uuid)
        .to_string();
    
    // Conectar ao PostgreSQL
    let config = get_postgres_config(secret_name).await?;
    let pool = create_postgres_connection(&config).await?;
    
    // Inserir ou atualizar resultado
    sqlx::query(r#"
        INSERT INTO test_results (id, name, config_id, endpoint_method, endpoint_path, request_data, response_data, user_account)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            request_data = EXCLUDED.request_data,
            response_data = EXCLUDED.response_data,
            user_account = EXCLUDED.user_account
    "#)
    .bind(&result_id)
    .bind(&result_name)
    .bind(&config_id)
    .bind(&endpoint_method)
    .bind(&endpoint_path)
    .bind(result_data.get("request"))
    .bind(result_data.get("response"))
    .bind(&user_account)
    .execute(&pool)
    .await
    .map_err(|e| format!("Failed to save test result to PostgreSQL: {}", e))?;
    
    Ok(result_id)
}

#[tauri::command]
async fn list_postgres_results(
    secret_name: String,
    config_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    // Conectar ao PostgreSQL
    let config = get_postgres_config(secret_name).await?;
    let pool = create_postgres_connection(&config).await?;
    
    // Buscar resultados do banco
    let rows = sqlx::query(r#"
        SELECT id, name, config_id, endpoint_method, endpoint_path, 
               request_data, response_data, timestamp, user_account
        FROM test_results 
        WHERE config_id = $1
        ORDER BY timestamp DESC
    "#)
    .bind(&config_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("Failed to fetch test results from PostgreSQL: {}", e))?;
    
    let mut results = Vec::new();
    for row in rows {
        let result = serde_json::json!({
            "id": row.get::<String, &str>("id"),
            "name": row.get::<String, &str>("name"),
            "endpoint": {
                "method": row.get::<String, &str>("endpoint_method"),
                "path": row.get::<String, &str>("endpoint_path"),
                "configId": row.get::<String, &str>("config_id")
            },
            "request": row.get::<serde_json::Value, &str>("request_data"),
            "response": row.get::<serde_json::Value, &str>("response_data"),
            "timestamp": row.get::<chrono::DateTime<chrono::Utc>, &str>("timestamp").to_rfc3339(),
            "userAccount": row.get::<String, &str>("user_account"),
            "storageLocation": "database"
        });
        results.push(result);
    }
    
    Ok(results)
}

async fn generate_new_gcloud_token() -> Result<String, String> {
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
            
            // Executa o comando gcloud diretamente sem mostrar janela CMD
            let mut cmd = Command::new(gcloud_path);
            cmd.args(&["auth", "print-identity-token"]);
            
            // No Windows, criar sem janela de console
            #[cfg(windows)]
            {
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            
            let result = cmd.output().await;
                
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

#[tauri::command]
async fn save_app_data(app: tauri::AppHandle, key: String, value: serde_json::Value) -> Result<(), String> {
    let store_result = tauri_plugin_store::StoreBuilder::new(&app, std::path::PathBuf::from("app-data.json")).build();
    
    match store_result {
        Ok(store) => {
            store.set(&key, value);
            if let Err(e) = store.save() {
                return Err(format!("Failed to save store: {}", e));
            }
            Ok(())
        }
        Err(e) => Err(format!("Failed to create store: {}", e))
    }
}

#[tauri::command]
async fn load_app_data(app: tauri::AppHandle, key: String) -> Result<Option<serde_json::Value>, String> {
    let store_result = tauri_plugin_store::StoreBuilder::new(&app, std::path::PathBuf::from("app-data.json")).build();
    
    match store_result {
        Ok(store) => {
            Ok(store.get(&key).map(|v| v.clone()))
        }
        Err(e) => Err(format!("Failed to create store: {}", e))
    }
}

#[tauri::command]
async fn read_package_json() -> Result<String, String> {
    use std::fs;
    use std::path::Path;
    
    // Caminho relativo a partir do diretório src-tauri
    let package_path = Path::new("../package.json");
    
    match fs::read_to_string(package_path) {
        Ok(content) => Ok(content),
        Err(e) => Err(format!("Failed to read package.json: {}", e))
    }
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
                                    // Aplicar posição salva
                                    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: x as i32, y: y as i32 }));
                                    
                                    // Aplicar tamanho com pequeno ajuste para compensar barras do sistema
                                    let adjusted_width = (width as u32).saturating_sub(16); // Compensar bordas
                                    let adjusted_height = (height as u32).saturating_sub(8); // Compensar bordas
                                    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: adjusted_width, height: adjusted_height }));
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
        .invoke_handler(tauri::generate_handler![
            greet, 
            get_gcloud_token, 
            get_gcloud_account, 
            fetch_openapi_spec, 
            make_test_request, 
            toggle_devtools, 
            save_app_data, 
            load_app_data, 
            read_package_json,
            create_postgres_tables,
            get_postgres_config,
            save_to_postgres, 
            list_postgres_results, 
            save_value_set_to_postgres, 
            list_postgres_value_sets
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
