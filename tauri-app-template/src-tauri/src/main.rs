// Prevents additional console window on Windows in release
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod commands;
mod engine;

use tauri::Manager;

fn main() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Initialize engine on startup
            let app_handle = app.handle().clone();

            // Show window when ready
            if let Some(window) = app.get_webview_window("main") {
                window.show().unwrap();
            }

            log::info!("Application started");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Engine commands
            commands::engine::engine_health,
            commands::engine::engine_call,
            // Job commands
            commands::jobs::job_start,
            commands::jobs::job_status,
            commands::jobs::job_cancel,
            commands::jobs::job_list,
            // Project commands
            commands::project::project_open,
            commands::project::project_save,
            commands::project::project_list,
            // Settings commands
            commands::settings::settings_get,
            commands::settings::settings_set,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
