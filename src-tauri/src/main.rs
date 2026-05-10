#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use chrono::Utc;
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs::OpenOptions;
use std::io::Write;
use std::process::Command;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    utils::config::BackgroundThrottlingPolicy,
    Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_positioner::{Position, WindowExt};

const TRAY_MENU_OPEN_ID: &str = "hexdeck-tray-open";
const TRAY_MENU_SETTINGS_ID: &str = "hexdeck-tray-settings";
const TRAY_MENU_QUIT_ID: &str = "hexdeck-tray-quit";
const ACTIVITY_CARD_REFRESH_EVENT: &str = "activity-card-refresh-requested";
const ACTIVITY_CARD_LOCAL_APPROVAL_EVENT: &str = "activity-card-local-approval-requested";
const ACTIVITY_CARD_BROKER_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);
const ACTIVITY_CARD_LOCAL_APPROVAL_POLL_INTERVAL: std::time::Duration =
    std::time::Duration::from_millis(100);
const ACTIVITY_CARD_DIAGNOSTICS_LOG_NAME: &str = "hexdeck-activity-card-diagnostics.log";
const ACTIVITY_CARD_DIAGNOSTICS_JSONL_NAME: &str = "hexdeck-activity-card-diagnostics.jsonl";
#[cfg(target_os = "macos")]
const MACOS_TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/tray-icon-macos.png");

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
    (320.0, 540.0)
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

#[cfg(target_os = "windows")]
fn activity_card_window_bootstraps_offscreen_for(preview: Option<&str>) -> bool {
    let _ = preview;
    false
}

#[cfg(not(target_os = "windows"))]
fn activity_card_window_bootstraps_offscreen_for(_preview: Option<&str>) -> bool {
    false
}

#[cfg(target_os = "windows")]
fn activity_card_window_focuses_on_show_for(preview: Option<&str>) -> bool {
    let _ = preview;
    true
}

#[cfg(not(target_os = "windows"))]
fn activity_card_window_focuses_on_show_for(preview: Option<&str>) -> bool {
    activity_card_window_starts_visible_for(preview)
}

fn activity_card_window_focuses_on_show() -> bool {
    activity_card_window_focuses_on_show_for(activity_card_preview_mode().as_deref())
}

#[cfg(target_os = "windows")]
fn activity_card_window_focusable_for(preview: Option<&str>) -> bool {
    let _ = preview;
    true
}

#[cfg(not(target_os = "windows"))]
fn activity_card_window_focusable_for(preview: Option<&str>) -> bool {
    activity_card_window_focuses_on_show_for(preview)
}

fn activity_card_window_focusable() -> bool {
    activity_card_window_focusable_for(activity_card_preview_mode().as_deref())
}

fn activity_card_window_accepts_first_mouse() -> bool {
    true
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

fn activity_card_diagnostics_log_path() -> std::path::PathBuf {
    env::temp_dir().join(ACTIVITY_CARD_DIAGNOSTICS_LOG_NAME)
}

fn activity_card_diagnostics_jsonl_path() -> std::path::PathBuf {
    env::temp_dir().join(ACTIVITY_CARD_DIAGNOSTICS_JSONL_NAME)
}

fn append_activity_card_diagnostics_log(message: &str) {
    let log_path = activity_card_diagnostics_log_path();
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
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

fn append_activity_card_diagnostics_event(event: &serde_json::Value) {
    let log_path = activity_card_diagnostics_jsonl_path();
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let mut object = match event.as_object() {
        Some(event) => event.clone(),
        None => {
            let mut object = serde_json::Map::new();
            object.insert("message".to_string(), event.clone());
            object
        }
    };
    object.insert(
        "timestamp".to_string(),
        serde_json::json!(Utc::now().to_rfc3339()),
    );
    object.insert("pid".to_string(), serde_json::json!(std::process::id()));

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&log_path) {
        let _ = writeln!(file, "{}", serde_json::Value::Object(object));
    }
}

fn project_name_from_project_path(project_path: Option<&str>) -> Option<String> {
    project_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| {
            std::path::Path::new(value)
                .file_name()
                .and_then(|name| name.to_str())
        })
        .map(str::to_string)
}

fn truncate_diagnostic_message(value: Option<&str>) -> String {
    let value = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("-");
    let truncated = value.chars().take(160).collect::<String>();
    if value.chars().count() > 160 {
        format!("{truncated}…")
    } else {
        truncated
    }
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
        Some(value) if value.trim().starts_with('&') => {
            format!("index.html?view=activity-card{}", value.trim())
        }
        Some(value) if !value.trim().is_empty() => {
            format!("index.html?view=activity-card&preview={}", value.trim())
        }
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
    [TRAY_MENU_OPEN_ID, TRAY_MENU_SETTINGS_ID, TRAY_MENU_QUIT_ID]
}

fn desktop_shell_uses_accessory_activation_policy() -> bool {
    true
}

fn tray_icon_uses_template_image() -> bool {
    true
}

#[cfg(target_os = "macos")]
fn load_tray_icon_pixels() -> Option<(Vec<u8>, u32, u32)> {
    let image = image::load_from_memory(MACOS_TRAY_ICON_PNG)
        .ok()?
        .into_rgba8();
    let (width, height) = image.dimensions();
    Some((image.into_raw(), width, height))
}

fn load_tray_icon_image() -> Option<Image<'static>> {
    #[cfg(target_os = "macos")]
    {
        let (pixels, width, height) = load_tray_icon_pixels()?;
        return Some(Image::new_owned(pixels, width, height));
    }

    #[cfg(not(target_os = "macos"))]
    {
        None
    }
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
    let top_margin_physical =
        (activity_card_window_top_margin() as f64 * safe_scale_factor).round() as i32;
    let centered_x =
        work_area_position.x + ((work_area_width as i32 - window_width_physical).max(0) / 2);
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

    Ok(
        activity_card_target_monitor_index(&work_area_positions, primary_index)
            .and_then(|index| monitors.into_iter().nth(index)),
    )
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
    let preview = activity_card_preview_mode();
    let starts_visible = activity_card_window_starts_visible_for(preview.as_deref());
    let bootstrap_offscreen = activity_card_window_bootstraps_offscreen_for(preview.as_deref());
    if preview.is_some() {
        eprintln!("[activity-card-preview] location: {location}");
    }
    let mut builder = WebviewWindowBuilder::new(app, "activity-card", WebviewUrl::App(location.into()))
        .title("HexDeck Activity Card")
        .inner_size(width, height)
        .resizable(activity_card_window_resizable())
        .visible(starts_visible || bootstrap_offscreen)
        .accept_first_mouse(activity_card_window_accepts_first_mouse())
        .focusable(activity_card_window_focusable())
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .decorations(false)
        .skip_taskbar(true)
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .on_page_load(|window, payload| {
            append_activity_card_diagnostics_log(&format!(
                "[native/page-load] label={} event={:?} url={}",
                window.label(),
                payload.event(),
                payload.url()
            ));
        });
    if bootstrap_offscreen {
        builder = builder.position(-20_000.0, -20_000.0);
    }
    builder
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
        append_activity_card_diagnostics_log(&format!(
            "[native/position] workAreaPos=({}, {}) workAreaSize=({}, {}) scale={} targetPos=({}, {})",
            work_area.position.x,
            work_area.position.y,
            work_area.size.width,
            work_area.size.height,
            monitor.scale_factor(),
            position.x,
            position.y
        ));
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

    // Reset width to canonical 320px (in case window was resized by a previous session)
    // Height starts at max; frontend ResizeObserver will shrink to fit content
    let (panel_width, _) = panel_window_size();
    let _ = window.set_size(tauri::LogicalSize::new(panel_width, 540.0));

    // Show window; frontend will measure content and call resize_panel_to_content
    // to shrink the window to fit content height after layout
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
    append_activity_card_diagnostics_log(&format!(
        "[native/show-before] visible={} location={}",
        window.is_visible().unwrap_or(false),
        activity_card_window_location()
    ));
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

    append_activity_card_diagnostics_log(&format!(
        "[native/show-after] visible={} focusable={} outerPos={:?} outerSize={:?}",
        window.is_visible().unwrap_or(false),
        activity_card_window_focusable(),
        window.outer_position().ok(),
        window.outer_size().ok()
    ));

    Ok(())
}

#[cfg(target_os = "macos")]
fn show_activity_card_window_inactive(window: &WebviewWindow) -> tauri::Result<()> {
    window.show()?;
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

#[cfg(test)]
fn should_prepare_activity_card_window(
    window_visible: bool,
    prepare_event_id: Option<u64>,
) -> bool {
    prepare_event_id.is_some() && !window_visible
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActivityCardWatcherWindowAction {
    None,
    Prepare,
}

fn should_emit_activity_card_refresh(prepare_event_id: Option<u64>) -> bool {
    prepare_event_id.is_some()
}

#[allow(dead_code)]
fn should_show_activity_card_window(
    window_action: ActivityCardWatcherWindowAction,
    prepare_succeeded: bool,
) -> bool {
    matches!(window_action, ActivityCardWatcherWindowAction::Prepare) && prepare_succeeded
}

fn activity_card_watcher_window_action(
    window_visible: bool,
    prepare_event_id: Option<u64>,
    prepare_local_approval_id: Option<&str>,
) -> ActivityCardWatcherWindowAction {
    if window_visible {
        return ActivityCardWatcherWindowAction::None;
    }

    if prepare_local_approval_id.is_some() {
        return ActivityCardWatcherWindowAction::Prepare;
    }

    if prepare_event_id.is_some() {
        return ActivityCardWatcherWindowAction::Prepare;
    }

    ActivityCardWatcherWindowAction::None
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

#[cfg(target_os = "windows")]
fn prime_activity_card_window_for_app(app: &tauri::AppHandle) -> tauri::Result<()> {
    let window = ensure_activity_card_window(app)?;
    sync_window_location_if_needed(&window, &activity_card_window_location())?;
    position_activity_card_window(app, &window)?;
    window.set_focusable(true)?;
    window.set_always_on_top(true)?;
    window.set_visible_on_all_workspaces(true)?;
    window.show()?;
    append_activity_card_diagnostics_log("[native/prime] show-onscreen");

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        let app_handle_for_hide = app_handle.clone();
        let _ = app_handle.run_on_main_thread(move || {
            if let Some(window) = app_handle_for_hide.get_webview_window("activity-card") {
                let _ = window.hide();
                append_activity_card_diagnostics_log("[native/prime] hide-onscreen");
            }
        });
    });

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn prime_activity_card_window_for_app(_app: &tauri::AppHandle) -> tauri::Result<()> {
    Ok(())
}

#[tauri::command]
fn show_activity_card_window(app: tauri::AppHandle) -> Result<(), String> {
    show_activity_card_window_for_app(&app).map_err(|error| error.to_string())
}

#[tauri::command]
fn resize_panel_to_content(app: tauri::AppHandle, content_width: f64, content_height: f64) -> Result<(), String> {
    let window = app
        .get_webview_window("panel")
        .ok_or_else(|| "panel window not found".to_string())?;
    let width = content_width.clamp(250.0, 420.0);
    let height = content_height.clamp(200.0, 600.0);
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    Ok(())
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
    append_activity_card_diagnostics_log(&format!("[frontend] {message}"));
    if let Ok(mut event) = serde_json::from_str::<serde_json::Value>(&message) {
        if let Some(object) = event.as_object_mut() {
            object
                .entry("kind".to_string())
                .or_insert_with(|| serde_json::json!("activity_card_frontend"));
            object
                .entry("source".to_string())
                .or_insert_with(|| serde_json::json!("frontend"));
            append_activity_card_diagnostics_event(&event);
        }
    }
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

fn local_host_approval_id(value: &serde_json::Value) -> Option<&str> {
    value.get("approvalId").and_then(serde_json::Value::as_str)
}

fn approval_item_string(value: Option<&serde_json::Value>, key: &str) -> Option<String> {
    value
        .and_then(|value| value.get(key))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

fn local_host_approval_meta_string(value: Option<&serde_json::Value>, key: &str) -> Option<String> {
    value.and_then(|value| {
        value
            .get("body")
            .and_then(serde_json::Value::as_object)
            .and_then(|body| body.get("localHostApproval"))
            .and_then(serde_json::Value::as_object)
            .and_then(|meta| meta.get(key))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    })
}

fn build_local_host_approval_event(
    stage: &str,
    approval_item: Option<&serde_json::Value>,
    extra: Option<serde_json::Value>,
) -> serde_json::Value {
    let mut object = serde_json::Map::new();
    object.insert(
        "kind".to_string(),
        serde_json::json!("activity_card_watcher"),
    );
    object.insert("stage".to_string(), serde_json::json!(stage));

    if let Some(approval_id) = approval_item.and_then(local_host_approval_id) {
        object.insert("approvalId".to_string(), serde_json::json!(approval_id));
    }
    if let Some(participant_id) = approval_item_string(approval_item, "participantId") {
        object.insert(
            "participantId".to_string(),
            serde_json::json!(participant_id),
        );
    }
    if let Some(task_id) = approval_item_string(approval_item, "taskId") {
        object.insert("taskId".to_string(), serde_json::json!(task_id));
    }
    if let Some(thread_id) = approval_item_string(approval_item, "threadId") {
        object.insert("threadId".to_string(), serde_json::json!(thread_id));
    }
    if let Some(session_id) = local_host_approval_meta_string(approval_item, "sessionId") {
        object.insert("sessionId".to_string(), serde_json::json!(session_id));
    }
    if let Some(call_id) = local_host_approval_meta_string(approval_item, "callId") {
        object.insert("callId".to_string(), serde_json::json!(call_id));
    }
    if let Some(project_path) = local_host_approval_meta_string(approval_item, "projectPath") {
        object.insert("projectPath".to_string(), serde_json::json!(project_path));
        if let Some(project_name) = project_name_from_project_path(Some(&project_path)) {
            object.insert("projectName".to_string(), serde_json::json!(project_name));
        }
    }

    if let Some(extra) = extra.and_then(|value| value.as_object().cloned()) {
        for (key, value) in extra {
            object.insert(key, value);
        }
    }

    serde_json::Value::Object(object)
}

fn describe_local_host_approval(value: Option<&serde_json::Value>) -> String {
    let Some(value) = value else {
        return "none".to_string();
    };

    let approval_id = local_host_approval_id(value).unwrap_or("-");
    let participant_id = value
        .get("participantId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("-");
    let created_at = value
        .get("createdAt")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("-");
    let command_line = value
        .get("commandLine")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            value
                .get("body")
                .and_then(serde_json::Value::as_object)
                .and_then(|body| body.get("commandLine"))
                .and_then(serde_json::Value::as_str)
        });
    format!(
        "approvalId={} participantId={} createdAt={} commandLine={}",
        approval_id,
        participant_id,
        created_at,
        truncate_diagnostic_message(command_line)
    )
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
    let approval_id = payload.and_then(|payload| {
        payload
            .get("approvalId")
            .and_then(serde_json::Value::as_str)
    });
    let summary = payload.and_then(broker_payload_summary);

    summary
        .map(|summary| {
            summary
                .trim()
                .to_ascii_lowercase()
                .starts_with("codex needs approval")
        })
        .unwrap_or(false)
        || approval_id
            .map(|approval_id| approval_id.starts_with("preview-approval-"))
            .unwrap_or(false)
        || task_id
            .map(|task_id| task_id.starts_with("preview-task-"))
            .unwrap_or(false)
}

fn broker_event_created_at(value: &serde_json::Value) -> Option<chrono::NaiveDateTime> {
    value
        .get("createdAt")
        .and_then(serde_json::Value::as_str)
        .and_then(|s| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok())
}

fn is_event_fresh(value: &serde_json::Value, max_age_seconds: i64) -> bool {
    let created_at = broker_event_created_at(value);
    if created_at.is_none() {
        // Events without createdAt are considered fresh (e.g., approvals)
        return true;
    }

    let now = chrono::Utc::now().naive_utc();
    let age_seconds = (now - created_at.unwrap()).num_seconds();
    age_seconds <= max_age_seconds
}

fn is_popup_activity_card_event(value: &serde_json::Value) -> bool {
    if is_suppressed_activity_card_event(value) {
        return false;
    }

    match broker_event_kind(value) {
        Some("request_approval") | Some("ask_clarification") => {
            is_event_fresh(value, 300) // 5 minutes
        }
        Some("report_progress") => {
            broker_event_payload(value)
                .and_then(|payload| payload.get("stage").and_then(serde_json::Value::as_str))
                == Some("completed")
                && is_event_fresh(value, 300)
        }
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
    #[allow(dead_code)]
    last_prepared_local_approval_id: Option<String>,
    consecutive_error_count: u32,
}

impl ActivityCardBrokerWatcher {
    fn new(initial_after: Option<u64>) -> Self {
        Self {
            initialized: initial_after.is_some(),
            after: initial_after.unwrap_or(0),
            last_prepared_popup_event_id: None,
            last_prepared_local_approval_id: None,
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

    #[allow(dead_code)]
    fn take_prepare_local_approval_id(&mut self, approval_id: Option<&str>) -> Option<String> {
        match approval_id {
            Some(approval_id)
                if self.last_prepared_local_approval_id.as_deref() != Some(approval_id) =>
            {
                let approval_id = approval_id.to_string();
                self.last_prepared_local_approval_id = Some(approval_id.clone());
                Some(approval_id)
            }
            Some(_) => None,
            None => {
                self.last_prepared_local_approval_id = None;
                None
            }
        }
    }
}

fn select_local_host_approval_dispatch(
    watcher: &mut ActivityCardBrokerWatcher,
    local_approval_item: Option<serde_json::Value>,
) -> (Option<serde_json::Value>, Option<String>) {
    let prepare_local_approval_id = watcher.take_prepare_local_approval_id(
        local_approval_item
            .as_ref()
            .and_then(local_host_approval_id),
    );
    (local_approval_item, prepare_local_approval_id)
}

async fn poll_activity_card_events(app: tauri::AppHandle) {
    let broker_url = "http://127.0.0.1:4318".to_string();
    let initial_after = load_latest_broker_event_id(&broker_url).await.ok();
    let mut watcher = ActivityCardBrokerWatcher::new(initial_after);
    let mut interval = tokio::time::interval(ACTIVITY_CARD_LOCAL_APPROVAL_POLL_INTERVAL);
    let mut next_broker_poll_at = tokio::time::Instant::now();

    loop {
        interval.tick().await;

        let now = tokio::time::Instant::now();
        let window_visible = app
            .get_webview_window("activity-card")
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false);
        let (local_approval_item, prepare_local_approval_id) = select_local_host_approval_dispatch(
            &mut watcher,
            commands::broker::latest_local_host_approval_item_value(),
        );
        let mut prepare_event_id = None;

        if now >= next_broker_poll_at {
            match commands::broker::broker_get_json(
                &broker_url,
                &format!("/events/replay?after={}", watcher.after),
            )
            .await
            {
                Ok(payload) => {
                    watcher.note_poll_success();
                    let events = commands::broker::value_items(payload, "items");
                    let page = events.as_array().cloned().unwrap_or_default();
                    prepare_event_id = watcher.take_prepare_event_id(&page);
                    next_broker_poll_at = now + ACTIVITY_CARD_BROKER_POLL_INTERVAL;
                }
                Err(_) => {
                    watcher.note_poll_error();
                    let backoff = watcher.error_backoff_duration();
                    next_broker_poll_at = now
                        + if backoff.is_zero() {
                            ACTIVITY_CARD_BROKER_POLL_INTERVAL
                        } else {
                            backoff
                        };
                }
            }
        }
        let window_action = activity_card_watcher_window_action(
            window_visible,
            prepare_event_id,
            prepare_local_approval_id.as_deref(),
        );
        let should_emit_refresh = should_emit_activity_card_refresh(prepare_event_id);

        if window_action != ActivityCardWatcherWindowAction::None
            || should_emit_refresh
            || prepare_local_approval_id.is_some()
        {
            append_activity_card_diagnostics_log(&format!(
                "[watcher/dispatch] windowVisible={} action={:?} emitRefresh={} popupEventId={} localRetryId={} {}",
                window_visible,
                window_action,
                should_emit_refresh,
                prepare_event_id
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "-".to_string()),
                prepare_local_approval_id.as_deref().unwrap_or("-"),
                describe_local_host_approval(local_approval_item.as_ref())
            ));
            let app_for_thread = app.clone();
            let app_for_window_action = app.clone();
            let refresh_payload = prepare_event_id.map(|event_id| event_id.to_string());
            let local_approval_payload = if prepare_local_approval_id.is_some() {
                local_approval_item.clone()
            } else {
                None
            };
            let _ = app_for_thread.run_on_main_thread(move || {
                let mut prepare_result = "skipped".to_string();
                match window_action {
                    ActivityCardWatcherWindowAction::Prepare => {
                        match prepare_activity_card_window_for_app(&app_for_window_action) {
                            Ok(()) => prepare_result = "ok".to_string(),
                            Err(error) => prepare_result = format!("error:{error}"),
                        }
                    }
                    ActivityCardWatcherWindowAction::None => {}
                }
                // Removed explicit show_window call: frontend controls window visibility
                // after receiving refresh event and preparing activity card data.
                // Previously watcher would show empty window before frontend had activeCard ready.
                let mut emit_local_result = "skipped".to_string();
                if let Some(payload) = local_approval_payload.clone() {
                    emit_local_result = match app_for_window_action.emit_to(
                        "activity-card",
                        ACTIVITY_CARD_LOCAL_APPROVAL_EVENT,
                        payload,
                    ) {
                        Ok(()) => "ok".to_string(),
                        Err(error) => format!("error:{error}"),
                    };
                }
                let mut emit_refresh_result = "skipped".to_string();
                if should_emit_refresh {
                    emit_refresh_result = match app_for_window_action.emit_to(
                        "activity-card",
                        ACTIVITY_CARD_REFRESH_EVENT,
                        refresh_payload.clone(),
                    ) {
                        Ok(()) => "ok".to_string(),
                        Err(error) => format!("error:{error}"),
                    };
                }
                let window_visible_after = app_for_window_action
                    .get_webview_window("activity-card")
                    .and_then(|window| window.is_visible().ok())
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown".to_string());
                append_activity_card_diagnostics_event(&build_local_host_approval_event(
                    "approval_emitted",
                    local_approval_payload.as_ref(),
                    Some(serde_json::json!({
                        "prepareResult": prepare_result.clone(),
                        "emitLocalResult": emit_local_result.clone(),
                        "emitRefreshResult": emit_refresh_result.clone(),
                        "windowVisibleAfter": window_visible_after.clone()
                    })),
                ));
                append_activity_card_diagnostics_log(&format!(
                    "[watcher/main-thread] action={:?} prepare={} emitLocal={} emitRefresh={} windowVisibleAfter={} {}",
                    window_action,
                    prepare_result,
                    emit_local_result,
                    emit_refresh_result,
                    window_visible_after,
                    describe_local_host_approval(local_approval_payload.as_ref())
                ));
            });
        }
    }
}

fn start_activity_card_event_watcher(app: tauri::AppHandle) {
    append_activity_card_diagnostics_log(&format!(
        "[watcher/start] logPath={}",
        activity_card_diagnostics_log_path().display()
    ));
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

    Menu::with_items(app, &[&open_item, &settings_item, &separator, &quit_item])
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

    if let Some(icon) = load_tray_icon_image() {
        tray = tray
            .icon(icon)
            .icon_as_template(tray_icon_uses_template_image());
    } else if let Some(icon) = app.default_window_icon().cloned() {
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
#[cfg(unix)]
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

#[cfg(not(unix))]
fn get_parent_tty() -> Result<String, String> {
    Err("parent_tty_lookup_unsupported_on_this_platform".to_string())
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
            resize_panel_to_content,
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
            commands::load_latest_local_host_approval_item,
            commands::check_local_approval_version,
            commands::register_broker_ui_participant,
            commands::respond_to_broker_approval,
            commands::respond_to_local_host_approval,
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

            // Start background emitter for local approval change events
            commands::broker::spawn_local_approval_emitter(app.handle().clone());

            if setup_creates_panel_window(preview.as_deref()) {
                let _panel = ensure_panel_window(app.handle())?;
                let _activity_card = ensure_activity_card_window(app.handle())?;
                prepare_activity_card_window_for_app(app.handle())?;
                prime_activity_card_window_for_app(app.handle())?;
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
        assert_eq!((width, height), (320.0, 540.0));
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
            tray_click_action(
                tauri::tray::MouseButton::Left,
                tauri::tray::MouseButtonState::Up
            ),
            TrayClickAction::TogglePanel
        );
    }

    #[test]
    fn tray_non_primary_clicks_do_not_toggle_panel() {
        assert_eq!(
            tray_click_action(
                tauri::tray::MouseButton::Right,
                tauri::tray::MouseButtonState::Up
            ),
            TrayClickAction::Ignore
        );
        assert_eq!(
            tray_click_action(
                tauri::tray::MouseButton::Left,
                tauri::tray::MouseButtonState::Down
            ),
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
        let positions = [PhysicalPosition::new(1512, 0), PhysicalPosition::new(0, 0)];

        assert_eq!(
            activity_card_target_monitor_index(&positions, Some(0)),
            Some(1)
        );
    }

    #[test]
    fn activity_card_target_monitor_falls_back_to_primary_when_origin_is_missing() {
        let positions = [
            PhysicalPosition::new(1512, 0),
            PhysicalPosition::new(3432, 0),
        ];

        assert_eq!(
            activity_card_target_monitor_index(&positions, Some(0)),
            Some(0)
        );
    }

    #[test]
    fn activity_card_window_show_policy_does_not_focus() {
        #[cfg(target_os = "windows")]
        assert!(activity_card_window_focuses_on_show());
        #[cfg(not(target_os = "windows"))]
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
        assert!(!activity_card_window_starts_visible_for(Some(
            "&debugLive=1&project=hexdeck"
        )));
        #[cfg(target_os = "windows")]
        assert!(activity_card_window_focuses_on_show_for(Some(
            "&debugLive=1&project=hexdeck"
        )));
        #[cfg(not(target_os = "windows"))]
        assert!(!activity_card_window_focuses_on_show_for(Some(
            "&debugLive=1&project=hexdeck"
        )));
        #[cfg(target_os = "windows")]
        assert!(activity_card_window_focusable_for(Some(
            "&debugLive=1&project=hexdeck"
        )));
        #[cfg(not(target_os = "windows"))]
        assert!(!activity_card_window_focusable_for(Some(
            "&debugLive=1&project=hexdeck"
        )));
    }

    #[test]
    fn activity_card_window_accepts_first_mouse_for_passive_popup_clicks() {
        assert!(activity_card_window_accepts_first_mouse());
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
    fn activity_card_broker_watcher_prepares_for_new_local_host_approval_ids() {
        let mut watcher = ActivityCardBrokerWatcher::new(Some(100));

        assert_eq!(
            watcher.take_prepare_local_approval_id(Some(
                "hexdeck-local-codex-host-codex-session-019db354-call_1",
            )),
            Some("hexdeck-local-codex-host-codex-session-019db354-call_1".to_string())
        );
        assert_eq!(
            watcher.take_prepare_local_approval_id(Some(
                "hexdeck-local-codex-host-codex-session-019db354-call_1",
            )),
            None
        );
        assert_eq!(
            watcher.take_prepare_local_approval_id(Some(
                "hexdeck-local-codex-host-codex-session-019db354-call_2",
            )),
            Some("hexdeck-local-codex-host-codex-session-019db354-call_2".to_string())
        );
    }

    #[test]
    fn select_local_host_approval_dispatch_preserves_payload_and_prepare_id() {
        let mut watcher = ActivityCardBrokerWatcher::new(Some(100));
        let approval = serde_json::json!({
            "approvalId": "hexdeck-local-codex-host-codex-session-019db354-call_1",
            "taskId": "local-host-approval-codex-session-019db354-call_1",
            "participantId": "codex.main"
        });

        let (payload, prepare_id) =
            select_local_host_approval_dispatch(&mut watcher, Some(approval.clone()));

        assert_eq!(payload, Some(approval));
        assert_eq!(
            prepare_id,
            Some("hexdeck-local-codex-host-codex-session-019db354-call_1".to_string())
        );
    }

    #[test]
    fn select_local_host_approval_dispatch_rearms_after_payload_disappears() {
        let mut watcher = ActivityCardBrokerWatcher::new(Some(100));
        let approval = serde_json::json!({
            "approvalId": "hexdeck-local-codex-host-codex-session-019db354-call_1",
            "taskId": "local-host-approval-codex-session-019db354-call_1"
        });

        assert_eq!(
            select_local_host_approval_dispatch(&mut watcher, Some(approval.clone())).1,
            Some("hexdeck-local-codex-host-codex-session-019db354-call_1".to_string())
        );
        assert_eq!(
            select_local_host_approval_dispatch(&mut watcher, None).1,
            None
        );
        assert_eq!(
            select_local_host_approval_dispatch(&mut watcher, Some(approval)).1,
            Some("hexdeck-local-codex-host-codex-session-019db354-call_1".to_string())
        );
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
    fn activity_card_broker_watcher_prepares_hidden_window_for_broker_events() {
        assert_eq!(
            activity_card_watcher_window_action(false, Some(501), None),
            ActivityCardWatcherWindowAction::Prepare
        );
    }

    #[test]
    fn activity_card_broker_watcher_prepares_hidden_window_for_local_host_approvals() {
        assert_eq!(
            activity_card_watcher_window_action(
                false,
                None,
                Some("hexdeck-local-codex-host-codex-session-019db354-call_1")
            ),
            ActivityCardWatcherWindowAction::Prepare
        );
    }

    #[test]
    fn activity_card_broker_watcher_keeps_window_action_idle_for_visible_local_host_approval() {
        assert_eq!(
            activity_card_watcher_window_action(
                true,
                None,
                Some("hexdeck-local-codex-host-codex-session-019db354-call_1")
            ),
            ActivityCardWatcherWindowAction::None
        );
    }

    #[test]
    fn activity_card_broker_watcher_does_not_emit_refresh_without_popup_signals() {
        assert!(!should_emit_activity_card_refresh(None));
    }

    #[test]
    fn activity_card_broker_watcher_emits_refresh_for_broker_popup_events() {
        assert!(should_emit_activity_card_refresh(Some(501)));
    }

    #[test]
    fn activity_card_broker_watcher_shows_window_after_successful_prepare() {
        assert!(should_show_activity_card_window(
            ActivityCardWatcherWindowAction::Prepare,
            true
        ));
    }

    #[test]
    fn activity_card_broker_watcher_skips_show_after_failed_prepare() {
        assert!(!should_show_activity_card_window(
            ActivityCardWatcherWindowAction::Prepare,
            false
        ));
    }

    #[test]
    fn activity_card_broker_watcher_skips_show_without_prepare_action() {
        assert!(!should_show_activity_card_window(
            ActivityCardWatcherWindowAction::None,
            true
        ));
    }

    #[test]
    fn activity_card_broker_watcher_does_not_retry_same_local_host_approval_while_window_hidden() {
        let mut watcher = ActivityCardBrokerWatcher::new(Some(0));
        let approval_id = "hexdeck-local-codex-host-codex-session-019db354-call_1";

        assert_eq!(
            watcher.take_prepare_local_approval_id(Some(approval_id)),
            Some(approval_id.to_string())
        );
        assert_eq!(
            watcher.take_prepare_local_approval_id(Some(approval_id)),
            None
        );
    }

    #[test]
    fn activity_card_broker_watcher_does_not_retry_same_local_host_approval_while_window_visible() {
        let mut watcher = ActivityCardBrokerWatcher::new(Some(0));
        let approval_id = "hexdeck-local-codex-host-codex-session-019db354-call_1";

        assert_eq!(
            watcher.take_prepare_local_approval_id(Some(approval_id)),
            Some(approval_id.to_string())
        );
        assert_eq!(
            watcher.take_prepare_local_approval_id(Some(approval_id)),
            None
        );
    }

    #[test]
    fn activity_card_broker_watcher_prefers_prepare_for_local_host_approval_when_both_signals_exist(
    ) {
        assert_eq!(
            activity_card_watcher_window_action(
                false,
                Some(501),
                Some("hexdeck-local-codex-host-codex-session-019db354-call_1")
            ),
            ActivityCardWatcherWindowAction::Prepare
        );
    }

    #[test]
    fn activity_card_window_location_defaults_to_live_route() {
        assert_eq!(
            activity_card_window_location_for(None),
            "index.html?view=activity-card"
        );
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
    fn macos_tray_has_dedicated_icon_asset() {
        #[cfg(target_os = "macos")]
        {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("src-tauri has parent")
                .join("public")
                .join("hexdeck-menu-tray.png");
            assert!(path.exists());
        }
    }

    #[test]
    fn macos_tray_normalizes_white_icon_configuration() {
        #[cfg(target_os = "macos")]
        {
            assert!(!tray_icon_uses_template_image());
            let (pixels, width, height) =
                load_tray_icon_pixels().expect("macOS tray icon should load");
            assert_eq!(width, 36);
            assert_eq!(height, 36);
            assert_eq!(pixels.len(), (width * height * 4) as usize);
            assert!(pixels.chunks_exact(4).any(|pixel| pixel[3] == 0));
            assert!(pixels.chunks_exact(4).any(|pixel| pixel[3] == 255));
            assert!(pixels
                .chunks_exact(4)
                .filter(|pixel| pixel[3] > 0)
                .all(|pixel| pixel[0] == 255 && pixel[1] == 255 && pixel[2] == 255));
        }
    }

    #[test]
    fn macos_tray_icon_has_visible_transparent_padding() {
        #[cfg(target_os = "macos")]
        {
            let (pixels, width, height) =
                load_tray_icon_pixels().expect("macOS tray icon should load");
            let mut min_x = width;
            let mut min_y = height;
            let mut max_x = 0;
            let mut max_y = 0;

            for (index, pixel) in pixels.chunks_exact(4).enumerate() {
                if pixel[3] == 0 {
                    continue;
                }

                let x = (index as u32) % width;
                let y = (index as u32) / width;
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }

            assert!(min_x > 0);
            assert!(min_y > 0);
            assert!(max_x < width - 1);
            assert!(max_y < height - 1);
        }
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
