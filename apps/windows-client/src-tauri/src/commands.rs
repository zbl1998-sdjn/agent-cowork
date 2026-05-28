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
use crate::updater::{self, DesktopUpdateInstallResult, DesktopUpdateStatus};

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

#[tauri::command]
pub async fn check_desktop_update(app: AppHandle) -> DesktopResult<DesktopUpdateStatus> {
    updater::check_desktop_update(app).await
}

#[tauri::command]
pub async fn install_desktop_update(app: AppHandle) -> DesktopResult<DesktopUpdateInstallResult> {
    updater::install_desktop_update(app).await
}

/// Find the most recent installer next to the running executable (Tauri puts
/// bundles under `target/release/bundle/{nsis,msi}/`) and reveal its folder in
/// Explorer so the user can copy/share the installer. Returns the path that was
/// found. Errors when no bundle has been built yet.
#[tauri::command]
pub fn reveal_bundled_installer(app: AppHandle) -> DesktopResult<String> {
    use std::path::PathBuf;
    use std::time::SystemTime;
    use tauri_plugin_opener::OpenerExt;

    let exe = std::env::current_exe()
        .map_err(|error| crate::error::DesktopError::Io(error.to_string()))?;
    let release_dir = exe
        .parent()
        .ok_or_else(|| crate::error::DesktopError::Io("无法解析可执行文件目录".into()))?;
    let bundle_root = release_dir.join("bundle");

    let mut newest: Option<(PathBuf, SystemTime)> = None;
    for sub in ["nsis", "msi"] {
        let dir = bundle_root.join(sub);
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let ext = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            if ext != "exe" && ext != "msi" {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                if let Ok(modified) = meta.modified() {
                    let beats = newest
                        .as_ref()
                        .map(|(_, current)| modified > *current)
                        .unwrap_or(true);
                    if beats {
                        newest = Some((path, modified));
                    }
                }
            }
        }
    }

    let installer = newest.map(|(path, _)| path).ok_or_else(|| {
        crate::error::DesktopError::Io(
            "找不到安装包(查找位置:target/release/bundle/{nsis,msi}/),请先 `npm run build:host` 后 `cargo tauri build`".into(),
        )
    })?;

    // Open Explorer at the containing folder; the user can drag the .exe/.msi.
    let folder = installer
        .parent()
        .ok_or_else(|| crate::error::DesktopError::Io("安装包路径异常".into()))?;
    app.opener()
        .open_path(folder.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| crate::error::DesktopError::Io(error.to_string()))?;

    Ok(installer.to_string_lossy().to_string())
}
