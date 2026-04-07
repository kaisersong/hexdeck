#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod commands;

use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs::OpenOptions;
use std::io::Write;
use std::process::Command;
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_positioner::{Position, WindowExt};

const PANEL_LABEL: &str = "panel";
const EXPANDED_LABEL: &str = "expanded";
const DRAG_DEMO_LABEL: &str = "drag-demo";
const PANEL_WIDTH: f64 = 340.0;
const PANEL_HEIGHT: f64 = 460.0;
const EXPANDED_WIDTH: f64 = 920.0;
const EXPANDED_HEIGHT: f64 = 680.0;
const DRAG_DEMO_WIDTH: f64 = 680.0;
const DRAG_DEMO_HEIGHT: f64 = 760.0;
const MENU_OPEN_ID: &str = "open";
const MENU_DRAG_DEMO_ID: &str = "drag-demo";
const MENU_QUIT_ID: &str = "quit";

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
    terminal_app: String,
    #[serde(rename = "precision")]
    _precision: String,
    session_hint: Option<String>,
    project_path: Option<String>,
}

#[derive(Debug, Serialize)]
struct JumpResultPayload {
    ok: bool,
    precision: String,
    reason: Option<String>,
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

#[tauri::command]
fn jump_with_ghostty(target: JumpTargetPayload) -> Result<JumpResultPayload, String> {
    let session_hint = escape_applescript(target.session_hint.as_deref().unwrap_or(""));
    let project_path = escape_applescript(target.project_path.as_deref().unwrap_or(""));

    let script = format!(
        r#"
tell application "Ghostty"
    activate
    set matches to {{}}
    if "{session_hint}" is not "" then
        set matches to every terminal whose name contains "{session_hint}"
    end if
    if (count of matches) = 0 and "{project_path}" is not "" then
        set matches to every terminal whose working directory contains "{project_path}"
    end if
    if (count of matches) > 0 then
        set focusedTerm to item 1 of matches
        focus focusedTerm
        return "exact"
    end if
    return "best_effort"
end tell
"#
    );

    match execute_osascript(&script) {
        Ok(result) => Ok(jump_result(true, &normalize_precision(&result, "best_effort"), None)),
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
        Ok(result) => Ok(jump_result(true, &normalize_precision(&result, "best_effort"), None)),
        Err(reason) => Ok(jump_result(false, "unsupported", Some(reason))),
    }
}

#[tauri::command]
fn jump_with_terminal_app(target: JumpTargetPayload) -> Result<JumpResultPayload, String> {
    let app_name = if target.terminal_app == "Terminal.app" {
        "Terminal"
    } else {
        "Terminal"
    };
    let script = format!(
        r#"
tell application "{app_name}"
    activate
end tell
return "best_effort"
"#
    );

    match execute_osascript(&script) {
        Ok(result) => Ok(jump_result(true, &normalize_precision(&result, "best_effort"), None)),
        Err(reason) => Ok(jump_result(false, "unsupported", Some(reason))),
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
    Err("terminal_title_cli_is_only_supported_on_unix".to_string())
}

/// Get the current terminal window title by querying the terminal process.
/// This uses AppleScript for iTerm2 and Terminal.app, and falls back to a heuristic for Ghostty.
fn get_terminal_title_via_applescript(term_program: &str) -> Option<String> {
    let script = match term_program {
        "iTerm.app" => r#"
tell application "iTerm2"
    tell current session of current window
        return name
    end tell
end tell
"#,
        "Apple_Terminal" => r#"
tell application "Terminal"
    return custom title of front window
end tell
"#,
        _ => return None,
    };

    execute_osascript(script).ok()
}

/// Get Ghostty terminal title by finding the terminal with matching tty.
fn get_ghostty_title_for_tty(_tty_path: &str) -> Option<String> {

    // Get list of Ghostty terminals and find the one matching our tty
    let script = r#"
tell application "Ghostty"
    set terminalList to every terminal
    set output to ""
    repeat with t in terminalList
        set output to output & (name of t) & "|"
    end repeat
    return output
end tell
"#;

    let names = execute_osascript(script).ok()?;
    // Return the first terminal name (best effort)
    names.split('|').next().map(|s| s.trim().to_string())
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
        Some("ghostty") => {
            // Ghostty doesn't support AppleScript title read, use tty matching
            get_ghostty_title_for_tty(&tty_path).unwrap_or_default()
        }
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
        Some("ghostty") => {
            get_ghostty_title_for_tty(&tty_path).unwrap_or_default()
        }
        _ => String::new(),
    };

    // Remove alias from title
    let new_title = clear_alias_from_title(&current_title, alias)
        .ok_or_else(|| "alias_not_in_title_or_would_be_empty".to_string())?;

    // Set title via OSC sequence
    set_title_via_osc(&tty_path, &new_title)?;

    Ok(())
}

fn build_panel(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let panel = WebviewWindowBuilder::new(app, PANEL_LABEL, WebviewUrl::App("index.html".into()))
        .title("HexDeck")
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .min_inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(true)
        .visible(false)
        .decorations(false)
        .always_on_top(false)
        .skip_taskbar(true)
        .build()?;

    let panel_handle = panel.clone();
    panel.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = panel_handle.hide();
        }
        _ => {}
    });

    Ok(panel)
}

fn build_expanded_window(app: &AppHandle, section: &str) -> tauri::Result<WebviewWindow> {
    let url = format!("index.html?view=expanded&section={section}");
    WebviewWindowBuilder::new(app, EXPANDED_LABEL, WebviewUrl::App(url.into()))
        .title("HexDeck")
        .inner_size(EXPANDED_WIDTH, EXPANDED_HEIGHT)
        .min_inner_size(720.0, 520.0)
        .visible(true)
        .resizable(true)
        .maximizable(true)
        .minimizable(true)
        .build()
}

fn build_drag_demo_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(
        app,
        DRAG_DEMO_LABEL,
        WebviewUrl::App("index.html?view=drag-demo".into()),
    )
    .title("HexDeck Drag Lab")
    .inner_size(DRAG_DEMO_WIDTH, DRAG_DEMO_HEIGHT)
    .min_inner_size(560.0, 620.0)
    .visible(true)
    .decorations(true)
    .resizable(true)
    .maximizable(false)
    .minimizable(true)
    .build()
}

fn quit_app(app: &AppHandle) {
    app.cleanup_before_exit();
    app.exit(0);
}

fn show_panel(app: &AppHandle, from_tray: bool) {
    if let Some(panel) = app.get_webview_window(PANEL_LABEL) {
        let _ = panel.set_size(LogicalSize::new(PANEL_WIDTH, PANEL_HEIGHT));
        if from_tray {
            let _ = panel.move_window_constrained(Position::TrayCenter);
        }
        let _ = panel.show();
        let _ = panel.unminimize();
        let _ = panel.set_focus();
    }
}

fn toggle_panel(app: &AppHandle, from_tray: bool, cursor_position: Option<(f64, f64)>) {
    let Some(panel) = app.get_webview_window(PANEL_LABEL) else {
        return;
    };

    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
        return;
    }

    let _ = panel.set_size(LogicalSize::new(PANEL_WIDTH, PANEL_HEIGHT));

    if from_tray {
        let _ = panel.move_window_constrained(Position::TrayCenter);
    } else if let Some((_x, _y)) = cursor_position {
        // Reserved for future non-tray entrypoints.
    }

    let _ = panel.show();
    let _ = panel.unminimize();
    let _ = panel.set_focus();
}

fn open_expanded_window_inner(app: &AppHandle, section: &str) -> Result<(), String> {
    if let Some(expanded) = app.get_webview_window(EXPANDED_LABEL) {
        let script = format!(
            "window.location.replace(`${{window.location.pathname}}?view=expanded&section={section}`);"
        );
        let _ = expanded.eval(&script);
        let _ = expanded.show();
        let _ = expanded.unminimize();
        let _ = expanded.set_focus();
        return Ok(());
    }

    build_expanded_window(app, section)
        .map(|window| {
            let _ = window.set_focus();
        })
        .map_err(|error| format!("failed_to_open_expanded_window: {error}"))
}

fn open_drag_demo_window_inner(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(DRAG_DEMO_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }

    build_drag_demo_window(app)
        .map(|window| {
            let _ = window.set_focus();
        })
        .map_err(|error| format!("failed_to_open_drag_demo_window: {error}"))
}

#[tauri::command]
fn toggle_panel_command(app: AppHandle) {
    toggle_panel(&app, false, None);
}

#[tauri::command]
fn open_expanded_window(app: AppHandle, section: Option<String>) -> Result<(), String> {
    let section = section.as_deref().unwrap_or("overview");
    open_expanded_window_inner(&app, section)
}

#[tauri::command]
fn open_drag_demo_window(app: AppHandle) -> Result<(), String> {
    open_drag_demo_window_inner(&app)
}

#[tauri::command]
fn quit_app_command(app: AppHandle) {
    quit_app(&app);
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text(MENU_OPEN_ID, "Open HexDeck")
        .text(MENU_DRAG_DEMO_ID, "Open Drag Lab")
        .text(MENU_QUIT_ID, "Quit")
        .build()?;

    let mut tray_builder = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            tauri_plugin_positioner::on_tray_event(&tray.app_handle(), &event);
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                position,
                ..
            } = event
            {
                toggle_panel(&tray.app_handle(), true, Some((position.x, position.y)));
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray_builder = tray_builder.icon(icon);
    }

    let _tray = tray_builder.build(app)?;
    Ok(())
}

fn configure_platform_shell(_app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = _app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        let _ = _app.set_dock_visibility(false);
    }
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
                TitleActions::Clear { alias } => {
                    match execute_title_clear(&alias) {
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
            },
            None => {
                // No subcommand, proceed to GUI
            }
        }
    }

    // GUI mode: run Tauri application
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(expanded) = app.get_webview_window(EXPANDED_LABEL) {
                let _ = expanded.show();
                let _ = expanded.unminimize();
                let _ = expanded.set_focus();
                return;
            }

            show_panel(app, false);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN_ID => show_panel(app, false),
            MENU_DRAG_DEMO_ID => {
                let _ = open_drag_demo_window_inner(app);
            }
            MENU_QUIT_ID => quit_app(app),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            toggle_panel_command,
            open_expanded_window,
            open_drag_demo_window,
            quit_app_command,
            jump_with_ghostty,
            jump_with_iterm,
            jump_with_terminal_app,
            commands::get_installed_broker_version,
            commands::get_installed_broker_path,
            commands::fetch_latest_broker_release,
            commands::install_broker_update,
            commands::is_broker_running,
            commands::get_broker_runtime_status,
            commands::ensure_broker_running,
            commands::restart_broker_runtime,
            commands::open_project_path
        ])
        .setup(|app| {
            build_panel(app.handle())?;
            setup_tray(app.handle())?;
            configure_platform_shell(app.handle());
            show_panel(app.handle(), false);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running hexdeck");
}

#[cfg(test)]
mod tests {
    use super::*;

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
