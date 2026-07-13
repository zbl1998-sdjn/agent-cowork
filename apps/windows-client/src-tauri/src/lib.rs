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
mod sidecar_health;
mod sidecar_monitor;
mod updater;

use tauri::Manager;

use sidecar::HostSidecar;

/// 生产护栏判定:release 构建是否错误地跑在 dev(devUrl)模式。
///
/// release 版必须加载内嵌前端。若它处于 dev 模式,说明构建漏了 `custom-protocol` feature,
/// webview 会去连本机 dev server(如 `127.0.0.1:5173`)——任何占用该端口的进程都能把外部前端
/// 注入进这个拥有 IPC 权限、能驱动 host 的窗口,构成本地 UI 欺骗 / 提权面。所以 release + dev 必须拒绝启动。
/// 抽成纯函数便于单测;真实的两个入参来自 `!cfg!(debug_assertions)` 与 `tauri::is_dev()`。
fn dev_mode_forbidden(is_release_build: bool, running_in_dev: bool) -> bool {
    is_release_build && running_in_dev
}

/// 构建并运行桌面应用:注册插件与 IPC 命令、在 setup 钩子里原生拉起 Node host、退出时停止 sidecar(避免遗留孤儿进程)。
/// setup 钩子原生启动 Node host,让安装版启动时一定拉起 host;webview 的 start_node_host 只是兜底。
pub fn run() {
    // 生产护栏:release 版绝不允许连 dev server 加载外部前端(见 dev_mode_forbidden)。
    if dev_mode_forbidden(!cfg!(debug_assertions), tauri::is_dev()) {
        eprintln!(
            "FATAL: Agent Cowork release build is running in dev (devUrl) mode — refusing to start \
             to avoid loading an external frontend from a local dev server. Rebuild with `tauri build` \
             or `cargo build --release --features tauri/custom-protocol`."
        );
        std::process::exit(78); // EX_CONFIG
    }
    tauri::Builder::default()
        .manage(HostSidecar::default())
        .plugin(tauri_plugin_opener::init())
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
                    if let Err(error) = state.start(&app.handle().clone(), &root.to_string_lossy())
                    {
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

#[cfg(test)]
mod tests {
    use super::dev_mode_forbidden;

    #[test]
    fn release_running_in_dev_is_forbidden() {
        // 唯一被拒绝的组合:release 二进制却跑在 dev(会连 devUrl)。
        assert!(dev_mode_forbidden(true, true));
    }

    #[test]
    fn release_in_production_is_allowed() {
        // 正常发布:release + 内嵌前端。
        assert!(!dev_mode_forbidden(true, false));
    }

    #[test]
    fn debug_builds_are_never_forbidden() {
        // 开发时(debug 构建)本就该用 dev server,不拦。
        assert!(!dev_mode_forbidden(false, true));
        assert!(!dev_mode_forbidden(false, false));
    }
}
