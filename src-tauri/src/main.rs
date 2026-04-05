#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs::OpenOptions;
use std::io::Write;
use std::process::Command;
use tauri::{WebviewUrl, WebviewWindowBuilder};

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
        .invoke_handler(tauri::generate_handler![
            jump_with_ghostty,
            jump_with_iterm,
            jump_with_terminal_app
        ])
        .setup(|app| {
            let _panel = WebviewWindowBuilder::new(
                app,
                "panel",
                WebviewUrl::App("index.html".into()),
            )
            .title("HexDeck")
            .inner_size(420.0, 620.0)
            .visible(true)
            .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running hexdeck");
}