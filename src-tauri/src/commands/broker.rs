use chrono::Utc;
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tar::Archive;
use tauri::{AppHandle, Manager};
use tokio::time::{sleep, Duration};

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

#[derive(Debug, Serialize, Deserialize)]
pub struct BrokerStartResult {
    pub already_running: bool,
    pub ready: bool,
    pub pid: Option<u32>,
    pub installed_path: String,
    pub heartbeat_path: String,
    pub stdout_path: String,
    pub stderr_path: String,
    pub log_path: String,
    pub node_path: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone)]
struct BrokerRuntimePaths {
    stdout: PathBuf,
    stderr: PathBuf,
    heartbeat: PathBuf,
}

/// Get the kernel directory path for storing broker versions
fn get_kernel_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed_to_get_app_data_dir: {}", e))?;
    Ok(app_data_dir.join("kernel"))
}

fn get_manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_kernel_dir(app)?.join("broker-manifest.json"))
}

fn get_bootstrap_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_kernel_dir(app)?.join("hexdeck-bootstrap.log"))
}

async fn read_broker_manifest(app: &AppHandle) -> Result<Option<BrokerManifest>, String> {
    let manifest_path = get_manifest_path(app)?;

    if !manifest_path.exists() {
        return Ok(None);
    }

    let content = tokio::fs::read_to_string(&manifest_path)
        .await
        .map_err(|e| format!("failed_to_read_manifest: {}", e))?;

    let manifest: BrokerManifest =
        serde_json::from_str(&content).map_err(|e| format!("failed_to_parse_manifest: {}", e))?;

    Ok(Some(manifest))
}

fn resolve_broker_runtime_paths(installed_path: &PathBuf) -> BrokerRuntimePaths {
    let runtime_root = installed_path.join(".tmp");
    BrokerRuntimePaths {
        stdout: runtime_root.join("broker.stdout.log"),
        stderr: runtime_root.join("broker.stderr.log"),
        heartbeat: runtime_root.join("broker.heartbeat.json"),
    }
}

fn append_bootstrap_log(log_path: &Path, message: &str) {
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "{} {}", Utc::now().to_rfc3339(), message);
    }
}

fn maybe_log(log_path: Option<&Path>, message: &str) {
    if let Some(path) = log_path {
        append_bootstrap_log(path, message);
    }
}

fn resolve_node_binary() -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(node_binary) = env::var("NODE_BINARY") {
        candidates.push(PathBuf::from(node_binary));
    }

    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/opt/homebrew/opt/node/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/usr/bin/node"),
    ]);

    candidates.into_iter().find(|path| path.exists())
}

fn resolve_npm_binary() -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(npm_binary) = env::var("NPM_BINARY") {
        candidates.push(PathBuf::from(npm_binary));
    }

    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/npm"),
        PathBuf::from("/opt/homebrew/opt/node/bin/npm"),
        PathBuf::from("/usr/local/bin/npm"),
        PathBuf::from("/usr/bin/npm"),
    ]);

    candidates.into_iter().find(|path| path.exists())
}

fn build_node_path_env() -> String {
    let mut segments = Vec::new();

    if let Ok(current_path) = env::var("PATH") {
        if !current_path.is_empty() {
            segments.push(current_path);
        }
    }

    for candidate in [
        "/opt/homebrew/bin",
        "/opt/homebrew/opt/node/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
    ] {
        if !segments
            .iter()
            .any(|segment| segment.split(':').any(|part| part == candidate))
        {
            segments.push(candidate.to_string());
        }
    }

    segments.join(":")
}

fn failed_start_result(
    log_path: &Path,
    installed_path: String,
    last_error: String,
) -> BrokerStartResult {
    BrokerStartResult {
        already_running: false,
        ready: false,
        pid: None,
        installed_path,
        heartbeat_path: String::new(),
        stdout_path: String::new(),
        stderr_path: String::new(),
        log_path: log_path.to_string_lossy().to_string(),
        node_path: resolve_node_binary().map(|path| path.to_string_lossy().to_string()),
        last_error: Some(last_error),
    }
}

async fn broker_health_ok(broker_url: &str) -> bool {
    let health_url = format!("{}/health", broker_url.trim_end_matches('/'));
    let response = match reqwest::get(&health_url).await {
        Ok(response) => response,
        Err(_) => return false,
    };

    if !response.status().is_success() {
        return false;
    }

    match response.json::<serde_json::Value>().await {
        Ok(payload) => payload.get("ok").and_then(|value| value.as_bool()) == Some(true),
        Err(_) => false,
    }
}

async fn read_heartbeat(heartbeat_path: &PathBuf) -> Option<serde_json::Value> {
    let content = tokio::fs::read_to_string(heartbeat_path).await.ok()?;
    serde_json::from_str(&content).ok()
}

fn heartbeat_pid(heartbeat: &serde_json::Value) -> Option<u32> {
    heartbeat
        .get("pid")
        .and_then(|value| value.as_u64())
        .map(|value| value as u32)
}

fn heartbeat_is_running(heartbeat: &serde_json::Value, expected_pid: Option<u32>) -> bool {
    let status_ok = heartbeat
        .get("status")
        .and_then(|value| value.as_str())
        .map(|status| status == "running")
        .unwrap_or(false);

    if !status_ok {
        return false;
    }

    match expected_pid {
        Some(pid) => heartbeat_pid(heartbeat) == Some(pid),
        None => true,
    }
}

/// Get the currently installed broker version
#[tauri::command]
pub async fn get_installed_broker_version(app: AppHandle) -> Result<Option<String>, String> {
    Ok(read_broker_manifest(&app)
        .await?
        .map(|manifest| manifest.version))
}

/// Get the installed broker path
#[tauri::command]
pub async fn get_installed_broker_path(app: AppHandle) -> Result<Option<String>, String> {
    Ok(read_broker_manifest(&app)
        .await?
        .map(|manifest| manifest.path))
}

async fn fetch_latest_broker_release_internal(
    log_path: Option<&Path>,
) -> Result<BrokerVersionInfo, String> {
    maybe_log(
        log_path,
        "fetch_latest_broker_release: requesting latest release metadata",
    );

    let api_client = reqwest::Client::builder()
        .user_agent("HexDeck-Updater")
        .build()
        .map_err(|e| format!("failed_to_create_client: {}", e))?;

    let response = api_client
        .get("https://api.github.com/repos/kaisersong/intent-broker/releases/latest")
        .send()
        .await;

    match response {
        Ok(response) if response.status().is_success() => {
            let release: serde_json::Value = response
                .json()
                .await
                .map_err(|e| format!("failed_to_parse_response: {}", e))?;

            let version = release
                .get("tag_name")
                .and_then(|v| v.as_str())
                .map(|s| s.trim_start_matches('v').to_string())
                .ok_or_else(|| "no_version_found".to_string())?;

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

            let info = BrokerVersionInfo {
                version,
                download_url,
                release_notes,
            };

            maybe_log(
                log_path,
                &format!(
                    "fetch_latest_broker_release: resolved version {} via github api",
                    info.version
                ),
            );

            Ok(info)
        }
        Ok(response) => {
            maybe_log(
                log_path,
                &format!(
                    "fetch_latest_broker_release: github api unavailable status={}, falling back to release redirect",
                    response.status()
                ),
            );
            fetch_latest_broker_release_via_redirect(log_path).await
        }
        Err(error) => {
            maybe_log(
                log_path,
                &format!(
                    "fetch_latest_broker_release: github api request failed error={}, falling back to release redirect",
                    error
                ),
            );
            fetch_latest_broker_release_via_redirect(log_path).await
        }
    }
}

async fn fetch_latest_broker_release_via_redirect(
    log_path: Option<&Path>,
) -> Result<BrokerVersionInfo, String> {
    let client = reqwest::Client::builder()
        .user_agent("HexDeck-Updater")
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("failed_to_create_redirect_client: {}", e))?;

    let response = client
        .get("https://github.com/kaisersong/intent-broker/releases/latest")
        .send()
        .await
        .map_err(|e| format!("failed_to_fetch_release_redirect: {}", e))?;

    if !response.status().is_redirection() {
        return Err(format!(
            "release_redirect_unavailable: {}",
            response.status()
        ));
    }

    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "missing_release_redirect_location".to_string())?;

    let tag = location
        .rsplit('/')
        .next()
        .filter(|segment| !segment.is_empty())
        .ok_or_else(|| "missing_release_tag".to_string())?;
    let version = tag.trim_start_matches('v').to_string();
    let download_url = format!(
        "https://codeload.github.com/kaisersong/intent-broker/tar.gz/refs/tags/{}",
        tag
    );

    maybe_log(
        log_path,
        &format!(
            "fetch_latest_broker_release: resolved version {} via release redirect {}",
            version, location
        ),
    );

    Ok(BrokerVersionInfo {
        version,
        download_url,
        release_notes: None,
    })
}

/// Fetch latest broker release info from GitHub
#[tauri::command]
pub async fn fetch_latest_broker_release() -> Result<BrokerVersionInfo, String> {
    fetch_latest_broker_release_internal(None).await
}

async fn ensure_broker_dependencies(
    installed_path: &Path,
    log_path: Option<&Path>,
) -> Result<(), String> {
    let dependency_marker = installed_path.join("node_modules/ws/package.json");
    if dependency_marker.exists() {
        maybe_log(
            log_path,
            &format!(
                "install_broker_update: dependency cache present at {}",
                dependency_marker.display()
            ),
        );
        return Ok(());
    }

    let npm_path = resolve_npm_binary().ok_or_else(|| "failed_to_locate_npm_binary".to_string())?;
    let path_env = build_node_path_env();
    let install_path = installed_path.to_path_buf();
    let npm_path_for_log = npm_path.to_string_lossy().to_string();
    let log_path = log_path.map(Path::to_path_buf);

    maybe_log(
        log_path.as_deref(),
        &format!(
            "install_broker_update: installing npm dependencies with {}",
            npm_path_for_log
        ),
    );

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let output = Command::new(&npm_path)
            .arg("install")
            .arg("--omit=dev")
            .current_dir(&install_path)
            .env("PATH", &path_env)
            .output()
            .map_err(|e| format!("failed_to_run_npm_install: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if let Some(path) = log_path.as_deref() {
                append_bootstrap_log(
                    path,
                    &format!(
                        "install_broker_update: npm install failed status={} stderr={}",
                        output.status,
                        stderr.trim()
                    ),
                );
            }
            return Err(format!(
                "failed_to_install_broker_dependencies: {}",
                stderr.trim()
            ));
        }

        if let Some(path) = log_path.as_deref() {
            append_bootstrap_log(
                path,
                &format!(
                    "install_broker_update: npm dependencies installed in {}",
                    install_path.display()
                ),
            );
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("npm_install_task_error: {}", e))?
}

async fn install_broker_update_internal(
    app: AppHandle,
    download_url: &str,
    version: &str,
    log_path: Option<&Path>,
) -> Result<String, String> {
    let kernel_dir = get_kernel_dir(&app)?;
    let version_dir = kernel_dir.join(format!("intent-broker-{}", version));

    maybe_log(
        log_path,
        &format!(
            "install_broker_update: preparing kernel_dir={} version_dir={}",
            kernel_dir.display(),
            version_dir.display()
        ),
    );

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
        .get(download_url)
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
        let entries =
            std::fs::read_dir(&temp_dir).map_err(|e| format!("failed_to_read_temp_dir: {}", e))?;

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

    ensure_broker_dependencies(Path::new(&installed_path), log_path).await?;

    // Write manifest
    let manifest = BrokerManifest {
        version: version.to_string(),
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

    maybe_log(
        log_path,
        &format!(
            "install_broker_update: installed version={} manifest_path={}",
            version,
            manifest_path.display()
        ),
    );

    Ok(installed_path)
}

/// Download and install broker update
#[tauri::command]
pub async fn install_broker_update(
    app: AppHandle,
    download_url: String,
    version: String,
) -> Result<String, String> {
    install_broker_update_internal(app, &download_url, &version, None).await
}

/// Check if broker is currently running
#[tauri::command]
pub async fn is_broker_running() -> Result<bool, String> {
    Ok(broker_health_ok("http://127.0.0.1:4318").await)
}

async fn start_broker_internal(
    app: AppHandle,
    broker_url: String,
    timeout_ms: u64,
    log_path: Option<&Path>,
) -> Result<BrokerStartResult, String> {
    let manifest = read_broker_manifest(&app)
        .await?
        .ok_or_else(|| "broker_not_installed".to_string())?;
    let installed_path = PathBuf::from(&manifest.path);
    let log_path = match log_path {
        Some(path) => path.to_path_buf(),
        None => get_bootstrap_log_path(&app)?,
    };

    if !installed_path.exists() {
        return Err("installed_broker_path_missing".to_string());
    }

    let runtime_paths = resolve_broker_runtime_paths(&installed_path);
    maybe_log(
        Some(log_path.as_path()),
        &format!(
            "start_broker: installed_path={} broker_url={} heartbeat={} stdout={} stderr={}",
            installed_path.display(),
            broker_url,
            runtime_paths.heartbeat.display(),
            runtime_paths.stdout.display(),
            runtime_paths.stderr.display()
        ),
    );

    if broker_health_ok(&broker_url).await {
        let pid = read_heartbeat(&runtime_paths.heartbeat)
            .await
            .as_ref()
            .and_then(heartbeat_pid);

        maybe_log(
            Some(log_path.as_path()),
            &format!("start_broker: broker already healthy pid={:?}", pid),
        );

        return Ok(BrokerStartResult {
            already_running: true,
            ready: true,
            pid,
            installed_path: manifest.path,
            heartbeat_path: runtime_paths.heartbeat.to_string_lossy().to_string(),
            stdout_path: runtime_paths.stdout.to_string_lossy().to_string(),
            stderr_path: runtime_paths.stderr.to_string_lossy().to_string(),
            log_path: log_path.to_string_lossy().to_string(),
            node_path: resolve_node_binary().map(|path| path.to_string_lossy().to_string()),
            last_error: None,
        });
    }

    tokio::fs::create_dir_all(installed_path.join(".tmp"))
        .await
        .map_err(|e| format!("failed_to_create_broker_runtime_dir: {}", e))?;

    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&runtime_paths.stdout)
        .map_err(|e| format!("failed_to_open_broker_stdout: {}", e))?;
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&runtime_paths.stderr)
        .map_err(|e| format!("failed_to_open_broker_stderr: {}", e))?;

    let node_path =
        resolve_node_binary().ok_or_else(|| "failed_to_locate_node_binary".to_string())?;
    let node_env_path = build_node_path_env();

    maybe_log(
        Some(log_path.as_path()),
        &format!(
            "start_broker: spawning node_path={} path_env={}",
            node_path.display(),
            node_env_path
        ),
    );

    let child = Command::new(&node_path)
        .arg("--experimental-sqlite")
        .arg("src/cli.js")
        .current_dir(&installed_path)
        .env("PATH", &node_env_path)
        .env(
            "INTENT_BROKER_HEARTBEAT_PATH",
            runtime_paths.heartbeat.to_string_lossy().to_string(),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|e| format!("failed_to_start_broker: {}", e))?;

    let pid = child.id();
    drop(child);

    maybe_log(
        Some(log_path.as_path()),
        &format!("start_broker: spawned child pid={}", pid),
    );

    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    let mut ready = false;
    while std::time::Instant::now() < deadline {
        let heartbeat = read_heartbeat(&runtime_paths.heartbeat).await;
        if broker_health_ok(&broker_url).await
            && heartbeat
                .as_ref()
                .map(|payload| heartbeat_is_running(payload, Some(pid)))
                .unwrap_or(false)
        {
            ready = true;
            break;
        }
        sleep(Duration::from_millis(200)).await;
    }

    if ready {
        maybe_log(
            Some(log_path.as_path()),
            &format!("start_broker: broker ready pid={}", pid),
        );
    } else {
        let heartbeat = read_heartbeat(&runtime_paths.heartbeat).await;
        maybe_log(
            Some(log_path.as_path()),
            &format!(
                "start_broker: broker not ready before timeout pid={} health_ok={} heartbeat={}",
                pid,
                broker_health_ok(&broker_url).await,
                heartbeat
                    .map(|payload| payload.to_string())
                    .unwrap_or_else(|| "missing".to_string())
            ),
        );
    }

    Ok(BrokerStartResult {
        already_running: false,
        ready,
        pid: Some(pid),
        installed_path: manifest.path,
        heartbeat_path: runtime_paths.heartbeat.to_string_lossy().to_string(),
        stdout_path: runtime_paths.stdout.to_string_lossy().to_string(),
        stderr_path: runtime_paths.stderr.to_string_lossy().to_string(),
        log_path: log_path.to_string_lossy().to_string(),
        node_path: Some(node_path.to_string_lossy().to_string()),
        last_error: (!ready).then(|| "broker_not_ready_before_timeout".to_string()),
    })
}

#[tauri::command]
pub async fn start_broker(
    app: AppHandle,
    broker_url: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<BrokerStartResult, String> {
    start_broker_internal(
        app,
        broker_url.unwrap_or_else(|| "http://127.0.0.1:4318".to_string()),
        timeout_ms.unwrap_or(15000),
        None,
    )
    .await
}

#[tauri::command]
pub async fn ensure_broker_ready(
    app: AppHandle,
    broker_url: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<BrokerStartResult, String> {
    let broker_url = broker_url.unwrap_or_else(|| "http://127.0.0.1:4318".to_string());
    let timeout_ms = timeout_ms.unwrap_or(15000);
    let log_path = get_bootstrap_log_path(&app)?;
    let manifest_path = get_manifest_path(&app)?;

    append_bootstrap_log(log_path.as_path(), "=== ensure_broker_ready begin ===");
    append_bootstrap_log(
        log_path.as_path(),
        &format!(
            "ensure_broker_ready: broker_url={} manifest_path={}",
            broker_url,
            manifest_path.display()
        ),
    );

    let manifest = match read_broker_manifest(&app).await {
        Ok(manifest) => manifest,
        Err(error) => {
            append_bootstrap_log(
                log_path.as_path(),
                &format!("ensure_broker_ready: manifest read failed error={}", error),
            );
            return Ok(failed_start_result(
                log_path.as_path(),
                String::new(),
                error,
            ));
        }
    };

    let installed_path = match manifest {
        Some(manifest) if PathBuf::from(&manifest.path).exists() => {
            append_bootstrap_log(
                log_path.as_path(),
                &format!(
                    "ensure_broker_ready: using installed broker version={} path={}",
                    manifest.version, manifest.path
                ),
            );
            manifest.path
        }
        Some(manifest) => {
            append_bootstrap_log(
                log_path.as_path(),
                &format!(
                    "ensure_broker_ready: manifest path missing, reinstalling version={} path={}",
                    manifest.version, manifest.path
                ),
            );

            let latest = match fetch_latest_broker_release_internal(Some(log_path.as_path())).await
            {
                Ok(info) => info,
                Err(error) => {
                    append_bootstrap_log(
                        log_path.as_path(),
                        &format!(
                            "ensure_broker_ready: latest release fetch failed error={}",
                            error
                        ),
                    );
                    return Ok(failed_start_result(
                        log_path.as_path(),
                        manifest.path,
                        error,
                    ));
                }
            };

            match install_broker_update_internal(
                app.clone(),
                &latest.download_url,
                &latest.version,
                Some(log_path.as_path()),
            )
            .await
            {
                Ok(path) => path,
                Err(error) => {
                    append_bootstrap_log(
                        log_path.as_path(),
                        &format!("ensure_broker_ready: install failed error={}", error),
                    );
                    return Ok(failed_start_result(
                        log_path.as_path(),
                        manifest.path,
                        error,
                    ));
                }
            }
        }
        None => {
            append_bootstrap_log(
                log_path.as_path(),
                "ensure_broker_ready: no manifest found, installing latest broker",
            );

            let latest = match fetch_latest_broker_release_internal(Some(log_path.as_path())).await
            {
                Ok(info) => info,
                Err(error) => {
                    append_bootstrap_log(
                        log_path.as_path(),
                        &format!(
                            "ensure_broker_ready: latest release fetch failed error={}",
                            error
                        ),
                    );
                    return Ok(failed_start_result(
                        log_path.as_path(),
                        String::new(),
                        error,
                    ));
                }
            };

            match install_broker_update_internal(
                app.clone(),
                &latest.download_url,
                &latest.version,
                Some(log_path.as_path()),
            )
            .await
            {
                Ok(path) => path,
                Err(error) => {
                    append_bootstrap_log(
                        log_path.as_path(),
                        &format!("ensure_broker_ready: install failed error={}", error),
                    );
                    return Ok(failed_start_result(
                        log_path.as_path(),
                        String::new(),
                        error,
                    ));
                }
            }
        }
    };

    match start_broker_internal(app, broker_url, timeout_ms, Some(log_path.as_path())).await {
        Ok(result) => {
            append_bootstrap_log(
                log_path.as_path(),
                &format!(
                    "ensure_broker_ready: completed ready={} pid={:?}",
                    result.ready, result.pid
                ),
            );
            Ok(result)
        }
        Err(error) => {
            append_bootstrap_log(
                log_path.as_path(),
                &format!("ensure_broker_ready: start failed error={}", error),
            );
            Ok(failed_start_result(
                log_path.as_path(),
                installed_path,
                error,
            ))
        }
    }
}
