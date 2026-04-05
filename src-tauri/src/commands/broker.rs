use chrono::Utc;
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tar::Archive;

#[derive(Debug, Serialize, Deserialize)]
pub struct BrokerVersionInfo {
    pub version: String,
    pub download_url: String,
    pub release_notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BrokerManifest {
    pub version: String,
    pub path: String,
    pub installed_at: String,
}

/// Get the kernel directory path for storing broker versions
fn get_kernel_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed_to_get_app_data_dir: {}", e))?;
    Ok(app_data_dir.join("kernel"))
}

/// Get the currently installed broker version
#[tauri::command]
pub async fn get_installed_broker_version(app: AppHandle) -> Result<Option<String>, String> {
    let kernel_dir = get_kernel_dir(&app)?;
    let manifest_path = kernel_dir.join("broker-manifest.json");

    if !manifest_path.exists() {
        return Ok(None);
    }

    let content = tokio::fs::read_to_string(&manifest_path)
        .await
        .map_err(|e| format!("failed_to_read_manifest: {}", e))?;

    let manifest: BrokerManifest =
        serde_json::from_str(&content).map_err(|e| format!("failed_to_parse_manifest: {}", e))?;

    Ok(Some(manifest.version))
}

/// Get the installed broker path
#[tauri::command]
pub async fn get_installed_broker_path(app: AppHandle) -> Result<Option<String>, String> {
    let kernel_dir = get_kernel_dir(&app)?;
    let manifest_path = kernel_dir.join("broker-manifest.json");

    if !manifest_path.exists() {
        return Ok(None);
    }

    let content = tokio::fs::read_to_string(&manifest_path)
        .await
        .map_err(|e| format!("failed_to_read_manifest: {}", e))?;

    let manifest: BrokerManifest =
        serde_json::from_str(&content).map_err(|e| format!("failed_to_parse_manifest: {}", e))?;

    Ok(Some(manifest.path))
}

/// Fetch latest broker release info from GitHub
#[tauri::command]
pub async fn fetch_latest_broker_release() -> Result<BrokerVersionInfo, String> {
    let client = reqwest::Client::builder()
        .user_agent("HexDeck-Updater")
        .build()
        .map_err(|e| format!("failed_to_create_client: {}", e))?;

    let response = client
        .get("https://api.github.com/repos/kaisersong/intent-broker/releases/latest")
        .send()
        .await
        .map_err(|e| format!("failed_to_fetch_release: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "github_api_error: {}",
            response.status()
        ));
    }

    let release: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("failed_to_parse_response: {}", e))?;

    let version = release
        .get("tag_name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim_start_matches('v').to_string())
        .ok_or_else(|| "no_version_found".to_string())?;

    // Find the tarball asset
    let assets = release
        .get("assets")
        .and_then(|a| a.as_array())
        .ok_or_else(|| "no_assets_found".to_string())?;

    let tarball_asset = assets
        .iter()
        .find(|asset| {
            asset
                .get("name")
                .and_then(|n| n.as_str())
                .map(|n| n.ends_with(".tar.gz") && n.contains("intent-broker"))
                .unwrap_or(false)
        })
        .ok_or_else(|| "no_tarball_asset_found".to_string())?;

    let download_url = tarball_asset
        .get("browser_download_url")
        .and_then(|u| u.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "no_download_url_found".to_string())?;

    let release_notes = release
        .get("body")
        .and_then(|b| b.as_str())
        .map(|s| s.to_string());

    Ok(BrokerVersionInfo {
        version,
        download_url,
        release_notes,
    })
}

/// Download and install broker update
#[tauri::command]
pub async fn install_broker_update(
    app: AppHandle,
    download_url: String,
    version: String,
) -> Result<String, String> {
    let kernel_dir = get_kernel_dir(&app)?;
    let version_dir = kernel_dir.join(format!("intent-broker-{}", version));

    // Create directories
    tokio::fs::create_dir_all(&kernel_dir)
        .await
        .map_err(|e| format!("failed_to_create_kernel_dir: {}", e))?;

    // Download tarball
    let client = reqwest::Client::builder()
        .user_agent("HexDeck-Updater")
        .build()
        .map_err(|e| format!("failed_to_create_client: {}", e))?;

    let response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("failed_to_download: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("download_failed: {}", response.status()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("failed_to_read_response: {}", e))?;

    // Extract tarball in a blocking task
    let version_dir_clone = version_dir.clone();
    let kernel_dir_clone = kernel_dir.clone();
    let installed_path = tokio::task::spawn_blocking(move || {
        // Extract to temp location first
        let temp_dir = kernel_dir_clone.join(".temp-extract");
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("failed_to_create_temp_dir: {}", e))?;

        // Extract tarball
        let decoder = GzDecoder::new(&bytes[..]);
        let mut archive = Archive::new(decoder);
        archive
            .unpack(&temp_dir)
            .map_err(|e| format!("failed_to_extract: {}", e))?;

        // Find the extracted directory
        let entries = std::fs::read_dir(&temp_dir)
            .map_err(|e| format!("failed_to_read_temp_dir: {}", e))?;

        let source_dir = entries
            .filter_map(|e| e.ok())
            .find(|e| e.path().is_dir())
            .map(|e| e.path())
            .unwrap_or(temp_dir.clone());

        // Remove existing version if present
        if version_dir_clone.exists() {
            std::fs::remove_dir_all(&version_dir_clone)
                .map_err(|e| format!("failed_to_remove_old_version: {}", e))?;
        }

        // Move to final location
        std::fs::rename(&source_dir, &version_dir_clone)
            .map_err(|e| format!("failed_to_move_extracted: {}", e))?;

        // Cleanup temp
        let _ = std::fs::remove_dir_all(&temp_dir);

        Ok::<String, String>(version_dir_clone.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("task_error: {}", e))??;

    // Write manifest
    let manifest = BrokerManifest {
        version: version.clone(),
        path: installed_path.clone(),
        installed_at: Utc::now().to_rfc3339(),
    };

    let manifest_path = kernel_dir.join("broker-manifest.json");
    tokio::fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .await
    .map_err(|e| format!("failed_to_write_manifest: {}", e))?;

    Ok(installed_path)
}

/// Check if broker is currently running
#[tauri::command]
pub async fn is_broker_running() -> Result<bool, String> {
    // Check if broker heartbeat file exists and is recent
    let heartbeat_path = std::env::var("HOME")
        .map(|h| PathBuf::from(h).join("projects/intent-broker/.tmp/broker.heartbeat.json"))
        .unwrap_or_else(|_| PathBuf::from("/tmp/broker.heartbeat.json"));

    if !heartbeat_path.exists() {
        return Ok(false);
    }

    // Read heartbeat and check timestamp
    let content = tokio::fs::read_to_string(&heartbeat_path)
        .await
        .unwrap_or_default();

    if content.is_empty() {
        return Ok(false);
    }

    // Parse and check if heartbeat is recent (within 30 seconds)
    if let Ok(heartbeat) = serde_json::from_str::<serde_json::Value>(&content) {
        if let Some(timestamp) = heartbeat.get("timestamp").and_then(|t| t.as_str()) {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(timestamp) {
                let now = Utc::now();
                let diff = now.signed_duration_since(dt.with_timezone(&Utc));
                return Ok(diff.num_seconds() < 30);
            }
        }
    }

    Ok(false)
}