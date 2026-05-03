use chrono::{DateTime, Datelike, Utc};
use flate2::read::GzDecoder;
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::future::Future;
use std::io::{Read, Seek, SeekFrom, Write};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{LazyLock, Mutex};
use tar::Archive;
use tauri::{AppHandle, Manager};
use tokio::time::{sleep, Duration};

const REPLAY_PAGE_SIZE: usize = 100;
const INTENT_BROKER_REPO: &str = "kaisersong/intent-broker";
const LOCAL_CODEX_HOST_APPROVAL_PREFIX: &str = "hexdeck-local-codex-host-";
const LOCAL_CODEX_APPROVAL_DIAGNOSTICS_LOG_NAME: &str = "hexdeck-activity-card-diagnostics.log";
const LOCAL_CODEX_APPROVAL_DIAGNOSTICS_JSONL_NAME: &str = "hexdeck-activity-card-diagnostics.jsonl";
const LOCAL_CODEX_TRANSCRIPT_TAIL_BYTES: u64 = 1_048_576;
const LOCAL_CODEX_APPROVAL_DETAIL_TEXT: &str = "";
const LOCAL_CODEX_APPROVAL_MAX_AGE_MS: i64 = 30 * 60 * 1000;
const LOCAL_CODEX_LOG_LOOKBACK_SECS: i64 = 10 * 60;
const MINIMUM_REQUIRED_BROKER_VERSION: &str = "0.3.3";
// Give transcript/log reconciliation enough time to observe that a local
// approval was handled before surfacing the same prompt again.
const LOCAL_CODEX_RESOLUTION_SUPPRESSION_TTL_MS: i64 = 60_000;
#[cfg(target_os = "windows")]
const LOCAL_CODEX_WINDOWS_CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(target_os = "windows")]
const LOCAL_CODEX_WINDOWS_DETACHED_PROCESS: u32 = 0x0000_0008;

static RECENT_LOCAL_CODEX_APPROVAL_RESOLUTIONS: LazyLock<Mutex<HashMap<String, i64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static LAST_LOCAL_CODEX_APPROVAL_LOAD_DIAGNOSTIC: LazyLock<Mutex<Option<String>>> =
    LazyLock::new(|| Mutex::new(None));
static BROKER_START_GUARD: LazyLock<Mutex<BrokerStartGuardState>> =
    LazyLock::new(|| Mutex::new(BrokerStartGuardState::default()));

#[derive(Debug, Default)]
struct BrokerStartGuardState {
    in_progress: bool,
}

fn try_acquire_broker_start_guard(state: &mut BrokerStartGuardState) -> bool {
    if state.in_progress {
        false
    } else {
        state.in_progress = true;
        true
    }
}

fn release_broker_start_guard(state: &mut BrokerStartGuardState) {
    state.in_progress = false;
}

fn broker_start_guard_in_progress() -> bool {
    BROKER_START_GUARD
        .lock()
        .map(|state| state.in_progress)
        .unwrap_or(false)
}

struct BrokerStartLease;

impl Drop for BrokerStartLease {
    fn drop(&mut self) {
        if let Ok(mut state) = BROKER_START_GUARD.lock() {
            release_broker_start_guard(&mut state);
        }
    }
}

fn try_acquire_broker_start_lease() -> Option<BrokerStartLease> {
    let Ok(mut state) = BROKER_START_GUARD.lock() else {
        return None;
    };
    if try_acquire_broker_start_guard(&mut state) {
        Some(BrokerStartLease)
    } else {
        None
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BrokerVersionInfo {
    pub version: String,
    pub download_url: String,
    pub release_notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BrokerChannelConfig {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub send_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_url: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BrokerChannelSettings {
    pub installed: bool,
    pub config_path: Option<String>,
    pub channels: HashMap<String, BrokerChannelConfig>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerApprovalResponsePayload {
    pub approval_id: String,
    pub task_id: String,
    pub from_participant_id: String,
    pub decision: String,
    pub decision_mode: Option<String>,
    pub native_decision: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalCodexRuntimeState {
    source: Option<String>,
    status: Option<String>,
    session_id: Option<String>,
    terminal_app: Option<String>,
    project_path: Option<String>,
    #[serde(alias = "terminalSessionID")]
    terminal_session_id: Option<String>,
    updated_at: Option<String>,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalCodexBridgeState {
    pid: Option<u32>,
    parent_pid: Option<u32>,
    session_id: Option<String>,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Deserialize)]
struct LocalCodexWindowsProcessEntry {
    #[serde(rename = "ProcessId")]
    process_id: Option<u32>,
    #[serde(rename = "ParentProcessId")]
    parent_process_id: Option<u32>,
    #[serde(rename = "Name")]
    name: Option<String>,
    #[serde(rename = "CommandLine")]
    command_line: Option<String>,
}

#[derive(Debug, Clone)]
struct PendingLocalCodexApprovalCall {
    call_id: String,
    command: String,
    workdir: String,
    justification: String,
    created_at: Option<String>,
}

#[derive(Debug, Clone)]
struct PendingLocalCodexApprovalLogEntry {
    log_id: i64,
    command: String,
    workdir: String,
    justification: String,
    created_at_ms: i64,
}

#[derive(Debug, Clone, Default)]
struct LocalCodexApprovalTranscriptSnapshot {
    pending: Vec<PendingLocalCodexApprovalCall>,
    resolved: Vec<PendingLocalCodexApprovalCall>,
}

#[derive(Debug, Clone)]
struct LocalHostApprovalPrompt {
    approval_id: String,
    task_id: String,
    thread_id: String,
    participant_id: String,
    session_id: String,
    summary: String,
    detail_text: String,
    command_title: String,
    command_line: String,
    command_preview: String,
    terminal_app: String,
    terminal_session_id: String,
    runtime_source: Option<String>,
    project_path: Option<String>,
    transcript_path: PathBuf,
    call_id: String,
    sort_key_ms: i64,
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

fn parse_broker_version_components(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.trim().split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    Some((major, minor, patch))
}

fn broker_version_is_older(version: &str, minimum: &str) -> bool {
    match (
        parse_broker_version_components(version),
        parse_broker_version_components(minimum),
    ) {
        (Some(current), Some(required)) => current < required,
        _ => version.trim() != minimum.trim(),
    }
}

fn broker_manifest_requires_upgrade(manifest: &BrokerManifest) -> bool {
    broker_version_is_older(&manifest.version, MINIMUM_REQUIRED_BROKER_VERSION)
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

fn activity_card_diagnostics_log_path() -> PathBuf {
    env::temp_dir().join(LOCAL_CODEX_APPROVAL_DIAGNOSTICS_LOG_NAME)
}

fn activity_card_diagnostics_jsonl_path() -> PathBuf {
    env::temp_dir().join(LOCAL_CODEX_APPROVAL_DIAGNOSTICS_JSONL_NAME)
}

fn append_activity_card_diagnostics_log(message: &str) {
    let log_path = activity_card_diagnostics_log_path();
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&log_path) {
        let _ = writeln!(
            file,
            "{} pid={} {}",
            Utc::now().to_rfc3339(),
            std::process::id(),
            message
        );
    }
}

fn append_activity_card_diagnostics_event(event: &Value) {
    let log_path = activity_card_diagnostics_jsonl_path();
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let mut object = match event.as_object() {
        Some(event) => event.clone(),
        None => {
            let mut object = Map::new();
            object.insert("message".to_string(), event.clone());
            object
        }
    };
    object.insert("timestamp".to_string(), json!(Utc::now().to_rfc3339()));
    object.insert("pid".to_string(), json!(std::process::id()));

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&log_path) {
        let _ = writeln!(file, "{}", Value::Object(object));
    }
}

fn maybe_log_local_codex_approval_diagnostic(message: String, event: Option<Value>) {
    let Ok(mut last_message) = LAST_LOCAL_CODEX_APPROVAL_LOAD_DIAGNOSTIC.lock() else {
        return;
    };
    if last_message.as_deref() == Some(message.as_str()) {
        return;
    }
    append_activity_card_diagnostics_log(&message);
    if let Some(event) = event {
        append_activity_card_diagnostics_event(&event);
    }
    *last_message = Some(message);
}

fn truncate_local_codex_diagnostic(value: &str, limit: usize) -> String {
    let value = value.trim();
    if value.is_empty() {
        return "-".to_string();
    }
    let truncated = value.chars().take(limit).collect::<String>();
    if value.chars().count() > limit {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn project_name_from_project_path(project_path: Option<&str>) -> Option<String> {
    project_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| Path::new(value).file_name().and_then(|name| name.to_str()))
        .map(str::to_string)
}

fn extend_json_object(target: &mut Map<String, Value>, value: Option<Value>) {
    let Some(value) = value else {
        return;
    };
    let Some(extra) = value.as_object() else {
        return;
    };
    for (key, value) in extra {
        target.insert(key.clone(), value.clone());
    }
}

fn build_local_codex_approval_event(
    stage: &str,
    approval: Option<&LocalHostApprovalPrompt>,
    response: Option<&BrokerApprovalResponsePayload>,
    extra: Option<Value>,
) -> Value {
    let mut object = Map::new();
    object.insert("kind".to_string(), json!("local_codex_approval"));
    object.insert("stage".to_string(), json!(stage));

    if let Some(approval) = approval {
        object.insert(
            "approvalId".to_string(),
            json!(approval.approval_id.clone()),
        );
        object.insert(
            "participantId".to_string(),
            json!(approval.participant_id.clone()),
        );
        if !approval.session_id.trim().is_empty() {
            object.insert("sessionId".to_string(), json!(approval.session_id.clone()));
        }
        object.insert("callId".to_string(), json!(approval.call_id.clone()));
        object.insert("taskId".to_string(), json!(approval.task_id.clone()));
        object.insert("threadId".to_string(), json!(approval.thread_id.clone()));
        if let Some(project_path) = approval.project_path.as_deref() {
            object.insert("projectPath".to_string(), json!(project_path));
        }
        if let Some(project_name) = project_name_from_project_path(approval.project_path.as_deref())
        {
            object.insert("projectName".to_string(), json!(project_name));
        }
        object.insert("command".to_string(), json!(approval.command_line.clone()));
        object.insert(
            "workdir".to_string(),
            json!(approval.command_preview.clone()),
        );
        object.insert("transport".to_string(), json!("local-host"));
    }

    if let Some(response) = response {
        object.insert(
            "responseApprovalId".to_string(),
            json!(response.approval_id.clone()),
        );
        object.insert(
            "responseTaskId".to_string(),
            json!(response.task_id.clone()),
        );
        object.insert(
            "fromParticipantId".to_string(),
            json!(response.from_participant_id.clone()),
        );
        object.insert("decision".to_string(), json!(response.decision.clone()));
        if let Some(decision_mode) = response.decision_mode.as_deref() {
            object.insert("decisionMode".to_string(), json!(decision_mode));
        }
    }

    extend_json_object(&mut object, extra);
    Value::Object(object)
}

fn append_local_codex_approval_event(
    stage: &str,
    approval: Option<&LocalHostApprovalPrompt>,
    response: Option<&BrokerApprovalResponsePayload>,
    extra: Option<Value>,
) {
    append_activity_card_diagnostics_event(&build_local_codex_approval_event(
        stage, approval, response, extra,
    ));
}

fn build_approval_response_event(
    stage: &str,
    input: &BrokerApprovalResponsePayload,
    extra: Option<Value>,
) -> Value {
    let mut object = Map::new();
    object.insert("kind".to_string(), json!("approval_response"));
    object.insert("stage".to_string(), json!(stage));
    object.insert("approvalId".to_string(), json!(input.approval_id.clone()));
    object.insert("taskId".to_string(), json!(input.task_id.clone()));
    object.insert(
        "fromParticipantId".to_string(),
        json!(input.from_participant_id.clone()),
    );
    object.insert("decision".to_string(), json!(input.decision.clone()));
    if let Some(decision_mode) = input.decision_mode.as_deref() {
        object.insert("decisionMode".to_string(), json!(decision_mode));
    }
    if let Some(native_decision) = input.native_decision.as_ref() {
        object.insert("nativeDecision".to_string(), native_decision.clone());
    }
    extend_json_object(&mut object, extra);
    Value::Object(object)
}

fn append_approval_response_event(
    stage: &str,
    input: &BrokerApprovalResponsePayload,
    extra: Option<Value>,
) {
    append_activity_card_diagnostics_event(&build_approval_response_event(stage, input, extra));
}

fn maybe_log(log_path: Option<&Path>, message: &str) {
    if let Some(path) = log_path {
        append_bootstrap_log(path, message);
    }
}

fn path_dedupe_key(path: &Path) -> String {
    let rendered = path.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        rendered.to_lowercase()
    }
    #[cfg(not(target_os = "windows"))]
    {
        rendered
    }
}

fn append_unique_path(paths: &mut Vec<PathBuf>, seen: &mut HashSet<String>, path: PathBuf) {
    let key = path_dedupe_key(&path);
    if seen.insert(key) {
        paths.push(path);
    }
}

fn broker_binary_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut seen = HashSet::new();

    if let Some(current_path) = env::var_os("PATH") {
        for path in env::split_paths(&current_path) {
            append_unique_path(&mut dirs, &mut seen, path);
        }
    }

    #[cfg(target_os = "windows")]
    {
        for env_name in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = env::var_os(env_name) {
                append_unique_path(&mut dirs, &mut seen, PathBuf::from(root).join("nodejs"));
            }
        }

        if let Some(local_app_data) = env::var_os("LocalAppData") {
            append_unique_path(
                &mut dirs,
                &mut seen,
                PathBuf::from(local_app_data)
                    .join("Programs")
                    .join("nodejs"),
            );
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        for candidate in [
            "/opt/homebrew/bin",
            "/opt/homebrew/opt/node/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
        ] {
            append_unique_path(&mut dirs, &mut seen, PathBuf::from(candidate));
        }
    }

    dirs
}

fn find_binary_in_search_dirs(names: &[&str]) -> Option<PathBuf> {
    for dir in broker_binary_search_dirs() {
        for name in names {
            let candidate = dir.join(name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    None
}

fn resolve_node_binary() -> Option<PathBuf> {
    if let Ok(node_binary) = env::var("NODE_BINARY") {
        let path = PathBuf::from(node_binary);
        if path.exists() {
            return Some(path);
        }
    }

    #[cfg(target_os = "windows")]
    let candidates = ["node.exe", "node.cmd", "node.bat", "node"];
    #[cfg(not(target_os = "windows"))]
    let candidates = ["node"];

    find_binary_in_search_dirs(&candidates)
}

fn resolve_npm_binary() -> Option<PathBuf> {
    if let Ok(npm_binary) = env::var("NPM_BINARY") {
        let path = PathBuf::from(npm_binary);
        if path.exists() {
            return Some(path);
        }
    }

    #[cfg(target_os = "windows")]
    let candidates = ["npm.cmd", "npm.exe", "npm.bat", "npm"];
    #[cfg(not(target_os = "windows"))]
    let candidates = ["npm"];

    find_binary_in_search_dirs(&candidates)
}

fn build_node_path_env() -> String {
    let search_dirs = broker_binary_search_dirs();

    match env::join_paths(search_dirs) {
        Ok(path) => path.to_string_lossy().to_string(),
        Err(_) => env::var("PATH").unwrap_or_default(),
    }
}

fn apply_background_command_mode(command: &mut Command) -> &mut Command {
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(
            LOCAL_CODEX_WINDOWS_CREATE_NO_WINDOW | LOCAL_CODEX_WINDOWS_DETACHED_PROCESS,
        );
    }

    command
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

fn healthy_broker_start_result(log_path: &Path, pid: Option<u32>) -> BrokerStartResult {
    BrokerStartResult {
        already_running: true,
        ready: true,
        pid,
        installed_path: String::new(),
        heartbeat_path: String::new(),
        stdout_path: String::new(),
        stderr_path: String::new(),
        log_path: log_path.to_string_lossy().to_string(),
        node_path: resolve_node_binary().map(|path| path.to_string_lossy().to_string()),
        last_error: None,
    }
}

async fn wait_for_parallel_broker_start(broker_url: &str, timeout_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);

    loop {
        if broker_health_ok(broker_url).await {
            return true;
        }

        if !broker_start_guard_in_progress() || std::time::Instant::now() >= deadline {
            break;
        }

        sleep(Duration::from_millis(100)).await;
    }

    broker_health_ok(broker_url).await
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

fn safe_identifier(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

fn home_dir_from_sources(
    home: Option<std::ffi::OsString>,
    user_profile: Option<std::ffi::OsString>,
    home_drive: Option<std::ffi::OsString>,
    home_path: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    home.filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            user_profile
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| {
            let drive = home_drive.filter(|value| !value.is_empty())?;
            let path = home_path.filter(|value| !value.is_empty())?;
            Some(PathBuf::from(format!(
                "{}{}",
                PathBuf::from(drive).display(),
                PathBuf::from(path).display()
            )))
        })
}

fn home_dir() -> Option<PathBuf> {
    home_dir_from_sources(
        env::var_os("HOME"),
        env::var_os("USERPROFILE"),
        env::var_os("HOMEDRIVE"),
        env::var_os("HOMEPATH"),
    )
}

#[cfg(target_os = "windows")]
fn resolve_local_codex_bridge_state_path(participant_id: &str) -> Option<PathBuf> {
    home_dir().map(|home| {
        home.join(".intent-broker")
            .join("codex")
            .join(format!("{participant_id}.bridge.json"))
    })
}

#[cfg(target_os = "windows")]
fn load_local_codex_bridge_state(participant_id: &str) -> Result<LocalCodexBridgeState, String> {
    let path = resolve_local_codex_bridge_state_path(participant_id)
        .ok_or_else(|| "missing_home_dir_for_local_codex_bridge".to_string())?;
    let content = fs::read_to_string(&path).map_err(|error| {
        format!(
            "failed_to_read_local_codex_bridge_state {}: {error}",
            path.display()
        )
    })?;
    serde_json::from_str(&content).map_err(|error| {
        format!(
            "failed_to_parse_local_codex_bridge_state {}: {error}",
            path.display()
        )
    })
}

#[cfg(target_os = "windows")]
fn resolve_local_codex_console_target_pid_from_bridge(
    approval: &LocalHostApprovalPrompt,
) -> Result<u32, String> {
    let bridge = load_local_codex_bridge_state(&approval.participant_id)?;
    if let Some(session_id) = bridge.session_id.as_deref() {
        let expected = approval.session_id.trim();
        if !expected.is_empty() && session_id.trim() != expected {
            return Err(format!(
                "local_codex_bridge_session_mismatch expected={} actual={}",
                expected,
                session_id.trim()
            ));
        }
    }

    bridge
        .parent_pid
        .or(bridge.pid)
        .filter(|pid| *pid > 0)
        .ok_or_else(|| "missing_local_codex_bridge_parent_pid".to_string())
}

#[cfg(target_os = "windows")]
fn normalize_local_codex_windows_process_name(value: Option<&str>) -> String {
    value.unwrap_or_default().trim().to_ascii_lowercase()
}

#[cfg(target_os = "windows")]
fn normalize_local_codex_windows_command_line(value: Option<&str>) -> String {
    value
        .unwrap_or_default()
        .trim()
        .replace('\\', "/")
        .to_ascii_lowercase()
}

#[cfg(target_os = "windows")]
fn local_codex_windows_process_entry_by_pid<'a>(
    entries: &'a [LocalCodexWindowsProcessEntry],
    pid: u32,
) -> Option<&'a LocalCodexWindowsProcessEntry> {
    entries
        .iter()
        .find(|entry| entry.process_id.filter(|candidate| *candidate == pid).is_some())
}

#[cfg(target_os = "windows")]
fn local_codex_windows_process_entry_is_cli_wrapper(
    entry: &LocalCodexWindowsProcessEntry,
) -> bool {
    let name = normalize_local_codex_windows_process_name(entry.name.as_deref());
    let command_line = normalize_local_codex_windows_command_line(entry.command_line.as_deref());

    ((name == "node.exe" || name == "node")
        && command_line.contains("/@openai/codex/bin/codex.js"))
        || ((name == "codex.exe" || name == "codex")
            && command_line.contains("/@openai/codex-win32-x64/")
            && !command_line.contains(" app-server"))
}

#[cfg(target_os = "windows")]
fn resolve_local_codex_console_host_pid_from_entries(
    entries: &[LocalCodexWindowsProcessEntry],
    start_pid: u32,
) -> Option<u32> {
    let mut current_pid = start_pid;
    let mut visited = std::collections::HashSet::new();

    while visited.insert(current_pid) {
        let entry = local_codex_windows_process_entry_by_pid(entries, current_pid)?;
        if !local_codex_windows_process_entry_is_cli_wrapper(entry) {
            return Some(current_pid);
        }
        current_pid = entry.parent_process_id.filter(|pid| *pid > 0)?;
    }

    None
}

#[cfg(target_os = "windows")]
fn load_local_codex_windows_process_entries() -> Result<Vec<LocalCodexWindowsProcessEntry>, String> {
    let output = execute_hidden_powershell(
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
    )?;
    let parsed: Value = serde_json::from_str(&output)
        .map_err(|error| format!("failed_to_parse_windows_process_list: {error}"))?;
    let items = match parsed {
        Value::Array(items) => items,
        Value::Object(_) => vec![parsed],
        _ => Vec::new(),
    };

    Ok(items
        .into_iter()
        .filter_map(|item| serde_json::from_value::<LocalCodexWindowsProcessEntry>(item).ok())
        .collect())
}

#[cfg(target_os = "windows")]
fn local_codex_windows_process_entries_include_pid(
    entries: &[LocalCodexWindowsProcessEntry],
    pid: u32,
) -> bool {
    entries
        .iter()
        .filter_map(|entry| entry.process_id)
        .any(|candidate| candidate == pid)
}

#[cfg(target_os = "windows")]
fn local_codex_console_target_from_process_entry(
    entry: &LocalCodexWindowsProcessEntry,
) -> Option<(u8, u32, u32)> {
    let source_pid = entry.process_id.filter(|pid| *pid > 0)?;
    let target_pid = entry
        .parent_process_id
        .filter(|pid| *pid > 0)
        .unwrap_or(source_pid);
    let name = normalize_local_codex_windows_process_name(entry.name.as_deref());
    let command_line = normalize_local_codex_windows_command_line(entry.command_line.as_deref());

    if (name == "node.exe" || name == "node")
        && command_line.contains("/@openai/codex/bin/codex.js")
    {
        return Some((0, target_pid, source_pid));
    }

    if (name == "codex.exe" || name == "codex")
        && command_line.contains("/@openai/codex-win32-x64/")
        && !command_line.contains(" app-server")
    {
        return Some((1, target_pid, source_pid));
    }

    None
}

#[cfg(target_os = "windows")]
fn discover_local_codex_console_target_pid_from_entries(
    entries: &[LocalCodexWindowsProcessEntry],
) -> Result<u32, String> {
    let mut candidates = entries
        .iter()
        .filter_map(local_codex_console_target_from_process_entry)
        .collect::<Vec<_>>();

    if candidates.is_empty() {
        return Err("missing_local_codex_cli_process".to_string());
    }

    candidates.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| right.2.cmp(&left.2)));
    let best_rank = candidates[0].0;
    let mut best_targets = candidates
        .into_iter()
        .filter(|candidate| candidate.0 == best_rank)
        .map(|candidate| candidate.1)
        .collect::<Vec<_>>();
    best_targets.sort_unstable();
    best_targets.dedup();

    if best_targets.len() > 1 {
        return Err(format!(
            "ambiguous_local_codex_cli_targets {}",
            best_targets
                .into_iter()
                .map(|pid| pid.to_string())
                .collect::<Vec<_>>()
                .join(",")
        ));
    }

    best_targets
        .into_iter()
        .next()
        .ok_or_else(|| "missing_local_codex_cli_target".to_string())
}

#[cfg(target_os = "windows")]
fn resolve_local_codex_console_target_pid(approval: &LocalHostApprovalPrompt) -> Result<u32, String> {
    let process_entries = load_local_codex_windows_process_entries()?;

    if let Ok(target_pid) = resolve_local_codex_console_target_pid_from_bridge(approval) {
        if let Some(console_host_pid) =
            resolve_local_codex_console_host_pid_from_entries(&process_entries, target_pid)
        {
            if local_codex_windows_process_entries_include_pid(&process_entries, console_host_pid) {
                return Ok(console_host_pid);
            }
        }
    }

    discover_local_codex_console_target_pid_from_entries(&process_entries)
}

fn parse_rfc3339_timestamp_ms(value: Option<&str>) -> Option<i64> {
    value
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp_millis())
}

fn read_text_tail(path: &Path, max_bytes: u64) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("failed_to_open_codex_transcript: {error}"))?;
    let file_len = file
        .metadata()
        .map_err(|error| format!("failed_to_stat_codex_transcript: {error}"))?
        .len();
    let start = file_len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))
        .map_err(|error| format!("failed_to_seek_codex_transcript: {error}"))?;

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("failed_to_read_codex_transcript: {error}"))?;

    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
        if let Some(newline_index) = text.find('\n') {
            text = text.split_off(newline_index + 1);
        } else {
            return Ok(String::new());
        }
    }

    Ok(text)
}

fn collect_matching_files(
    root: &Path,
    needle: &str,
    remaining_depth: usize,
    matches: &mut Vec<PathBuf>,
) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut files = Vec::new();
    let mut directories = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            directories.push(path);
        } else {
            files.push(path);
        }
    }

    files.sort();
    directories.sort();

    for file_path in files {
        let matches_needle = file_path
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| value.ends_with(".jsonl") && value.contains(needle))
            .unwrap_or(false);
        if matches_needle {
            matches.push(file_path);
        }
    }

    if remaining_depth == 0 {
        return;
    }

    for directory in directories {
        collect_matching_files(&directory, needle, remaining_depth - 1, matches);
    }
}

fn find_latest_matching_file(root: &Path, needle: &str, remaining_depth: usize) -> Option<PathBuf> {
    let mut matches = Vec::new();
    collect_matching_files(root, needle, remaining_depth, &mut matches);
    matches.sort();
    matches.pop()
}

fn local_codex_runtime_participant_session_hint(participant_id: &str) -> Option<&str> {
    participant_id
        .strip_prefix("codex-session-")
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn resolve_codex_transcript_path_from_root(
    root: &Path,
    participant_id: &str,
    session_id: &str,
    updated_at: Option<&str>,
) -> Option<PathBuf> {
    let mut needles = Vec::new();
    if let Some(participant_hint) = local_codex_runtime_participant_session_hint(participant_id) {
        needles.push(participant_hint.to_string());
    }
    let session_id = session_id.trim();
    if !session_id.is_empty() && !needles.iter().any(|needle| needle == session_id) {
        needles.push(session_id.to_string());
    }

    if let Some(updated_at) = updated_at.and_then(|value| DateTime::parse_from_rfc3339(value).ok())
    {
        let day_dir = root
            .join(format!("{:04}", updated_at.year()))
            .join(format!("{:02}", updated_at.month()))
            .join(format!("{:02}", updated_at.day()));
        for needle in &needles {
            if let Some(path) = find_latest_matching_file(&day_dir, needle, 0) {
                return Some(path);
            }
        }
    }

    for needle in &needles {
        if let Some(path) = find_latest_matching_file(root, needle, 4) {
            return Some(path);
        }
    }

    None
}

fn resolve_codex_transcript_path(
    participant_id: &str,
    session_id: &str,
    updated_at: Option<&str>,
) -> Option<PathBuf> {
    let root = home_dir()?.join(".codex").join("sessions");
    resolve_codex_transcript_path_from_root(&root, participant_id, session_id, updated_at)
}

fn local_codex_runtime_has_session_id(runtime: &LocalCodexRuntimeState) -> bool {
    runtime
        .session_id
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn is_supported_local_codex_runtime(runtime: &LocalCodexRuntimeState, now_ms: i64) -> bool {
    if !local_codex_runtime_has_session_id(runtime) {
        return false;
    }

    if runtime.status.as_deref() == Some("running") {
        return true;
    }

    if runtime.status.as_deref() != Some("idle") || runtime.source.as_deref() != Some("stop-hook") {
        return false;
    }

    let recent_cutoff_ms = now_ms.saturating_sub(LOCAL_CODEX_APPROVAL_MAX_AGE_MS);
    parse_rfc3339_timestamp_ms(runtime.updated_at.as_deref())
        .map(|updated_at_ms| updated_at_ms >= recent_cutoff_ms)
        .unwrap_or(false)
}

fn parse_pending_local_codex_approval_call(
    line: &str,
    fallback_project_path: Option<&str>,
) -> Option<PendingLocalCodexApprovalCall> {
    let entry: Value = serde_json::from_str(line).ok()?;
    let payload = entry.get("payload")?;
    if entry.get("type").and_then(Value::as_str) != Some("response_item") {
        return None;
    }
    if payload.get("type").and_then(Value::as_str) != Some("function_call") {
        return None;
    }
    let tool_name = payload.get("name").and_then(Value::as_str)?;
    if tool_name != "exec_command" && tool_name != "shell_command" {
        return None;
    }

    let arguments = payload.get("arguments").and_then(Value::as_str)?;
    let args: Value = serde_json::from_str(arguments).ok()?;
    if args.get("sandbox_permissions").and_then(Value::as_str) != Some("require_escalated") {
        return None;
    }

    Some(PendingLocalCodexApprovalCall {
        call_id: payload.get("call_id").and_then(Value::as_str)?.to_string(),
        command: args
            .get("cmd")
            .or_else(|| args.get("command"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        workdir: args
            .get("workdir")
            .and_then(Value::as_str)
            .or(fallback_project_path)
            .unwrap_or_default()
            .to_string(),
        justification: args
            .get("justification")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Codex command approval requested")
            .to_string(),
        created_at: entry
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn parse_local_codex_approval_log_entry(
    log_id: i64,
    ts_secs: i64,
    _session_id: &str,
    body: &str,
) -> Option<PendingLocalCodexApprovalLogEntry> {
    let marker = ["ToolCall: exec_command ", "ToolCall: shell_command "]
        .into_iter()
        .find_map(|marker| body.find(marker).map(|start| (marker, start)))?;
    let start = marker.1 + marker.0.len();
    let end = body.rfind(" thread_id=").unwrap_or(body.len());
    let raw_json = body.get(start..end)?.trim();
    let payload: Value = serde_json::from_str(raw_json).ok()?;

    if payload.get("sandbox_permissions").and_then(Value::as_str) != Some("require_escalated") {
        return None;
    }

    Some(PendingLocalCodexApprovalLogEntry {
        log_id,
        command: payload
            .get("cmd")
            .or_else(|| payload.get("command"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        workdir: payload
            .get("workdir")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        justification: payload
            .get("justification")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Codex command approval requested")
            .to_string(),
        created_at_ms: ts_secs.saturating_mul(1000),
    })
}

fn effective_local_codex_workdir(raw_workdir: &str, fallback_project_path: Option<&str>) -> String {
    let raw_workdir = raw_workdir.trim();
    if !raw_workdir.is_empty() {
        return raw_workdir.to_string();
    }

    fallback_project_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn extract_local_codex_resolved_call_id(line: &str) -> Option<String> {
    let entry: Value = serde_json::from_str(line).ok()?;
    let payload = entry.get("payload")?;

    if entry.get("type").and_then(Value::as_str) == Some("response_item")
        && payload.get("type").and_then(Value::as_str) == Some("function_call_output")
    {
        return payload
            .get("call_id")
            .and_then(Value::as_str)
            .map(str::to_string);
    }

    if entry.get("type").and_then(Value::as_str) == Some("event_msg")
        && payload.get("type").and_then(Value::as_str) == Some("exec_command_end")
    {
        return payload
            .get("call_id")
            .and_then(Value::as_str)
            .map(str::to_string);
    }

    None
}

fn collect_local_codex_approval_transcript_snapshot(
    tail: &str,
    fallback_project_path: Option<&str>,
) -> LocalCodexApprovalTranscriptSnapshot {
    let mut pending_by_call_id = HashMap::new();
    let mut resolved = Vec::new();

    for line in tail.lines() {
        if let Some(call) = parse_pending_local_codex_approval_call(line, fallback_project_path) {
            pending_by_call_id.insert(call.call_id.clone(), call);
            continue;
        }

        if let Some(call_id) = extract_local_codex_resolved_call_id(line) {
            if let Some(call) = pending_by_call_id.remove(&call_id) {
                resolved.push(call);
            }
        }
    }

    let mut pending = pending_by_call_id.into_values().collect::<Vec<_>>();
    pending.sort_by_key(|call| parse_rfc3339_timestamp_ms(call.created_at.as_deref()).unwrap_or(0));
    resolved
        .sort_by_key(|call| parse_rfc3339_timestamp_ms(call.created_at.as_deref()).unwrap_or(0));

    LocalCodexApprovalTranscriptSnapshot { pending, resolved }
}

#[cfg(test)]
fn collect_pending_local_codex_approval_calls(
    tail: &str,
    fallback_project_path: Option<&str>,
) -> Vec<PendingLocalCodexApprovalCall> {
    collect_local_codex_approval_transcript_snapshot(tail, fallback_project_path).pending
}

fn build_local_host_approval_prompt(
    participant_id: &str,
    runtime: &LocalCodexRuntimeState,
    transcript_path: PathBuf,
    call: PendingLocalCodexApprovalCall,
) -> LocalHostApprovalPrompt {
    let participant_safe = safe_identifier(participant_id);
    let call_safe = safe_identifier(&call.call_id);
    let approval_id = format!("{LOCAL_CODEX_HOST_APPROVAL_PREFIX}{participant_safe}-{call_safe}");
    let task_id = format!("local-host-approval-{participant_safe}-{call_safe}");
    let thread_id = format!("local-host-approval-{participant_safe}");
    let project_path = runtime
        .project_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let workdir = call.workdir.trim();
            if workdir.is_empty() {
                None
            } else {
                Some(workdir.to_string())
            }
        });
    let sort_key_ms = parse_rfc3339_timestamp_ms(call.created_at.as_deref())
        .or_else(|| parse_rfc3339_timestamp_ms(runtime.updated_at.as_deref()))
        .unwrap_or(0);

    LocalHostApprovalPrompt {
        approval_id,
        task_id,
        thread_id,
        participant_id: participant_id.to_string(),
        session_id: runtime.session_id.clone().unwrap_or_default(),
        summary: call.justification,
        detail_text: LOCAL_CODEX_APPROVAL_DETAIL_TEXT.to_string(),
        command_title: "Codex".to_string(),
        command_line: call.command,
        command_preview: call.workdir,
        terminal_app: runtime.terminal_app.clone().unwrap_or_default(),
        terminal_session_id: runtime.terminal_session_id.clone().unwrap_or_default(),
        runtime_source: runtime.source.clone(),
        project_path,
        transcript_path,
        call_id: call.call_id,
        sort_key_ms,
    }
}

fn build_local_host_approval_prompt_from_log(
    participant_id: &str,
    runtime: &LocalCodexRuntimeState,
    transcript_path: &Path,
    entry: PendingLocalCodexApprovalLogEntry,
) -> LocalHostApprovalPrompt {
    let synthetic_call_id = format!("log-{}", entry.log_id);
    let participant_safe = safe_identifier(participant_id);
    let call_safe = safe_identifier(&synthetic_call_id);
    let approval_id = format!("{LOCAL_CODEX_HOST_APPROVAL_PREFIX}{participant_safe}-{call_safe}");
    let task_id = format!("local-host-approval-{participant_safe}-{call_safe}");
    let thread_id = format!("local-host-approval-{participant_safe}");
    let project_path = runtime
        .project_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let workdir = entry.workdir.trim();
            if workdir.is_empty() {
                None
            } else {
                Some(workdir.to_string())
            }
        });

    LocalHostApprovalPrompt {
        approval_id,
        task_id,
        thread_id,
        participant_id: participant_id.to_string(),
        session_id: runtime.session_id.clone().unwrap_or_default(),
        summary: entry.justification,
        detail_text: LOCAL_CODEX_APPROVAL_DETAIL_TEXT.to_string(),
        command_title: "Codex".to_string(),
        command_line: entry.command,
        command_preview: entry.workdir,
        terminal_app: runtime.terminal_app.clone().unwrap_or_default(),
        terminal_session_id: runtime.terminal_session_id.clone().unwrap_or_default(),
        runtime_source: runtime.source.clone(),
        project_path,
        transcript_path: transcript_path.to_path_buf(),
        call_id: synthetic_call_id,
        sort_key_ms: entry.created_at_ms,
    }
}

fn load_local_host_approvals() -> Vec<LocalHostApprovalPrompt> {
    let Some(runtime_dir) = home_dir().map(|home| home.join(".intent-broker").join("codex")) else {
        return Vec::new();
    };

    let Ok(entries) = fs::read_dir(runtime_dir) else {
        return Vec::new();
    };

    let now_ms = Utc::now().timestamp_millis();
    let mut approvals = Vec::new();
    let mut diagnostics = Vec::new();
    let recent_resolution_fingerprints =
        recent_local_codex_resolution_fingerprints(Utc::now().timestamp_millis());

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !file_name.ends_with(".runtime.json") {
            continue;
        }
        let diagnostic_label = format!("file={file_name}");

        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) => {
                diagnostics.push(format!("{diagnostic_label} skip=read-error error={error}"));
                continue;
            }
        };
        let runtime: LocalCodexRuntimeState = match serde_json::from_str(&content) {
            Ok(runtime) => runtime,
            Err(error) => {
                diagnostics.push(format!("{diagnostic_label} skip=parse-error error={error}"));
                continue;
            }
        };
        if !is_supported_local_codex_runtime(&runtime, now_ms) {
            diagnostics.push(format!(
                "{diagnostic_label} skip=unsupported status={} terminalApp={} hasSessionId={} hasTerminalSessionId={}",
                runtime.status.as_deref().unwrap_or("-"),
                runtime.terminal_app.as_deref().unwrap_or("-"),
                local_codex_runtime_has_session_id(&runtime),
                runtime
                    .terminal_session_id
                    .as_deref()
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false)
            ));
            continue;
        }

        let participant_id = file_name.trim_end_matches(".runtime.json").to_string();
        let Some(session_id) = runtime.session_id.as_deref() else {
            diagnostics.push(format!("{diagnostic_label} skip=missing-session-id"));
            continue;
        };
        let transcript_path =
            resolve_codex_transcript_path(&participant_id, session_id, runtime.updated_at.as_deref())
                .unwrap_or_default();
        let tail = if transcript_path.as_os_str().is_empty() {
            String::new()
        } else {
            match read_text_tail(&transcript_path, LOCAL_CODEX_TRANSCRIPT_TAIL_BYTES) {
                Ok(tail) => tail,
                Err(_) => String::new(),
            }
        };
        let transcript_snapshot = collect_local_codex_approval_transcript_snapshot(
            &tail,
            runtime.project_path.as_deref(),
        );
        let log_entries = load_recent_local_codex_approval_log_entries(session_id);
        let merged_log_approvals = merge_log_backed_local_host_approvals(
            &participant_id,
            &runtime,
            &transcript_path,
            &log_entries,
            &transcript_snapshot.pending,
            &transcript_snapshot.resolved,
            &recent_resolution_fingerprints,
        );
        diagnostics.push(format!(
            "{diagnostic_label} session={} updatedAt={} transcript={} pending={} resolved={} logEntries={} merged={} projectPath={}",
            session_id,
            runtime.updated_at.as_deref().unwrap_or("-"),
            truncate_local_codex_diagnostic(&transcript_path.to_string_lossy(), 120),
            transcript_snapshot.pending.len(),
            transcript_snapshot.resolved.len(),
            log_entries.len(),
            merged_log_approvals.len(),
            truncate_local_codex_diagnostic(runtime.project_path.as_deref().unwrap_or("-"), 80)
        ));

        for call in transcript_snapshot.pending.iter().cloned() {
            approvals.push(build_local_host_approval_prompt(
                &participant_id,
                &runtime,
                transcript_path.clone(),
                call,
            ));
        }

        approvals.extend(merged_log_approvals);
    }

    let approvals =
        suppress_recently_resolved_local_host_approvals(approvals, &recent_resolution_fingerprints);
    let approvals = filter_and_sort_local_host_approvals(approvals, now_ms);
    let top_approval = approvals
        .first()
        .map(|approval| {
            format!(
                "{} participant={} command={}",
                approval.approval_id,
                approval.participant_id,
                truncate_local_codex_diagnostic(&approval.command_line, 100)
            )
        })
        .unwrap_or_else(|| "none".to_string());
    let summary_event = approvals.first().map(|approval| {
        build_local_codex_approval_event(
            "approval_detected",
            Some(approval),
            None,
            Some(json!({
                "approvalCount": approvals.len(),
                "diagnosticSource": "local_approval_scan"
            })),
        )
    });
    maybe_log_local_codex_approval_diagnostic(
        format!(
            "[broker/local-approvals] total={} top={} {}",
            approvals.len(),
            top_approval,
            diagnostics.join(" | ")
        ),
        summary_event,
    );
    approvals
}

fn normalize_approval_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.replace("\\n", "\n").replace("/n", "\n"))
}

fn approval_fingerprint(
    participant_id: Option<&str>,
    command_line: Option<&str>,
    command_preview: Option<&str>,
) -> Option<String> {
    let participant_id = participant_id
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let command_line = normalize_approval_text(command_line)?;
    let command_preview = normalize_approval_text(command_preview).unwrap_or_default();
    Some(format!(
        "{participant_id}\u{0}{command_line}\u{0}{command_preview}"
    ))
}

fn local_host_approval_fingerprint(approval: &LocalHostApprovalPrompt) -> Option<String> {
    approval_fingerprint(
        Some(&approval.participant_id),
        Some(&approval.command_line),
        Some(&approval.command_preview),
    )
}

fn local_codex_call_fingerprint(
    participant_id: &str,
    command: &str,
    workdir: &str,
) -> Option<String> {
    approval_fingerprint(Some(participant_id), Some(command), Some(workdir))
}

fn load_recent_local_codex_approval_log_entries(
    session_id: &str,
) -> Vec<PendingLocalCodexApprovalLogEntry> {
    let Some(log_path) = home_dir().map(|home| home.join(".codex").join("logs_2.sqlite")) else {
        return Vec::new();
    };
    let connection = match Connection::open_with_flags(
        &log_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(connection) => connection,
        Err(_) => return Vec::new(),
    };

    let min_ts = Utc::now()
        .timestamp()
        .saturating_sub(LOCAL_CODEX_LOG_LOOKBACK_SECS);
    let mut statement = match connection.prepare(
        "
        SELECT id, ts, feedback_log_body
        FROM logs
        WHERE thread_id = ?1
          AND feedback_log_body IS NOT NULL
          AND ts >= ?2
          AND (
            feedback_log_body LIKE '%ToolCall: exec_command %'
            OR feedback_log_body LIKE '%ToolCall: shell_command %'
          )
        ORDER BY id DESC
        LIMIT 64
        ",
    ) {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };

    let rows = match statement.query_map(params![session_id, min_ts], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };

    rows.flatten()
        .filter_map(|(log_id, ts_secs, body)| {
            parse_local_codex_approval_log_entry(log_id, ts_secs, session_id, &body)
        })
        .collect()
}

fn recent_local_codex_resolution_fingerprints(now_ms: i64) -> HashSet<String> {
    let Ok(mut recent_resolutions) = RECENT_LOCAL_CODEX_APPROVAL_RESOLUTIONS.lock() else {
        return HashSet::new();
    };

    recent_resolutions.retain(|_, resolved_at_ms| {
        now_ms.saturating_sub(*resolved_at_ms) <= LOCAL_CODEX_RESOLUTION_SUPPRESSION_TTL_MS
    });

    recent_resolutions.keys().cloned().collect()
}

fn remember_recent_local_codex_resolution(approval: &LocalHostApprovalPrompt) {
    let Some(fingerprint) = local_host_approval_fingerprint(approval) else {
        return;
    };
    let Ok(mut recent_resolutions) = RECENT_LOCAL_CODEX_APPROVAL_RESOLUTIONS.lock() else {
        return;
    };
    recent_resolutions.insert(fingerprint, Utc::now().timestamp_millis());
}

fn local_host_approval_still_pending(
    approval: &LocalHostApprovalPrompt,
    approvals: &[LocalHostApprovalPrompt],
) -> bool {
    let Some(target_fingerprint) = local_host_approval_fingerprint(approval) else {
        return approvals
            .iter()
            .any(|candidate| candidate.approval_id == approval.approval_id);
    };

    approvals.iter().any(|candidate| {
        candidate.approval_id == approval.approval_id
            || local_host_approval_fingerprint(candidate)
                .as_ref()
                .is_some_and(|fingerprint| fingerprint == &target_fingerprint)
    })
}

async fn wait_for_local_host_approval_resolution(
    approval: &LocalHostApprovalPrompt,
) -> Result<(), String> {
    const LOCAL_CODEX_APPROVAL_RESOLUTION_VERIFY_ATTEMPTS: usize = 20;
    const LOCAL_CODEX_APPROVAL_RESOLUTION_VERIFY_SLEEP_MS: u64 = 100;

    for _ in 0..LOCAL_CODEX_APPROVAL_RESOLUTION_VERIFY_ATTEMPTS {
        tokio::time::sleep(std::time::Duration::from_millis(
            LOCAL_CODEX_APPROVAL_RESOLUTION_VERIFY_SLEEP_MS,
        ))
        .await;

        let approvals = load_local_host_approvals();
        if !local_host_approval_still_pending(approval, &approvals) {
            return Ok(());
        }
    }

    Err("local_host_approval_not_acknowledged".to_string())
}

fn suppress_recently_resolved_local_host_approvals(
    approvals: Vec<LocalHostApprovalPrompt>,
    recent_resolution_fingerprints: &HashSet<String>,
) -> Vec<LocalHostApprovalPrompt> {
    if recent_resolution_fingerprints.is_empty() {
        return approvals;
    }

    approvals
        .into_iter()
        .filter(|approval| {
            local_host_approval_fingerprint(approval)
                .map(|fingerprint| !recent_resolution_fingerprints.contains(&fingerprint))
                .unwrap_or(true)
        })
        .collect()
}

fn merge_log_backed_local_host_approvals(
    participant_id: &str,
    runtime: &LocalCodexRuntimeState,
    transcript_path: &Path,
    log_entries: &[PendingLocalCodexApprovalLogEntry],
    transcript_pending: &[PendingLocalCodexApprovalCall],
    transcript_resolved: &[PendingLocalCodexApprovalCall],
    recent_resolution_fingerprints: &HashSet<String>,
) -> Vec<LocalHostApprovalPrompt> {
    let pending_fingerprints: HashSet<String> = transcript_pending
        .iter()
        .filter_map(|call| {
            local_codex_call_fingerprint(participant_id, &call.command, &call.workdir)
        })
        .collect();
    let resolved_fingerprints: HashSet<String> = transcript_resolved
        .iter()
        .filter_map(|call| {
            local_codex_call_fingerprint(participant_id, &call.command, &call.workdir)
        })
        .collect();
    let mut newest_log_by_fingerprint = HashMap::new();

    for entry in log_entries {
        let effective_workdir =
            effective_local_codex_workdir(&entry.workdir, runtime.project_path.as_deref());
        let Some(fingerprint) =
            local_codex_call_fingerprint(participant_id, &entry.command, &effective_workdir)
        else {
            continue;
        };
        if pending_fingerprints.contains(&fingerprint)
            || resolved_fingerprints.contains(&fingerprint)
            || recent_resolution_fingerprints.contains(&fingerprint)
        {
            continue;
        }

        let should_replace = newest_log_by_fingerprint
            .get(&fingerprint)
            .map(|existing: &PendingLocalCodexApprovalLogEntry| {
                entry.created_at_ms > existing.created_at_ms || entry.log_id > existing.log_id
            })
            .unwrap_or(true);
        if should_replace {
            newest_log_by_fingerprint.insert(fingerprint, entry.clone());
        }
    }

    let mut approvals = newest_log_by_fingerprint
        .into_values()
        .map(|entry| {
            build_local_host_approval_prompt_from_log(
                participant_id,
                runtime,
                transcript_path,
                PendingLocalCodexApprovalLogEntry {
                    workdir: effective_local_codex_workdir(
                        &entry.workdir,
                        runtime.project_path.as_deref(),
                    ),
                    ..entry
                },
            )
        })
        .collect::<Vec<_>>();
    approvals.sort_by_key(|approval| approval.sort_key_ms);
    approvals
}

fn nested_value_object<'a>(
    source: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Option<&'a serde_json::Map<String, Value>> {
    source.get(key).and_then(Value::as_object)
}

fn nested_value_string<'a>(
    source: Option<&'a serde_json::Map<String, Value>>,
    key: &str,
) -> Option<&'a str> {
    source
        .and_then(|source| source.get(key))
        .and_then(Value::as_str)
}

fn is_mirrored_codex_hook_payload(payload: &serde_json::Map<String, Value>) -> bool {
    let delivery_source = nested_value_object(payload, "delivery")
        .and_then(|delivery| delivery.get("source"))
        .and_then(Value::as_str);
    if delivery_source == Some("codex-hook-approval") {
        return true;
    }

    nested_value_object(payload, "nativeHookApproval")
        .and_then(|approval| approval.get("agentTool"))
        .and_then(Value::as_str)
        .map(|agent_tool| agent_tool.trim().eq_ignore_ascii_case("codex"))
        .unwrap_or(false)
}

fn codex_hook_event_fingerprint(event: &Value) -> Option<String> {
    let event_kind = event
        .get("kind")
        .or_else(|| event.get("type"))
        .and_then(Value::as_str);
    if event_kind != Some("request_approval") {
        return None;
    }

    let payload = event.get("payload").and_then(Value::as_object)?;
    if !is_mirrored_codex_hook_payload(payload) {
        return None;
    }

    let body = nested_value_object(payload, "body");
    approval_fingerprint(
        nested_value_string(body, "participantId")
            .or_else(|| nested_value_string(Some(payload), "participantId")),
        nested_value_string(body, "commandLine")
            .or_else(|| nested_value_string(Some(payload), "commandLine")),
        nested_value_string(body, "commandPreview")
            .or_else(|| nested_value_string(Some(payload), "commandPreview")),
    )
}

fn find_matching_codex_hook_approvals(
    events: &[Value],
    approval: &LocalHostApprovalPrompt,
) -> Vec<(String, String)> {
    let Some(local_fingerprint) = local_host_approval_fingerprint(approval) else {
        return Vec::new();
    };

    let responded_approval_ids: HashSet<String> = events
        .iter()
        .filter_map(|event| {
            let event_kind = event
                .get("kind")
                .or_else(|| event.get("type"))
                .and_then(Value::as_str);
            if event_kind != Some("respond_approval") {
                return None;
            }

            event
                .get("payload")
                .and_then(Value::as_object)
                .and_then(|payload| payload.get("approvalId"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();

    let mut matches = Vec::new();
    let mut seen = HashSet::new();

    for event in events {
        if codex_hook_event_fingerprint(event).as_deref() != Some(local_fingerprint.as_str()) {
            continue;
        }

        let payload = match event.get("payload").and_then(Value::as_object) {
            Some(payload) => payload,
            None => continue,
        };
        let Some(approval_id) = payload.get("approvalId").and_then(Value::as_str) else {
            continue;
        };
        let Some(task_id) = event.get("taskId").and_then(Value::as_str) else {
            continue;
        };
        if responded_approval_ids.contains(approval_id) || !seen.insert(approval_id.to_string()) {
            continue;
        }

        matches.push((approval_id.to_string(), task_id.to_string()));
    }

    matches
}

fn local_host_approval_to_json(approval: &LocalHostApprovalPrompt) -> Value {
    let unsupported_reason = local_host_approval_transport_unavailable_reason(approval);
    let mut body = json!({
        "summary": approval.summary.clone(),
        "commandTitle": approval.command_title.clone(),
        "commandLine": approval.command_line.clone(),
        "commandPreview": approval.command_preview.clone(),
        "participantId": approval.participant_id.clone(),
        "localHostApproval": {
            "source": "codex",
            "sessionId": approval.session_id.clone(),
            "callId": approval.call_id.clone(),
            "projectPath": approval.project_path.clone(),
            "terminalApp": approval.terminal_app.clone(),
            "terminalSessionId": approval.terminal_session_id.clone(),
            "transcriptPath": approval.transcript_path.to_string_lossy().to_string()
        },
        "delivery": {
            "semantic": "actionable",
            "source": "hexdeck-local-host-approval"
        }
    });
    if !approval.detail_text.trim().is_empty() {
        body["detailText"] = json!(approval.detail_text.clone());
    }
    if let Some(runtime_source) = approval
        .runtime_source
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body["localHostApproval"]["runtimeSource"] = json!(runtime_source);
    }

    let mut item = json!({
        "approvalId": approval.approval_id.clone(),
        "taskId": approval.task_id.clone(),
        "threadId": approval.thread_id.clone(),
        "createdAt": DateTime::<Utc>::from_timestamp_millis(approval.sort_key_ms)
            .map(|timestamp| timestamp.to_rfc3339()),
        "summary": approval.summary.clone(),
        "decision": "pending",
        "participantId": approval.participant_id.clone(),
        "actions": [
            {
                "label": "Allow once",
                "decisionMode": "yes",
                "disabled": unsupported_reason.is_some(),
                "unsupportedReason": unsupported_reason.clone()
            },
            {
                "label": "Reject",
                "decisionMode": "no",
                "disabled": unsupported_reason.is_some(),
                "unsupportedReason": unsupported_reason.clone()
            }
        ],
        "commandTitle": approval.command_title.clone(),
        "commandLine": approval.command_line.clone(),
        "commandPreview": approval.command_preview.clone(),
        "body": body
    });
    if !approval.detail_text.trim().is_empty() {
        item["detailText"] = json!(approval.detail_text.clone());
    }

    item
}

pub(crate) fn latest_local_host_approval_item_value() -> Option<Value> {
    load_local_host_approvals()
        .first()
        .map(local_host_approval_to_json)
}

#[tauri::command]
pub fn load_latest_local_host_approval_item() -> Result<Option<Value>, String> {
    Ok(latest_local_host_approval_item_value())
}

#[cfg(target_os = "windows")]
fn local_host_approval_transport_unavailable_reason(
    _approval: &LocalHostApprovalPrompt,
) -> Option<String> {
    None
}

#[cfg(not(target_os = "windows"))]
fn local_host_approval_transport_unavailable_reason(
    approval: &LocalHostApprovalPrompt,
) -> Option<String> {
    if !approval
        .terminal_app
        .to_ascii_lowercase()
        .contains("ghostty")
    {
        let terminal = approval.terminal_app.trim();
        return Some(if terminal.is_empty() {
            "HexDeck can only confirm local Codex approvals through Ghostty right now.".to_string()
        } else {
            format!(
                "HexDeck can only confirm local Codex approvals through Ghostty right now (current terminal: {}).",
                terminal
            )
        });
    }

    if approval.terminal_session_id.trim().is_empty() {
        return Some(
            "HexDeck needs a Ghostty terminal session id before it can confirm this local Codex approval."
                .to_string(),
        );
    }

    None
}

fn filter_and_sort_local_host_approvals(
    approvals: Vec<LocalHostApprovalPrompt>,
    now_ms: i64,
) -> Vec<LocalHostApprovalPrompt> {
    let min_sort_key_ms = now_ms.saturating_sub(LOCAL_CODEX_APPROVAL_MAX_AGE_MS);
    let mut approvals = approvals
        .into_iter()
        .filter(|approval| approval.sort_key_ms >= min_sort_key_ms)
        .collect::<Vec<_>>();
    approvals.sort_by(|left, right| {
        right
            .sort_key_ms
            .cmp(&left.sort_key_ms)
            .then_with(|| left.approval_id.cmp(&right.approval_id))
    });
    approvals
}

#[cfg(not(target_os = "windows"))]
fn escape_applescript(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(not(target_os = "windows"))]
fn execute_osascript(script: &str) -> Result<String, String> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| format!("failed_to_launch_osascript: {error}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            "osascript_failed".to_string()
        } else {
            stderr
        })
    }
}

fn local_codex_host_approval_shortcut(
    decision: &str,
    decision_mode: Option<&str>,
) -> Result<&'static str, String> {
    match decision {
        "denied" | "cancelled" => Ok("escape"),
        "approved" => {
            if decision_mode == Some("always") {
                Ok("p")
            } else {
                Ok("y")
            }
        }
        other => Err(format!("unsupported_local_host_approval_decision {other}")),
    }
}

#[cfg(not(target_os = "windows"))]
fn local_codex_host_terminal_command(
    decision: &str,
    decision_mode: Option<&str>,
) -> Result<String, String> {
    fn ghostty_keypress_command(key: &str) -> String {
        format!(
            concat!(
                "send key \"{key}\" action press to targetTerminal\n",
                "    delay 0.02\n",
                "    send key \"{key}\" action release to targetTerminal"
            ),
            key = escape_applescript(key)
        )
    }

    let shortcut = local_codex_host_approval_shortcut(decision, decision_mode)?;
    Ok(ghostty_keypress_command(shortcut))
}

#[cfg(target_os = "windows")]
fn execute_hidden_powershell(script: &str) -> Result<String, String> {
    let output = Command::new("powershell.exe")
        .creation_flags(LOCAL_CODEX_WINDOWS_CREATE_NO_WINDOW)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output()
        .map_err(|error| format!("failed_to_launch_powershell: {error}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            "powershell_failed".to_string()
        } else {
            stderr
        })
    }
}

#[cfg(target_os = "windows")]
fn build_windows_codex_console_input_script(target_pid: u32, shortcut: &str) -> Result<String, String> {
    let (virtual_key_code, unicode_char_code, shortcut_label) = match shortcut {
        "y" => (0x59_u16, 0x0079_u16, "y"),
        "p" => (0x50_u16, 0x0070_u16, "p"),
        "escape" => (0x1B_u16, 0x0000_u16, "escape"),
        other => return Err(format!("unsupported_local_codex_console_shortcut {other}")),
    };

    Ok(
        r#"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class HexdeckNativeConsole {
    public const uint SHIFT_PRESSED = 0x0010;
    public const uint LEFT_ALT_PRESSED = 0x0002;
    public const uint LEFT_CTRL_PRESSED = 0x0008;

    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    public struct INPUT_RECORD {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct KEY_EVENT_RECORD {
        [MarshalAs(UnmanagedType.Bool)] public bool bKeyDown;
        public ushort wRepeatCount;
        public ushort wVirtualKeyCode;
        public ushort wVirtualScanCode;
        public char UnicodeChar;
        public uint dwControlKeyState;
    }

    public const ushort KEY_EVENT = 0x0001;
    public const uint ATTACH_PARENT_PROCESS = 0xFFFFFFFF;
    public static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateFileW(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool WriteConsoleInputW(
        IntPtr hConsoleInput,
        INPUT_RECORD[] lpBuffer,
        int nLength,
        out int lpNumberOfEventsWritten
    );

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern short VkKeyScanW(char ch);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint MapVirtualKeyW(uint uCode, uint uMapType);
}
"@

$targetPid = [uint32]__TARGET_PID__
$virtualKeyCode = [uint16]__VKEY__
$unicodeCharCode = [uint16]__UNICODE__
$shortcutLabel = '__SHORTCUT_LABEL__'
[uint32]$desiredAccess = 3221225472
[uint32]$shareMode = 3
[uint32]$openExisting = 3
[uint32]$noFileFlags = 0
[uint16]$scanCode = 0
[uint32]$controlKeyState = 0
if ($unicodeCharCode -ne 0) {
    $vkInfo = [HexdeckNativeConsole]::VkKeyScanW([char]$unicodeCharCode)
    if ($vkInfo -ge 0) {
        $virtualKeyCode = [uint16]($vkInfo -band 0xFF)
        $shiftState = [uint16](($vkInfo -shr 8) -band 0xFF)
        if (($shiftState -band 1) -ne 0) {
            $controlKeyState = $controlKeyState -bor [HexdeckNativeConsole]::SHIFT_PRESSED
        }
        if (($shiftState -band 2) -ne 0) {
            $controlKeyState = $controlKeyState -bor [HexdeckNativeConsole]::LEFT_CTRL_PRESSED
        }
        if (($shiftState -band 4) -ne 0) {
            $controlKeyState = $controlKeyState -bor [HexdeckNativeConsole]::LEFT_ALT_PRESSED
        }
    }
}
$scanCode = [uint16][HexdeckNativeConsole]::MapVirtualKeyW([uint32]$virtualKeyCode, 0)
[void][HexdeckNativeConsole]::FreeConsole()
if (-not [HexdeckNativeConsole]::AttachConsole($targetPid)) {
    throw ('failed_to_attach_console:' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
}
$inputHandle = [IntPtr]::Zero
$inputHandle = [HexdeckNativeConsole]::CreateFileW(
    'CONIN$',
    $desiredAccess,
    $shareMode,
    [IntPtr]::Zero,
    $openExisting,
    $noFileFlags,
    [IntPtr]::Zero
)
if ($inputHandle -eq [IntPtr]::Zero -or $inputHandle -eq [HexdeckNativeConsole]::INVALID_HANDLE_VALUE) {
    throw ('failed_to_open_console_input:' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
}
try {
    $keyDown = New-Object 'HexdeckNativeConsole+INPUT_RECORD'
    $keyDown.EventType = [HexdeckNativeConsole]::KEY_EVENT
    $keyDown.KeyEvent.bKeyDown = $true
    $keyDown.KeyEvent.wRepeatCount = 1
    $keyDown.KeyEvent.wVirtualKeyCode = $virtualKeyCode
    $keyDown.KeyEvent.wVirtualScanCode = $scanCode
    $keyDown.KeyEvent.UnicodeChar = [char]$unicodeCharCode
    $keyDown.KeyEvent.dwControlKeyState = $controlKeyState

    $keyUp = New-Object 'HexdeckNativeConsole+INPUT_RECORD'
    $keyUp.EventType = [HexdeckNativeConsole]::KEY_EVENT
    $keyUp.KeyEvent.bKeyDown = $false
    $keyUp.KeyEvent.wRepeatCount = 1
    $keyUp.KeyEvent.wVirtualKeyCode = $virtualKeyCode
    $keyUp.KeyEvent.wVirtualScanCode = $scanCode
    $keyUp.KeyEvent.UnicodeChar = [char]0
    $keyUp.KeyEvent.dwControlKeyState = $controlKeyState

    $writtenDown = 0
    if (-not [HexdeckNativeConsole]::WriteConsoleInputW($inputHandle, @($keyDown), 1, [ref]$writtenDown)) {
        throw ('failed_to_write_console_input:' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
    }
    $writtenUp = 0
    if (-not [HexdeckNativeConsole]::WriteConsoleInputW($inputHandle, @($keyUp), 1, [ref]$writtenUp)) {
        throw ('failed_to_write_console_input:' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
    }
    Write-Output ('sent:' + $shortcutLabel + ':' + $targetPid + ':' + ($writtenDown + $writtenUp))
} finally {
    if ($inputHandle -ne [IntPtr]::Zero -and $inputHandle -ne [HexdeckNativeConsole]::INVALID_HANDLE_VALUE) {
        [HexdeckNativeConsole]::CloseHandle($inputHandle) | Out-Null
    }
    [void][HexdeckNativeConsole]::FreeConsole()
}
"#
        .replace("__TARGET_PID__", &target_pid.to_string())
        .replace("__VKEY__", &virtual_key_code.to_string())
        .replace("__UNICODE__", &unicode_char_code.to_string())
        .replace("__SHORTCUT_LABEL__", shortcut_label),
    )
}

#[cfg(target_os = "windows")]
fn send_windows_codex_console_approval_decision(
    approval: &LocalHostApprovalPrompt,
    target_pid: u32,
    decision: &str,
    decision_mode: Option<&str>,
) -> Result<(), String> {
    let shortcut = local_codex_host_approval_shortcut(decision, decision_mode)?;
    let script = build_windows_codex_console_input_script(target_pid, shortcut)?;
    let result = execute_hidden_powershell(&script)?;
    append_activity_card_diagnostics_log(&format!(
        "[local-approval/respond-result] approvalId={} result={}",
        truncate_local_codex_diagnostic(&approval.approval_id, 120),
        truncate_local_codex_diagnostic(&result, 80)
    ));
    append_local_codex_approval_event(
        "windows_console_input_sent",
        Some(approval),
        None,
        Some(json!({
            "transport": "windows-console",
            "transportResult": result,
            "targetPid": target_pid
        })),
    );
    Ok(())
}

#[cfg(target_os = "windows")]
fn send_windows_codex_desktop_approval_decision(
    approval: &LocalHostApprovalPrompt,
    decision: &str,
    decision_mode: Option<&str>,
) -> Result<(), String> {
    let target_pid = resolve_local_codex_console_target_pid(approval)?;
    if let Err(error) =
        send_windows_codex_console_approval_decision(approval, target_pid, decision, decision_mode)
    {
        append_local_codex_approval_event(
            "windows_console_transport_failed",
            Some(approval),
            None,
            Some(json!({
                "transport": "windows-console",
                "targetPid": target_pid,
                "error": error
            })),
        );
        return Err(error);
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn send_windows_codex_desktop_approval_decision(
    _approval: &LocalHostApprovalPrompt,
    _decision: &str,
    _decision_mode: Option<&str>,
) -> Result<(), String> {
    Err("windows_uia_transport_unavailable".to_string())
}

#[cfg(not(target_os = "windows"))]
fn send_ghostty_local_codex_host_approval_decision(
    approval: &LocalHostApprovalPrompt,
    decision: &str,
    decision_mode: Option<&str>,
) -> Result<(), String> {
    if !approval
        .terminal_app
        .to_ascii_lowercase()
        .contains("ghostty")
    {
        return Err(format!(
            "unsupported_local_host_approval_terminal {}",
            approval.terminal_app
        ));
    }
    if approval.terminal_session_id.trim().is_empty() {
        return Err("missing_local_host_approval_terminal_session_id".to_string());
    }

    let approve_command = local_codex_host_terminal_command(decision, decision_mode)?;
    let terminal_id = escape_applescript(&approval.terminal_session_id);
    let project_path = escape_applescript(approval.project_path.as_deref().unwrap_or(""));
    let script = format!(
        r#"
tell application "Ghostty"
    set targetWindow to missing value
    set targetTab to missing value
    set targetTerminal to missing value
    repeat with aWindow in windows
        repeat with aTab in tabs of aWindow
            repeat with aTerminal in terminals of aTab
                if (id of aTerminal as text) is "{terminal_id}" then
                    set targetWindow to aWindow
                    set targetTab to aTab
                    set targetTerminal to aTerminal
                    exit repeat
                end if
            end repeat
            if targetTerminal is not missing value then exit repeat
        end repeat
        if targetTerminal is not missing value then exit repeat
    end repeat
    if targetTerminal is missing value and "{project_path}" is not "" then
        repeat with aWindow in windows
            repeat with aTab in tabs of aWindow
                repeat with aTerminal in terminals of aTab
                    if (working directory of aTerminal as text) is "{project_path}" then
                        set targetWindow to aWindow
                        set targetTab to aTab
                        set targetTerminal to aTerminal
                        exit repeat
                    end if
                end repeat
                if targetTerminal is not missing value then exit repeat
            end repeat
            if targetTerminal is not missing value then exit repeat
        end repeat
    end if
    if targetTerminal is missing value then return "missing-terminal"
    activate
    set targetTerminalID to (id of targetTerminal as text)
    set focusMatched to false
    repeat 4 times
        activate window targetWindow
        delay 0.05
        select tab targetTab
        delay 0.05
        focus targetTerminal
        delay 0.08
        try
            if (id of focused terminal of selected tab of front window as text) is targetTerminalID then
                set focusMatched to true
                exit repeat
            end if
        end try
    end repeat
    if focusMatched is false then return "focus-mismatch"
    {approve_command}
    return "sent"
end tell
"#
    );

    let result = execute_osascript(&script)?;
    append_activity_card_diagnostics_log(&format!(
        "[local-approval/respond-result] approvalId={} result={}",
        truncate_local_codex_diagnostic(&approval.approval_id, 120),
        truncate_local_codex_diagnostic(&result, 80)
    ));
    append_local_codex_approval_event(
        "ghostty_input_sent",
        Some(approval),
        None,
        Some(json!({
            "transport": "ghostty",
            "transportResult": result.clone()
        })),
    );
    if result == "missing-terminal" {
        let error = "missing_local_host_approval_terminal".to_string();
        append_local_codex_approval_event(
            "approval_failed",
            Some(approval),
            None,
            Some(json!({
                "error": error,
                "failureStage": "approval_transport_result"
            })),
        );
        return Err(error);
    }
    if result == "focus-mismatch" {
        let error = "local_host_approval_terminal_focus_mismatch".to_string();
        append_local_codex_approval_event(
            "approval_failed",
            Some(approval),
            None,
            Some(json!({
                "error": error,
                "failureStage": "approval_transport_result"
            })),
        );
        return Err(error);
    }

    Ok(())
}

fn send_local_codex_host_approval_decision(
    approval: &LocalHostApprovalPrompt,
    decision: &str,
    decision_mode: Option<&str>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let transport = "windows-console";
    #[cfg(not(target_os = "windows"))]
    let transport = "ghostty";

    append_activity_card_diagnostics_log(&format!(
        "[local-approval/respond] approvalId={} participantId={} decision={} decisionMode={} terminalSessionId={} transport={}",
        truncate_local_codex_diagnostic(&approval.approval_id, 120),
        truncate_local_codex_diagnostic(&approval.participant_id, 80),
        decision,
        decision_mode.unwrap_or("-"),
        truncate_local_codex_diagnostic(&approval.terminal_session_id, 80),
        transport
    ));
    append_local_codex_approval_event(
        "approval_transport_started",
        Some(approval),
        None,
        Some(json!({
            "decision": decision,
            "decisionMode": decision_mode,
            "terminalApp": approval.terminal_app.clone(),
            "terminalSessionId": approval.terminal_session_id.clone(),
            "transport": transport
        })),
    );

    #[cfg(target_os = "windows")]
    {
        if let Err(error) =
            send_windows_codex_desktop_approval_decision(approval, decision, decision_mode)
        {
            append_local_codex_approval_event(
                "approval_failed",
                Some(approval),
                None,
                Some(json!({
                    "error": error,
                    "failureStage": "approval_transport_windows"
                })),
            );
            return Err(error);
        }
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Err(error) =
            send_ghostty_local_codex_host_approval_decision(approval, decision, decision_mode)
        {
            append_local_codex_approval_event(
                "approval_failed",
                Some(approval),
                None,
                Some(json!({
                    "error": error,
                    "failureStage": "approval_transport_ghostty"
                })),
            );
            return Err(error);
        }
        Ok(())
    }
}

async fn post_broker_approval_response(
    broker_url: &str,
    input: &BrokerApprovalResponsePayload,
) -> Result<(), String> {
    let url = format!(
        "{}/approvals/{}/respond",
        broker_url.trim_end_matches('/'),
        urlencoding::encode(&input.approval_id)
    );
    let response = reqwest::Client::new()
        .post(url)
        .json(&json!({
            "taskId": input.task_id,
            "fromParticipantId": input.from_participant_id,
            "decision": input.decision,
            "decisionMode": input.decision_mode,
            "nativeDecision": input.native_decision,
        }))
        .send()
        .await
        .map_err(|e| format!("broker_approval_failed {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "broker_approval_failed {}",
            response.status().as_u16()
        ));
    }

    Ok(())
}

async fn resolve_matching_codex_hook_approvals(
    broker_url: &str,
    approval: &LocalHostApprovalPrompt,
    input: &BrokerApprovalResponsePayload,
) -> Result<(), String> {
    let events = load_all_replay_events(broker_url).await?;
    let items = value_items(events, "items")
        .as_array()
        .cloned()
        .unwrap_or_default();
    let matches = find_matching_codex_hook_approvals(&items, approval);
    for (approval_id, task_id) in &matches {
        let hook_response = BrokerApprovalResponsePayload {
            approval_id: approval_id.clone(),
            task_id: task_id.clone(),
            from_participant_id: input.from_participant_id.clone(),
            decision: input.decision.clone(),
            decision_mode: input.decision_mode.clone(),
            native_decision: input.native_decision.clone(),
        };
        post_broker_approval_response(broker_url, &hook_response).await?;
    }
    append_local_codex_approval_event(
        "approval_response_mirrored",
        Some(approval),
        Some(input),
        Some(json!({
            "mirroredApprovalCount": matches.len(),
            "mirrorTransport": "broker"
        })),
    );

    Ok(())
}

fn heartbeat_error(heartbeat: &serde_json::Value) -> Option<String> {
    heartbeat
        .get("error")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
}

fn build_runtime_status(
    manifest: Option<&BrokerManifest>,
    healthy: bool,
    runtime_paths: Option<&BrokerRuntimePaths>,
    heartbeat: Option<&serde_json::Value>,
    last_error: Option<String>,
) -> BrokerRuntimeStatus {
    let installed = manifest.is_some();
    let running = healthy
        || heartbeat
            .map(|payload| heartbeat_is_running(payload, None))
            .unwrap_or(false);

    BrokerRuntimeStatus {
        installed,
        running,
        healthy,
        version: manifest.map(|item| item.version.clone()),
        path: manifest.map(|item| item.path.clone()),
        heartbeat_path: runtime_paths.map(|paths| paths.heartbeat.to_string_lossy().to_string()),
        stdout_path: runtime_paths.map(|paths| paths.stdout.to_string_lossy().to_string()),
        stderr_path: runtime_paths.map(|paths| paths.stderr.to_string_lossy().to_string()),
        last_error: last_error
            .or_else(|| heartbeat.and_then(heartbeat_error))
            .filter(|value| !value.is_empty()),
    }
}

async fn collect_broker_runtime_status(
    app: &AppHandle,
    broker_url: &str,
    last_error: Option<String>,
) -> Result<BrokerRuntimeStatus, String> {
    let manifest = read_broker_manifest(app).await?;
    let runtime_paths = manifest
        .as_ref()
        .map(|item| PathBuf::from(&item.path))
        .filter(|path| path.exists())
        .map(|path| resolve_broker_runtime_paths(&path));
    let heartbeat = match runtime_paths.as_ref() {
        Some(paths) => read_heartbeat(&paths.heartbeat).await,
        None => None,
    };
    let healthy = broker_health_ok(broker_url).await;

    Ok(build_runtime_status(
        manifest.as_ref(),
        healthy,
        runtime_paths.as_ref(),
        heartbeat.as_ref(),
        last_error,
    ))
}

pub(crate) async fn broker_get_json(
    broker_url: &str,
    path: &str,
) -> Result<serde_json::Value, String> {
    let url = format!("{}{}", broker_url.trim_end_matches('/'), path);
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("broker_request_failed {} {}", path, e))?;

    if !response.status().is_success() {
        return Err(format!(
            "broker_request_failed {} {}",
            response.status().as_u16(),
            path
        ));
    }

    response
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("broker_response_parse_failed {} {}", path, e))
}

pub(crate) fn value_items(payload: serde_json::Value, key: &str) -> serde_json::Value {
    if payload.is_array() {
        return payload;
    }

    payload
        .get(key)
        .cloned()
        .filter(|value| value.is_array())
        .unwrap_or_else(|| json!([]))
}

fn event_cursor(value: &Value) -> Option<u64> {
    value
        .get("id")
        .and_then(Value::as_u64)
        .or_else(|| value.get("eventId").and_then(Value::as_u64))
}

async fn load_all_replay_events_with<F, Fut>(mut fetch_page: F) -> Result<serde_json::Value, String>
where
    F: FnMut(u64) -> Fut,
    Fut: Future<Output = Result<serde_json::Value, String>>,
{
    let mut after = 0;
    let mut events = Vec::new();

    loop {
        let payload = fetch_page(after).await?;
        let items = value_items(payload, "items");
        let page = items.as_array().cloned().unwrap_or_default();
        let page_len = page.len();
        let next_after = page.iter().filter_map(event_cursor).max().unwrap_or(after);
        events.extend(page);

        if page_len < REPLAY_PAGE_SIZE || next_after <= after {
            break;
        }

        after = next_after;
    }

    Ok(json!(events))
}

pub(crate) async fn load_all_replay_events(broker_url: &str) -> Result<serde_json::Value, String> {
    load_all_replay_events_with(|after| async move {
        broker_get_json(broker_url, &format!("/events/replay?after={after}")).await
    })
    .await
}

fn merge_participants_with_presence(participants: Value, presence: Value) -> Value {
    let mut participants = value_items(participants, "participants");
    let presence_items = value_items(presence, "participants");
    let presence_by_participant: HashMap<String, String> = presence_items
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let participant_id = item.get("participantId")?.as_str()?.to_string();
            let status = item.get("status")?.as_str()?.to_string();
            Some((participant_id, status))
        })
        .collect();
    let presence_metadata_by_participant: HashMap<String, Value> = presence_items
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let participant_id = item.get("participantId")?.as_str()?.to_string();
            let metadata = item.get("metadata")?.clone();
            Some((participant_id, metadata))
        })
        .collect();

    if let Some(items) = participants.as_array_mut() {
        for participant in items.iter_mut() {
            let Some(participant_id) = participant
                .get("participantId")
                .and_then(|value| value.as_str())
                .map(str::to_string)
            else {
                continue;
            };
            let Some(status) = presence_by_participant.get(&participant_id) else {
                continue;
            };
            let Some(object) = participant.as_object_mut() else {
                continue;
            };
            object.insert("presence".to_string(), json!(status));
            if let Some(metadata) = presence_metadata_by_participant
                .get(&participant_id)
                .cloned()
            {
                object.insert("presenceMetadata".to_string(), metadata);
            }
        }
    }

    participants
}

fn filter_events_for_project_participants(events: Value, participants: &Value) -> Value {
    let participant_ids: HashSet<String> = value_items(participants.clone(), "participants")
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|participant| {
            participant
                .get("participantId")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .collect();
    let all_events = value_items(events, "items")
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut project_approval_ids = HashSet::new();
    let mut project_approval_task_ids = HashSet::new();

    for event in &all_events {
        let event_kind = event
            .get("kind")
            .or_else(|| event.get("type"))
            .and_then(|value| value.as_str());

        if event_kind != Some("request_approval") {
            continue;
        }

        let payload = event.get("payload").and_then(|value| value.as_object());
        let participant_id = payload
            .and_then(|payload| payload.get("participantId"))
            .and_then(|value| value.as_str());

        if !participant_id
            .map(|participant_id| participant_ids.contains(participant_id))
            .unwrap_or(false)
        {
            continue;
        }

        if let Some(approval_id) = payload
            .and_then(|payload| payload.get("approvalId"))
            .and_then(|value| value.as_str())
        {
            project_approval_ids.insert(approval_id.to_string());
        }

        if let Some(task_id) = event.get("taskId").and_then(|value| value.as_str()) {
            project_approval_task_ids.insert(task_id.to_string());
        }
    }

    Value::Array(
        all_events
            .into_iter()
            .filter(|event| {
                let payload = event.get("payload").and_then(|value| value.as_object());
                if payload
                    .and_then(|payload| payload.get("participantId"))
                    .and_then(|value| value.as_str())
                    .map(|participant_id| participant_ids.contains(participant_id))
                    .unwrap_or(false)
                {
                    return true;
                }

                let event_kind = event
                    .get("kind")
                    .or_else(|| event.get("type"))
                    .and_then(|value| value.as_str());
                if event_kind != Some("respond_approval") {
                    return false;
                }

                let approval_id_matches = payload
                    .and_then(|payload| payload.get("approvalId"))
                    .and_then(|value| value.as_str())
                    .map(|approval_id| project_approval_ids.contains(approval_id))
                    .unwrap_or(false);
                let task_id_matches = event
                    .get("taskId")
                    .and_then(|value| value.as_str())
                    .map(|task_id| project_approval_task_ids.contains(task_id))
                    .unwrap_or(false);

                approval_id_matches || task_id_matches
            })
            .collect(),
    )
}

#[tauri::command]
pub async fn load_broker_service_seed(
    broker_url: Option<String>,
) -> Result<serde_json::Value, String> {
    let broker_url = broker_url.unwrap_or_else(|| "http://127.0.0.1:4318".to_string());
    let health = broker_get_json(&broker_url, "/health").await?;
    let participants = broker_get_json(&broker_url, "/participants").await?;
    let work_states = broker_get_json(&broker_url, "/work-state").await?;
    let presence = broker_get_json(&broker_url, "/presence")
        .await
        .unwrap_or_else(|_| json!({ "participants": [] }));
    let events = load_all_replay_events(&broker_url).await?;

    Ok(json!({
        "health": health,
        "participants": merge_participants_with_presence(participants, presence),
        "workStates": value_items(work_states, "items"),
        "events": value_items(events, "items"),
        "approvals": Value::Array(vec![])
    }))
}

#[tauri::command]
pub async fn load_broker_project_seed(
    broker_url: Option<String>,
    project_name: String,
) -> Result<serde_json::Value, String> {
    let broker_url = broker_url.unwrap_or_else(|| "http://127.0.0.1:4318".to_string());
    let encoded_project_name = urlencoding::encode(&project_name);
    let approvals_path = format!(
        "/projects/{}/approvals?status=pending",
        encoded_project_name
    );
    let participants_path = format!("/participants?projectName={}", encoded_project_name);
    let work_state_path = format!("/work-state?projectName={}", encoded_project_name);

    let health = broker_get_json(&broker_url, "/health").await?;
    let participants = broker_get_json(&broker_url, &participants_path).await?;
    let work_states = broker_get_json(&broker_url, &work_state_path).await?;
    let presence = broker_get_json(&broker_url, "/presence")
        .await
        .unwrap_or_else(|_| json!({ "participants": [] }));
    let events = load_all_replay_events(&broker_url).await?;
    let approvals = broker_get_json(&broker_url, &approvals_path).await?;

    let merged_participants = merge_participants_with_presence(participants, presence);
    let filtered_events = filter_events_for_project_participants(events, &merged_participants);

    Ok(json!({
        "health": health,
        "participants": merged_participants,
        "workStates": value_items(work_states, "items"),
        "events": filtered_events,
        "approvals": value_items(approvals, "items")
    }))
}

#[tauri::command]
pub async fn load_broker_pending_approvals(
    broker_url: Option<String>,
    project_name: String,
) -> Result<serde_json::Value, String> {
    let broker_url = broker_url.unwrap_or_else(|| "http://127.0.0.1:4318".to_string());
    let encoded_project_name = urlencoding::encode(&project_name);
    let path = format!(
        "/projects/{}/approvals?status=pending",
        encoded_project_name
    );
    let approvals = broker_get_json(&broker_url, &path).await?;
    Ok(value_items(approvals, "items"))
}

#[tauri::command]
pub async fn register_broker_ui_participant(broker_url: Option<String>) -> Result<(), String> {
    let broker_url = broker_url.unwrap_or_else(|| "http://127.0.0.1:4318".to_string());
    let url = format!("{}/participants/register", broker_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .post(url)
        .json(&json!({
            "participantId": "human.local",
            "alias": "human",
            "kind": "human",
            "roles": ["approver"],
            "capabilities": ["activity-card"],
            "metadata": {
                "source": "hexdeck"
            }
        }))
        .send()
        .await
        .map_err(|e| format!("broker_register_ui_participant_failed {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "broker_register_ui_participant_failed {}",
            response.status().as_u16()
        ));
    }

    Ok(())
}

#[tauri::command]
pub async fn respond_to_broker_approval(
    broker_url: Option<String>,
    input: BrokerApprovalResponsePayload,
) -> Result<(), String> {
    let broker_url = broker_url.unwrap_or_else(|| "http://127.0.0.1:4318".to_string());
    append_approval_response_event(
        "approval_response_posted",
        &input,
        Some(json!({
            "transport": "broker"
        })),
    );
    match post_broker_approval_response(&broker_url, &input).await {
        Ok(()) => {
            append_approval_response_event(
                "approval_response_delivered",
                &input,
                Some(json!({
                    "transport": "broker"
                })),
            );
            Ok(())
        }
        Err(error) => {
            append_approval_response_event(
                "approval_failed",
                &input,
                Some(json!({
                    "error": error,
                    "failureStage": "approval_response_delivered",
                    "transport": "broker"
                })),
            );
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn respond_to_local_host_approval(
    broker_url: Option<String>,
    input: BrokerApprovalResponsePayload,
) -> Result<(), String> {
    append_activity_card_diagnostics_log(&format!(
        "[local-approval/command] approvalId={} taskId={} decision={} decisionMode={}",
        truncate_local_codex_diagnostic(&input.approval_id, 120),
        truncate_local_codex_diagnostic(&input.task_id, 120),
        truncate_local_codex_diagnostic(&input.decision, 40),
        truncate_local_codex_diagnostic(input.decision_mode.as_deref().unwrap_or("-"), 40)
    ));
    append_approval_response_event(
        "approval_command_received",
        &input,
        Some(json!({
            "transport": "local-host"
        })),
    );

    let approval = match load_local_host_approvals()
        .into_iter()
        .find(|approval| approval.approval_id == input.approval_id)
    {
        Some(approval) => approval,
        None => {
            let error = format!("local_host_approval_not_found {}", input.approval_id);
            append_approval_response_event(
                "approval_failed",
                &input,
                Some(json!({
                    "error": error,
                    "failureStage": "approval_lookup",
                    "transport": "local-host"
                })),
            );
            return Err(error);
        }
    };
    append_local_codex_approval_event("approval_loaded", Some(&approval), Some(&input), None);

    if let Some(reason) = local_host_approval_transport_unavailable_reason(&approval) {
        append_local_codex_approval_event(
            "approval_failed",
            Some(&approval),
            Some(&input),
            Some(json!({
                "error": reason,
                "failureStage": "approval_transport_unavailable",
                "transport": "local-host"
            })),
        );
        return Err(reason);
    }

    send_local_codex_host_approval_decision(
        &approval,
        &input.decision,
        input.decision_mode.as_deref(),
    )?;
    wait_for_local_host_approval_resolution(&approval)
        .await
        .inspect_err(|error| {
            append_local_codex_approval_event(
                "approval_failed",
                Some(&approval),
                Some(&input),
                Some(json!({
                    "error": error,
                    "failureStage": "approval_resolution_not_acknowledged",
                    "transport": "local-host"
                })),
            );
        })?;
    remember_recent_local_codex_resolution(&approval);
    append_local_codex_approval_event(
        "approval_response_delivered",
        Some(&approval),
        Some(&input),
        Some(json!({
            "transport": "local-host"
        })),
    );

    let broker_url = broker_url.unwrap_or_else(|| "http://127.0.0.1:4318".to_string());
    if let Err(error) = resolve_matching_codex_hook_approvals(&broker_url, &approval, &input).await
    {
        append_local_codex_approval_event(
            "approval_failed",
            Some(&approval),
            Some(&input),
            Some(json!({
                "error": error,
                "failureStage": "approval_response_mirrored"
            })),
        );
    }
    Ok(())
}

async fn stop_running_broker(
    log_path: &Path,
    broker_url: &str,
    heartbeat_path: &PathBuf,
) -> Result<(), String> {
    let heartbeat = read_heartbeat(heartbeat_path).await;
    let pid = heartbeat.as_ref().and_then(heartbeat_pid);
    if let Some(pid) = pid {
        maybe_log(
            Some(log_path),
            &format!("restart_broker_runtime: sending TERM to pid={}", pid),
        );

        #[cfg(unix)]
        let status = Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status()
            .map_err(|e| format!("failed_to_stop_broker: {}", e))?;

        #[cfg(target_os = "windows")]
        let status = {
            let mut command = Command::new("taskkill");
            apply_background_command_mode(&mut command)
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .status()
                .map_err(|e| format!("failed_to_stop_broker: {}", e))?
        };

        if !status.success() {
            return Err(format!("failed_to_stop_broker_pid_{}", pid));
        }
    }

    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if !broker_health_ok(broker_url).await {
            return Ok(());
        }
        sleep(Duration::from_millis(200)).await;
    }

    Err("broker_did_not_stop_before_timeout".to_string())
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

fn broker_local_config_path(manifest: &BrokerManifest) -> PathBuf {
    PathBuf::from(&manifest.path).join("intent-broker.local.json")
}

fn read_broker_local_config_value(config_path: &Path) -> Result<Value, String> {
    if !config_path.exists() {
        return Ok(json!({}));
    }

    let content = fs::read_to_string(config_path)
        .map_err(|error| format!("failed_to_read_broker_local_config: {}", error))?;
    if content.trim().is_empty() {
        return Ok(json!({}));
    }

    serde_json::from_str(&content)
        .map_err(|error| format!("failed_to_parse_broker_local_config: {}", error))
}

fn broker_channel_settings_from_config(
    installed: bool,
    config_path: Option<&Path>,
    config: &Value,
) -> Result<BrokerChannelSettings, String> {
    let channels = match config.get("channels") {
        Some(value) => serde_json::from_value(value.clone())
            .map_err(|error| format!("failed_to_parse_broker_channels: {}", error))?,
        None => HashMap::new(),
    };

    Ok(BrokerChannelSettings {
        installed,
        config_path: config_path.map(|path| path.to_string_lossy().to_string()),
        channels,
    })
}

fn merge_broker_channel_settings(
    mut config: Value,
    channels: HashMap<String, BrokerChannelConfig>,
) -> Result<Value, String> {
    if !config.is_object() {
        return Err("broker_local_config_must_be_object".to_string());
    }

    let config_object = config
        .as_object_mut()
        .ok_or_else(|| "broker_local_config_must_be_object".to_string())?;
    config_object.insert(
        "channels".to_string(),
        serde_json::to_value(channels)
            .map_err(|error| format!("failed_to_serialize_broker_channels: {}", error))?,
    );
    Ok(config)
}

fn write_broker_local_config_value(config_path: &Path, config: &Value) -> Result<(), String> {
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed_to_create_broker_config_dir: {}", error))?;
    }

    let content = serde_json::to_string_pretty(config)
        .map_err(|error| format!("failed_to_format_broker_local_config: {}", error))?;
    let tmp_path = config_path.with_extension("json.tmp");
    fs::write(&tmp_path, format!("{}\n", content))
        .map_err(|error| format!("failed_to_write_broker_local_config: {}", error))?;
    fs::rename(&tmp_path, config_path)
        .map_err(|error| format!("failed_to_replace_broker_local_config: {}", error))?;
    Ok(())
}

#[tauri::command]
pub async fn get_broker_channel_settings(app: AppHandle) -> Result<BrokerChannelSettings, String> {
    let Some(manifest) = read_broker_manifest(&app).await? else {
        return Ok(BrokerChannelSettings {
            installed: false,
            config_path: None,
            channels: HashMap::new(),
        });
    };

    let config_path = broker_local_config_path(&manifest);
    let config = read_broker_local_config_value(&config_path)?;
    broker_channel_settings_from_config(true, Some(&config_path), &config)
}

#[tauri::command]
pub async fn save_broker_channel_settings(
    app: AppHandle,
    channels: HashMap<String, BrokerChannelConfig>,
) -> Result<BrokerChannelSettings, String> {
    let manifest = read_broker_manifest(&app)
        .await?
        .ok_or_else(|| "broker_not_installed".to_string())?;
    let config_path = broker_local_config_path(&manifest);
    let config = read_broker_local_config_value(&config_path)?;
    let next_config = merge_broker_channel_settings(config, channels)?;
    write_broker_local_config_value(&config_path, &next_config)?;
    broker_channel_settings_from_config(true, Some(&config_path), &next_config)
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

            let info = broker_release_info_from_github_release(&release)?;

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
        "https://codeload.github.com/{}/tar.gz/refs/tags/{}",
        INTENT_BROKER_REPO, tag
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

fn broker_release_info_from_github_release(
    release: &serde_json::Value,
) -> Result<BrokerVersionInfo, String> {
    let tag = release
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "no_version_found".to_string())?;
    let version = tag.trim_start_matches('v').to_string();

    let asset_download_url = release
        .get("assets")
        .and_then(|a| a.as_array())
        .and_then(|assets| {
            assets.iter().find_map(|asset| {
                let name = asset.get("name").and_then(|n| n.as_str())?;
                if !name.ends_with(".tar.gz") || !name.contains("intent-broker") {
                    return None;
                }
                asset
                    .get("browser_download_url")
                    .and_then(|u| u.as_str())
                    .map(|s| s.to_string())
            })
        });

    let download_url = asset_download_url
        .or_else(|| {
            release
                .get("tarball_url")
                .and_then(|u| u.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| {
            format!(
                "https://codeload.github.com/{}/tar.gz/refs/tags/{}",
                INTENT_BROKER_REPO, tag
            )
        });

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
        let mut command = Command::new(&npm_path);
        let output = apply_background_command_mode(&mut command)
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

#[tauri::command]
pub async fn get_broker_runtime_status(app: AppHandle) -> Result<BrokerRuntimeStatus, String> {
    collect_broker_runtime_status(&app, "http://127.0.0.1:4318", None).await
}

#[tauri::command]
pub async fn ensure_broker_running(app: AppHandle) -> Result<BrokerRuntimeStatus, String> {
    let result = ensure_broker_ready(app.clone(), None, None).await?;
    collect_broker_runtime_status(&app, "http://127.0.0.1:4318", result.last_error).await
}

#[tauri::command]
pub async fn restart_broker_runtime(app: AppHandle) -> Result<BrokerRuntimeStatus, String> {
    let broker_url = "http://127.0.0.1:4318";
    let log_path = get_bootstrap_log_path(&app)?;
    append_bootstrap_log(log_path.as_path(), "=== restart_broker_runtime begin ===");

    if let Some(manifest) = read_broker_manifest(&app).await? {
        let installed_path = PathBuf::from(&manifest.path);
        if installed_path.exists() {
            let runtime_paths = resolve_broker_runtime_paths(&installed_path);
            if broker_health_ok(broker_url).await {
                if let Err(error) =
                    stop_running_broker(log_path.as_path(), broker_url, &runtime_paths.heartbeat)
                        .await
                {
                    append_bootstrap_log(
                        log_path.as_path(),
                        &format!("restart_broker_runtime: stop failed error={}", error),
                    );
                    return collect_broker_runtime_status(&app, broker_url, Some(error)).await;
                }
            }
        }
    }

    let result = start_broker_internal(
        app.clone(),
        broker_url.to_string(),
        15000,
        Some(log_path.as_path()),
    )
    .await
    .map_err(|error| format!("restart_broker_runtime_failed: {}", error))?;

    collect_broker_runtime_status(&app, broker_url, result.last_error).await
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

    let mut command = Command::new(&node_path);
    let child = apply_background_command_mode(&mut command)
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

    let outdated_manifest = manifest
        .as_ref()
        .filter(|manifest| broker_manifest_requires_upgrade(manifest))
        .cloned();

    if broker_health_ok(&broker_url).await {
        if let Some(manifest) = outdated_manifest.as_ref() {
            append_bootstrap_log(
                log_path.as_path(),
                &format!(
                    "ensure_broker_ready: healthy broker uses outdated installed version={}, upgrading to at least {}",
                    manifest.version, MINIMUM_REQUIRED_BROKER_VERSION
                ),
            );
        } else {
            append_bootstrap_log(
                log_path.as_path(),
                "ensure_broker_ready: external broker already healthy, skipping install/start",
            );

            return Ok(healthy_broker_start_result(log_path.as_path(), None));
        }
    }

    let _start_lease = match try_acquire_broker_start_lease() {
        Some(lease) => lease,
        None => {
            append_bootstrap_log(
                log_path.as_path(),
                "ensure_broker_ready: another broker start is already in progress; waiting",
            );

            if wait_for_parallel_broker_start(&broker_url, timeout_ms).await {
                append_bootstrap_log(
                    log_path.as_path(),
                    "ensure_broker_ready: existing broker start completed successfully",
                );
                return Ok(healthy_broker_start_result(log_path.as_path(), None));
            }

            append_bootstrap_log(
                log_path.as_path(),
                "ensure_broker_ready: existing broker start finished without a healthy runtime",
            );
            return Ok(failed_start_result(
                log_path.as_path(),
                String::new(),
                "broker_not_ready_after_waiting_for_existing_start".to_string(),
            ));
        }
    };

    if broker_health_ok(&broker_url).await {
        append_bootstrap_log(
            log_path.as_path(),
            "ensure_broker_ready: broker became healthy before this start attempt began",
        );
        return Ok(healthy_broker_start_result(log_path.as_path(), None));
    }

    let restart_runtime_paths = outdated_manifest.as_ref().and_then(|manifest| {
        let installed_path = PathBuf::from(&manifest.path);
        installed_path
            .exists()
            .then(|| resolve_broker_runtime_paths(&installed_path))
    });

    let installed_path = match manifest {
        Some(manifest)
            if PathBuf::from(&manifest.path).exists()
                && !broker_manifest_requires_upgrade(&manifest) =>
        {
            append_bootstrap_log(
                log_path.as_path(),
                &format!(
                    "ensure_broker_ready: using installed broker version={} path={}",
                    manifest.version, manifest.path
                ),
            );
            manifest.path
        }
        Some(manifest) if broker_manifest_requires_upgrade(&manifest) => {
            append_bootstrap_log(
                log_path.as_path(),
                &format!(
                    "ensure_broker_ready: installed broker version={} is below minimum {}, upgrading",
                    manifest.version, MINIMUM_REQUIRED_BROKER_VERSION
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

    if let Some(runtime_paths) = restart_runtime_paths.as_ref() {
        if broker_health_ok(&broker_url).await {
            append_bootstrap_log(
                log_path.as_path(),
                "ensure_broker_ready: stopping old broker after upgrade",
            );
            if let Err(error) =
                stop_running_broker(log_path.as_path(), &broker_url, &runtime_paths.heartbeat).await
            {
                append_bootstrap_log(
                    log_path.as_path(),
                    &format!("ensure_broker_ready: stop old broker failed error={}", error),
                );
                return Ok(failed_start_result(
                    log_path.as_path(),
                    installed_path.clone(),
                    error,
                ));
            }
        }
    }

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn build_runtime_status_reports_installed_healthy_runtime() {
        let manifest = BrokerManifest {
            version: "0.2.0".to_string(),
            path: "/tmp/intent-broker-0.2.0".to_string(),
            installed_at: "2026-04-08T00:00:00Z".to_string(),
        };
        let runtime_paths = BrokerRuntimePaths {
            stdout: PathBuf::from("/tmp/intent-broker-0.2.0/.tmp/broker.stdout.log"),
            stderr: PathBuf::from("/tmp/intent-broker-0.2.0/.tmp/broker.stderr.log"),
            heartbeat: PathBuf::from("/tmp/intent-broker-0.2.0/.tmp/broker.heartbeat.json"),
        };
        let heartbeat = json!({
            "pid": 1234,
            "status": "running",
            "error": null
        });

        let status = build_runtime_status(
            Some(&manifest),
            true,
            Some(&runtime_paths),
            Some(&heartbeat),
            None,
        );

        assert!(status.installed);
        assert!(status.running);
        assert!(status.healthy);
        assert_eq!(status.version.as_deref(), Some("0.2.0"));
        assert_eq!(status.path.as_deref(), Some("/tmp/intent-broker-0.2.0"));
        assert_eq!(
            status.heartbeat_path.as_deref(),
            Some("/tmp/intent-broker-0.2.0/.tmp/broker.heartbeat.json")
        );
        assert_eq!(status.last_error, None);
    }

    #[test]
    fn build_runtime_status_uses_runtime_error_when_present() {
        let manifest = BrokerManifest {
            version: "0.2.0".to_string(),
            path: "/tmp/intent-broker-0.2.0".to_string(),
            installed_at: "2026-04-08T00:00:00Z".to_string(),
        };
        let heartbeat = json!({
            "status": "stopped",
            "error": "broker_not_ready_before_timeout"
        });

        let status = build_runtime_status(Some(&manifest), false, None, Some(&heartbeat), None);

        assert!(status.installed);
        assert!(!status.running);
        assert!(!status.healthy);
        assert_eq!(
            status.last_error.as_deref(),
            Some("broker_not_ready_before_timeout")
        );
    }

    #[test]
    fn broker_release_info_falls_back_to_github_tarball_when_assets_are_absent() {
        let release = json!({
            "tag_name": "v0.2.1",
            "assets": [],
            "tarball_url": "https://api.github.com/repos/kaisersong/intent-broker/tarball/v0.2.1",
            "body": "Hook approval release"
        });

        let info = broker_release_info_from_github_release(&release).expect("release info");

        assert_eq!(info.version, "0.2.1");
        assert_eq!(
            info.download_url,
            "https://api.github.com/repos/kaisersong/intent-broker/tarball/v0.2.1"
        );
        assert_eq!(info.release_notes.as_deref(), Some("Hook approval release"));
    }

    #[test]
    fn broker_release_info_prefers_uploaded_tarball_assets() {
        let release = json!({
            "tag_name": "v0.2.2",
            "assets": [
                {
                    "name": "intent-broker-0.2.2.tar.gz",
                    "browser_download_url": "https://github.com/kaisersong/intent-broker/releases/download/v0.2.2/intent-broker-0.2.2.tar.gz"
                }
            ],
            "tarball_url": "https://api.github.com/repos/kaisersong/intent-broker/tarball/v0.2.2"
        });

        let info = broker_release_info_from_github_release(&release).expect("release info");

        assert_eq!(info.version, "0.2.2");
        assert_eq!(
            info.download_url,
            "https://github.com/kaisersong/intent-broker/releases/download/v0.2.2/intent-broker-0.2.2.tar.gz"
        );
    }

    #[test]
    fn merge_broker_channel_settings_preserves_unrelated_config() {
        let config = json!({
            "server": {
                "host": "127.0.0.1",
                "port": 4318
            },
            "channels": {
                "legacy": {
                    "enabled": true,
                    "custom": "keep"
                }
            }
        });
        let mut channels = HashMap::new();
        channels.insert(
            "yunzhijia".to_string(),
            BrokerChannelConfig {
                enabled: true,
                send_url: Some("https://www.yunzhijia.com/webhook".to_string()),
                webhook_url: None,
                extra: Map::new(),
            },
        );

        let merged = merge_broker_channel_settings(config, channels).expect("merged config");

        assert_eq!(merged["server"]["port"], json!(4318));
        assert_eq!(
            merged["channels"]["yunzhijia"]["sendUrl"],
            json!("https://www.yunzhijia.com/webhook")
        );
    }

    #[test]
    fn broker_channel_settings_parses_unknown_channel_fields() {
        let config = json!({
            "channels": {
                "dingtalk": {
                    "enabled": false,
                    "webhookUrl": "https://oapi.dingtalk.com/robot/send",
                    "secret": "preserve"
                }
            }
        });

        let settings =
            broker_channel_settings_from_config(true, None, &config).expect("channel settings");
        let dingtalk = settings.channels.get("dingtalk").expect("dingtalk config");

        assert!(!dingtalk.enabled);
        assert_eq!(
            dingtalk.webhook_url.as_deref(),
            Some("https://oapi.dingtalk.com/robot/send")
        );
        assert_eq!(dingtalk.extra.get("secret"), Some(&json!("preserve")));
    }

    #[test]
    fn load_all_replay_events_pages_until_the_latest_slice() {
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let calls: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
        let calls_for_fetch = Arc::clone(&calls);

        let events = runtime
            .block_on(load_all_replay_events_with(move |after| {
                let calls = Arc::clone(&calls_for_fetch);
                async move {
                    calls.lock().expect("calls").push(after);
                    Ok(match after {
                        0 => json!({
                            "items": (1..=100)
                                .map(|event_id| json!({ "eventId": event_id, "kind": "report_progress" }))
                                .collect::<Vec<_>>()
                        }),
                        100 => json!({
                            "items": [
                                { "eventId": 101, "kind": "ask_clarification" }
                            ]
                        }),
                        _ => panic!("unexpected replay cursor {after}"),
                    })
                }
            }))
            .expect("events");

        assert_eq!(calls.lock().expect("calls").as_slice(), &[0, 100]);
        let items = value_items(events, "items")
            .as_array()
            .cloned()
            .expect("array");
        assert_eq!(items.len(), 101);
        assert_eq!(
            items.first(),
            Some(&json!({ "eventId": 1, "kind": "report_progress" }))
        );
        assert_eq!(
            items.last(),
            Some(&json!({ "eventId": 101, "kind": "ask_clarification" }))
        );
    }

    #[test]
    fn filter_events_for_project_participants_keeps_only_matching_participant_ids() {
        let events = json!({
            "items": [
                {
                    "eventId": 1,
                    "kind": "ask_clarification",
                    "payload": { "participantId": "agent-a", "summary": "keep" }
                },
                {
                    "eventId": 2,
                    "kind": "ask_clarification",
                    "payload": { "participantId": "agent-b", "summary": "drop" }
                }
            ]
        });
        let participants = json!({
            "participants": [
                { "participantId": "agent-a", "alias": "codex4" }
            ]
        });

        let filtered = filter_events_for_project_participants(events, &participants);

        assert_eq!(
            filtered,
            json!([
                {
                    "eventId": 1,
                    "kind": "ask_clarification",
                    "payload": { "participantId": "agent-a", "summary": "keep" }
                }
            ])
        );
    }

    #[test]
    fn filter_events_for_project_participants_keeps_matching_approval_responses() {
        let events = json!({
            "items": [
                {
                    "eventId": 1,
                    "kind": "request_approval",
                    "taskId": "task-a",
                    "payload": {
                        "approvalId": "approval-a",
                        "participantId": "agent-a",
                        "summary": "keep request"
                    }
                },
                {
                    "eventId": 2,
                    "kind": "respond_approval",
                    "taskId": "task-a",
                    "payload": {
                        "approvalId": "approval-a",
                        "participantId": "human.local",
                        "decision": "approved"
                    }
                },
                {
                    "eventId": 3,
                    "kind": "respond_approval",
                    "taskId": "task-b",
                    "payload": {
                        "approvalId": "approval-b",
                        "participantId": "human.local",
                        "decision": "approved"
                    }
                }
            ]
        });
        let participants = json!({
            "participants": [
                { "participantId": "agent-a", "alias": "codex4" }
            ]
        });

        let filtered = filter_events_for_project_participants(events, &participants);

        assert_eq!(
            filtered,
            json!([
                {
                    "eventId": 1,
                    "kind": "request_approval",
                    "taskId": "task-a",
                    "payload": {
                        "approvalId": "approval-a",
                        "participantId": "agent-a",
                        "summary": "keep request"
                    }
                },
                {
                    "eventId": 2,
                    "kind": "respond_approval",
                    "taskId": "task-a",
                    "payload": {
                        "approvalId": "approval-a",
                        "participantId": "human.local",
                        "decision": "approved"
                    }
                }
            ])
        );
    }

    #[test]
    fn collect_pending_local_codex_approval_calls_keeps_unresolved_exec_and_shell_require_escalated_calls(
    ) {
        let tail = r#"
{"timestamp":"2026-04-22T06:46:03.464Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"cargo test\",\"workdir\":\"/Users/song/projects/hexdeck/src-tauri\",\"sandbox_permissions\":\"require_escalated\",\"justification\":\"Allow Cargo to run tests?\"}","call_id":"call_pending"}}
{"timestamp":"2026-04-22T06:46:04.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"npm test\",\"workdir\":\"/Users/song/projects/hexdeck\",\"sandbox_permissions\":\"require_escalated\",\"justification\":\"Allow npm to run tests?\"}","call_id":"call_resolved"}}
{"timestamp":"2026-04-22T06:46:05.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_resolved","output":"ok"}}
{"timestamp":"2026-04-25T06:22:26.450Z","type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\"command\":\"whoami\",\"workdir\":\"D:\\\\projects\",\"sandbox_permissions\":\"require_escalated\",\"justification\":\"Allow whoami approval check?\"}","call_id":"call_shell_pending"}}
{"timestamp":"2026-04-25T06:02:50.001Z","type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\"command\":\"hostname\",\"workdir\":\"D:\\\\projects\",\"sandbox_permissions\":\"require_escalated\",\"justification\":\"Allow hostname approval check?\"}","call_id":"call_shell_resolved"}}
{"timestamp":"2026-04-25T06:21:35.584Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_shell_resolved","output":"Wall time: 1125.6 seconds\naborted by user"}}
"#;

        let approvals = collect_pending_local_codex_approval_calls(
            tail.trim(),
            Some("/Users/song/projects/hexdeck"),
        );

        assert_eq!(approvals.len(), 2);
        assert_eq!(approvals[0].call_id, "call_pending");
        assert_eq!(approvals[0].command, "cargo test");
        assert_eq!(
            approvals[0].workdir,
            "/Users/song/projects/hexdeck/src-tauri"
        );
        assert_eq!(approvals[0].justification, "Allow Cargo to run tests?");
        assert_eq!(approvals[1].call_id, "call_shell_pending");
        assert_eq!(approvals[1].command, "whoami");
        assert_eq!(approvals[1].workdir, "D:\\projects");
        assert_eq!(approvals[1].justification, "Allow whoami approval check?");
    }

    #[test]
    fn filter_and_sort_local_host_approvals_keeps_recent_items_newest_first() {
        let now_ms = 1_776_900_000_000;
        let approvals = vec![
            LocalHostApprovalPrompt {
                approval_id: "hexdeck-local-codex-host-old".to_string(),
                task_id: "local-host-approval-old".to_string(),
                thread_id: "local-host-thread-old".to_string(),
                participant_id: "codex-session-old".to_string(),
                session_id: "session-old".to_string(),
                summary: "old".to_string(),
                detail_text: "".to_string(),
                command_title: "Codex".to_string(),
                command_line: "mkdir /tmp/old".to_string(),
                command_preview: "/Users/song/projects/hexdeck".to_string(),
                terminal_app: "Ghostty".to_string(),
                terminal_session_id: "ghostty-old".to_string(),
                runtime_source: None,
                project_path: Some("/Users/song/projects/hexdeck".to_string()),
                transcript_path: PathBuf::from("/tmp/old.jsonl"),
                call_id: "call_old".to_string(),
                sort_key_ms: now_ms - 5_000,
            },
            LocalHostApprovalPrompt {
                approval_id: "hexdeck-local-codex-host-new".to_string(),
                task_id: "local-host-approval-new".to_string(),
                thread_id: "local-host-thread-new".to_string(),
                participant_id: "codex-session-new".to_string(),
                session_id: "session-new".to_string(),
                summary: "new".to_string(),
                detail_text: "".to_string(),
                command_title: "Codex".to_string(),
                command_line: "mkdir /tmp/new".to_string(),
                command_preview: "/Users/song/projects/hexdeck".to_string(),
                terminal_app: "Ghostty".to_string(),
                terminal_session_id: "ghostty-new".to_string(),
                runtime_source: None,
                project_path: Some("/Users/song/projects/hexdeck".to_string()),
                transcript_path: PathBuf::from("/tmp/new.jsonl"),
                call_id: "call_new".to_string(),
                sort_key_ms: now_ms - 1_000,
            },
        ];

        let filtered = filter_and_sort_local_host_approvals(approvals, now_ms);

        assert_eq!(filtered.len(), 2);
        assert_eq!(filtered[0].approval_id, "hexdeck-local-codex-host-new");
        assert_eq!(filtered[1].approval_id, "hexdeck-local-codex-host-old");
    }

    #[test]
    fn filter_and_sort_local_host_approvals_drops_stale_items() {
        let now_ms = 1_776_900_000_000;
        let approvals = vec![
            LocalHostApprovalPrompt {
                approval_id: "hexdeck-local-codex-host-stale".to_string(),
                task_id: "local-host-approval-stale".to_string(),
                thread_id: "local-host-thread-stale".to_string(),
                participant_id: "codex-session-stale".to_string(),
                session_id: "session-stale".to_string(),
                summary: "stale".to_string(),
                detail_text: "".to_string(),
                command_title: "Codex".to_string(),
                command_line: "mkdir /tmp/stale".to_string(),
                command_preview: "/Users/song/projects/hexdeck".to_string(),
                terminal_app: "Ghostty".to_string(),
                terminal_session_id: "ghostty-stale".to_string(),
                runtime_source: None,
                project_path: Some("/Users/song/projects/hexdeck".to_string()),
                transcript_path: PathBuf::from("/tmp/stale.jsonl"),
                call_id: "call_stale".to_string(),
                sort_key_ms: now_ms - LOCAL_CODEX_APPROVAL_MAX_AGE_MS - 1,
            },
            LocalHostApprovalPrompt {
                approval_id: "hexdeck-local-codex-host-fresh".to_string(),
                task_id: "local-host-approval-fresh".to_string(),
                thread_id: "local-host-thread-fresh".to_string(),
                participant_id: "codex-session-fresh".to_string(),
                session_id: "session-fresh".to_string(),
                summary: "fresh".to_string(),
                detail_text: "".to_string(),
                command_title: "Codex".to_string(),
                command_line: "mkdir /tmp/fresh".to_string(),
                command_preview: "/Users/song/projects/hexdeck".to_string(),
                terminal_app: "Ghostty".to_string(),
                terminal_session_id: "ghostty-fresh".to_string(),
                runtime_source: None,
                project_path: Some("/Users/song/projects/hexdeck".to_string()),
                transcript_path: PathBuf::from("/tmp/fresh.jsonl"),
                call_id: "call_fresh".to_string(),
                sort_key_ms: now_ms - LOCAL_CODEX_APPROVAL_MAX_AGE_MS + 1,
            },
        ];

        let filtered = filter_and_sort_local_host_approvals(approvals, now_ms);

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].approval_id, "hexdeck-local-codex-host-fresh");
    }

    #[test]
    fn local_host_approval_to_json_uses_verified_codex_actions_and_omits_empty_detail_text() {
        let approval = LocalHostApprovalPrompt {
            approval_id: "hexdeck-local-codex-host-codex-session-1-call_1".to_string(),
            task_id: "local-host-approval-codex-session-1-call_1".to_string(),
            thread_id: "local-host-approval-codex-session-1".to_string(),
            participant_id: "codex-session-1".to_string(),
            session_id: "session-1".to_string(),
            summary: "Do you want to allow this command?".to_string(),
            detail_text: "".to_string(),
            command_title: "Codex".to_string(),
            command_line: "rm -f ~/Desktop/test.txt".to_string(),
            command_preview: "/Users/song/projects/hexdeck".to_string(),
            terminal_app: "Ghostty".to_string(),
            terminal_session_id: "ghostty-1".to_string(),
            runtime_source: Some("user-prompt-submit".to_string()),
            project_path: Some("/Users/song/projects/hexdeck".to_string()),
            transcript_path: PathBuf::from("/tmp/codex-session.jsonl"),
            call_id: "call_1".to_string(),
            sort_key_ms: 1,
        };

        let payload = local_host_approval_to_json(&approval);
        let actions = payload
            .get("actions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        assert_eq!(
            actions,
            vec![
                json!({
                    "label": "Allow once",
                    "decisionMode": "yes",
                    "disabled": false,
                    "unsupportedReason": null
                }),
                json!({
                    "label": "Reject",
                    "decisionMode": "no",
                    "disabled": false,
                    "unsupportedReason": null
                }),
            ]
        );
        assert_eq!(
            payload["body"]["localHostApproval"]["runtimeSource"],
            json!("user-prompt-submit")
        );
        assert_eq!(
            payload["body"]["localHostApproval"]["sessionId"],
            json!("session-1")
        );
        assert!(payload.get("detailText").is_none());
        assert!(payload
            .get("body")
            .and_then(Value::as_object)
            .and_then(|body| body.get("detailText"))
            .is_none());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn local_host_approval_transport_reason_allows_windows_uia_transport() {
        let approval = LocalHostApprovalPrompt {
            approval_id: "hexdeck-local-codex-host-codex-session-1-call_1".to_string(),
            task_id: "local-host-approval-codex-session-1-call_1".to_string(),
            thread_id: "local-host-approval-codex-session-1".to_string(),
            participant_id: "codex-session-1".to_string(),
            session_id: "session-1".to_string(),
            summary: "Do you want to allow this command?".to_string(),
            detail_text: "".to_string(),
            command_title: "Codex".to_string(),
            command_line: "whoami".to_string(),
            command_preview: "D:\\projects\\hexdeck".to_string(),
            terminal_app: "unknown".to_string(),
            terminal_session_id: "".to_string(),
            runtime_source: Some("queued-context".to_string()),
            project_path: Some("D:\\projects\\hexdeck".to_string()),
            transcript_path: PathBuf::from("C:\\tmp\\codex-session.jsonl"),
            call_id: "call_1".to_string(),
            sort_key_ms: 1,
        };

        assert_eq!(local_host_approval_transport_unavailable_reason(&approval), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn discover_local_codex_console_target_pid_from_entries_prefers_cli_parent_shell() {
        let entries = vec![
            LocalCodexWindowsProcessEntry {
                process_id: Some(31232),
                parent_process_id: Some(41772),
                name: Some("codex.exe".to_string()),
                command_line: Some("C:\\Users\\song\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe".to_string()),
            },
            LocalCodexWindowsProcessEntry {
                process_id: Some(41772),
                parent_process_id: Some(5468),
                name: Some("node.exe".to_string()),
                command_line: Some("\"D:\\Program Files\\nodejs\\node.exe\" C:\\Users\\song\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js".to_string()),
            },
        ];

        assert_eq!(
            discover_local_codex_console_target_pid_from_entries(&entries).unwrap(),
            5468
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn resolve_local_codex_console_host_pid_from_entries_walks_up_from_bridge_wrapper_pid() {
        let entries = vec![
            LocalCodexWindowsProcessEntry {
                process_id: Some(35864),
                parent_process_id: Some(3628),
                name: Some("codex.exe".to_string()),
                command_line: Some("C:\\Users\\song\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe".to_string()),
            },
            LocalCodexWindowsProcessEntry {
                process_id: Some(3628),
                parent_process_id: Some(5468),
                name: Some("node.exe".to_string()),
                command_line: Some("\"D:\\Program Files\\nodejs\\node.exe\" C:\\Users\\song\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js".to_string()),
            },
            LocalCodexWindowsProcessEntry {
                process_id: Some(5468),
                parent_process_id: Some(24812),
                name: Some("pwsh.exe".to_string()),
                command_line: Some("\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\"".to_string()),
            },
        ];

        assert_eq!(
            resolve_local_codex_console_host_pid_from_entries(&entries, 35864),
            Some(5468)
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn discover_local_codex_console_target_pid_from_entries_rejects_ambiguous_cli_targets() {
        let entries = vec![
            LocalCodexWindowsProcessEntry {
                process_id: Some(41772),
                parent_process_id: Some(5468),
                name: Some("node.exe".to_string()),
                command_line: Some("\"D:\\Program Files\\nodejs\\node.exe\" C:\\Users\\song\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js".to_string()),
            },
            LocalCodexWindowsProcessEntry {
                process_id: Some(50000),
                parent_process_id: Some(60000),
                name: Some("node.exe".to_string()),
                command_line: Some("\"D:\\Program Files\\nodejs\\node.exe\" C:\\Users\\song\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js".to_string()),
            },
        ];

        assert_eq!(
            discover_local_codex_console_target_pid_from_entries(&entries),
            Err("ambiguous_local_codex_cli_targets 5468,60000".to_string())
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn build_windows_codex_console_input_script_targets_attached_console() {
        let script =
            build_windows_codex_console_input_script(33860, "y").expect("expected console script");

        assert!(script.contains("AttachConsole($targetPid)"));
        assert!(script.contains("WriteConsoleInputW"));
        assert!(script.contains("VkKeyScanW"));
        assert!(script.contains("MapVirtualKeyW"));
        assert!(script.contains("$scanCode = [uint16][HexdeckNativeConsole]::MapVirtualKeyW"));
        assert!(script.contains("$controlKeyState = $controlKeyState -bor [HexdeckNativeConsole]::SHIFT_PRESSED"));
        assert!(script.contains("$targetPid = [uint32]33860"));
        assert!(script.contains("[uint32]$desiredAccess = 3221225472"));
        assert!(script.contains("[uint32]$shareMode = 3"));
        assert!(script.contains("[uint32]$openExisting = 3"));
        assert!(script.contains("[uint32]$noFileFlags = 0"));
        assert!(script.contains("$inputHandle = [IntPtr]::Zero"));
        assert!(script.contains("$inputHandle -ne [IntPtr]::Zero"));
        assert!(script.contains("$shortcutLabel = 'y'"));
        assert!(!script.contains("??"));
    }

    #[test]
    fn local_host_approval_still_pending_matches_by_fingerprint() {
        let approval = LocalHostApprovalPrompt {
            approval_id: "hexdeck-local-codex-host-codex-session-1-call_1".to_string(),
            task_id: "local-host-approval-codex-session-1-call_1".to_string(),
            thread_id: "local-host-approval-codex-session-1".to_string(),
            participant_id: "codex-session-1".to_string(),
            session_id: "session-1".to_string(),
            summary: "Do you want to allow this command?".to_string(),
            detail_text: "".to_string(),
            command_title: "Codex".to_string(),
            command_line: "whoami".to_string(),
            command_preview: "D:\\projects\\hexdeck".to_string(),
            terminal_app: "PowerShell".to_string(),
            terminal_session_id: "".to_string(),
            runtime_source: Some("queued-context".to_string()),
            project_path: Some("D:\\projects\\hexdeck".to_string()),
            transcript_path: PathBuf::from("C:\\tmp\\codex-session.jsonl"),
            call_id: "call_1".to_string(),
            sort_key_ms: 1,
        };
        let same_fingerprint_different_id = LocalHostApprovalPrompt {
            approval_id: "hexdeck-local-codex-host-codex-session-1-call_2".to_string(),
            task_id: "local-host-approval-codex-session-1-call_2".to_string(),
            thread_id: "local-host-approval-codex-session-1".to_string(),
            participant_id: "codex-session-1".to_string(),
            session_id: "session-1".to_string(),
            summary: "Do you want to allow this command?".to_string(),
            detail_text: "".to_string(),
            command_title: "Codex".to_string(),
            command_line: "whoami".to_string(),
            command_preview: "D:\\projects\\hexdeck".to_string(),
            terminal_app: "PowerShell".to_string(),
            terminal_session_id: "".to_string(),
            runtime_source: Some("queued-context".to_string()),
            project_path: Some("D:\\projects\\hexdeck".to_string()),
            transcript_path: PathBuf::from("C:\\tmp\\codex-session-2.jsonl"),
            call_id: "call_2".to_string(),
            sort_key_ms: 2,
        };

        assert!(local_host_approval_still_pending(
            &approval,
            &[same_fingerprint_different_id]
        ));
        assert!(!local_host_approval_still_pending(&approval, &[]));
    }

    #[test]
    fn build_local_codex_approval_event_keeps_shared_identifiers() {
        let approval = LocalHostApprovalPrompt {
            approval_id: "hexdeck-local-codex-host-codex-session-1-call_1".to_string(),
            task_id: "local-host-approval-codex-session-1-call_1".to_string(),
            thread_id: "local-host-approval-codex-session-1".to_string(),
            participant_id: "codex-session-1".to_string(),
            session_id: "019dbb3a-1234".to_string(),
            summary: "Do you want to allow this command?".to_string(),
            detail_text: "".to_string(),
            command_title: "Codex".to_string(),
            command_line: "mkdir ~/Desktop/example".to_string(),
            command_preview: "/Users/song/projects/hexdeck".to_string(),
            terminal_app: "Ghostty".to_string(),
            terminal_session_id: "ghostty-1".to_string(),
            runtime_source: None,
            project_path: Some("/Users/song/projects/hexdeck".to_string()),
            transcript_path: PathBuf::from("/tmp/codex-session.jsonl"),
            call_id: "call_1".to_string(),
            sort_key_ms: 1,
        };

        let event = build_local_codex_approval_event(
            "approval_detected",
            Some(&approval),
            None,
            Some(json!({ "approvalCount": 1 })),
        );

        assert_eq!(event["kind"], json!("local_codex_approval"));
        assert_eq!(event["stage"], json!("approval_detected"));
        assert_eq!(event["approvalId"], json!(approval.approval_id));
        assert_eq!(event["participantId"], json!(approval.participant_id));
        assert_eq!(event["sessionId"], json!(approval.session_id));
        assert_eq!(event["callId"], json!(approval.call_id));
        assert_eq!(event["projectName"], json!("hexdeck"));
        assert_eq!(event["approvalCount"], json!(1));
    }

    #[test]
    fn parse_local_codex_approval_log_entry_extracts_require_escalated_exec_command() {
        let body = concat!(
            "session_loop{thread_id=019db354-9e87-7e73-8a40-b6a9d503a8bc}: ",
            "ToolCall: exec_command ",
            "{\"cmd\":\"touch ~/Desktop/hexdeck-approval-visible-20260422.txt\",",
            "\"workdir\":\"/Users/song/projects/hexdeck\",",
            "\"yield_time_ms\":1000,",
            "\"max_output_tokens\":2000,",
            "\"sandbox_permissions\":\"require_escalated\",",
            "\"justification\":\"Allow Desktop touch?\"}",
            " thread_id=019db354-9e87-7e73-8a40-b6a9d503a8bc"
        );

        let entry = parse_local_codex_approval_log_entry(
            42,
            1_776_853_075,
            "019db354-9e87-7e73-8a40-b6a9d503a8bc",
            body,
        )
        .expect("expected log-backed approval entry");

        assert_eq!(entry.log_id, 42);
        assert_eq!(
            entry.command,
            "touch ~/Desktop/hexdeck-approval-visible-20260422.txt"
        );
        assert_eq!(entry.workdir, "/Users/song/projects/hexdeck");
        assert_eq!(entry.justification, "Allow Desktop touch?");
        assert_eq!(entry.created_at_ms, 1_776_853_075_000);
    }

    #[test]
    fn parse_local_codex_approval_log_entry_extracts_require_escalated_shell_command() {
        let body = concat!(
            "session_loop{thread_id=019dabe2-fef6-72a0-8a64-f35602d94c2f}: ",
            "ToolCall: shell_command ",
            "{\"command\":\"whoami\",",
            "\"workdir\":\"D:\\\\projects\",",
            "\"sandbox_permissions\":\"require_escalated\",",
            "\"justification\":\"Allow whoami approval check?\"}",
            " thread_id=019dabe2-fef6-72a0-8a64-f35602d94c2f"
        );

        let entry = parse_local_codex_approval_log_entry(
            52,
            1_777_098_146,
            "019dabe2-fef6-72a0-8a64-f35602d94c2f",
            body,
        )
        .expect("expected shell-command log-backed approval entry");

        assert_eq!(entry.log_id, 52);
        assert_eq!(entry.command, "whoami");
        assert_eq!(entry.workdir, "D:\\projects");
        assert_eq!(entry.justification, "Allow whoami approval check?");
        assert_eq!(entry.created_at_ms, 1_777_098_146_000);
    }

    #[test]
    fn local_codex_runtime_state_accepts_terminal_session_id_alias() {
        let runtime: LocalCodexRuntimeState = serde_json::from_str(
            r#"{
                "status": "running",
                "sessionId": "019db354-9e87-7e73-8a40-b6a9d503a8bc",
                "terminalApp": "Ghostty",
                "projectPath": "/Users/song/projects/hexdeck",
                "terminalSessionID": "DFCFDE26-762E-4742-9E9C-5DBC2CEACA5C",
                "updatedAt": "2026-04-23T05:30:07.330Z"
            }"#,
        )
        .expect("expected runtime json to deserialize");

        assert_eq!(
            runtime.terminal_session_id.as_deref(),
            Some("DFCFDE26-762E-4742-9E9C-5DBC2CEACA5C")
        );
        assert!(is_supported_local_codex_runtime(&runtime, 1_777_000_000_000));
    }

    #[test]
    fn local_codex_runtime_state_accepts_windows_desktop_runtime_without_terminal_session() {
        let runtime: LocalCodexRuntimeState = serde_json::from_str(
            r#"{
  "status": "running",
                "sessionId": "019dabe2-fef6-72a0-8a64-f35602d94c2f",
                "terminalApp": "unknown",
                "projectPath": "D:\\projects\\hexdeck",
                "updatedAt": "2026-04-25T06:22:49.894Z"
            }"#,
        )
        .expect("expected windows runtime json to deserialize");

        assert!(is_supported_local_codex_runtime(&runtime, 1_777_000_000_000));
    }

    #[test]
    fn local_codex_runtime_state_accepts_recent_idle_stop_hook_runtime() {
        let runtime: LocalCodexRuntimeState = serde_json::from_str(
            r#"{
                "status": "idle",
                "source": "stop-hook",
                "sessionId": "019dc7c7-5dac-7582-acc8-552f30f50aab",
                "terminalApp": "unknown",
                "projectPath": "C:\\Users\\song\\.codex\\memories",
                "updatedAt": "2026-04-26T03:17:00.973Z"
            }"#,
        )
        .expect("expected stop-hook runtime json to deserialize");

        assert!(is_supported_local_codex_runtime(&runtime, 1_777_173_000_000));
    }

    #[test]
    fn home_dir_from_sources_prefers_home() {
        let home = home_dir_from_sources(
            Some("/Users/song".into()),
            Some("C:\\Users\\song".into()),
            Some("C:".into()),
            Some("\\Users\\song".into()),
        );

        assert_eq!(home, Some(PathBuf::from("/Users/song")));
    }

    #[test]
    fn home_dir_from_sources_falls_back_to_userprofile() {
        let home = home_dir_from_sources(
            None,
            Some("C:\\Users\\song".into()),
            Some("C:".into()),
            Some("\\Users\\song".into()),
        );

        assert_eq!(home, Some(PathBuf::from("C:\\Users\\song")));
    }

    #[test]
    fn home_dir_from_sources_falls_back_to_homedrive_and_homepath() {
        let home =
            home_dir_from_sources(None, None, Some("C:".into()), Some("\\Users\\song".into()));

        assert_eq!(home, Some(PathBuf::from("C:\\Users\\song")));
    }

    fn unique_test_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!("hexdeck-broker-tests-{name}-{nonce}"))
    }

    #[test]
    fn resolve_codex_transcript_path_prefers_runtime_participant_hint_when_session_id_drifts() {
        let root = unique_test_dir("participant-hint");
        let day_dir = root.join("2026").join("04").join("26");
        fs::create_dir_all(&day_dir).expect("day dir");
        let expected = day_dir.join(
            "rollout-2026-04-26T11-13-20-019dc7c6-ff71-7b70-ae33-317d53683d82.jsonl",
        );
        fs::write(&expected, "{}").expect("transcript");

        let resolved = resolve_codex_transcript_path_from_root(
            &root,
            "codex-session-019dc7c6",
            "019dc7c7-5dac-7582-acc8-552f30f50aab",
            Some("2026-04-26T03:13:51.293Z"),
        );

        assert_eq!(resolved, Some(expected.clone()));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_codex_transcript_path_returns_latest_match() {
        let root = unique_test_dir("latest-match");
        let day_dir = root.join("2026").join("04").join("26");
        fs::create_dir_all(&day_dir).expect("day dir");
        let older = day_dir.join(
            "rollout-2026-04-26T08-58-52-019dc74b-e3fb-7a81-8732-1749ae3a1733.jsonl",
        );
        let newer = day_dir.join(
            "rollout-2026-04-26T10-41-04-019dc74b-e3fb-7a81-8732-1749ae3a1733.jsonl",
        );
        fs::write(&older, "{}").expect("older transcript");
        fs::write(&newer, "{}").expect("newer transcript");

        let resolved = resolve_codex_transcript_path_from_root(
            &root,
            "codex-session-019dc74b",
            "019dc74b-e3fb-7a81-8732-1749ae3a1733",
            Some("2026-04-26T11:00:00Z"),
        );

        assert_eq!(resolved, Some(newer.clone()));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_log_backed_local_host_approvals_keeps_recent_log_only_when_transcript_has_not_caught_up(
    ) {
        let runtime = LocalCodexRuntimeState {
            source: Some("user-prompt-submit".to_string()),
            status: Some("running".to_string()),
            session_id: Some("019db354-9e87-7e73-8a40-b6a9d503a8bc".to_string()),
            terminal_app: Some("Ghostty".to_string()),
            project_path: Some("/Users/song/projects/hexdeck".to_string()),
            terminal_session_id: Some("ghostty-1".to_string()),
            updated_at: Some("2026-04-22T10:18:23.831Z".to_string()),
        };
        let approvals = merge_log_backed_local_host_approvals(
            "codex-session-019db354",
            &runtime,
            Path::new("/tmp/codex-session.jsonl"),
            &[PendingLocalCodexApprovalLogEntry {
                log_id: 42,
                command: "touch ~/Desktop/hexdeck-approval-visible-20260422.txt".to_string(),
                workdir: "/Users/song/projects/hexdeck".to_string(),
                justification: "Allow Desktop touch?".to_string(),
                created_at_ms: 1_776_853_075_000,
            }],
            &[],
            &[],
            &HashSet::new(),
        );

        assert_eq!(approvals.len(), 1);
        assert_eq!(
            approvals[0].approval_id,
            "hexdeck-local-codex-host-codex-session-019db354-log-42"
        );
        assert_eq!(
            approvals[0].command_line,
            "touch ~/Desktop/hexdeck-approval-visible-20260422.txt"
        );
        assert_eq!(approvals[0].summary, "Allow Desktop touch?");
    }

    #[test]
    fn merge_log_backed_local_host_approvals_skips_duplicate_when_transcript_pending_exists() {
        let runtime = LocalCodexRuntimeState {
            source: Some("user-prompt-submit".to_string()),
            status: Some("running".to_string()),
            session_id: Some("019db354-9e87-7e73-8a40-b6a9d503a8bc".to_string()),
            terminal_app: Some("Ghostty".to_string()),
            project_path: Some("/Users/song/projects/hexdeck".to_string()),
            terminal_session_id: Some("ghostty-1".to_string()),
            updated_at: Some("2026-04-22T10:18:23.831Z".to_string()),
        };
        let approvals = merge_log_backed_local_host_approvals(
            "codex-session-019db354",
            &runtime,
            Path::new("/tmp/codex-session.jsonl"),
            &[PendingLocalCodexApprovalLogEntry {
                log_id: 42,
                command: "touch ~/Desktop/hexdeck-approval-visible-20260422.txt".to_string(),
                workdir: "/Users/song/projects/hexdeck".to_string(),
                justification: "Allow Desktop touch?".to_string(),
                created_at_ms: 1_776_853_075_000,
            }],
            &[PendingLocalCodexApprovalCall {
                call_id: "call_pending".to_string(),
                command: "touch ~/Desktop/hexdeck-approval-visible-20260422.txt".to_string(),
                workdir: "/Users/song/projects/hexdeck".to_string(),
                justification: "Allow Desktop touch?".to_string(),
                created_at: Some("2026-04-22T10:17:55.057Z".to_string()),
            }],
            &[],
            &HashSet::new(),
        );

        assert!(approvals.is_empty());
    }

    #[test]
    fn merge_log_backed_local_host_approvals_skips_recently_resolved_fingerprints() {
        let runtime = LocalCodexRuntimeState {
            source: Some("user-prompt-submit".to_string()),
            status: Some("running".to_string()),
            session_id: Some("019db354-9e87-7e73-8a40-b6a9d503a8bc".to_string()),
            terminal_app: Some("Ghostty".to_string()),
            project_path: Some("/Users/song/projects/hexdeck".to_string()),
            terminal_session_id: Some("ghostty-1".to_string()),
            updated_at: Some("2026-04-22T10:18:23.831Z".to_string()),
        };
        let mut recent = HashSet::new();
        recent.insert(
            approval_fingerprint(
                Some("codex-session-019db354"),
                Some("touch ~/Desktop/hexdeck-approval-visible-20260422.txt"),
                Some("/Users/song/projects/hexdeck"),
            )
            .expect("expected approval fingerprint"),
        );

        let approvals = merge_log_backed_local_host_approvals(
            "codex-session-019db354",
            &runtime,
            Path::new("/tmp/codex-session.jsonl"),
            &[PendingLocalCodexApprovalLogEntry {
                log_id: 42,
                command: "touch ~/Desktop/hexdeck-approval-visible-20260422.txt".to_string(),
                workdir: "/Users/song/projects/hexdeck".to_string(),
                justification: "Allow Desktop touch?".to_string(),
                created_at_ms: 1_776_853_075_000,
            }],
            &[],
            &[],
            &recent,
        );

        assert!(approvals.is_empty());
    }

    #[test]
    fn merge_log_backed_local_host_approvals_matches_resolved_transcript_when_log_workdir_is_empty()
    {
        let runtime = LocalCodexRuntimeState {
            source: Some("user-prompt-submit".to_string()),
            status: Some("running".to_string()),
            session_id: Some("019db9bc-af6e-79d0-85ae-ec0693f71d16".to_string()),
            terminal_app: Some("Ghostty".to_string()),
            project_path: Some("/Users/song/projects/hexdeck".to_string()),
            terminal_session_id: Some("ghostty-1".to_string()),
            updated_at: Some("2026-04-23T10:11:18.802Z".to_string()),
        };

        let approvals = merge_log_backed_local_host_approvals(
            "codex-session-019db9bc",
            &runtime,
            Path::new("/tmp/codex-session.jsonl"),
            &[PendingLocalCodexApprovalLogEntry {
                log_id: 16839635,
                command: "mkdir ~/Desktop/hexdeck-codex-approval-check-210260431-x".to_string(),
                workdir: "".to_string(),
                justification: "Do you want to create the requested folder on your Desktop?"
                    .to_string(),
                created_at_ms: 1_776_939_082_000,
            }],
            &[],
            &[PendingLocalCodexApprovalCall {
                call_id: "call_CbSYMBOwNL7RChU7onx5t7QF".to_string(),
                command: "mkdir ~/Desktop/hexdeck-codex-approval-check-210260431-x".to_string(),
                workdir: "/Users/song/projects/hexdeck".to_string(),
                justification: "Do you want to create the requested folder on your Desktop?"
                    .to_string(),
                created_at: Some("2026-04-23T10:11:22.974Z".to_string()),
            }],
            &HashSet::new(),
        );

        assert!(approvals.is_empty());
    }

    #[test]
    fn suppress_recently_resolved_local_host_approvals_skips_transcript_backed_items() {
        let approval = LocalHostApprovalPrompt {
            approval_id: "hexdeck-local-codex-host-codex-session-1-call_1".to_string(),
            task_id: "local-host-approval-codex-session-1-call_1".to_string(),
            thread_id: "local-host-approval-codex-session-1".to_string(),
            participant_id: "codex-session-1".to_string(),
            session_id: "session-1".to_string(),
            summary: "Do you want to allow this command?".to_string(),
            detail_text: "".to_string(),
            command_title: "Codex".to_string(),
            command_line: "mkdir ~/Desktop/example".to_string(),
            command_preview: "/Users/song/projects/hexdeck".to_string(),
            terminal_app: "Ghostty".to_string(),
            terminal_session_id: "ghostty-1".to_string(),
            runtime_source: None,
            project_path: Some("/Users/song/projects/hexdeck".to_string()),
            transcript_path: PathBuf::from("/tmp/codex-session.jsonl"),
            call_id: "call_1".to_string(),
            sort_key_ms: 1_776_853_075_000,
        };
        let mut recent = HashSet::new();
        recent.insert(
            approval_fingerprint(
                Some("codex-session-1"),
                Some("mkdir ~/Desktop/example"),
                Some("/Users/song/projects/hexdeck"),
            )
            .expect("expected approval fingerprint"),
        );

        let approvals = suppress_recently_resolved_local_host_approvals(vec![approval], &recent);

        assert!(approvals.is_empty());
    }

    #[test]
    fn find_matching_codex_hook_approvals_matches_only_unresolved_duplicates() {
        let approval = LocalHostApprovalPrompt {
            approval_id: "hexdeck-local-codex-host-codex-session-1-call_1".to_string(),
            task_id: "local-host-approval-codex-session-1-call_1".to_string(),
            thread_id: "local-host-approval-codex-session-1".to_string(),
            participant_id: "codex-session-1".to_string(),
            session_id: "session-1".to_string(),
            summary: "Do you want to allow this command?".to_string(),
            detail_text: "".to_string(),
            command_title: "Codex".to_string(),
            command_line: "rm -f ~/Desktop/test.txt".to_string(),
            command_preview: "/Users/song/projects/hexdeck".to_string(),
            terminal_app: "Ghostty".to_string(),
            terminal_session_id: "ghostty-1".to_string(),
            runtime_source: None,
            project_path: Some("/Users/song/projects/hexdeck".to_string()),
            transcript_path: PathBuf::from("/tmp/codex-session.jsonl"),
            call_id: "call_1".to_string(),
            sort_key_ms: 1,
        };
        let events = vec![
            json!({
                "eventId": 1,
                "kind": "request_approval",
                "taskId": "hook-task-1",
                "payload": {
                    "approvalId": "hook-approval-1",
                    "participantId": "codex-session-1",
                    "delivery": { "source": "codex-hook-approval" },
                    "nativeHookApproval": { "agentTool": "codex" },
                    "body": {
                        "summary": "Codex needs approval to run Bash.",
                        "commandLine": "rm -f ~/Desktop/test.txt",
                        "commandPreview": "/Users/song/projects/hexdeck"
                    }
                }
            }),
            json!({
                "eventId": 2,
                "kind": "request_approval",
                "taskId": "hook-task-2",
                "payload": {
                    "approvalId": "hook-approval-2",
                    "participantId": "codex-session-1",
                    "delivery": { "source": "codex-hook-approval" },
                    "nativeHookApproval": { "agentTool": "codex" },
                    "body": {
                        "summary": "Codex needs approval to run Bash.",
                        "commandLine": "mkdir -p /tmp/example",
                        "commandPreview": "/Users/song/projects/hexdeck"
                    }
                }
            }),
            json!({
                "eventId": 3,
                "kind": "respond_approval",
                "taskId": "hook-task-1",
                "payload": {
                    "approvalId": "hook-approval-1",
                    "participantId": "human.local",
                    "decision": "approved"
                }
            }),
            json!({
                "eventId": 4,
                "kind": "request_approval",
                "taskId": "hook-task-3",
                "payload": {
                    "approvalId": "hook-approval-3",
                    "participantId": "codex-session-1",
                    "delivery": { "source": "codex-hook-approval" },
                    "nativeHookApproval": { "agentTool": "codex" },
                    "body": {
                        "summary": "Codex needs approval to run Bash.",
                        "commandLine": "rm -f ~/Desktop/test.txt",
                        "commandPreview": "/Users/song/projects/hexdeck"
                    }
                }
            }),
        ];

        let matches = find_matching_codex_hook_approvals(&events, &approval);

        assert_eq!(
            matches,
            vec![("hook-approval-3".to_string(), "hook-task-3".to_string())]
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn local_codex_host_terminal_command_uses_verified_codex_shortcuts() {
        assert_eq!(
            local_codex_host_terminal_command("approved", Some("always")).unwrap(),
            "send key \"p\" action press to targetTerminal\n    delay 0.02\n    send key \"p\" action release to targetTerminal"
        );
        assert_eq!(
            local_codex_host_terminal_command("approved", Some("yes")).unwrap(),
            "send key \"y\" action press to targetTerminal\n    delay 0.02\n    send key \"y\" action release to targetTerminal"
        );
        assert_eq!(
            local_codex_host_terminal_command("denied", None).unwrap(),
            "send key \"escape\" action press to targetTerminal\n    delay 0.02\n    send key \"escape\" action release to targetTerminal"
        );
    }

    #[test]
    fn local_codex_host_approval_shortcut_matches_codex_desktop_choices() {
        assert_eq!(
            local_codex_host_approval_shortcut("approved", Some("always")).unwrap(),
            "p"
        );
        assert_eq!(
            local_codex_host_approval_shortcut("approved", Some("yes")).unwrap(),
            "y"
        );
        assert_eq!(
            local_codex_host_approval_shortcut("cancelled", None).unwrap(),
            "escape"
        );
    }

    #[test]
    fn broker_start_guard_allows_only_one_active_lease() {
        let mut state = BrokerStartGuardState::default();

        assert!(try_acquire_broker_start_guard(&mut state));
        assert!(!try_acquire_broker_start_guard(&mut state));

        release_broker_start_guard(&mut state);

        assert!(try_acquire_broker_start_guard(&mut state));
    }
}
