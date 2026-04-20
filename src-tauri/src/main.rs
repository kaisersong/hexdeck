#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs::OpenOptions;
use std::io::Write;
use std::process::Command;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    utils::config::BackgroundThrottlingPolicy, Manager, PhysicalPosition, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_positioner::{Position, WindowExt};

const TRAY_MENU_OPEN_ID: &str = "hexdeck-tray-open";
const TRAY_MENU_SETTINGS_ID: &str = "hexdeck-tray-settings";
const TRAY_MENU_QUIT_ID: &str = "hexdeck-tray-quit";

// ============================================================================
// CLI Subcommand Definitions
// ============================================================================

#[derive(Parser)]
#[command(name = "hexdeck")]
#[command(about = "HexDeck - Agent desktop companion")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Manage terminal title aliases
    Title {
        #[command(subcommand)]
        action: TitleActions,
    },
}

#[derive(Subcommand)]
enum TitleActions {
    /// Append an alias to the current terminal title
    Append {
        /// The broker alias to append, e.g., "@claude2"
        #[arg(short, long)]
        alias: String,
        /// Project name for context (optional, defaults to current directory)
        #[arg(short, long)]
        project: Option<String>,
    },
    /// Clear alias from the current terminal title
    Clear {
        /// The broker alias to remove, e.g., "@claude2"
        #[arg(short, long)]
        alias: String,
    },
}

// ============================================================================
// Tauri Jump Commands (existing)
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JumpTargetPayload {
    #[serde(rename = "participantId")]
    _participant_id: String,
    _terminal_app: String,
    #[serde(rename = "precision")]
    _precision: String,
    session_hint: Option<String>,
    #[serde(rename = "terminalTTY")]
    terminal_tty: Option<String>,
    #[serde(rename = "terminalSessionID")]
    terminal_session_id: Option<String>,
    project_path: Option<String>,
}

#[derive(Debug, Serialize)]
struct JumpResultPayload {
    ok: bool,
    precision: String,
    reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivityCardWindowMeasurementPayload {
    target_height: f64,
    inner_height: f64,
    outer_height: f64,
    scale_factor: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayClickAction {
    TogglePanel,
    Ignore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PanelShowAnchor {
    Current,
    TrayCenter,
}

fn escape_applescript(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn execute_osascript(script: &str) -> Result<String, String> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| format!("failed_to_launch_osascript: {error}"))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            "osascript_failed".to_string()
        } else {
            stderr
        })
    }
}

fn normalize_precision(value: &str, fallback: &str) -> String {
    match value {
        "exact" | "best_effort" | "unsupported" => value.to_string(),
        _ => fallback.to_string(),
    }
}

fn jump_result(ok: bool, precision: &str, reason: Option<String>) -> JumpResultPayload {
    JumpResultPayload {
        ok,
        precision: precision.to_string(),
        reason,
    }
}

fn panel_window_size() -> (f64, f64) {
    (344.0, 540.0)
}

fn panel_window_resizable() -> bool {
    false
}

fn panel_window_starts_visible() -> bool {
    false
}

fn panel_window_always_on_top() -> bool {
    true
}

fn panel_window_decorated() -> bool {
    false
}

fn panel_window_skips_taskbar() -> bool {
    true
}

fn activity_card_window_size() -> (f64, f64) {
    (680.0, 152.0)
}

fn activity_card_window_resizable() -> bool {
    false
}

fn activity_card_window_top_margin() -> i32 {
    16
}

fn activity_card_window_starts_visible_for(preview: Option<&str>) -> bool {
    matches!(preview, Some(value) if !value.trim().is_empty() && !value.trim().starts_with('&'))
}

fn activity_card_window_focuses_on_show_for(preview: Option<&str>) -> bool {
    activity_card_window_starts_visible_for(preview)
}

fn activity_card_window_focuses_on_show() -> bool {
    activity_card_window_focuses_on_show_for(activity_card_preview_mode().as_deref())
}

fn activity_card_window_focusable_for(preview: Option<&str>) -> bool {
    activity_card_window_focuses_on_show_for(preview)
}

fn activity_card_window_focusable() -> bool {
    activity_card_window_focusable_for(activity_card_preview_mode().as_deref())
}

fn log_activity_card_window_state(stage: &str, window: &WebviewWindow) {
    if activity_card_preview_mode().is_none() {
        return;
    }

    eprintln!(
        "[activity-card-preview] {stage}: visible={:?} pos={:?} inner={:?} outer={:?}",
        window.is_visible(),
        window.outer_position(),
        window.inner_size(),
        window.outer_size()
    );
}

fn activity_card_preview_mode() -> Option<String> {
    let preview = env::var("HEXDECK_ACTIVITY_CARD_PREVIEW").ok()?;
    let trimmed = preview.trim();
    if trimmed.is_empty() {
        return None;
    }

    Some(trimmed.to_string())
}

fn activity_card_window_location_for(preview: Option<&str>) -> String {
    match preview {
        Some(value) if value.trim().starts_with('&') => format!("index.html?view=activity-card{}", value.trim()),
        Some(value) if !value.trim().is_empty() => format!("index.html?view=activity-card&preview={}", value.trim()),
        _ => "index.html?view=activity-card".to_string(),
    }
}

fn activity_card_window_location() -> String {
    activity_card_window_location_for(activity_card_preview_mode().as_deref())
}

fn setup_creates_panel_window(activity_card_preview: Option<&str>) -> bool {
    activity_card_preview.is_none()
}

fn tray_click_action(button: MouseButton, state: MouseButtonState) -> TrayClickAction {
    if button == MouseButton::Left && state == MouseButtonState::Up {
        TrayClickAction::TogglePanel
    } else {
        TrayClickAction::Ignore
    }
}

fn tray_menu_item_ids() -> [&'static str; 3] {
    [
        TRAY_MENU_OPEN_ID,
        TRAY_MENU_SETTINGS_ID,
        TRAY_MENU_QUIT_ID,
    ]
}

fn desktop_shell_uses_accessory_activation_policy() -> bool {
    true
}

fn activity_card_window_position(
    work_area_position: PhysicalPosition<i32>,
    work_area_width: u32,
    scale_factor: f64,
) -> PhysicalPosition<i32> {
    let (window_width, _) = activity_card_window_size();
    let safe_scale_factor = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let window_width_physical = (window_width * safe_scale_factor).round() as i32;
    let top_margin_physical = (activity_card_window_top_margin() as f64 * safe_scale_factor).round() as i32;
    let centered_x = work_area_position.x + ((work_area_width as i32 - window_width_physical).max(0) / 2);
    let top_y = work_area_position.y + top_margin_physical;

    PhysicalPosition::new(centered_x, top_y)
}

fn activity_card_target_monitor_index(
    work_area_positions: &[PhysicalPosition<i32>],
    primary_index: Option<usize>,
) -> Option<usize> {
    work_area_positions
        .iter()
        .position(|position| position.x == 0 && position.y == 0)
        .or(primary_index)
        .or_else(|| (!work_area_positions.is_empty()).then_some(0))
}

fn activity_card_target_monitor(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
) -> tauri::Result<Option<tauri::Monitor>> {
    let monitors = app.available_monitors()?;
    if activity_card_preview_mode().is_some() {
        for (index, monitor) in monitors.iter().enumerate() {
            let work_area = monitor.work_area();
            eprintln!(
                "[activity-card-preview] monitor[{index}]: pos={:?} size={:?} scale={}",
                work_area.position,
                work_area.size,
                monitor.scale_factor()
            );
        }
    }
    if monitors.is_empty() {
        return window.current_monitor();
    }

    let primary_work_area_position = app
        .primary_monitor()?
        .map(|monitor| monitor.work_area().position);
    let primary_index = primary_work_area_position.and_then(|primary_position| {
        monitors.iter().position(|monitor| {
            let position = monitor.work_area().position;
            position.x == primary_position.x && position.y == primary_position.y
        })
    });
    let work_area_positions = monitors
        .iter()
        .map(|monitor| monitor.work_area().position)
        .collect::<Vec<_>>();

    Ok(activity_card_target_monitor_index(&work_area_positions, primary_index)
        .and_then(|index| monitors.into_iter().nth(index)))
}

fn expanded_window_size() -> (f64, f64) {
    (960.0, 720.0)
}

fn expanded_window_resizable() -> bool {
    true
}

fn ensure_panel_window(app: &tauri::AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window("panel") {
        return Ok(window);
    }

    let (width, height) = panel_window_size();
    WebviewWindowBuilder::new(app, "panel", WebviewUrl::App("index.html".into()))
        .title("HexDeck")
        .inner_size(width, height)
        .resizable(panel_window_resizable())
        .visible(panel_window_starts_visible())
        .always_on_top(panel_window_always_on_top())
        .decorations(panel_window_decorated())
        .skip_taskbar(panel_window_skips_taskbar())
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .build()
}

fn expanded_window_location(section: &str) -> String {
    format!("index.html?view=expanded&section={section}")
}

fn sync_window_location(window: &WebviewWindow, location: &str) -> tauri::Result<()> {
    window.eval(&format!("window.location.replace({location:?});"))
}

fn current_window_location_matches(current_url: &str, location: &str) -> bool {
    current_url.ends_with(location.trim_start_matches('/'))
}

fn sync_window_location_if_needed(window: &WebviewWindow, location: &str) -> tauri::Result<()> {
    let current_url_matches = window
        .url()
        .map(|url| current_window_location_matches(url.as_str(), location))
        .unwrap_or(false);

    if current_url_matches {
        return Ok(());
    }

    sync_window_location(window, location)
}

fn ensure_expanded_window(app: &tauri::AppHandle, section: &str) -> tauri::Result<WebviewWindow> {
    let location = expanded_window_location(section);

    if let Some(window) = app.get_webview_window("expanded") {
        sync_window_location_if_needed(&window, &location)?;
        return Ok(window);
    }

    let (width, height) = expanded_window_size();
    WebviewWindowBuilder::new(app, "expanded", WebviewUrl::App(location.into()))
        .title("HexDeck Expanded")
        .inner_size(width, height)
        .resizable(expanded_window_resizable())
        .visible(false)
        .build()
}

fn ensure_activity_card_window(app: &tauri::AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window("activity-card") {
        log_activity_card_window_state("ensure-existing", &window);
        return Ok(window);
    }

    let (width, height) = activity_card_window_size();
    let location = activity_card_window_location();
    if activity_card_preview_mode().is_some() {
        eprintln!("[activity-card-preview] location: {location}");
    }
    WebviewWindowBuilder::new(
        app,
        "activity-card",
        WebviewUrl::App(location.into()),
    )
    .title("HexDeck Activity Card")
    .inner_size(width, height)
    .resizable(activity_card_window_resizable())
    .visible(false)
    .focusable(activity_card_window_focusable())
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .decorations(false)
    .skip_taskbar(true)
    .background_throttling(BackgroundThrottlingPolicy::Disabled)
    .build()
    .inspect(|window| {
        if activity_card_preview_mode().is_some() {
            log_activity_card_window_state("created", window);
            window.on_window_event(|event| {
                eprintln!("[activity-card-preview] window-event: {event:?}");
            });
        }
    })
}

fn position_activity_card_window(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
) -> tauri::Result<()> {
    let monitor = activity_card_target_monitor(app, window)?;

    if let Some(monitor) = monitor {
        let work_area = monitor.work_area();
        let position = activity_card_window_position(
            work_area.position,
            work_area.size.width,
            monitor.scale_factor(),
        );
        window.set_position(position)?;
    }

    Ok(())
}

fn show_panel_window(
    app: &tauri::AppHandle,
    anchor: PanelShowAnchor,
) -> tauri::Result<WebviewWindow> {
    let window = ensure_panel_window(app)?;

    if anchor == PanelShowAnchor::TrayCenter {
        window.move_window_constrained(Position::TrayCenter)?;
    }

    window.show()?;
    window.set_focus()?;
    Ok(window)
}

fn toggle_panel_window(app: &tauri::AppHandle, anchor: PanelShowAnchor) -> tauri::Result<()> {
    let window = ensure_panel_window(app)?;
    let visible = window.is_visible()?;

    if visible {
        window.hide()?;
        return Ok(());
    }

    show_panel_window(app, anchor)?;
    Ok(())
}

#[tauri::command]
fn toggle_panel_command(app: tauri::AppHandle) -> Result<(), String> {
    toggle_panel_window(&app, PanelShowAnchor::Current).map_err(|error| error.to_string())
}

fn open_expanded_window_for_app(app: &tauri::AppHandle, section: &str) -> tauri::Result<()> {
    let window = ensure_expanded_window(app, section)?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

#[tauri::command]
fn open_expanded_window(app: tauri::AppHandle, section: String) -> Result<(), String> {
    open_expanded_window_for_app(&app, &section).map_err(|error| error.to_string())
}

fn show_activity_card_window_for_app(app: &tauri::AppHandle) -> tauri::Result<()> {
    let window = ensure_activity_card_window(app)?;
    log_activity_card_window_state("show-before-position", &window);
    if matches!(window.is_visible(), Ok(false)) {
        sync_window_location_if_needed(&window, &activity_card_window_location())?;
    }
    position_activity_card_window(app, &window)?;
    window.set_focusable(activity_card_window_focusable())?;
    window.set_always_on_top(true)?;
    window.set_visible_on_all_workspaces(true)?;

    if activity_card_window_focuses_on_show() {
        window.show()?;
    } else {
        show_activity_card_window_inactive(&window)?;
    }
    log_activity_card_window_state("show-after-show", &window);

    if activity_card_window_focuses_on_show() {
        window.set_focus()?;
        log_activity_card_window_state("show-after-focus", &window);
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn show_activity_card_window_inactive(window: &WebviewWindow) -> tauri::Result<()> {
    let ns_window = window.ns_window()?;
    let ns_window: &objc2_app_kit::NSWindow = unsafe { &*ns_window.cast() };
    unsafe {
        ns_window.orderFrontRegardless();
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn show_activity_card_window_inactive(window: &WebviewWindow) -> tauri::Result<()> {
    window.show()
}

#[tauri::command]
fn prepare_activity_card_window(app: tauri::AppHandle) -> Result<(), String> {
    prepare_activity_card_window_for_app(&app).map_err(|error| error.to_string())
}

fn should_prepare_activity_card_window(
    window_visible: bool,
    prepare_event_id: Option<u64>,
) -> bool {
    prepare_event_id.is_some() && !window_visible
}

fn prepare_activity_card_window_for_app(app: &tauri::AppHandle) -> tauri::Result<()> {
    let window = ensure_activity_card_window(app)?;
    if matches!(window.is_visible(), Ok(true)) {
        return Ok(());
    }
    if matches!(window.is_visible(), Ok(false)) {
        sync_window_location_if_needed(&window, &activity_card_window_location())?;
    }
    position_activity_card_window(app, &window)?;
    window.set_focusable(activity_card_window_focusable())?;
    window.set_always_on_top(true)?;
    window.set_visible_on_all_workspaces(true)
}

fn prepare_activity_card_window_for_app_silent(app: &tauri::AppHandle) {
    let _ = prepare_activity_card_window_for_app(app);
}

#[tauri::command]
fn show_activity_card_window(app: tauri::AppHandle) -> Result<(), String> {
    show_activity_card_window_for_app(&app).map_err(|error| error.to_string())
}

#[tauri::command]
fn resize_activity_card_window(
    app: tauri::AppHandle,
    width: f64,
    height: f64,
) -> Result<ActivityCardWindowMeasurementPayload, String> {
    let window = ensure_activity_card_window(&app).map_err(|error| error.to_string())?;
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    let inner_size = window.inner_size().map_err(|error| error.to_string())?;
    let outer_size = window.outer_size().map_err(|error| error.to_string())?;

    log_activity_card_window_state("resize-after-set-size", &window);

    Ok(ActivityCardWindowMeasurementPayload {
        target_height: height,
        inner_height: inner_size.height as f64 / scale_factor,
        outer_height: outer_size.height as f64 / scale_factor,
        scale_factor,
    })
}

#[tauri::command]
fn hide_activity_card_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("activity-card") {
        log_activity_card_window_state("hide-before", &window);
        window.hide().map_err(|error| error.to_string())?;
        log_activity_card_window_state("hide-after", &window);
    }

    Ok(())
}

#[tauri::command]
fn debug_log_activity_card_frontend(message: String) -> Result<(), String> {
    if activity_card_preview_mode().is_some() {
        eprintln!("[activity-card-frontend] {message}");
    }

    Ok(())
}

fn broker_event_id(value: &serde_json::Value) -> Option<u64> {
    value
        .get("eventId")
        .and_then(serde_json::Value::as_u64)
        .or_else(|| value.get("id").and_then(serde_json::Value::as_u64))
}

fn broker_event_kind(value: &serde_json::Value) -> Option<&str> {
    value
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .or_else(|| value.get("type").and_then(serde_json::Value::as_str))
}

fn broker_event_payload(value: &serde_json::Value) -> Option<&serde_json::Value> {
    value.get("payload").filter(|payload| payload.is_object())
}

fn broker_payload_body(payload: &serde_json::Value) -> Option<&serde_json::Value> {
    payload.get("body").filter(|body| body.is_object())
}

fn broker_payload_summary(payload: &serde_json::Value) -> Option<&str> {
    broker_payload_body(payload)
        .and_then(|body| body.get("summary").and_then(serde_json::Value::as_str))
        .or_else(|| payload.get("summary").and_then(serde_json::Value::as_str))
}

fn is_suppressed_activity_card_event(value: &serde_json::Value) -> bool {
    let task_id = value.get("taskId").and_then(serde_json::Value::as_str);
    let payload = broker_event_payload(value);
    let approval_id = payload
        .and_then(|payload| payload.get("approvalId").and_then(serde_json::Value::as_str));
    let summary = payload.and_then(broker_payload_summary);

    summary
        .map(|summary| summary.trim().to_ascii_lowercase().starts_with("codex needs approval"))
        .unwrap_or(false)
        || approval_id
            .map(|approval_id| approval_id.starts_with("preview-approval-"))
            .unwrap_or(false)
        || task_id
            .map(|task_id| task_id.starts_with("preview-task-"))
            .unwrap_or(false)
}

fn is_popup_activity_card_event(value: &serde_json::Value) -> bool {
    if is_suppressed_activity_card_event(value) {
        return false;
    }

    match broker_event_kind(value) {
        Some("request_approval") | Some("ask_clarification") => true,
        Some("report_progress") => broker_event_payload(value)
            .and_then(|payload| payload.get("stage").and_then(serde_json::Value::as_str))
            == Some("completed"),
        _ => false,
    }
}

async fn load_latest_broker_event_id(broker_url: &str) -> Result<u64, String> {
    let events = commands::broker::load_all_replay_events(broker_url).await?;
    Ok(events
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(broker_event_id)
        .max()
        .unwrap_or(0))
}

#[derive(Debug, Clone)]
struct ActivityCardBrokerWatcher {
    initialized: bool,
    after: u64,
    last_prepared_popup_event_id: Option<u64>,
    consecutive_error_count: u32,
}

impl ActivityCardBrokerWatcher {
    fn new(initial_after: Option<u64>) -> Self {
        Self {
            initialized: initial_after.is_some(),
            after: initial_after.unwrap_or(0),
            last_prepared_popup_event_id: None,
            consecutive_error_count: 0,
        }
    }

    fn note_poll_success(&mut self) {
        self.consecutive_error_count = 0;
    }

    fn note_poll_error(&mut self) {
        self.consecutive_error_count = self.consecutive_error_count.saturating_add(1);
    }

    fn error_backoff_duration(&self) -> std::time::Duration {
        match self.consecutive_error_count {
            0 | 1 => std::time::Duration::from_secs(0),
            2 => std::time::Duration::from_secs(1),
            3 => std::time::Duration::from_secs(2),
            _ => std::time::Duration::from_secs(5),
        }
    }

    fn take_prepare_event_id(&mut self, page: &[serde_json::Value]) -> Option<u64> {
        let next_after = page.iter().filter_map(broker_event_id).max()?;

        if !self.initialized {
            self.after = self.after.max(next_after);
            self.initialized = true;
            return None;
        }

        self.after = self.after.max(next_after);

        let latest_popup_event_id = page
            .iter()
            .filter(|value| is_popup_activity_card_event(value))
            .filter_map(broker_event_id)
            .max();

        match latest_popup_event_id {
            Some(event_id) if Some(event_id) != self.last_prepared_popup_event_id => {
                self.last_prepared_popup_event_id = Some(event_id);
                Some(event_id)
            }
            _ => None,
        }
    }
}

async fn poll_activity_card_events(app: tauri::AppHandle) {
    let broker_url = "http://127.0.0.1:4318".to_string();
    let initial_after = load_latest_broker_event_id(&broker_url).await.ok();
    let mut watcher = ActivityCardBrokerWatcher::new(initial_after);
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));

    loop {
        interval.tick().await;

        let payload = match commands::broker::broker_get_json(
            &broker_url,
            &format!("/events/replay?after={}", watcher.after),
        )
        .await
        {
            Ok(payload) => payload,
            Err(_) => {
                watcher.note_poll_error();
                let backoff = watcher.error_backoff_duration();
                if !backoff.is_zero() {
                    tokio::time::sleep(backoff).await;
                }
                continue;
            }
        };

        watcher.note_poll_success();
        let events = commands::broker::value_items(payload, "items");
        let page = events.as_array().cloned().unwrap_or_default();
        let prepare_event_id = watcher.take_prepare_event_id(&page);
        let window_visible = app
            .get_webview_window("activity-card")
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false);

        if should_prepare_activity_card_window(window_visible, prepare_event_id) {
            let app_for_thread = app.clone();
            let app_for_prepare = app.clone();
            let _ = app_for_thread.run_on_main_thread(move || {
                prepare_activity_card_window_for_app_silent(&app_for_prepare);
            });
        }
    }
}

fn start_activity_card_event_watcher(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        poll_activity_card_events(app).await;
    });
}

fn build_tray_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let [open_id, settings_id, quit_id] = tray_menu_item_ids();
    let open_item = MenuItem::with_id(app, open_id, "Open HexDeck", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, settings_id, "Settings", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, quit_id, "Quit HexDeck", true, None::<&str>)?;

    Menu::with_items(
        app,
        &[&open_item, &settings_item, &separator, &quit_item],
    )
}

fn handle_tray_menu_event(app: &tauri::AppHandle, menu_id: &str) {
    let result = match menu_id {
        TRAY_MENU_OPEN_ID => show_panel_window(app, PanelShowAnchor::Current).map(|_| ()),
        TRAY_MENU_SETTINGS_ID => open_expanded_window_for_app(app, "settings"),
        TRAY_MENU_QUIT_ID => {
            app.exit(0);
            Ok(())
        }
        _ => Ok(()),
    };

    if let Err(error) = result {
        eprintln!("[tray] failed to handle menu item {menu_id}: {error}");
    }
}

fn handle_tray_icon_event(app: &tauri::AppHandle, event: TrayIconEvent) {
    tauri_plugin_positioner::on_tray_event(app, &event);

    let TrayIconEvent::Click {
        button,
        button_state,
        ..
    } = event
    else {
        return;
    };

    if tray_click_action(button, button_state) == TrayClickAction::TogglePanel {
        if let Err(error) = toggle_panel_window(app, PanelShowAnchor::TrayCenter) {
            eprintln!("[tray] failed to toggle panel: {error}");
        }
    }
}

fn setup_tray_icon(app: &tauri::AppHandle) -> tauri::Result<()> {
    let menu = build_tray_menu(app)?;
    let mut tray = TrayIconBuilder::with_id("hexdeck-tray")
        .tooltip("HexDeck")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            handle_tray_menu_event(app, event.id().0.as_str());
        })
        .on_tray_icon_event(|tray, event| {
            handle_tray_icon_event(tray.app_handle(), event);
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon).icon_as_template(cfg!(target_os = "macos"));
    }

    tray.build(app)?;
    Ok(())
}

#[tauri::command]
fn jump_with_ghostty(target: JumpTargetPayload) -> Result<JumpResultPayload, String> {
    let session_hint = escape_applescript(target.terminal_session_id.as_deref().unwrap_or(""));
    let project_path = escape_applescript(target.project_path.as_deref().unwrap_or(""));

    let script = format!(
        r#"
tell application "Ghostty"
    activate
    set targetWindow to missing value
    set targetTab to missing value
    set targetTerminal to missing value
    set projectPathMatches to 0

    if "{session_hint}" is not "" then
        repeat with aWindow in windows
            repeat with aTab in tabs of aWindow
                repeat with aTerminal in terminals of aTab
                    if (id of aTerminal as text) is "{session_hint}" then
                        set targetWindow to aWindow
                        set targetTab to aTab
                        set targetTerminal to aTerminal
                        exit repeat
                    end if
                end repeat
                if targetTerminal is not missing value then
                    exit repeat
                end if
            end repeat
            if targetTerminal is not missing value then
                exit repeat
            end if
        end repeat
    end if

    if targetTerminal is missing value and "{project_path}" is not "" then
        repeat with aWindow in windows
            repeat with aTab in tabs of aWindow
                repeat with aTerminal in terminals of aTab
                    if (working directory of aTerminal as text) contains "{project_path}" then
                        set projectPathMatches to projectPathMatches + 1
                        if targetTerminal is missing value then
                            set targetWindow to aWindow
                            set targetTab to aTab
                            set targetTerminal to aTerminal
                        end if
                    end if
                end repeat
            end repeat
        end repeat
    end if

    if targetTerminal is missing value then
        return "best_effort"
    end if

    if "{session_hint}" is "" and projectPathMatches > 1 then
        return "best_effort"
    end if

    if targetWindow is not missing value then
        activate window targetWindow
        delay 0.05
    end if

    if targetTab is not missing value then
        select tab targetTab
        delay 0.05
    end if

    if "{session_hint}" is "" then
        focus targetTerminal
        delay 0.1
        return "exact"
    end if

    repeat 3 times
        focus targetTerminal
        delay 0.1
        try
            if (id of focused terminal of selected tab of front window as text) is "{session_hint}" then
                return "exact"
            end if
        end try
    end repeat
end tell
return "best_effort"
"#
    );

    match execute_osascript(&script) {
        Ok(result) => Ok(jump_result(
            true,
            &normalize_precision(&result, "best_effort"),
            None,
        )),
        Err(reason) => Ok(jump_result(false, "unsupported", Some(reason))),
    }
}

#[tauri::command]
fn jump_with_iterm(target: JumpTargetPayload) -> Result<JumpResultPayload, String> {
    let session_hint = escape_applescript(target.session_hint.as_deref().unwrap_or(""));

    let script = format!(
        r#"
tell application "iTerm2"
    activate
    if "{session_hint}" is not "" then
        repeat with aWindow in windows
            repeat with aTab in tabs of aWindow
                repeat with aSession in sessions of aTab
                    if (unique id of aSession contains "{session_hint}") or (name of aSession contains "{session_hint}") or (tty of aSession contains "{session_hint}") then
                        tell aTab to select
                        tell aSession to select
                        activate
                        return "exact"
                    end if
                end repeat
            end repeat
        end repeat
    end if
    return "best_effort"
end tell
"#
    );

    match execute_osascript(&script) {
        Ok(result) => Ok(jump_result(
            true,
            &normalize_precision(&result, "best_effort"),
            None,
        )),
        Err(reason) => Ok(jump_result(false, "unsupported", Some(reason))),
    }
}

#[tauri::command]
fn jump_with_terminal_app(target: JumpTargetPayload) -> Result<JumpResultPayload, String> {
    let terminal_tty = escape_applescript(
        target
            .terminal_tty
            .as_deref()
            .or(target.session_hint.as_deref())
            .unwrap_or(""),
    );
    let script = format!(
        r#"
tell application "Terminal"
    activate
    if "{terminal_tty}" is not "" then
        repeat with aWindow in windows
            repeat with aTab in tabs of aWindow
                if (tty of aTab as text) is "{terminal_tty}" then
                    set selected of aTab to true
                    set frontmost of aWindow to true
                    return "exact"
                end if
            end repeat
        end repeat
    end if
end tell
return "best_effort"
"#
    );

    match execute_osascript(&script) {
        Ok(result) => Ok(jump_result(
            true,
            &normalize_precision(&result, "best_effort"),
            None,
        )),
        Err(reason) => Ok(jump_result(false, "unsupported", Some(reason))),
    }
}

#[tauri::command]
fn open_project_path(project_path: String) -> Result<(), String> {
    let status = Command::new("open")
        .arg(&project_path)
        .status()
        .map_err(|error| format!("failed_to_open_project_path: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("open_project_path_failed".to_string())
    }
}

// ============================================================================
// Terminal Title via OSC Escape Sequence
// ============================================================================

/// Detect which terminal emulator is running based on environment variables.
fn detect_terminal() -> Option<String> {
    env::var("TERM_PROGRAM").ok()
}

/// Get the tty device by walking up the process chain to find a process with a tty.
fn get_parent_tty() -> Result<String, String> {
    let mut pid = std::os::unix::process::parent_id();

    // Walk up the process chain to find a process with a tty
    for _ in 0..10 {
        let output = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "tty=,ppid="])
            .output()
            .map_err(|e| format!("failed_to_run_ps: {e}"))?;

        if output.status.success() {
            let info = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let parts: Vec<&str> = info.split_whitespace().collect();

            if parts.len() >= 2 {
                let tty = parts[0];
                let ppid_str = parts[1];

                if tty.starts_with("tty") {
                    return Ok(format!("/dev/{tty}"));
                }

                // Move to parent process
                if let Ok(next_pid) = ppid_str.parse::<u32>() {
                    if next_pid == 0 || next_pid == pid {
                        break;
                    }
                    pid = next_pid;
                } else {
                    break;
                }
            } else {
                break;
            }
        } else {
            break;
        }
    }

    Err("no_tty_found_in_process_chain".to_string())
}

/// Get the current terminal window title by querying the terminal process.
/// This uses AppleScript for iTerm2 and Terminal.app, and falls back to a heuristic for Ghostty.
fn get_terminal_title_via_applescript(term_program: &str) -> Option<String> {
    let script = match term_program {
        "iTerm.app" => {
            r#"
tell application "iTerm2"
    tell current session of current window
        return name
    end tell
end tell
"#
        }
        "Apple_Terminal" => {
            r#"
tell application "Terminal"
    return custom title of front window
end tell
"#
        }
        _ => return None,
    };

    execute_osascript(script).ok()
}

/// Set terminal title by sending OSC escape sequence directly to tty.
/// This works for all terminals that support OSC sequences.
fn set_title_via_osc(tty_path: &str, title: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .open(tty_path)
        .map_err(|e| format!("failed_to_open_tty: {e}"))?;

    // OSC 0: Set window title
    // Format: ESC ] 0 ; title BEL
    let osc_sequence = format!("\x1b]0;{}\x07", title);
    file.write_all(osc_sequence.as_bytes())
        .map_err(|e| format!("failed_to_write_osc: {e}"))?;

    Ok(())
}

/// Format the new title with alias appended.
/// If title already contains the alias, return None (no change needed).
fn format_new_title(current: &str, alias: &str, project: Option<&str>) -> Option<String> {
    // Idempotent: if alias already in title, no change needed
    if current.contains(alias) {
        return None;
    }

    let separator = " · ";

    // Build title based on current state
    let mut parts: Vec<&str> = Vec::new();

    // Add current title if meaningful
    let cleaned_current = current.trim();
    if !cleaned_current.is_empty()
        && cleaned_current != "Terminal"
        && cleaned_current != "ghostty"
        && !cleaned_current.starts_with("root@")
        && !cleaned_current.contains("@xiaok:")
    {
        // Keep existing content, but avoid duplicating project
        if let Some(proj) = project {
            if cleaned_current.contains(proj) {
                parts.push(cleaned_current);
            } else {
                parts.push(cleaned_current);
                parts.push(proj);
            }
        } else {
            parts.push(cleaned_current);
        }
    } else if let Some(proj) = project {
        // Empty/default title: start with project
        parts.push(proj);
    }

    parts.push(alias);

    Some(parts.join(separator))
}

/// Execute the title append CLI action.
fn execute_title_append(alias: &str, project: Option<&str>) -> Result<(), String> {
    // Get parent tty for OSC fallback
    let tty_path = get_parent_tty()?;

    // Detect terminal and try to get current title
    let term_program = detect_terminal();
    let current_title = match term_program.as_deref() {
        Some("iTerm.app") | Some("Apple_Terminal") => {
            get_terminal_title_via_applescript(&term_program.unwrap()).unwrap_or_default()
        }
        // For Ghostty, avoid reading back a "current title" because it is not
        // reliably exposed per-tty and can leak another terminal's title into
        // this one. Use a deterministic title instead.
        Some("ghostty") => String::new(),
        _ => String::new(),
    };

    // Format new title
    let new_title = format_new_title(&current_title, alias, project)
        .ok_or_else(|| "alias_already_in_title".to_string())?;

    // Set title via OSC sequence (works for all terminals)
    set_title_via_osc(&tty_path, &new_title)?;

    Ok(())
}

/// Remove alias from title, preserving the rest.
fn clear_alias_from_title(current: &str, alias: &str) -> Option<String> {
    if !current.contains(alias) {
        return None; // Alias not in title, nothing to clear
    }

    let separator = " · ";

    // Remove the alias and any trailing separator
    let cleaned = current
        .replace(&format!("{}{}", separator, alias), "")
        .replace(&format!("{}{}{}", separator, alias, separator), separator)
        .replace(alias, "");

    // Clean up leading/trailing separators and whitespace
    let result = cleaned
        .trim()
        .trim_start_matches('·')
        .trim_end_matches('·')
        .trim()
        .to_string();

    if result.is_empty() {
        None // Would result in empty title
    } else {
        Some(result)
    }
}

/// Execute the title clear CLI action.
fn execute_title_clear(alias: &str) -> Result<(), String> {
    // Get parent tty for OSC fallback
    let tty_path = get_parent_tty()?;

    // Detect terminal and try to get current title
    let term_program = detect_terminal();
    let current_title = match term_program.as_deref() {
        Some("iTerm.app") | Some("Apple_Terminal") => {
            get_terminal_title_via_applescript(&term_program.unwrap()).unwrap_or_default()
        }
        Some("ghostty") => String::new(),
        _ => String::new(),
    };

    // Remove alias from title
    let new_title = clear_alias_from_title(&current_title, alias)
        .ok_or_else(|| "alias_not_in_title_or_would_be_empty".to_string())?;

    // Set title via OSC sequence
    set_title_via_osc(&tty_path, &new_title)?;

    Ok(())
}

// ============================================================================
// Main Entry Point (dual mode: CLI or GUI)
// ============================================================================

fn main() {
    // Check if running as CLI (has subcommand arguments)
    let args: Vec<String> = env::args().collect();

    // If args contain a subcommand, run CLI mode
    if args.len() > 1 && !args[1].starts_with("--") {
        let cli = Cli::parse();

        match cli.command {
            Some(Commands::Title { action }) => match action {
                TitleActions::Append { alias, project } => {
                    match execute_title_append(&alias, project.as_deref()) {
                        Ok(()) => {
                            println!("ok");
                            std::process::exit(0);
                        }
                        Err(reason) => {
                            eprintln!("error: {reason}");
                            std::process::exit(1);
                        }
                    }
                }
                TitleActions::Clear { alias } => match execute_title_clear(&alias) {
                    Ok(()) => {
                        println!("ok");
                        std::process::exit(0);
                    }
                    Err(reason) => {
                        eprintln!("error: {reason}");
                        std::process::exit(1);
                    }
                },
            },
            None => {
                // No subcommand, proceed to GUI
            }
        }
    }

    // GUI mode: run Tauri application
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            toggle_panel_command,
            open_expanded_window,
            prepare_activity_card_window,
            show_activity_card_window,
            resize_activity_card_window,
            hide_activity_card_window,
            debug_log_activity_card_frontend,
            jump_with_ghostty,
            jump_with_iterm,
            jump_with_terminal_app,
            open_project_path,
            commands::get_installed_broker_version,
            commands::get_installed_broker_path,
            commands::fetch_latest_broker_release,
            commands::install_broker_update,
            commands::is_broker_running,
            commands::load_broker_service_seed,
            commands::load_broker_project_seed,
            commands::load_broker_pending_approvals,
            commands::register_broker_ui_participant,
            commands::respond_to_broker_approval,
            commands::get_broker_runtime_status,
            commands::ensure_broker_running,
            commands::restart_broker_runtime,
            commands::start_broker,
            commands::ensure_broker_ready
        ])
        .setup(|app| {
            let preview = activity_card_preview_mode();

            if desktop_shell_uses_accessory_activation_policy() {
                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            setup_tray_icon(app.handle())?;

            if setup_creates_panel_window(preview.as_deref()) {
                let _panel = ensure_panel_window(app.handle())?;
                start_activity_card_event_watcher(app.handle().clone());
            } else {
                let _activity_card = ensure_activity_card_window(app.handle())?;
                if activity_card_window_starts_visible_for(preview.as_deref()) {
                    show_activity_card_window_for_app(app.handle())?;
                } else {
                    prepare_activity_card_window_for_app(app.handle())?;
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running hexdeck");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panel_window_size_matches_compact_dropdown_shell() {
        let (width, height) = panel_window_size();
        assert_eq!((width, height), (344.0, 540.0));
    }

    #[test]
    fn panel_window_disables_manual_resize() {
        assert!(!panel_window_resizable());
    }

    #[test]
    fn panel_window_starts_hidden() {
        assert!(!panel_window_starts_visible());
    }

    #[test]
    fn panel_window_uses_tray_popover_chrome() {
        assert!(panel_window_always_on_top());
        assert!(!panel_window_decorated());
        assert!(panel_window_skips_taskbar());
    }

    #[test]
    fn tray_left_mouse_up_toggles_panel() {
        assert_eq!(
            tray_click_action(tauri::tray::MouseButton::Left, tauri::tray::MouseButtonState::Up),
            TrayClickAction::TogglePanel
        );
    }

    #[test]
    fn tray_non_primary_clicks_do_not_toggle_panel() {
        assert_eq!(
            tray_click_action(tauri::tray::MouseButton::Right, tauri::tray::MouseButtonState::Up),
            TrayClickAction::Ignore
        );
        assert_eq!(
            tray_click_action(tauri::tray::MouseButton::Left, tauri::tray::MouseButtonState::Down),
            TrayClickAction::Ignore
        );
    }

    #[test]
    fn tray_menu_ids_are_stable() {
        assert_eq!(
            tray_menu_item_ids(),
            [
                "hexdeck-tray-open",
                "hexdeck-tray-settings",
                "hexdeck-tray-quit"
            ]
        );
    }

    #[test]
    fn desktop_shell_uses_accessory_policy_for_menu_bar_mode() {
        assert!(desktop_shell_uses_accessory_activation_policy());
    }

    #[test]
    fn activity_card_window_size_is_compact_and_non_resizable() {
        assert_eq!(activity_card_window_size(), (680.0, 152.0));
        assert!(!activity_card_window_resizable());
    }

    #[test]
    fn activity_card_window_position_centers_at_top_of_work_area() {
        let position = activity_card_window_position(PhysicalPosition::new(100, 40), 1600, 1.0);

        assert_eq!(position.x, 560);
        assert_eq!(position.y, 56);
    }

    #[test]
    fn activity_card_window_position_scales_window_width_on_retina_work_area() {
        let position = activity_card_window_position(PhysicalPosition::new(0, 34), 3024, 2.0);

        assert_eq!(position.x, 832);
        assert_eq!(position.y, 66);
    }

    #[test]
    fn activity_card_target_monitor_prefers_origin_work_area_for_notch_display() {
        let positions = [
            PhysicalPosition::new(1512, 0),
            PhysicalPosition::new(0, 0),
        ];

        assert_eq!(activity_card_target_monitor_index(&positions, Some(0)), Some(1));
    }

    #[test]
    fn activity_card_target_monitor_falls_back_to_primary_when_origin_is_missing() {
        let positions = [
            PhysicalPosition::new(1512, 0),
            PhysicalPosition::new(3432, 0),
        ];

        assert_eq!(activity_card_target_monitor_index(&positions, Some(0)), Some(0));
    }

    #[test]
    fn activity_card_window_show_policy_does_not_focus() {
        assert!(!activity_card_window_focuses_on_show());
    }

    #[test]
    fn local_preview_activity_card_window_starts_visible_and_focuses() {
        assert!(activity_card_window_starts_visible_for(Some("approval")));
        assert!(activity_card_window_focuses_on_show_for(Some("approval")));
        assert!(activity_card_window_focusable_for(Some("approval")));
    }

    #[test]
    fn live_debug_activity_card_window_starts_hidden_and_does_not_focus() {
        assert!(!activity_card_window_starts_visible_for(Some("&debugLive=1&project=hexdeck")));
        assert!(!activity_card_window_focuses_on_show_for(Some("&debugLive=1&project=hexdeck")));
        assert!(!activity_card_window_focusable_for(Some("&debugLive=1&project=hexdeck")));
    }

    #[test]
    fn activity_card_event_watcher_matches_popup_message_types_without_project_filtering() {
        let approval = serde_json::json!({
            "eventId": 1,
            "kind": "request_approval",
            "fromParticipantId": "xiaok-code-session-1",
            "taskId": "task-1",
            "payload": {
                "participantId": "xiaok-code-session-1",
                "approvalId": "approval-1",
                "body": { "summary": "Xiaok approval" }
            }
        });
        let question = serde_json::json!({
            "eventId": 2,
            "kind": "ask_clarification",
            "fromParticipantId": "claude-code-session-1",
            "taskId": "task-2",
            "payload": {
                "participantId": "claude-code-session-1",
                "body": { "summary": "Claude question" }
            }
        });
        let completion = serde_json::json!({
            "eventId": 3,
            "kind": "report_progress",
            "fromParticipantId": "codex-session-1",
            "taskId": "task-3",
            "payload": {
                "stage": "completed",
                "body": { "summary": "Codex completed" }
            }
        });

        assert!(is_popup_activity_card_event(&approval));
        assert!(is_popup_activity_card_event(&question));
        assert!(is_popup_activity_card_event(&completion));
    }

    #[test]
    fn activity_card_event_watcher_suppresses_preview_and_generic_codex_noise() {
        let codex_hook = serde_json::json!({
            "eventId": 1,
            "kind": "request_approval",
            "taskId": "codex-hook-approval",
            "payload": {
                "approvalId": "codex-hook-approval-1",
                "body": { "summary": "Codex needs approval to run Bash." }
            }
        });
        let preview = serde_json::json!({
            "eventId": 2,
            "kind": "request_approval",
            "taskId": "preview-task-1",
            "payload": {
                "approvalId": "preview-approval-1",
                "body": { "summary": "Preview approval" }
            }
        });
        let progress = serde_json::json!({
            "eventId": 3,
            "kind": "report_progress",
            "taskId": "task-3",
            "payload": {
                "stage": "in_progress",
                "body": { "summary": "Still running" }
            }
        });

        assert!(!is_popup_activity_card_event(&codex_hook));
        assert!(!is_popup_activity_card_event(&preview));
        assert!(!is_popup_activity_card_event(&progress));
    }

    #[test]
    fn activity_card_broker_watcher_initial_page_only_sets_cursor() {
        let mut watcher = ActivityCardBrokerWatcher::new(None);
        let page = vec![
            serde_json::json!({
                "eventId": 41,
                "kind": "ask_clarification",
                "payload": { "body": { "summary": "Old question" } }
            }),
            serde_json::json!({
                "eventId": 42,
                "kind": "report_progress",
                "payload": { "stage": "completed", "body": { "summary": "Old completion" } }
            }),
        ];

        assert_eq!(watcher.take_prepare_event_id(&page), None);
        assert!(watcher.initialized);
        assert_eq!(watcher.after, 42);
        assert_eq!(watcher.last_prepared_popup_event_id, None);
    }

    #[test]
    fn activity_card_broker_watcher_prepares_only_once_for_same_popup_event_id() {
        let mut watcher = ActivityCardBrokerWatcher::new(Some(100));
        let page = vec![serde_json::json!({
            "eventId": 101,
            "kind": "request_approval",
            "payload": {
                "approvalId": "approval-101",
                "body": { "summary": "Deploy approval" }
            }
        })];

        assert_eq!(watcher.take_prepare_event_id(&page), Some(101));
        assert_eq!(watcher.take_prepare_event_id(&page), None);
        assert_eq!(watcher.after, 101);
    }

    #[test]
    fn activity_card_broker_watcher_advances_cursor_for_non_popup_pages_without_prepare() {
        let mut watcher = ActivityCardBrokerWatcher::new(Some(200));
        let page = vec![
            serde_json::json!({
                "eventId": 201,
                "kind": "report_progress",
                "payload": { "stage": "in_progress", "body": { "summary": "Still running" } }
            }),
            serde_json::json!({
                "eventId": 202,
                "kind": "respond_approval",
                "payload": { "approvalId": "approval-200" }
            }),
        ];

        assert_eq!(watcher.take_prepare_event_id(&page), None);
        assert_eq!(watcher.after, 202);
    }

    #[test]
    fn activity_card_broker_watcher_error_backoff_caps_and_resets() {
        let mut watcher = ActivityCardBrokerWatcher::new(Some(0));

        watcher.note_poll_error();
        watcher.note_poll_error();
        watcher.note_poll_error();
        assert_eq!(
            watcher.error_backoff_duration(),
            std::time::Duration::from_secs(2)
        );

        watcher.note_poll_success();
        assert_eq!(
            watcher.error_backoff_duration(),
            std::time::Duration::from_secs(0)
        );
    }

    #[test]
    fn activity_card_broker_watcher_skips_prepare_when_window_is_already_visible() {
        assert!(!should_prepare_activity_card_window(true, Some(500)));
    }

    #[test]
    fn activity_card_broker_watcher_still_prepares_when_hidden_and_new_popup_arrives() {
        assert!(should_prepare_activity_card_window(false, Some(501)));
    }

    #[test]
    fn activity_card_window_location_defaults_to_live_route() {
        assert_eq!(activity_card_window_location_for(None), "index.html?view=activity-card");
    }

    #[test]
    fn current_window_location_matches_same_activity_card_route() {
        assert!(current_window_location_matches(
            "tauri://localhost/index.html?view=activity-card&debugLive=1",
            "index.html?view=activity-card&debugLive=1",
        ));
    }

    #[test]
    fn current_window_location_rejects_different_activity_card_route() {
        assert!(!current_window_location_matches(
            "tauri://localhost/index.html?view=activity-card&debugLive=1",
            "index.html?view=activity-card&project=hexdeck",
        ));
    }

    #[test]
    fn activity_card_window_location_supports_preview_mode() {
        assert_eq!(
            activity_card_window_location_for(Some("approval")),
            "index.html?view=activity-card&preview=approval"
        );
    }

    #[test]
    fn activity_card_window_location_supports_live_debug_query() {
        assert_eq!(
            activity_card_window_location_for(Some("&debugLive=1&project=hexdeck")),
            "index.html?view=activity-card&debugLive=1&project=hexdeck"
        );
    }

    #[test]
    fn preview_mode_skips_hidden_panel_window() {
        assert!(setup_creates_panel_window(None));
        assert!(!setup_creates_panel_window(Some("approval")));
    }

    #[test]
    fn test_format_new_title_returns_none_when_alias_present() {
        let result = format_new_title("projects · @claude2", "@claude2", None);
        assert!(result.is_none());
    }

    #[test]
    fn test_format_new_title_appends_to_existing() {
        let result = format_new_title("projects", "@claude2", None);
        assert_eq!(result, Some("projects · @claude2".to_string()));
    }

    #[test]
    fn test_format_new_title_includes_project() {
        let result = format_new_title("projects", "@claude2", Some("hexdeck"));
        assert_eq!(result, Some("projects · hexdeck · @claude2".to_string()));
    }

    #[test]
    fn test_format_new_title_handles_empty_current() {
        let result = format_new_title("", "@claude2", Some("hexdeck"));
        assert_eq!(result, Some("hexdeck · @claude2".to_string()));
    }

    #[test]
    fn test_format_new_title_ignores_default_titles() {
        // "ghostty" is a default title, should be replaced
        let result = format_new_title("ghostty", "@claude2", Some("hexdeck"));
        assert_eq!(result, Some("hexdeck · @claude2".to_string()));

        // "Terminal" is also a default
        let result = format_new_title("Terminal", "@claude2", None);
        assert_eq!(result, Some("@claude2".to_string()));
    }

    #[test]
    fn test_format_new_title_avoids_duplicate_project() {
        // If project already in title, don't duplicate
        let result = format_new_title("hexdeck work", "@claude2", Some("hexdeck"));
        assert_eq!(result, Some("hexdeck work · @claude2".to_string()));
    }

    #[test]
    fn test_format_new_title_ignores_shell_prompt_titles() {
        // Titles like "root@host:" are shell prompts, ignore them
        let result = format_new_title("root@xiaok: ~", "@claude2", Some("hexdeck"));
        assert_eq!(result, Some("hexdeck · @claude2".to_string()));
    }

    #[test]
    fn test_clear_alias_from_title_removes_alias() {
        let result = clear_alias_from_title("projects · @claude2", "@claude2");
        assert_eq!(result, Some("projects".to_string()));
    }

    #[test]
    fn test_clear_alias_from_title_handles_middle_alias() {
        let result = clear_alias_from_title("projects · @claude2 · working", "@claude2");
        assert_eq!(result, Some("projects · working".to_string()));
    }

    #[test]
    fn test_clear_alias_from_title_returns_none_when_alias_not_present() {
        let result = clear_alias_from_title("projects", "@claude2");
        assert!(result.is_none());
    }

    #[test]
    fn test_clear_alias_from_title_returns_none_for_empty_result() {
        let result = clear_alias_from_title("@claude2", "@claude2");
        assert!(result.is_none());
    }

    #[test]
    fn test_clear_alias_from_title_preserves_project() {
        let result = clear_alias_from_title("hexdeck · @claude2", "@claude2");
        assert_eq!(result, Some("hexdeck".to_string()));
    }
}
