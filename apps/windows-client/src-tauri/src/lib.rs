//! Agent Cowork desktop shell (Tauri 2).
//!
//! This crate is intentionally thin: it owns the application window, manages
//! the bundled Node host sidecar lifecycle, and exposes a small, typed IPC
//! surface to the webview. All real logic lives in focused modules:
//!
//! - [`error`]    typed, serialisable errors crossing the IPC boundary
//! - [`config`]   host binding + trusted-root resolution (single source)
//! - [`security`] trusted-path enforcement shared by every fs-touching command
//! - [`sidecar`]  Node host start/stop/status + graceful shutdown
//! - [`commands`] thin `#[tauri::command]` wrappers delegating to the above

mod commands;
mod config;
mod error;
mod security;
mod sidecar;

use tauri::Manager;

use sidecar::HostSidecar;

/// Build and run the desktop application.
///
/// The Node host is started natively in the `setup` hook so a packaged build
/// always brings it up at launch (the webview's `start_node_host` invoke is
/// only a best-effort fallback). On exit we stop the sidecar so closing the
/// window never leaves an orphaned Node process behind.
pub fn run() {
    tauri::Builder::default()
        .manage(HostSidecar::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            commands::host_status,
            commands::start_node_host,
            commands::stop_node_host,
            commands::open_path,
        ])
        .setup(|app| {
            if let Some(state) = app.try_state::<HostSidecar>() {
                if let Ok(root) = config::trusted_root() {
                    if let Err(error) = state.start(&app.handle().clone(), &root.to_string_lossy()) {
                        eprintln!("host sidecar autostart failed: {error}");
                    }
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Agent Cowork desktop")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<HostSidecar>() {
                    state.shutdown_quietly();
                }
            }
        });
}
