//! Desktop auto-update commands backed by the Tauri updater plugin.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

use crate::error::{DesktopError, DesktopResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateStatus {
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub date: Option<String>,
    pub body: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateInstallResult {
    pub installed: bool,
    pub current_version: String,
    pub version: Option<String>,
}

fn update_error(error: tauri_plugin_updater::Error) -> DesktopError {
    DesktopError::Update(error.to_string())
}

pub async fn check_desktop_update(app: AppHandle) -> DesktopResult<DesktopUpdateStatus> {
    let current_version = app.package_info().version.to_string();
    let update = app.updater().map_err(update_error)?.check().await.map_err(update_error)?;
    Ok(match update {
        Some(update) => DesktopUpdateStatus {
            available: true,
            current_version,
            version: Some(update.version.to_string()),
            date: update.date.map(|date| date.to_string()),
            body: update.body,
        },
        None => DesktopUpdateStatus {
            available: false,
            current_version,
            version: None,
            date: None,
            body: None,
        },
    })
}

pub async fn install_desktop_update(app: AppHandle) -> DesktopResult<DesktopUpdateInstallResult> {
    let current_version = app.package_info().version.to_string();
    let update = app.updater().map_err(update_error)?.check().await.map_err(update_error)?;
    let Some(update) = update else {
        return Ok(DesktopUpdateInstallResult {
            installed: false,
            current_version,
            version: None,
        });
    };

    let version = update.version.to_string();
    update.download_and_install(|_, _| {}, || {}).await.map_err(update_error)?;
    Ok(DesktopUpdateInstallResult {
        installed: true,
        current_version,
        version: Some(version),
    })
}
