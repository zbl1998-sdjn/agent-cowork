//! Node host sidecar 生命周期(sidecar)——打包的 Node 二进制(agent-cowork-host(.exe))随桌面程序分发。
//! 本模块持有其唯一子进程句柄和每次启动独立的认证密钥。只有通过本机 challenge/HMAC
//! 身份校验后，才会向 webview 宣布 host 可用；密钥从不进入 loopback 响应、事件或 renderer。

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use ring::rand::{SecureRandom, SystemRandom};
use serde::Serialize;
use tauri::AppHandle;
#[cfg(windows)]
use tauri::Manager;

use crate::config::{HOST, HOST_URL, PORT};
use crate::error::{DesktopError, DesktopResult};
use crate::sidecar_health::{encode_hex, SECRET_BYTES};
use crate::sidecar_monitor::{emit_host_stopped, monitor_generation, SidecarState};

// TODO(env-rename batch): KCW_SIDECAR_SECRET is a live Tauri<->host handshake secret
// (see apps/host/src/routes/sidecar-health-proof.ts SECRET_ENV) — rename together with
// the host side in the same commit, not here in isolation.
const SIDECAR_SECRET_ENV: &str = "KCW_SIDECAR_SECRET";

/// 打包 host 二进制文件名,运行时从桌面 exe 同目录解析。
#[cfg(windows)]
const SIDECAR_FILE: &str = "agent-cowork-host.exe";
#[cfg(not(windows))]
const SIDECAR_FILE: &str = "agent-cowork-host";

#[cfg(windows)]
const EMBEDDED_PYTHON_DIR: &str = "python-embedded";
#[cfg(windows)]
const EMBEDDED_PYTHON_EXE: &str = "python.exe";

/// Tauri 托管状态:保存唯一 host 子进程及其仅限 native 层使用的身份状态。
#[derive(Default)]
pub struct HostSidecar {
    state: Arc<Mutex<SidecarState>>,
}

/// 暴露给前端的 host 可用性快照。verified 仅由 native HMAC 校验置真。
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct HostStatus {
    pub url: &'static str,
    pub running: bool,
    pub verified: bool,
}

impl HostStatus {
    fn new(running: bool, verified: bool) -> Self {
        Self {
            url: HOST_URL,
            running,
            verified: running && verified,
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
        // 同时设置新旧变量名:host(Node)侧目前仍读取 KCW_PYTHON_HOME /
        // KCW_EMBEDDED_PYTHON(见 apps/host/src/runtime/python-runtime.ts),待其
        // 完成 ACW_* 改名前两者都设置以保持握手不断。
        command
            .env("ACW_PYTHON_HOME", &home)
            .env("KCW_PYTHON_HOME", &home)
            .env("ACW_EMBEDDED_PYTHON", &exe)
            .env("KCW_EMBEDDED_PYTHON", &exe);
    }
}

#[cfg(not(windows))]
fn configure_embedded_python_env(_command: &mut Command, _app: &AppHandle) {}

impl HostSidecar {
    /// 查询真实进程态和 native 身份校验态；子进程退出后立即撤销信任。
    pub fn status(&self) -> DesktopResult<HostStatus> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| DesktopError::Lock("host sidecar"))?;
        Ok(guard.status()?.map_or_else(
            || HostStatus::new(false, false),
            |verified| HostStatus::new(true, verified),
        ))
    }

    /// 启动 host sidecar；幂等。新进程先返回 running=true/verified=false，
    /// 只有后台 challenge/HMAC 校验成功后 verified 才会变为 true。
    pub fn start(&self, app: &AppHandle, trusted_root: &str) -> DesktopResult<HostStatus> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| DesktopError::Lock("host sidecar"))?;
        if let Some(verified) = guard.status()? {
            return Ok(HostStatus::new(true, verified));
        }

        let mut secret = [0_u8; SECRET_BYTES];
        SystemRandom::new()
            .fill(&mut secret)
            .map_err(|_| DesktopError::Sidecar("generate sidecar identity secret failed".into()))?;
        let secret_hex = encode_hex(&secret);

        let path = sidecar_path()?;
        let mut command = Command::new(&path);
        command
            .env("HOST", HOST)
            .env("PORT", PORT)
            .env("TRUSTED_ROOT", trusted_root)
            .env("ACW_TAURI", "1")
            .env(SIDECAR_SECRET_ENV, &secret_hex)
            // host 侧 parent-watchdog 依赖此变量:外壳进程消失(强杀/崩溃/关窗未及
            // kill)时 host 自行优雅退出,杜绝孤儿 sidecar 常驻占 3017。
            // 同时设置新旧变量名:host(apps/host/src/main.ts)目前仍读取
            // KCW_PARENT_PID,待其完成 ACW_* 改名前两者都设置以保持握手不断。
            .env("ACW_PARENT_PID", std::process::id().to_string())
            .env("KCW_PARENT_PID", std::process::id().to_string());
        configure_embedded_python_env(&mut command, app);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let child = command.spawn().map_err(|error| {
            secret.fill(0);
            DesktopError::Sidecar(format!("spawn {} failed: {error}", path.display()))
        })?;
        let generation = guard.register(child, secret);
        drop(guard);

        let state = Arc::clone(&self.state);
        let app_handle = app.clone();
        std::thread::spawn(move || monitor_generation(state, app_handle, generation));
        Ok(HostStatus::new(true, false))
    }

    /// 停止 host sidecar；幂等，并立即清除进程句柄、密钥与信任态。
    pub fn stop(&self, app: &AppHandle) -> DesktopResult<HostStatus> {
        let stopped = self
            .state
            .lock()
            .map_err(|_| DesktopError::Lock("host sidecar"))?
            .stop();
        if stopped {
            emit_host_stopped(app);
        }
        Ok(HostStatus::new(false, false))
    }

    /// 进程 teardown 阶段的尽力关闭：不向用户冒泡错误，不 panic，也不长时间阻塞。
    pub fn shutdown_quietly(&self) {
        if let Ok(mut guard) = self.state.lock() {
            guard.stop();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::HostStatus;

    #[test]
    fn stopped_status_can_never_be_verified() {
        assert_eq!(
            HostStatus::new(false, true),
            HostStatus {
                url: super::HOST_URL,
                running: false,
                verified: false,
            }
        );
    }
}
