use chrono::{DateTime, Utc};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tar::Archive;

const BROKER_PORT: u16 = 4318;
const BROKER_HOST: &str = "127.0.0.1";
const BROKER_REPO_URL: &str = "https://github.com/kaisersong/intent-broker.git";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerRuntimeStatus {
    pub installed: bool,
    pub running: bool,
    pub healthy: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub heartbeat_path: Option<String>,
    pub stdout_path: Option<String>,
    pub stderr_path: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug)]
struct BrokerRuntimePaths {
    repo_path: PathBuf,
    heartbeat: PathBuf,
    stdout: PathBuf,
    stderr: PathBuf,
}

#[derive(Debug)]
struct BrokerHeartbeatState {
    status: Option<String>,
    updated_at: Option<String>,
    error_message: Option<String>,
}

fn broker_url() -> String {
    format!("http://{BROKER_HOST}:{BROKER_PORT}")
}

#[cfg(windows)]
fn node_command() -> &'static str {
    "node.exe"
}

#[cfg(not(windows))]
fn node_command() -> &'static str {
    "node"
}

#[cfg(windows)]
fn npm_command() -> &'static str {
    "npm.cmd"
}

#[cfg(not(windows))]
fn npm_command() -> &'static str {
    "npm"
}

#[cfg(windows)]
fn git_command() -> &'static str {
    "git.exe"
}

#[cfg(not(windows))]
fn git_command() -> &'static str {
    "git"
}

fn get_kernel_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed_to_get_app_data_dir: {e}"))?;
    Ok(app_data_dir.join("kernel"))
}

fn get_manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(get_kernel_dir(app)?.join("broker-manifest.json"))
}

async fn load_manifest(app: &AppHandle) -> Result<Option<BrokerManifest>, String> {
    let manifest_path = get_manifest_path(app)?;
    if !manifest_path.exists() {
        return Ok(None);
    }

    let content = tokio::fs::read_to_string(&manifest_path)
        .await
        .map_err(|e| format!("failed_to_read_manifest: {e}"))?;

    let manifest: BrokerManifest =
        serde_json::from_str(&content).map_err(|e| format!("failed_to_parse_manifest: {e}"))?;

    Ok(Some(manifest))
}

async fn save_manifest(app: &AppHandle, path: &Path, version: &str) -> Result<(), String> {
    let manifest = BrokerManifest {
        version: version.to_string(),
        path: path.to_string_lossy().to_string(),
        installed_at: Utc::now().to_rfc3339(),
    };

    let manifest_path = get_manifest_path(app)?;
    tokio::fs::create_dir_all(
        manifest_path
            .parent()
            .ok_or_else(|| "invalid_manifest_parent".to_string())?,
    )
    .await
    .map_err(|e| format!("failed_to_create_kernel_dir: {e}"))?;
    tokio::fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest).map_err(|e| format!("failed_to_encode_manifest: {e}"))?,
    )
    .await
    .map_err(|e| format!("failed_to_write_manifest: {e}"))?;

    Ok(())
}

async fn resolve_broker_repo_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(manifest) = load_manifest(app).await? {
        let path = PathBuf::from(&manifest.path);
        if path.exists() {
            return Ok(path);
        }
    }

    Ok(get_kernel_dir(app)?.join("intent-broker"))
}

fn broker_runtime_paths(repo_path: &Path) -> BrokerRuntimePaths {
    let runtime_dir = repo_path.join(".tmp");
    BrokerRuntimePaths {
        repo_path: repo_path.to_path_buf(),
        heartbeat: runtime_dir.join("broker.heartbeat.json"),
        stdout: runtime_dir.join("broker.stdout.log"),
        stderr: runtime_dir.join("broker.stderr.log"),
    }
}

fn parse_recent_timestamp(timestamp: Option<&str>, max_age_seconds: i64) -> bool {
    let Some(timestamp) = timestamp else {
        return false;
    };

    let Ok(parsed) = DateTime::parse_from_rfc3339(timestamp) else {
        return false;
    };

    let age = Utc::now().signed_duration_since(parsed.with_timezone(&Utc));
    age.num_seconds() <= max_age_seconds
}

fn load_heartbeat_state(path: &Path) -> BrokerHeartbeatState {
    let value = std::fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok());

    BrokerHeartbeatState {
        status: value
            .as_ref()
            .and_then(|item| item.get("status"))
            .and_then(|item| item.as_str())
            .map(str::to_string),
        updated_at: value
            .as_ref()
            .and_then(|item| item.get("updatedAt"))
            .and_then(|item| item.as_str())
            .map(str::to_string),
        error_message: value
            .as_ref()
            .and_then(|item| item.get("error"))
            .and_then(|item| item.get("message"))
            .and_then(|item| item.as_str())
            .map(str::to_string),
    }
}

fn heartbeat_indicates_running(path: &Path) -> bool {
    let heartbeat = load_heartbeat_state(path);
    matches!(
        heartbeat.status.as_deref(),
        Some("starting") | Some("running")
    ) && parse_recent_timestamp(heartbeat.updated_at.as_deref(), 20)
}

async fn probe_broker_health() -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_millis(900))
        .build()
    else {
        return false;
    };

    let Ok(response) = client.get(format!("{}/health", broker_url())).send().await else {
        return false;
    };

    if !response.status().is_success() {
        return false;
    }

    let Ok(payload) = response.json::<serde_json::Value>().await else {
        return false;
    };

    payload
        .get("ok")
        .and_then(|value| value.as_bool())
        .unwrap_or_else(|| {
            payload
                .get("status")
                .and_then(|value| value.as_str())
                .map(|value| matches!(value, "ok" | "healthy" | "live"))
                .unwrap_or(false)
        })
}

fn run_command_capture(program: &str, args: &[&str], cwd: Option<&Path>) -> Result<String, String> {
    let mut command = Command::new(program);
    command.args(args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }

    let output = command
        .output()
        .map_err(|e| format!("failed_to_run_{program}: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("{program}_failed")
        } else {
            stderr
        })
    }
}

fn run_command_status(program: &str, args: &[&str], cwd: Option<&Path>) -> Result<(), String> {
    run_command_capture(program, args, cwd).map(|_| ())
}

fn path_exists(path: &Path, relative: &str) -> bool {
    path.join(relative).exists()
}

fn detect_repo_version(repo_path: &Path) -> Option<String> {
    run_command_capture(git_command(), &["describe", "--tags", "--always"], Some(repo_path))
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::fs::read_to_string(repo_path.join("package.json"))
                .ok()
                .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
                .and_then(|value| value.get("version").and_then(|item| item.as_str()).map(str::to_string))
        })
}

fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
}

fn ensure_broker_repo_cloned(repo_path: &Path) -> Result<(), String> {
    if repo_path.join("package.json").exists() {
        return Ok(());
    }

    if repo_path.exists() {
        std::fs::remove_dir_all(repo_path)
            .map_err(|e| format!("failed_to_remove_invalid_broker_dir: {e}"))?;
    }

    if let Some(parent) = repo_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed_to_create_broker_parent: {e}"))?;
    }

    let repo_path_string = repo_path.to_string_lossy().to_string();
    run_command_status(
        git_command(),
        &["clone", "--depth", "1", BROKER_REPO_URL, &repo_path_string],
        None,
    )
}

fn ensure_broker_dependencies(repo_path: &Path) -> Result<(), String> {
    if path_exists(repo_path, "node_modules/ws/package.json") {
        return Ok(());
    }

    run_command_status(npm_command(), &["--version"], None)?;
    run_command_status(npm_command(), &["install", "--no-fund", "--no-audit"], Some(repo_path))
}

fn install_codex_bridge(repo_path: &Path) -> Result<(), String> {
    let Some(home_dir) = user_home_dir() else {
        return Ok(());
    };

    if !home_dir.join(".codex").exists() {
        return Ok(());
    }

    run_command_status(
        node_command(),
        &["adapters/codex-plugin/bin/codex-broker.js", "install"],
        Some(repo_path),
    )
}

fn install_claude_bridge(repo_path: &Path) -> Result<(), String> {
    let Some(home_dir) = user_home_dir() else {
        return Ok(());
    };

    if !home_dir.join(".claude").exists() {
        return Ok(());
    }

    run_command_status(
        node_command(),
        &["adapters/claude-code-plugin/bin/claude-code-broker.js", "install"],
        Some(repo_path),
    )
}

async fn ensure_broker_files(app: &AppHandle) -> Result<PathBuf, String> {
    let repo_path = resolve_broker_repo_path(app).await?;

    run_command_status(node_command(), &["--version"], None)?;

    if !repo_path.join("package.json").exists() {
        run_command_status(git_command(), &["--version"], None)?;
    }

    ensure_broker_repo_cloned(&repo_path)?;
    ensure_broker_dependencies(&repo_path)?;
    let _ = install_codex_bridge(&repo_path);
    let _ = install_claude_bridge(&repo_path);

    let version = detect_repo_version(&repo_path).unwrap_or_else(|| "source".to_string());
    save_manifest(app, &repo_path, &version).await?;

    Ok(repo_path)
}

fn spawn_broker_process(paths: &BrokerRuntimePaths) -> Result<(), String> {
    std::fs::create_dir_all(
        paths
            .stdout
            .parent()
            .ok_or_else(|| "invalid_runtime_parent".to_string())?,
    )
    .map_err(|e| format!("failed_to_create_runtime_dir: {e}"))?;

    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.stdout)
        .map_err(|e| format!("failed_to_open_broker_stdout: {e}"))?;
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.stderr)
        .map_err(|e| format!("failed_to_open_broker_stderr: {e}"))?;

    let mut command = Command::new(node_command());
    command
        .arg("--experimental-sqlite")
        .arg("src/cli.js")
        .current_dir(&paths.repo_path)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .env("INTENT_BROKER_HEARTBEAT_PATH", &paths.heartbeat);

    #[cfg(windows)]
    {
        command.env("INTENT_BROKER_DISABLE_CODEX_DISCOVERY", "1");
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
        .spawn()
        .map_err(|e| format!("failed_to_spawn_broker: {e}"))?;

    Ok(())
}

async fn wait_for_broker_ready() -> bool {
    for _ in 0..30 {
        if probe_broker_health().await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    false
}

fn stop_pid_from_heartbeat(heartbeat_path: &Path) -> Result<(), String> {
    let content = std::fs::read_to_string(heartbeat_path)
        .map_err(|e| format!("failed_to_read_heartbeat: {e}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("failed_to_parse_heartbeat: {e}"))?;
    let pid = value
        .get("pid")
        .and_then(|item| item.as_u64())
        .ok_or_else(|| "missing_heartbeat_pid".to_string())?;

    #[cfg(windows)]
    {
        run_command_status(
            "taskkill.exe",
            &["/PID", &pid.to_string(), "/T", "/F"],
            None,
        )?;
    }

    #[cfg(not(windows))]
    {
        run_command_status("kill", &["-TERM", &pid.to_string()], None)?;
    }

    Ok(())
}

async fn build_runtime_status(app: &AppHandle, explicit_error: Option<String>) -> Result<BrokerRuntimeStatus, String> {
    let repo_path = resolve_broker_repo_path(app).await?;
    let runtime_paths = broker_runtime_paths(&repo_path);
    let installed = repo_path.join("package.json").exists();
    let healthy = probe_broker_health().await;
    let running = healthy || heartbeat_indicates_running(&runtime_paths.heartbeat);
    let version = if installed {
        detect_repo_version(&repo_path)
    } else {
        load_manifest(app).await?.map(|manifest| manifest.version)
    };
    let heartbeat_state = load_heartbeat_state(&runtime_paths.heartbeat);

    Ok(BrokerRuntimeStatus {
        installed,
        running,
        healthy,
        version,
        path: installed.then(|| repo_path.to_string_lossy().to_string()),
        heartbeat_path: runtime_paths
            .heartbeat
            .exists()
            .then(|| runtime_paths.heartbeat.to_string_lossy().to_string()),
        stdout_path: runtime_paths
            .stdout
            .exists()
            .then(|| runtime_paths.stdout.to_string_lossy().to_string()),
        stderr_path: runtime_paths
            .stderr
            .exists()
            .then(|| runtime_paths.stderr.to_string_lossy().to_string()),
        last_error: explicit_error.or(heartbeat_state.error_message),
    })
}

#[tauri::command]
pub async fn get_installed_broker_version(app: AppHandle) -> Result<Option<String>, String> {
    let repo_path = resolve_broker_repo_path(&app).await?;
    if !repo_path.join("package.json").exists() {
        return Ok(load_manifest(&app).await?.map(|manifest| manifest.version));
    }

    Ok(detect_repo_version(&repo_path))
}

#[tauri::command]
pub async fn get_installed_broker_path(app: AppHandle) -> Result<Option<String>, String> {
    let repo_path = resolve_broker_repo_path(&app).await?;
    if !repo_path.exists() {
        return Ok(None);
    }

    Ok(Some(repo_path.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn fetch_latest_broker_release() -> Result<BrokerVersionInfo, String> {
    let client = reqwest::Client::builder()
        .user_agent("HexDeck-Updater")
        .build()
        .map_err(|e| format!("failed_to_create_client: {e}"))?;

    let response = client
        .get("https://api.github.com/repos/kaisersong/intent-broker/releases/latest")
        .send()
        .await
        .map_err(|e| format!("failed_to_fetch_release: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("github_api_error: {}", response.status()));
    }

    let release: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("failed_to_parse_response: {e}"))?;

    let version = release
        .get("tag_name")
        .and_then(|value| value.as_str())
        .map(|value| value.trim_start_matches('v').to_string())
        .ok_or_else(|| "no_version_found".to_string())?;

    let download_url = release
        .get("assets")
        .and_then(|items| items.as_array())
        .and_then(|items| {
            items.iter().find_map(|asset| {
                let name = asset.get("name").and_then(|value| value.as_str())?;
                if !(name.ends_with(".tar.gz") && name.contains("intent-broker")) {
                    return None;
                }

                asset
                    .get("browser_download_url")
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
            })
        })
        .or_else(|| {
            release
                .get("tarball_url")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .ok_or_else(|| "no_download_url_found".to_string())?;

    let release_notes = release
        .get("body")
        .and_then(|value| value.as_str())
        .map(str::to_string);

    Ok(BrokerVersionInfo {
        version,
        download_url,
        release_notes,
    })
}

#[tauri::command]
pub async fn install_broker_update(
    app: AppHandle,
    download_url: String,
    version: String,
) -> Result<String, String> {
    let kernel_dir = get_kernel_dir(&app)?;
    let version_dir = kernel_dir.join(format!("intent-broker-{version}"));

    tokio::fs::create_dir_all(&kernel_dir)
        .await
        .map_err(|e| format!("failed_to_create_kernel_dir: {e}"))?;

    let client = reqwest::Client::builder()
        .user_agent("HexDeck-Updater")
        .build()
        .map_err(|e| format!("failed_to_create_client: {e}"))?;

    let response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("failed_to_download: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("download_failed: {}", response.status()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("failed_to_read_response: {e}"))?;

    let version_dir_clone = version_dir.clone();
    let kernel_dir_clone = kernel_dir.clone();
    let installed_path = tokio::task::spawn_blocking(move || {
        let temp_dir = kernel_dir_clone.join(".temp-extract");
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("failed_to_create_temp_dir: {e}"))?;

        let decoder = GzDecoder::new(&bytes[..]);
        let mut archive = Archive::new(decoder);
        archive
            .unpack(&temp_dir)
            .map_err(|e| format!("failed_to_extract: {e}"))?;

        let entries = std::fs::read_dir(&temp_dir)
            .map_err(|e| format!("failed_to_read_temp_dir: {e}"))?;

        let source_dir = entries
            .filter_map(|entry| entry.ok())
            .find(|entry| entry.path().is_dir())
            .map(|entry| entry.path())
            .unwrap_or(temp_dir.clone());

        if version_dir_clone.exists() {
            std::fs::remove_dir_all(&version_dir_clone)
                .map_err(|e| format!("failed_to_remove_old_version: {e}"))?;
        }

        std::fs::rename(&source_dir, &version_dir_clone)
            .map_err(|e| format!("failed_to_move_extracted: {e}"))?;
        let _ = std::fs::remove_dir_all(&temp_dir);

        Ok::<String, String>(version_dir_clone.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("task_error: {e}"))??;

    save_manifest(&app, Path::new(&installed_path), &version).await?;
    Ok(installed_path)
}

#[tauri::command]
pub async fn is_broker_running(app: AppHandle) -> Result<bool, String> {
    let repo_path = resolve_broker_repo_path(&app).await?;
    let runtime_paths = broker_runtime_paths(&repo_path);
    Ok(probe_broker_health().await || heartbeat_indicates_running(&runtime_paths.heartbeat))
}

#[tauri::command]
pub async fn get_broker_runtime_status(app: AppHandle) -> Result<BrokerRuntimeStatus, String> {
    build_runtime_status(&app, None).await
}

#[tauri::command]
pub async fn ensure_broker_running(app: AppHandle) -> Result<BrokerRuntimeStatus, String> {
    if probe_broker_health().await {
        return build_runtime_status(&app, None).await;
    }

    let repo_path = ensure_broker_files(&app).await?;
    let runtime_paths = broker_runtime_paths(&repo_path);

    if !probe_broker_health().await && !heartbeat_indicates_running(&runtime_paths.heartbeat) {
        spawn_broker_process(&runtime_paths)?;
    }

    if wait_for_broker_ready().await {
        return build_runtime_status(&app, None).await;
    }

    let heartbeat = load_heartbeat_state(&runtime_paths.heartbeat);
    build_runtime_status(
        &app,
        Some(
            heartbeat
                .error_message
                .unwrap_or_else(|| "broker_failed_to_become_ready".to_string()),
        ),
    )
    .await
}

#[tauri::command]
pub async fn restart_broker_runtime(app: AppHandle) -> Result<BrokerRuntimeStatus, String> {
    let repo_path = ensure_broker_files(&app).await?;
    let runtime_paths = broker_runtime_paths(&repo_path);

    if runtime_paths.heartbeat.exists() {
        let _ = stop_pid_from_heartbeat(&runtime_paths.heartbeat);
        tokio::time::sleep(Duration::from_millis(700)).await;
    }

    spawn_broker_process(&runtime_paths)?;

    if wait_for_broker_ready().await {
        return build_runtime_status(&app, None).await;
    }

    build_runtime_status(&app, Some("broker_restart_failed".to_string())).await
}

#[tauri::command]
pub async fn open_project_path(project_path: String) -> Result<(), String> {
    let path = PathBuf::from(&project_path);
    if !path.exists() {
        return Err("project_path_missing".to_string());
    }

    #[cfg(target_os = "windows")]
    run_command_status("explorer.exe", &[&project_path], None)?;

    #[cfg(target_os = "macos")]
    run_command_status("open", &[&project_path], None)?;

    #[cfg(all(unix, not(target_os = "macos")))]
    run_command_status("xdg-open", &[&project_path], None)?;

    Ok(())
}
