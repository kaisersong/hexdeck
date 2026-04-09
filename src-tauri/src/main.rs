#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs::OpenOptions;
use std::io::Write;
use std::process::Command;
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

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

fn activity_card_window_size() -> (f64, f64) {
    (420.0, 120.0)
}

fn activity_card_window_resizable() -> bool {
    false
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
        .visible(true)
        .build()
}

fn expanded_window_location(section: &str) -> String {
    format!("index.html?view=expanded&section={section}")
}

fn sync_window_location(window: &WebviewWindow, location: &str) -> tauri::Result<()> {
    window.eval(&format!("window.location.replace({location:?});"))
}

fn ensure_expanded_window(app: &tauri::AppHandle, section: &str) -> tauri::Result<WebviewWindow> {
    let location = expanded_window_location(section);

    if let Some(window) = app.get_webview_window("expanded") {
        sync_window_location(&window, &location)?;
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
        return Ok(window);
    }

    let (width, height) = activity_card_window_size();
    WebviewWindowBuilder::new(
        app,
        "activity-card",
        WebviewUrl::App("index.html?view=activity-card".into()),
    )
    .title("HexDeck Activity Card")
    .inner_size(width, height)
    .resizable(activity_card_window_resizable())
    .visible(false)
    .always_on_top(true)
    .decorations(false)
    .skip_taskbar(true)
    .build()
}

#[tauri::command]
fn toggle_panel_command(app: tauri::AppHandle) -> Result<(), String> {
    let window = ensure_panel_window(&app).map_err(|error| error.to_string())?;
    let visible = window.is_visible().map_err(|error| error.to_string())?;

    if visible {
        window.hide().map_err(|error| error.to_string())?;
        return Ok(());
    }

    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_expanded_window(app: tauri::AppHandle, section: String) -> Result<(), String> {
    let window = ensure_expanded_window(&app, &section).map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn show_activity_card_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = ensure_activity_card_window(&app).map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn hide_activity_card_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("activity-card") {
        window.hide().map_err(|error| error.to_string())?;
    }

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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            toggle_panel_command,
            open_expanded_window,
            show_activity_card_window,
            hide_activity_card_window,
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
            commands::respond_to_broker_approval,
            commands::get_broker_runtime_status,
            commands::ensure_broker_running,
            commands::restart_broker_runtime,
            commands::start_broker,
            commands::ensure_broker_ready
        ])
        .setup(|app| {
            let _panel = ensure_panel_window(app.handle())?;

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
    fn activity_card_window_size_is_compact_and_non_resizable() {
        assert_eq!(activity_card_window_size(), (420.0, 120.0));
        assert!(!activity_card_window_resizable());
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
