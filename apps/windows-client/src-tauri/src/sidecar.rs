//! Node host sidecar 生命周期(sidecar)——打包的 Node 二进制(agent-cowork-host(.exe))随桌面程序分发。
//! 本模块在锁后持有其唯一子进程句柄,负责启动/停止/查询状态与优雅停机,保证关窗不遗留孤儿 Node 进程。
//! 启动时直接用 `std::process::Command` 指向当前 exe 旁的已知二进制,而不是 Tauri shell
//! plugin 的 sidecar() helper;后者在安装版里曾静默解析/启动失败,会让应用卡在启动态。

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
#[cfg(windows)]
use tauri::Manager;

use crate::config::{HOST, HOST_URL, PORT};
use crate::error::{DesktopError, DesktopResult};

/// host 进入 running 状态时发给 webview 的事件名。
pub const EVENT_HOST_STARTED: &str = "kimi://host-started";
/// host 被停止后发给 webview 的事件名。
pub const EVENT_HOST_STOPPED: &str = "kimi://host-stopped";

/// 打包 host 二进制文件名,运行时从桌面 exe 同目录解析。
#[cfg(windows)]
const SIDECAR_FILE: &str = "agent-cowork-host.exe";
#[cfg(not(windows))]
const SIDECAR_FILE: &str = "agent-cowork-host";

#[cfg(windows)]
const EMBEDDED_PYTHON_DIR: &str = "python-embedded";
#[cfg(windows)]
const EMBEDDED_PYTHON_EXE: &str = "python.exe";

/// Tauri 托管状态:只保存一个可选的 host 子进程句柄。
#[derive(Default)]
pub struct HostSidecar {
    child: Mutex<Option<Child>>,
}

/// 暴露给前端的 host 可用性快照。
#[derive(Serialize, Clone)]
pub struct HostStatus {
    pub url: &'static str,
    pub running: bool,
}

impl HostStatus {
    fn new(running: bool) -> Self {
        Self {
            url: HOST_URL,
            running,
        }
    }
}

/// 解析 sidecar 二进制路径:安装版与 target/<profile> 开发运行都在当前 exe 旁。
fn sidecar_path() -> DesktopResult<PathBuf> {
    let exe = std::env::current_exe().map_err(|error| DesktopError::Io(error.to_string()))?;
    let dir = exe
        .parent()
        .ok_or_else(|| DesktopError::Sidecar("cannot resolve executable directory".into()))?;
    Ok(dir.join(SIDECAR_FILE))
}

#[cfg(windows)]
fn embedded_python_paths(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    let home = app.path().resource_dir().ok()?.join(EMBEDDED_PYTHON_DIR);
    let exe = home.join(EMBEDDED_PYTHON_EXE);
    if exe.is_file() {
        Some((home, exe))
    } else {
        None
    }
}

#[cfg(windows)]
fn configure_embedded_python_env(command: &mut Command, app: &AppHandle) {
    if let Some((home, exe)) = embedded_python_paths(app) {
        command.env("KCW_PYTHON_HOME", home).env("KCW_EMBEDDED_PYTHON", exe);
    }
}

#[cfg(not(windows))]
fn configure_embedded_python_env(_command: &mut Command, _app: &AppHandle) {}

/// 轮询 TCP 连接,确认打包 host 已在 127.0.0.1:PORT 开始监听(最多约 10s)。
/// 用于在宣布 host-started 前确认 host 真正可用,避免"已启动但连不上"。
fn wait_for_host_listening() -> bool {
    use std::net::{SocketAddr, TcpStream};
    use std::time::{Duration, Instant};
    let Ok(addr) = format!("{HOST}:{PORT}").parse::<SocketAddr>() else {
        return false;
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

impl HostSidecar {
    /// 查询当前 host 状态;若子进程已自行退出,顺手回收句柄以反映真实状态。
    pub fn status(&self) -> DesktopResult<HostStatus> {
        let mut guard = self
            .child
            .lock()
            .map_err(|_| DesktopError::Lock("host sidecar"))?;
        // 子进程自行退出时清空句柄,避免 UI 误以为 host 仍在运行。
        if let Some(child) = guard.as_mut() {
            if matches!(child.try_wait(), Ok(Some(_))) {
                *guard = None;
            }
        }
        Ok(HostStatus::new(guard.is_some()))
    }

    /// 启动 host sidecar;幂等,已运行时只返回当前状态。
    pub fn start(&self, app: &AppHandle, trusted_root: &str) -> DesktopResult<HostStatus> {
        let mut guard = self
            .child
            .lock()
            .map_err(|_| DesktopError::Lock("host sidecar"))?;
        if let Some(child) = guard.as_mut() {
            // 已持有句柄时仍确认进程未退出,避免僵尸句柄导致误报。
            if matches!(child.try_wait(), Ok(None)) {
                return Ok(HostStatus::new(true));
            }
        }

        let path = sidecar_path()?;
        let mut command = Command::new(&path);
        command
            .env("HOST", HOST)
            .env("PORT", PORT)
            .env("TRUSTED_ROOT", trusted_root)
            .env("KCW_TAURI", "1")
            // host 侧 parent-watchdog 依赖此变量:外壳进程消失(强杀/崩溃/关窗未及
            // kill)时 host 自行优雅退出,杜绝孤儿 sidecar 常驻占 3017。
            .env("KCW_PARENT_PID", std::process::id().to_string());
        configure_embedded_python_env(&mut command, app);
        // Windows 上后台 host 不应弹出控制台窗口。
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let child = command.spawn().map_err(|error| {
            DesktopError::Sidecar(format!("spawn {} failed: {error}", path.display()))
        })?;
        *guard = Some(child);
        drop(guard);

        // 不在 spawn 后立刻宣布 started:host 可能尚未开始监听,甚至会因端口被占
        // (EADDRINUSE→exit)起不来。改为后台轮询 TCP,确认 host 真在监听后再 emit
        // started;未就绪则不发,避免前端"已启动但连不上"。host_status 仍如实反映进程态。
        let app_handle = app.clone();
        std::thread::spawn(move || {
            if wait_for_host_listening() {
                let _ = app_handle.emit(EVENT_HOST_STARTED, HOST_URL);
            }
        });
        Ok(HostStatus::new(true))
    }

    /// 停止 host sidecar;幂等,退出流程中可安全调用。
    pub fn stop(&self, app: &AppHandle) -> DesktopResult<HostStatus> {
        let mut guard = self
            .child
            .lock()
            .map_err(|_| DesktopError::Lock("host sidecar"))?;
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
            drop(guard);
            let _ = app.emit(EVENT_HOST_STOPPED, HOST_URL);
        }
        Ok(HostStatus::new(false))
    }

    /// 进程 teardown 阶段的尽力关闭:不向用户冒泡错误,不 panic,也不长时间阻塞。
    pub fn shutdown_quietly(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}
