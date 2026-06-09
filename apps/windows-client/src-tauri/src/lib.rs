//! Agent Cowork 桌面外壳(Tauri 2)— 组装根 / crate 入口。
//!
//! 中文说明:本 crate 刻意「保持薄」(plan/00 桌面外壳准则)——只负责开窗、守护打包的 Node host
//! sidecar、向 webview 暴露一小撮带类型的 IPC 命令;真正的业务逻辑都在 host(Node)里。各模块职责单一:
//! error(IPC 错误)/ config(绑定与可信根)/ security(路径围栏)/ sidecar(host 生命周期)/
//! commands(薄命令层)/ updater(自动更新)。绝不把业务塞进外壳。

mod commands;
mod config;
mod error;
mod security;
mod sidecar;
mod updater;

use tauri::Manager;

use sidecar::HostSidecar;

/// 构建并运行桌面应用:注册插件与 IPC 命令、在 setup 钩子里原生拉起 Node host、退出时停止 sidecar(避免遗留孤儿进程)。
/// setup 钩子原生启动 Node host,让安装版启动时一定拉起 host;webview 的 start_node_host 只是兜底。
pub fn run() {
    tauri::Builder::default()
        .manage(HostSidecar::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::host_status,
            commands::start_node_host,
            commands::stop_node_host,
            commands::open_path,
            commands::check_desktop_update,
            commands::install_desktop_update,
            commands::reveal_bundled_installer,
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
