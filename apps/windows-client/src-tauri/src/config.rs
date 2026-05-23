//! Static and environment-derived configuration for the desktop shell.
//!
//! Keeping configuration in one place means the host binding, dev URL, and
//! trusted-root resolution have a single source of truth that both the sidecar
//! launcher and the security layer read from.

use std::env;
use std::path::PathBuf;

use crate::error::{DesktopError, DesktopResult};

/// Loopback host the bundled Node host binds to.
pub const HOST: &str = "127.0.0.1";
/// Port the bundled Node host listens on (kept in sync with `tauri.conf.json`).
pub const PORT: &str = "3017";
/// Fully-qualified local URL of the host, used by the webview and status calls.
pub const HOST_URL: &str = "http://127.0.0.1:3017";

/// Resolve the trusted workspace root the host is allowed to operate within.
///
/// Resolution order (first match wins):
/// 1. `KCW_TRUSTED_ROOT` — explicit override.
/// 2. `KCW_REPO_ROOT` — repo checkout root (dev convenience).
/// 3. The user's home directory (`USERPROFILE`/`HOME`).
/// 4. The process current directory (last resort).
///
/// Note: an *installed* app is usually launched with a current directory that
/// is the launcher's cwd (often a non-writable system path), so falling back to
/// the home directory guarantees the host can always create its `.AgentCowork`
/// state (config/auth/runs). The per-request workspace the user picks is passed
/// separately on each `/api` call; this value is only the host's own home.
pub fn trusted_root() -> DesktopResult<PathBuf> {
    if let Ok(root) = env::var("KCW_TRUSTED_ROOT") {
        if !root.is_empty() {
            return Ok(PathBuf::from(root));
        }
    }
    if let Ok(root) = env::var("KCW_REPO_ROOT") {
        if !root.is_empty() {
            return Ok(PathBuf::from(root));
        }
    }
    for var in ["USERPROFILE", "HOME"] {
        if let Ok(home) = env::var(var) {
            if !home.is_empty() {
                return Ok(PathBuf::from(home));
            }
        }
    }
    env::current_dir().map_err(|error| DesktopError::Io(error.to_string()))
}
