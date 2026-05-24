//! Thin Tauri command layer.
//!
//! Commands are deliberately tiny: they resolve shared state / config and
//! delegate to the domain modules (`sidecar`, `security`). Keeping them thin
//! keeps the IPC surface easy to read and the real logic unit-testable in its
//! own modules.

use tauri::{AppHandle, State};

use crate::config;
use crate::error::DesktopResult;
use crate::security;
use crate::sidecar::{HostSidecar, HostStatus};

/// Report whether the host sidecar is running and at what URL.
#[tauri::command]
pub fn host_status(state: State<'_, HostSidecar>) -> DesktopResult<HostStatus> {
    state.status()
}

/// Start the bundled Node host sidecar (idempotent).
#[tauri::command]
pub fn start_node_host(app: AppHandle, state: State<'_, HostSidecar>) -> DesktopResult<HostStatus> {
    let root = config::trusted_root()?;
    state.start(&app, &root.to_string_lossy())
}

/// Stop the bundled Node host sidecar (idempotent).
#[tauri::command]
pub fn stop_node_host(app: AppHandle, state: State<'_, HostSidecar>) -> DesktopResult<HostStatus> {
    state.stop(&app)
}

/// Open a path with the OS default handler, but only inside the trusted root.
#[tauri::command]
pub fn open_path(app: AppHandle, path: String) -> DesktopResult<()> {
    use tauri_plugin_opener::OpenerExt;

    let root = config::trusted_root()?;
    let safe = security::assert_openable_path(&root, &path)?;
    app.opener()
        .open_path(safe.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| crate::error::DesktopError::Io(error.to_string()))
}
