//! Lifecycle management for the bundled Node host sidecar.
//!
//! The host is a packaged Node binary (`binaries/agent-cowork-host`) that serves
//! the local API + UI. This module owns its single child handle behind a mutex
//! and exposes idempotent `start` / `stop` / `status` operations. Owning the
//! lifecycle here (rather than inline in `lib.rs`) means the shell can cleanly
//! shut the host down on window close instead of leaking an orphan process.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

use crate::config::{HOST, HOST_URL, PORT};
use crate::error::{DesktopError, DesktopResult};

/// Emitted to the webview when the host transitions to running.
pub const EVENT_HOST_STARTED: &str = "kimi://host-started";
/// Emitted to the webview when the host has been stopped.
pub const EVENT_HOST_STOPPED: &str = "kimi://host-stopped";

const SIDECAR_BIN: &str = "binaries/agent-cowork-host";

/// Managed Tauri state holding the (optional) running host child.
#[derive(Default)]
pub struct HostSidecar {
    child: Mutex<Option<CommandChild>>,
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

impl HostSidecar {
    /// Current host status without mutating anything.
    pub fn status(&self) -> DesktopResult<HostStatus> {
        let guard = self
            .child
            .lock()
            .map_err(|_| DesktopError::Lock("host sidecar"))?;
        Ok(HostStatus::new(guard.is_some()))
    }

    /// Start the host sidecar if it is not already running. Idempotent: a
    /// second call while running is a no-op that reports the running status.
    pub fn start(&self, app: &AppHandle, trusted_root: &str) -> DesktopResult<HostStatus> {
        let mut guard = self
            .child
            .lock()
            .map_err(|_| DesktopError::Lock("host sidecar"))?;
        if guard.is_some() {
            return Ok(HostStatus::new(true));
        }

        let (_rx, child) = app
            .shell()
            .sidecar(SIDECAR_BIN)
            .map_err(|error| DesktopError::Sidecar(format!("create command failed: {error}")))?
            .env("HOST", HOST)
            .env("PORT", PORT)
            .env("TRUSTED_ROOT", trusted_root)
            .env("KCW_TAURI", "1")
            .spawn()
            .map_err(|error| DesktopError::Sidecar(format!("spawn failed: {error}")))?;
        *guard = Some(child);
        drop(guard);

        app.emit(EVENT_HOST_STARTED, HOST_URL)
            .map_err(|error| DesktopError::Sidecar(error.to_string()))?;
        Ok(HostStatus::new(true))
    }

    /// Stop the host sidecar if running. Idempotent and safe to call on exit.
    pub fn stop(&self, app: &AppHandle) -> DesktopResult<HostStatus> {
        let mut guard = self
            .child
            .lock()
            .map_err(|_| DesktopError::Lock("host sidecar"))?;
        if let Some(child) = guard.take() {
            child
                .kill()
                .map_err(|error| DesktopError::Sidecar(format!("kill failed: {error}")))?;
            drop(guard);
            let _ = app.emit(EVENT_HOST_STOPPED, HOST_URL);
        }
        Ok(HostStatus::new(false))
    }

    /// Best-effort shutdown used during process teardown, where surfacing an
    /// error to the user is pointless. Never panics, never blocks on emit.
    pub fn shutdown_quietly(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}
