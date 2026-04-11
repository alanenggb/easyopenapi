use tauri::Manager;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use sqlx::postgres::{PgConnectOptions};
use std::sync::Arc;
use std::collections::HashMap;
use tokio::sync::Mutex;

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

#[derive(Debug, Deserialize, Clone, Serialize)]
struct QueryParam {
    name: String,
    #[serde(rename = "type")]
    param_type: String,
    required: bool,
    default: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
struct CustomEndpoint {
    id: String,
    config_id: String,
    name: String,
    description: Option<String>,
    base_url: String,
    endpoint_path: String,
    method: String,
    query_params: Vec<QueryParam>,
    example_body: Option<String>,
    example_result: Option<String>,
    created_by: String,
}

// Cache de conexões PostgreSQL
#[derive(Clone)]
struct PostgresConnectionCache {
    connections: Arc<Mutex<HashMap<String, PgPool>>>,
}

// Cache de configurações PostgreSQL
#[derive(Clone)]
struct PostgresConfigCache {
    configs: Arc<Mutex<HashMap<String, PostgresConfig>>>,
}

impl PostgresConnectionCache {
    fn new() -> Self {
        Self {
            connections: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    
    async fn clear_cache(&self, secret_name: Option<&str>) {
        let mut connections = self.connections.lock().await;
        match secret_name {
            Some(name) => {
                // Remover conexões que contenham o nome do secret no cache key
                connections.retain(|key, _| !key.contains(&format!("{}:", name)));
                println!("Cleared connection cache for secret: {}", name);
            }
            None => {
                connections.clear();
                println!("Cleared all connection cache");
            }
        }
    }
    
    async fn get_connection(&self, config: &PostgresConfig) -> Result<PgPool, String> {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        
        // Incluir hash da senha no cache key para detectar mudanças de credenciais
        let mut hasher = DefaultHasher::new();
        config.pw.hash(&mut hasher);
        let password_hash = hasher.finish();
        
        let cache_key = format!("{}:{}@{}:{}/{}#{}", config.user, config.host, config.port, config.db, config.schema, password_hash);
        
        let mut connections = self.connections.lock().await;
        
        // Verificar se já existe conexão no cache
        if let Some(pool) = connections.get(&cache_key) {
            // Testar se a conexão ainda está válida
            match sqlx::query("SELECT 1").fetch_one(pool).await {
                Ok(_) => return Ok(pool.clone()),
                Err(e) => {
                    // Conexão inválida, remover do cache
                    connections.remove(&cache_key);
                    println!("Removed invalid connection from cache: {}", e);
                }
            }
        }
        
        // Criar nova conexão
        let options = PgConnectOptions::new()
    .host(&config.host)
    .port(config.port as u16)
    .username(&config.user)
    .password(&config.pw)
    .database(&config.db)
    .options([("search_path", config.schema.as_str())]);

let pool = PgPool::connect_with(options)
    .await
    .map_err(|e| {
        let error_str = e.to_string();
        if error_str.contains("password authentication failed") {
            format!("Falha de autenticação PostgreSQL: usuário '{}' ou senha incorretos para o banco '{}'", config.user, config.db)
        } else if error_str.contains("connection refused") {
            format!("Conexão PostgreSQL recusada: verifique se o servidor está rodando em {}:{}", config.host, config.port)
        } else if error_str.contains("database") && error_str.contains("does not exist") {
            format!("Banco de dados '{}' não existe no servidor PostgreSQL", config.db)
        } else if error_str.contains("timeout") {
            format!("Timeout na conexão PostgreSQL: servidor em {}:{} não respondeu", config.host, config.port)
        } else {
            format!("Erro na conexão PostgreSQL: {}", e)
        }
    })?;
        
        // Adicionar ao cache
        connections.insert(cache_key, pool.clone());
        
        Ok(pool)
    }
}

impl PostgresConfigCache {
    fn new() -> Self {
        Self {
            configs: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    
    async fn get_config(&self, secret_name: &str) -> Result<PostgresConfig, String> {
        let mut configs = self.configs.lock().await;
        
        // Verificar se já existe configuração no cache
        if let Some(config) = configs.get(secret_name) {
            println!("Using cached config for secret: {}", secret_name);
            return Ok(config.clone());
        }
        
        // Buscar configuração do GCP
        println!("Fetching config from GCP for secret: {}", secret_name);
        let config = fetch_postgres_config_from_gcp(secret_name).await?;
        
        // Adicionar ao cache
        configs.insert(secret_name.to_string(), config.clone());
        
        Ok(config)
    }
    
    async fn clear_cache(&self, secret_name: Option<&str>) {
        let mut configs = self.configs.lock().await;
        match secret_name {
            Some(name) => {
                configs.remove(name);
                println!("Cleared cache for secret: {}", name);
            }
            None => {
                configs.clear();
                println!("Cleared all config cache");
            }
        }
    }
}

async fn fetch_postgres_config_from_gcp(secret_name: &str) -> Result<PostgresConfig, String> {
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
                if stderr.contains("NOT_FOUND") || stderr.contains("Secret") {
                    return Err(format!("Secret '{}' not found or access denied", secret_name));
                }
                continue;
            }
        }
        
        return Err(format!(
            "gcloud not found. Checked: {}. Ensure Google Cloud SDK is installed.",
            gcloud_candidates.join(", ")
        ));
    }

    #[cfg(not(target_os = "windows"))]
    {
        use std::env;

        let home = env::var("HOME").unwrap_or_default();
        let full_path = format!(
            "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/google-cloud-sdk/bin:{}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            home
        );

        let gcloud_candidates = vec![
            "/opt/homebrew/bin/gcloud".to_string(),
            "/usr/local/bin/gcloud".to_string(),
            format!("{}/google-cloud-sdk/bin/gcloud", home),
        ];

        let mut diagnostics: Vec<String> = Vec::new();

        for gcloud_path in &gcloud_candidates {
            if !std::path::Path::new(gcloud_path).exists() {
                continue;
            }

            let sh_cmd = format!(
                "PATH=\"{}\" \"{}\" secrets versions access latest --secret={}",
                full_path, gcloud_path, secret_name
            );

            let result = Command::new("/bin/sh")
                .args(&["-c", &sh_cmd])
                .output()
                .await;

            match result {
                Ok(output) if output.status.success() => {
                    let secret_json = String::from_utf8_lossy(&output.stdout);
                    return serde_json::from_str::<PostgresConfig>(&secret_json)
                        .map_err(|e| format!("Failed to parse PostgreSQL config: {}", e));
                }
                Ok(output) => {
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    if stderr.contains("NOT_FOUND") || stderr.contains("Secret") {
                        return Err(format!("Secret '{}' not found or access denied", secret_name));
                    }
                    diagnostics.push(format!(
                        "[{}] exit={} stderr='{}'",
                        gcloud_path,
                        output.status.code().unwrap_or(-1),
                        stderr
                    ));
                }
                Err(e) => {
                    diagnostics.push(format!("[{}] spawn error: {}", gcloud_path, e));
                }
            }
        }

        if diagnostics.is_empty() {
            return Err(format!(
                "gcloud not found. Checked: {}. Ensure Google Cloud SDK is installed.",
                gcloud_candidates.join(", ")
            ));
        } else {
            return Err(format!(
                "gcloud found but failed. Diagnostics: {}",
                diagnostics.join(" | ")
            ));
        }
    }
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
async fn get_postgres_config(secret_name: String, cache: tauri::State<'_, PostgresConfigCache>) -> Result<PostgresConfig, String> {
    cache.get_config(&secret_name).await
}

#[tauri::command]
async fn clear_postgres_config_cache(
    secret_name: Option<String>, 
    cache: tauri::State<'_, PostgresConfigCache>,
    connection_cache: tauri::State<'_, PostgresConnectionCache>
) -> Result<String, String> {
    match &secret_name {
        Some(name) => {
            cache.clear_cache(Some(name)).await;
            connection_cache.clear_cache(Some(name)).await;
            Ok(format!("Cache cleared for secret: {}", name))
        }
        None => {
            cache.clear_cache(None).await;
            connection_cache.clear_cache(None).await;
            Ok("All cache cleared".to_string())
        }
    }
}

#[tauri::command]
async fn create_postgres_tables(secret_name: String, connection_cache: tauri::State<'_, PostgresConnectionCache>, config_cache: tauri::State<'_, PostgresConfigCache>) -> Result<String, String> {
    let config = get_postgres_config(secret_name, config_cache).await?;
    let pool = connection_cache.get_connection(&config).await?;
    
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
    
    // Criar tabela de custom endpoints
    sqlx::query(r#"
        CREATE TABLE IF NOT EXISTS custom_endpoints (
            id VARCHAR(255) PRIMARY KEY,
            config_id VARCHAR(255) NOT NULL,
            name VARCHAR(255) NOT NULL,
            description TEXT,
            base_url VARCHAR(500) NOT NULL,
            endpoint_path VARCHAR(500) NOT NULL,
            method VARCHAR(10) NOT NULL,
            query_params JSONB,
            example_body TEXT,
            example_result TEXT,
            created_by VARCHAR(255) NOT NULL,
            UNIQUE (config_id, base_url, endpoint_path, method)
        )
    "#)
    .execute(&pool)
    .await
    .map_err(|e| format!("Failed to create custom_endpoints table: {}", e))?;
    
    // Criar índice para custom endpoints
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_custom_endpoints_config_id ON custom_endpoints (config_id)")
        .execute(&pool)
        .await
        .map_err(|e| format!("Failed to create custom_endpoints index: {}", e))?;
    
    Ok("PostgreSQL tables created successfully".to_string())
}

#[tauri::command]
async fn save_value_set_to_postgres(
    secret_name: String,
    config_id: String,
    endpoint_method: String,
    endpoint_path: String,
    value_set_data: serde_json::Value,
    connection_cache: tauri::State<'_, PostgresConnectionCache>,
    config_cache: tauri::State<'_, PostgresConfigCache>,
) -> Result<String, String> {
    // Extrair conta do usuário dos dados (com fallback para gcloud atual)
    let user_account = if let Some(account) = value_set_data.get("userAccount").and_then(|v| v.as_str()) {
        account.to_string()
    } else {
        // Fallback: tentar obter do gcloud se não especificado
        get_gcloud_account().await.unwrap_or_else(|_| "unknown".to_string())
    };
    
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
    
    let config = get_postgres_config(secret_name, config_cache).await?;
    let pool = connection_cache.get_connection(&config).await?;
    
    // Inserir ou atualizar value set (baseado no nome único dentro do mesmo endpoint)
    sqlx::query(r#"
        INSERT INTO value_sets (id, name, config_id, endpoint_method, endpoint_path, path_params, query_params, body, user_account)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (name, config_id, endpoint_method, endpoint_path) DO UPDATE SET
            id = EXCLUDED.id,
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
    endpoint_method: Option<String>,
    endpoint_path: Option<String>,
    connection_cache: tauri::State<'_, PostgresConnectionCache>,
    config_cache: tauri::State<'_, PostgresConfigCache>,
) -> Result<Vec<serde_json::Value>, String> {
    // Conectar ao PostgreSQL
    let config = get_postgres_config(secret_name, config_cache).await?;
    let pool = connection_cache.get_connection(&config).await?;

    // Construir query com filtros opcionais
    let query = if endpoint_method.is_some() && endpoint_path.is_some() {
        let method = endpoint_method.as_ref().unwrap();
        let path = endpoint_path.as_ref().unwrap();
        sqlx::query(r#"
            SELECT id, name, config_id, endpoint_method, endpoint_path,
                   path_params, query_params, body, created_at, user_account
            FROM value_sets
            WHERE config_id = $1 AND endpoint_method = $2 AND endpoint_path = $3
            ORDER BY created_at DESC
        "#)
        .bind(&config_id)
        .bind(method)
        .bind(path)
    } else {
        sqlx::query(r#"
            SELECT id, name, config_id, endpoint_method, endpoint_path,
                   path_params, query_params, body, created_at, user_account
            FROM value_sets
            WHERE config_id = $1
            ORDER BY created_at DESC
        "#)
        .bind(&config_id)
    };

    let rows = query
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("Failed to fetch value sets from PostgreSQL: {}", e))?;
    
    let mut results: Vec<serde_json::Value> = Vec::new();
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
    connection_cache: tauri::State<'_, PostgresConnectionCache>,
    config_cache: tauri::State<'_, PostgresConfigCache>,
) -> Result<String, String> {
    // Extrair conta do usuário dos dados (com fallback para gcloud atual)
    let user_account = if let Some(account) = result_data.get("userAccount").and_then(|v| v.as_str()) {
        account.to_string()
    } else {
        // Fallback: tentar obter do gcloud se não especificado
        get_gcloud_account().await.unwrap_or_else(|_| "unknown".to_string())
    };
    
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
    let config = get_postgres_config(secret_name, config_cache).await?;
    let pool = connection_cache.get_connection(&config).await?;
    
    // Inserir ou atualizar resultado (baseado no nome único dentro do mesmo endpoint)
    sqlx::query(r#"
        INSERT INTO test_results (id, name, config_id, endpoint_method, endpoint_path, request_data, response_data, user_account)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (name, config_id, endpoint_method, endpoint_path) DO UPDATE SET
            id = EXCLUDED.id,
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
    connection_cache: tauri::State<'_, PostgresConnectionCache>,
    config_cache: tauri::State<'_, PostgresConfigCache>,
) -> Result<Vec<serde_json::Value>, String> {
    // Conectar ao PostgreSQL
    let config = get_postgres_config(secret_name, config_cache).await?;
    let pool = connection_cache.get_connection(&config).await?;
    
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
    
    let mut results: Vec<serde_json::Value> = Vec::new();
    for row in rows {
        let request_data: Option<serde_json::Value> = row.try_get("request_data").unwrap_or(None);
        let response_data: Option<serde_json::Value> = row.try_get("response_data").unwrap_or(None);
        
        let result = serde_json::json!({
            "id": row.get::<String, &str>("id"),
            "name": row.get::<String, &str>("name"),
            "endpoint": {
                "method": row.get::<String, &str>("endpoint_method"),
                "path": row.get::<String, &str>("endpoint_path"),
                "configId": row.get::<String, &str>("config_id")
            },
            "request": request_data.unwrap_or(serde_json::json!(null)),
            "response": response_data.unwrap_or(serde_json::json!(null)),
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

#[tauri::command]
async fn get_app_version() -> Result<String, String> {
    // Usa a versão do Cargo.toml que é compilada no binário
    // Isso funciona tanto em dev quanto em produção
    let version = env!("CARGO_PKG_VERSION");
    Ok(version.to_string())
}

#[tauri::command]
async fn load_value_set_from_postgres(
    secret_name: String,
    config_id: String,
    value_set_id: String,
    connection_cache: tauri::State<'_, PostgresConnectionCache>,
    config_cache: tauri::State<'_, PostgresConfigCache>,
) -> Result<serde_json::Value, String> {
    let config = get_postgres_config(secret_name, config_cache).await?;
    let pool = connection_cache.get_connection(&config).await?;

    // Buscar value set específico por ID
    let row = sqlx::query(
        r#"SELECT id, name, config_id, endpoint_method, endpoint_path, path_params, query_params, body, created_at, user_account 
         FROM value_sets 
         WHERE id = $1 AND config_id = $2"#
    )
    .bind(&value_set_id)
    .bind(&config_id)
    .fetch_one(&pool)
    .await
    .map_err(|e| format!("Failed to fetch value set from PostgreSQL: {}", e))?;

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

    Ok(value_set)
}

#[tauri::command]
async fn delete_value_set_from_postgres(secret_name: String, config_id: String, method: String, path: String, value_set_id: String, user_account: String, connection_cache: tauri::State<'_, PostgresConnectionCache>, config_cache: tauri::State<'_, PostgresConfigCache>) -> Result<bool, String> {
    let config = get_postgres_config(secret_name, config_cache).await?;
    let pool = connection_cache.get_connection(&config).await?;

    // Verificar se o usuário é o criador do conjunto de valores
    let row = sqlx::query(
        r#"SELECT id, name, config_id, endpoint_method, endpoint_path, path_params, query_params, body, created_at, user_account 
         FROM value_sets 
         WHERE id = $1 AND config_id = $2 AND endpoint_method = $3 AND endpoint_path = $4"#
    )
    .bind(&value_set_id)
    .bind(&config_id)
    .bind(&method)
    .bind(&path)
    .fetch_one(&pool)
    .await
    .map_err(|e| format!("Erro ao buscar conjunto de valores: {}", e))?;

    let record = ValueSetRecord {
        id: row.get("id"),
        name: row.get("name"),
        config_id: row.get("config_id"),
        endpoint_method: row.get("endpoint_method"),
        endpoint_path: row.get("endpoint_path"),
        path_params: row.get("path_params"),
        query_params: row.get("query_params"),
        body: row.get("body"),
        created_at: row.get("created_at"),
        user_account: row.get("user_account"),
    };

    // Verificar se o usuário atual é o criador
    if record.user_account != user_account {
        return Err("Você não tem permissão para excluir este conjunto de valores.".to_string());
    }

    // Excluir o conjunto de valores
    let result = sqlx::query("DELETE FROM value_sets WHERE id = $1")
        .bind(&value_set_id)
        .execute(&pool)
        .await
        .map_err(|e| format!("Erro ao excluir conjunto de valores: {}", e))?;

    Ok(result.rows_affected() > 0)
}

#[tauri::command]
async fn delete_test_result_from_postgres(secret_name: String, config_id: String, result_id: String, user_account: String, connection_cache: tauri::State<'_, PostgresConnectionCache>, config_cache: tauri::State<'_, PostgresConfigCache>) -> Result<bool, String> {
    let config = get_postgres_config(secret_name, config_cache).await?;
    let pool = connection_cache.get_connection(&config).await?;

    // Verificar se o usuário é o criador do resultado
    let row = sqlx::query(
        r#"SELECT id, name, config_id, endpoint_method, endpoint_path, request_data, response_data, timestamp, user_account 
         FROM test_results 
         WHERE id = $1 AND config_id = $2"#
    )
    .bind(&result_id)
    .bind(&config_id)
    .fetch_one(&pool)
    .await
    .map_err(|e| format!("Erro ao buscar resultado de teste: {}", e))?;

    let record = TestResultRecord {
        id: row.get("id"),
        name: row.get("name"),
        config_id: row.get("config_id"),
        endpoint_method: row.get("endpoint_method"),
        endpoint_path: row.get("endpoint_path"),
        request_data: row.get("request_data"),
        response_data: row.get("response_data"),
        timestamp: row.get("timestamp"),
        user_account: row.get("user_account"),
    };

    // Verificar se o usuário atual é o criador
    if record.user_account != user_account {
        return Err("Você não tem permissão para excluir este resultado de teste.".to_string());
    }

    // Excluir o resultado de teste
    let result = sqlx::query("DELETE FROM test_results WHERE id = $1")
        .bind(&result_id)
        .execute(&pool)
        .await
        .map_err(|e| format!("Erro ao excluir resultado de teste: {}", e))?;

    Ok(result.rows_affected() > 0)
}

#[tauri::command]
async fn save_custom_endpoint(
    config_id: String,
    endpoint_data: serde_json::Value,
    connection_cache: tauri::State<'_, PostgresConnectionCache>,
    config_cache: tauri::State<'_, PostgresConfigCache>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    // Extrair dados do endpoint
    let name = endpoint_data.get("name")
        .and_then(|v| v.as_str())
        .ok_or("Name is required")?
        .to_string();
    
    let base_url = endpoint_data.get("base_url")
        .and_then(|v| v.as_str())
        .ok_or("Base URL is required")?
        .to_string();
    
    let endpoint_path = endpoint_data.get("endpoint_path")
        .and_then(|v| v.as_str())
        .ok_or("Endpoint path is required")?
        .to_string();
    
    let method = endpoint_data.get("method")
        .and_then(|v| v.as_str())
        .ok_or("Method is required")?
        .to_string();
    
    let description = endpoint_data.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());
    let query_params = endpoint_data.get("query_params").cloned().unwrap_or(serde_json::json!([]));
    let example_body = endpoint_data.get("example_body").and_then(|v| v.as_str()).map(|s| s.to_string());
    let example_result = endpoint_data.get("example_result").and_then(|v| v.as_str()).map(|s| s.to_string());
    
    // Obter conta do usuário
    let created_by = get_gcloud_account().await.unwrap_or_else(|_| "unknown".to_string());
    
    let new_uuid = uuid::Uuid::new_v4().to_string();
    let endpoint_id = endpoint_data.get("id")
        .and_then(|v| v.as_str())
        .unwrap_or(&new_uuid)
        .to_string();
    
    // Verificar se config tem databaseName para decidir onde salvar
    let config_data = load_app_data_sync(&app, "openapiui-configurations")?;
    let configs: Vec<serde_json::Value> = serde_json::from_value(config_data).unwrap_or_default();
    let config = configs.iter()
        .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(&config_id));
    
    let database_name = config
        .and_then(|c| c.get("databaseName").and_then(|v| v.as_str()))
        .or_else(|| config.and_then(|c| c.get("gcpSecretName").and_then(|v| v.as_str())));
    
    if let Some(db_name) = database_name {
        // Salvar no banco de dados
        let pg_config = get_postgres_config(db_name.to_string(), config_cache).await?;
        let pool = connection_cache.get_connection(&pg_config).await?;
        
        // Verificar duplicidade
        let existing = sqlx::query(
            r#"SELECT id FROM custom_endpoints 
             WHERE config_id = $1 AND base_url = $2 AND endpoint_path = $3 AND method = $4"#
        )
        .bind(&config_id)
        .bind(&base_url)
        .bind(&endpoint_path)
        .bind(&method)
        .fetch_optional(&pool)
        .await
        .map_err(|e| format!("Failed to check for duplicate endpoint: {}", e))?;
        
        if existing.is_some() {
            return Err("Já existe um endpoint com a mesma combinação de base_url, endpoint_path e method nesta configuração.".to_string());
        }
        
        sqlx::query(r#"
            INSERT INTO custom_endpoints (id, config_id, name, description, base_url, endpoint_path, method, query_params, example_body, example_result, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        "#)
        .bind(&endpoint_id)
        .bind(&config_id)
        .bind(&name)
        .bind(&description)
        .bind(&base_url)
        .bind(&endpoint_path)
        .bind(&method)
        .bind(&query_params)
        .bind(&example_body)
        .bind(&example_result)
        .bind(&created_by)
        .execute(&pool)
        .await
        .map_err(|e| format!("Failed to save custom endpoint to PostgreSQL: {}", e))?;
    } else {
        // Salvar localmente
        let endpoints_data = load_app_data_sync(&app, "openapiui-custom-endpoints")?;
        let mut endpoints: serde_json::Value = if endpoints_data.is_null() {
            serde_json::json!({})
        } else {
            endpoints_data
        };
        
        let config_id_clone = config_id.clone();
        let config_endpoints = if let Some(arr) = endpoints.get_mut(&config_id_clone).and_then(|v| v.as_array_mut()) {
            arr
        } else {
            endpoints[&config_id_clone] = serde_json::json!([]);
            endpoints.get_mut(&config_id_clone).and_then(|v| v.as_array_mut()).unwrap()
        };
        
        // Verificar duplicidade
        for endpoint in config_endpoints.iter() {
            if endpoint.get("base_url").and_then(|v| v.as_str()) == Some(&base_url)
                && endpoint.get("endpoint_path").and_then(|v| v.as_str()) == Some(&endpoint_path)
                && endpoint.get("method").and_then(|v| v.as_str()) == Some(&method)
            {
                return Err("Já existe um endpoint com a mesma combinação de base_url, endpoint_path e method nesta configuração.".to_string());
            }
        }
        
        let new_endpoint = serde_json::json!({
            "id": endpoint_id,
            "config_id": config_id,
            "name": name,
            "description": description,
            "base_url": base_url,
            "endpoint_path": endpoint_path,
            "method": method,
            "query_params": query_params,
            "example_body": example_body,
            "example_result": example_result,
            "created_by": created_by
        });
        
        config_endpoints.push(new_endpoint);
        
        save_app_data_sync(&app, "openapiui-custom-endpoints", endpoints)?;
    }
    
    Ok(endpoint_id)
}

#[tauri::command]
async fn list_custom_endpoints(
    config_id: String,
    connection_cache: tauri::State<'_, PostgresConnectionCache>,
    config_cache: tauri::State<'_, PostgresConfigCache>,
    app: tauri::AppHandle,
) -> Result<Vec<serde_json::Value>, String> {
    let mut all_endpoints: Vec<serde_json::Value> = vec![];
    
    // Verificar se config tem databaseName
    let config_data = load_app_data_sync(&app, "openapiui-configurations")?;
    let configs: Vec<serde_json::Value> = serde_json::from_value(config_data).unwrap_or_default();
    let config = configs.iter()
        .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(&config_id));
    
    let database_name = config
        .and_then(|c| c.get("databaseName").and_then(|v| v.as_str()))
        .or_else(|| config.and_then(|c| c.get("gcpSecretName").and_then(|v| v.as_str())));
    
    if let Some(db_name) = database_name {
        // Carregar do banco de dados
        let pg_config = get_postgres_config(db_name.to_string(), config_cache).await?;
        let pool = connection_cache.get_connection(&pg_config).await?;
        
        let rows = sqlx::query(
            r#"SELECT id, config_id, name, description, base_url, endpoint_path, method, query_params, example_body, example_result, created_by
             FROM custom_endpoints 
             WHERE config_id = $1"#
        )
        .bind(&config_id)
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("Failed to fetch custom endpoints from PostgreSQL: {}", e))?;
        
        for row in rows {
            let endpoint = serde_json::json!({
                "id": row.get::<String, &str>("id"),
                "config_id": row.get::<String, &str>("config_id"),
                "name": row.get::<String, &str>("name"),
                "description": row.get::<Option<String>, &str>("description"),
                "base_url": row.get::<String, &str>("base_url"),
                "endpoint_path": row.get::<String, &str>("endpoint_path"),
                "method": row.get::<String, &str>("method"),
                "query_params": row.get::<serde_json::Value, &str>("query_params"),
                "example_body": row.get::<Option<String>, &str>("example_body"),
                "example_result": row.get::<Option<String>, &str>("example_result"),
                "created_by": row.get::<String, &str>("created_by")
            });
            all_endpoints.push(endpoint);
        }
    }
    
    // Carregar do armazenamento local
    let endpoints_data = load_app_data_sync(&app, "openapiui-custom-endpoints")?;
    if !endpoints_data.is_null() {
        if let Some(config_endpoints) = endpoints_data.get(&config_id).and_then(|v| v.as_array()) {
            all_endpoints.extend(config_endpoints.clone());
        }
    }
    
    Ok(all_endpoints)
}

#[tauri::command]
async fn delete_custom_endpoint(
    config_id: String,
    endpoint_id: String,
    current_user: String,
    connection_cache: tauri::State<'_, PostgresConnectionCache>,
    config_cache: tauri::State<'_, PostgresConfigCache>,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    // Verificar se config tem databaseName
    let config_data = load_app_data_sync(&app, "openapiui-configurations")?;
    let configs: Vec<serde_json::Value> = serde_json::from_value(config_data).unwrap_or_default();
    let config = configs.iter()
        .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(&config_id));
    
    let database_name = config
        .and_then(|c| c.get("databaseName").and_then(|v| v.as_str()))
        .or_else(|| config.and_then(|c| c.get("gcpSecretName").and_then(|v| v.as_str())));
    
    let mut deleted = false;
    
    if let Some(db_name) = database_name {
        // Deletar do banco de dados
        let pg_config = get_postgres_config(db_name.to_string(), config_cache).await?;
        let pool = connection_cache.get_connection(&pg_config).await?;
        
        // Verificar se o usuário é o criador
        let row = sqlx::query(
            r#"SELECT id, created_by FROM custom_endpoints 
             WHERE id = $1 AND config_id = $2"#
        )
        .bind(&endpoint_id)
        .bind(&config_id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| format!("Failed to fetch custom endpoint: {}", e))?;
        
        if let Some(row) = row {
            let created_by = row.get::<String, &str>("created_by");
            if created_by != current_user {
                return Err("Você não tem permissão para excluir este endpoint.".to_string());
            }
            
            let result = sqlx::query("DELETE FROM custom_endpoints WHERE id = $1")
                .bind(&endpoint_id)
                .execute(&pool)
                .await
                .map_err(|e| format!("Failed to delete custom endpoint: {}", e))?;
            
            deleted = result.rows_affected() > 0;
        }
    }
    
    // Deletar do armazenamento local
    let mut endpoints_data = load_app_data_sync(&app, "openapiui-custom-endpoints")?;
    if !endpoints_data.is_null() {
        if let Some(config_endpoints) = endpoints_data.get_mut(&config_id) {
            if let Some(endpoints_array) = config_endpoints.as_array_mut() {
                let original_len = endpoints_array.len();
                endpoints_array.retain(|endpoint| {
                    endpoint.get("id").and_then(|v| v.as_str()) != Some(&endpoint_id)
                        || endpoint.get("created_by").and_then(|v| v.as_str()) != Some(&current_user)
                });
                
                if endpoints_array.len() < original_len {
                    deleted = true;
                    save_app_data_sync(&app, "openapiui-custom-endpoints", endpoints_data)?;
                }
            }
        }
    }
    
    Ok(deleted)
}

#[tauri::command]
async fn update_custom_endpoint(
    config_id: String,
    endpoint_id: String,
    endpoint_data: serde_json::Value,
    connection_cache: tauri::State<'_, PostgresConnectionCache>,
    config_cache: tauri::State<'_, PostgresConfigCache>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let base_url = endpoint_data.get("base_url")
        .and_then(|v| v.as_str())
        .ok_or("Base URL is required")?
        .to_string();
    
    let endpoint_path = endpoint_data.get("endpoint_path")
        .and_then(|v| v.as_str())
        .ok_or("Endpoint path is required")?
        .to_string();
    
    let method = endpoint_data.get("method")
        .and_then(|v| v.as_str())
        .ok_or("Method is required")?
        .to_string();
    
    // Verificar se config tem databaseName
    let config_data = load_app_data_sync(&app, "openapiui-configurations")?;
    let configs: Vec<serde_json::Value> = serde_json::from_value(config_data).unwrap_or_default();
    let config = configs.iter()
        .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(&config_id));
    
    let database_name = config
        .and_then(|c| c.get("databaseName").and_then(|v| v.as_str()))
        .or_else(|| config.and_then(|c| c.get("gcpSecretName").and_then(|v| v.as_str())));
    
    if let Some(db_name) = database_name {
        // Atualizar no banco de dados
        let pg_config = get_postgres_config(db_name.to_string(), config_cache).await?;
        let pool = connection_cache.get_connection(&pg_config).await?;
        
        // Verificar duplicidade (excluindo o endpoint atual)
        let existing = sqlx::query(
            r#"SELECT id FROM custom_endpoints 
             WHERE config_id = $1 AND base_url = $2 AND endpoint_path = $3 AND method = $4 AND id != $5"#
        )
        .bind(&config_id)
        .bind(&base_url)
        .bind(&endpoint_path)
        .bind(&method)
        .bind(&endpoint_id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| format!("Failed to check for duplicate endpoint: {}", e))?;
        
        if existing.is_some() {
            return Err("Já existe um endpoint com a mesma combinação de base_url, endpoint_path e method nesta configuração.".to_string());
        }
        
        sqlx::query(r#"
            UPDATE custom_endpoints
            SET name = $1, description = $2, base_url = $3, endpoint_path = $4, method = $5, 
                query_params = $6, example_body = $7, example_result = $8
            WHERE id = $9 AND config_id = $10
        "#)
        .bind(endpoint_data.get("name").and_then(|v| v.as_str()).unwrap_or(""))
        .bind(endpoint_data.get("description").and_then(|v| v.as_str()))
        .bind(&base_url)
        .bind(&endpoint_path)
        .bind(&method)
        .bind(endpoint_data.get("query_params").cloned().unwrap_or(serde_json::json!([])))
        .bind(endpoint_data.get("example_body").and_then(|v| v.as_str()))
        .bind(endpoint_data.get("example_result").and_then(|v| v.as_str()))
        .bind(&endpoint_id)
        .bind(&config_id)
        .execute(&pool)
        .await
        .map_err(|e| format!("Failed to update custom endpoint: {}", e))?;
    } else {
        // Atualizar no armazenamento local
        let mut endpoints_data = load_app_data_sync(&app, "openapiui-custom-endpoints")?;
        if !endpoints_data.is_null() {
            if let Some(config_endpoints) = endpoints_data.get_mut(&config_id) {
                if let Some(endpoints_array) = config_endpoints.as_array_mut() {
                    // Verificar duplicidade com outros endpoints (coletar antes de mutar)
                    let has_duplicate = endpoints_array.iter().any(|other| {
                        other.get("id").and_then(|v| v.as_str()) != Some(&endpoint_id)
                            && other.get("base_url").and_then(|v| v.as_str()) == Some(&base_url)
                            && other.get("endpoint_path").and_then(|v| v.as_str()) == Some(&endpoint_path)
                            && other.get("method").and_then(|v| v.as_str()) == Some(&method)
                    });
                    
                    if has_duplicate {
                        return Err("Já existe um endpoint com a mesma combinação de base_url, endpoint_path e method nesta configuração.".to_string());
                    }
                    
                    for endpoint in endpoints_array.iter_mut() {
                        if endpoint.get("id").and_then(|v| v.as_str()) == Some(&endpoint_id) {
                            // Atualizar campos
                            if let Some(name) = endpoint_data.get("name").and_then(|v| v.as_str()) {
                                endpoint["name"] = serde_json::Value::String(name.to_string());
                            }
                            if let Some(desc) = endpoint_data.get("description").and_then(|v| v.as_str()) {
                                endpoint["description"] = serde_json::Value::String(desc.to_string());
                            }
                            endpoint["base_url"] = serde_json::Value::String(base_url.clone());
                            endpoint["endpoint_path"] = serde_json::Value::String(endpoint_path.clone());
                            endpoint["method"] = serde_json::Value::String(method.clone());
                            if let Some(qp) = endpoint_data.get("query_params") {
                                endpoint["query_params"] = qp.clone();
                            }
                            if let Some(eb) = endpoint_data.get("example_body").and_then(|v| v.as_str()) {
                                endpoint["example_body"] = serde_json::Value::String(eb.to_string());
                            }
                            if let Some(er) = endpoint_data.get("example_result").and_then(|v| v.as_str()) {
                                endpoint["example_result"] = serde_json::Value::String(er.to_string());
                            }
                            
                            save_app_data_sync(&app, "openapiui-custom-endpoints", endpoints_data)?;
                            break;
                        }
                    }
                }
            }
        }
    }
    
    Ok(endpoint_id)
}

#[tauri::command]
async fn delete_config(
    config_id: String,
    current_user: String,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    let config_data = load_app_data_sync(&app, "openapiui-configurations")?;
    let mut configs: Vec<serde_json::Value> = serde_json::from_value(config_data).unwrap_or_default();
    
    let config_index = configs.iter()
        .position(|c| c.get("id").and_then(|v| v.as_str()) == Some(&config_id));
    
    if let Some(index) = config_index {
        let config = &configs[index];
        
        // Verificar se o usuário é o criador (ou se não há created_by para backward compatibility)
        let created_by = config.get("created_by").and_then(|v| v.as_str());
        if let Some(creator) = created_by {
            if creator != current_user {
                return Err("Você não tem permissão para excluir esta configuração.".to_string());
            }
        }
        
        configs.remove(index);
        
        let new_config_data = serde_json::to_value(&configs).unwrap();
        save_app_data_sync(&app, "openapiui-configurations", new_config_data)?;
        
        Ok(true)
    } else {
        Err("Configuração não encontrada.".to_string())
    }
}

// Helper functions for app data sync
fn load_app_data_sync(app: &tauri::AppHandle, key: &str) -> Result<serde_json::Value, String> {
    use tauri_plugin_store::StoreBuilder;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    
    let (tx, rx) = std::sync::mpsc::channel();
    let tx = Arc::new(Mutex::new(tx));
    let app_handle = app.clone();
    let key = key.to_string();
    
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(async {
            let store = StoreBuilder::new(&app_handle, std::path::PathBuf::from("app-data.json")).build();
            match store {
                Ok(s) => {
                    let data = s.get(&key);
                    Ok(data)
                }
                Err(e) => Err(format!("Failed to load store: {:?}", e))
            }
        });
        
        let _ = tx.lock().unwrap().send(result);
    });
    
    let result = rx.recv_timeout(Duration::from_secs(5))
        .map_err(|e| format!("Timeout loading app data: {}", e))?;
    
    match result {
        Ok(Some(data)) => Ok(data),
        Ok(None) => Ok(serde_json::Value::Null),
        Err(e) => Err(format!("Error loading app data: {:?}", e)),
    }
}

fn save_app_data_sync(app: &tauri::AppHandle, key: &str, value: serde_json::Value) -> Result<(), String> {
    use tauri_plugin_store::StoreBuilder;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    
    let (tx, rx) = std::sync::mpsc::channel();
    let tx = Arc::new(Mutex::new(tx));
    let app_handle = app.clone();
    let key = key.to_string();
    
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(async {
            let mut store = StoreBuilder::new(&app_handle, std::path::PathBuf::from("app-data.json")).build();
            match store {
                Ok(ref mut s) => {
                    s.set(&key, value);
                    let _ = s.save();
                    Ok(())
                }
                Err(e) => Err(format!("Failed to load store: {:?}", e))
            }
        });
        
        let _ = tx.lock().unwrap().send(result);
    });
    
    let result = rx.recv_timeout(Duration::from_secs(5))
        .map_err(|e| format!("Timeout saving app data: {}", e))?;
    
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            
            // Inicializar cache de conexões PostgreSQL
            let postgres_cache = PostgresConnectionCache::new();
            app.manage(postgres_cache);
            
            // Inicializar cache de configurações PostgreSQL
            let postgres_config_cache = PostgresConfigCache::new();
            app.manage(postgres_config_cache);
            
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
            get_app_version,
            create_postgres_tables,
            get_postgres_config,
            clear_postgres_config_cache,
            save_to_postgres, 
            list_postgres_results, 
            save_value_set_to_postgres, 
            list_postgres_value_sets,
            load_value_set_from_postgres,
            delete_value_set_from_postgres,
            delete_test_result_from_postgres,
            save_custom_endpoint,
            list_custom_endpoints,
            delete_custom_endpoint,
            update_custom_endpoint,
            delete_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
