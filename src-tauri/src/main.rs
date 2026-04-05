#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::process::Command;
use tauri::{WebviewUrl, WebviewWindowBuilder};

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

fn main() {
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
