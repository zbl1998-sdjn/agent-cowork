//! 薄命令层(commands)——#[tauri::command] 包装:解析共享状态/配置后委派给 sidecar/security/updater 等领域模块。
//! 命令故意保持极薄,新增原生能力 = 新模块 + 一个薄 command,不往这里堆逻辑(plan/00 外壳准则)。

use tauri::{AppHandle, State};

use crate::config;
use crate::error::DesktopResult;
use crate::security;
use crate::sidecar::{HostSidecar, HostStatus};
use crate::updater::{self, DesktopUpdateInstallResult, DesktopUpdateStatus};

/// 返回 host sidecar 是否运行以及其本地 URL。
#[tauri::command]
pub fn host_status(state: State<'_, HostSidecar>) -> DesktopResult<HostStatus> {
    state.status()
}

/// 启动打包的 Node host sidecar(幂等)。
#[tauri::command]
pub fn start_node_host(app: AppHandle, state: State<'_, HostSidecar>) -> DesktopResult<HostStatus> {
    let root = config::trusted_root()?;
    state.start(&app, &root.to_string_lossy())
}

/// 停止打包的 Node host sidecar(幂等)。
#[tauri::command]
pub fn stop_node_host(app: AppHandle, state: State<'_, HostSidecar>) -> DesktopResult<HostStatus> {
    state.stop(&app)
}

/// 用系统默认程序打开被动文档,但必须先通过可信根、敏感路径与文件类型 allowlist 校验。
/// 执行文件/脚本/快捷方式/未知类型拒绝；目录仅保留产物目录例外，其他场景走专用 reveal command。
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

/// 查找当前 exe 旁最新的安装包(Tauri 放在 target/release/bundle/{nsis,msi}/),并在 Explorer 中打开其目录。
/// 返回找到的安装包路径;尚未构建安装包时返回错误。
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
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
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

    // 在 Explorer 中打开所在文件夹,用户可直接拖拽 .exe/.msi。
    let folder = installer
        .parent()
        .ok_or_else(|| crate::error::DesktopError::Io("安装包路径异常".into()))?;
    app.opener()
        .open_path(folder.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| crate::error::DesktopError::Io(error.to_string()))?;

    Ok(installer.to_string_lossy().to_string())
}
