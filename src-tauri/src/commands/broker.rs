use chrono::Utc;
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::future::Future;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tar::Archive;
use tauri::{AppHandle, Manager};
use tokio::time::{sleep, Duration};

const REPLAY_PAGE_SIZE: usize = 100;

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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerApprovalResponsePayload {
    pub approval_id: String,
    pub task_id: String,
    pub from_participant_id: String,
    pub decision: String,
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

async fn broker_get_json(broker_url: &str, path: &str) -> Result<serde_json::Value, String> {
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

fn value_items(payload: serde_json::Value, key: &str) -> serde_json::Value {
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

async fn load_all_replay_events(broker_url: &str) -> Result<serde_json::Value, String> {
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
            if let Some(metadata) = presence_metadata_by_participant.get(&participant_id).cloned() {
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
    let all_events = value_items(events, "items").as_array().cloned().unwrap_or_default();
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
        "approvals": []
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
pub async fn respond_to_broker_approval(
    broker_url: Option<String>,
    input: BrokerApprovalResponsePayload,
) -> Result<(), String> {
    let broker_url = broker_url.unwrap_or_else(|| "http://127.0.0.1:4318".to_string());
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
        let status = Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status()
            .map_err(|e| format!("failed_to_stop_broker: {}", e))?;
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
                    stop_running_broker(log_path.as_path(), broker_url, &runtime_paths.heartbeat).await
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

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
        let items = value_items(events, "items").as_array().cloned().expect("array");
        assert_eq!(items.len(), 101);
        assert_eq!(items.first(), Some(&json!({ "eventId": 1, "kind": "report_progress" })));
        assert_eq!(items.last(), Some(&json!({ "eventId": 101, "kind": "ask_clarification" })));
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
}
