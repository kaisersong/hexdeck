#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
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
