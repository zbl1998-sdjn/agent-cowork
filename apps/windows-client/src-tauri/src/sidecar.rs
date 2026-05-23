//! Lifecycle management for the bundled Node host sidecar.
//!
//! The host is a packaged Node binary (`agent-cowork-host(.exe)`) shipped next
//! to the desktop executable. This module owns its single child handle behind a
//! mutex and exposes idempotent `start` / `stop` / `status` operations. Owning
//! the lifecycle here (rather than inline in `lib.rs`) means the shell can
//! cleanly shut the host down on window close instead of leaking an orphan.
//!
//! We spawn the sidecar with `std::process::Command` (pointed at the binary next
//! to the current executable) rather than the Tauri shell plugin's `sidecar()`
//! helper. The plugin helper resolved/spawned unreliably in packaged builds —
//! the spawn failed silently, the host never came up, and the app hung on its
//! boot splash. A direct `Command` spawn of a known-present binary is robust and
//! behaves identically in dev and installed builds.

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::config::{HOST, HOST_URL, PORT};
use crate::error::{DesktopError, DesktopResult};

/// Emitted to the webview when the host transitions to running.
pub const EVENT_HOST_STARTED: &str = "kimi://host-started";
/// Emitted to the webview when the host has been stopped.
pub const EVENT_HOST_STOPPED: &str = "kimi://host-stopped";

/// Basename of the bundled host binary, resolved next to the desktop exe.
#[cfg(windows)]
const SIDECAR_FILE: &str = "agent-cowork-host.exe";
#[cfg(not(windows))]
const SIDECAR_FILE: &str = "agent-cowork-host";

/// Managed Tauri state holding the (optional) running host child.
#[derive(Default)]
pub struct HostSidecar {
    child: Mutex<Option<Child>>,
}

/// Snapshot of host availability for the frontend.
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

/// Resolve the sidecar binary path: it sits next to the running executable in
/// both packaged installs and `target/<profile>` dev runs.
fn sidecar_path() -> DesktopResult<PathBuf> {
    let exe = std::env::current_exe().map_err(|error| DesktopError::Io(error.to_string()))?;
    let dir = exe
        .parent()
        .ok_or_else(|| DesktopError::Sidecar("cannot resolve executable directory".into()))?;
    Ok(dir.join(SIDECAR_FILE))
}

impl HostSidecar {
    /// Current host status without mutating anything.
    pub fn status(&self) -> DesktopResult<HostStatus> {
        let mut guard = self
            .child
            .lock()
            .map_err(|_| DesktopError::Lock("host sidecar"))?;
        // Reap a child that exited on its own so status reflects reality.
        if let Some(child) = guard.as_mut() {
            if matches!(child.try_wait(), Ok(Some(_))) {
                *guard = None;
            }
        }
        Ok(HostStatus::new(guard.is_some()))
    }

    /// Start the host sidecar if it is not already running. Idempotent: a
    /// second call while running is a no-op that reports the running status.
    pub fn start(&self, app: &AppHandle, trusted_root: &str) -> DesktopResult<HostStatus> {
        let mut guard = self
            .child
            .lock()
            .map_err(|_| DesktopError::Lock("host sidecar"))?;
        if let Some(child) = guard.as_mut() {
            // Already have a handle; only treat as running if it hasn't exited.
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
            .env("KCW_TAURI", "1");
        // Don't pop a console window for the background host on Windows.
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

        let _ = app.emit(EVENT_HOST_STARTED, HOST_URL);
        Ok(HostStatus::new(true))
    }

    /// Stop the host sidecar if running. Idempotent and safe to call on exit.
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

    /// Best-effort shutdown used during process teardown, where surfacing an
    /// error to the user is pointless. Never panics, never blocks for long.
    pub fn shutdown_quietly(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}
