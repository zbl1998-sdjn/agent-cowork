//! Error handling for the Agent Cowork desktop shell.
//!
//! Every fallible operation in the shell returns [`DesktopResult`]. The error
//! type is intentionally small and serialisable so it can cross the Tauri IPC
//! boundary into the webview as a plain message, while still carrying enough
//! structure (variants) for Rust-side matching and logging.

use std::fmt;

/// A typed error for desktop-shell operations.
///
/// Variants map to the distinct failure domains of the shell. Adding a new
/// failure mode means adding a variant here rather than threading bare
/// `String`s through the call sites.
#[derive(Debug)]
pub enum DesktopError {
    /// The Node host sidecar could not be created, started, or stopped.
    Sidecar(String),
    /// A requested path was invalid or escaped the trusted root.
    Path(String),
    /// A shared lock (e.g. the sidecar handle) was poisoned.
    Lock(&'static str),
    /// An underlying I/O or platform call failed.
    Io(String),
}

impl DesktopError {
    /// Short, stable category string. Useful for logging / metrics tags.
    pub fn kind(&self) -> &'static str {
        match self {
            DesktopError::Sidecar(_) => "sidecar",
            DesktopError::Path(_) => "path",
            DesktopError::Lock(_) => "lock",
            DesktopError::Io(_) => "io",
        }
    }
}

impl fmt::Display for DesktopError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DesktopError::Sidecar(msg) => write!(f, "host sidecar error: {msg}"),
            DesktopError::Path(msg) => write!(f, "path error: {msg}"),
            DesktopError::Lock(what) => write!(f, "lock poisoned: {what}"),
            DesktopError::Io(msg) => write!(f, "io error: {msg}"),
        }
    }
}

impl std::error::Error for DesktopError {}

impl From<std::io::Error> for DesktopError {
    fn from(error: std::io::Error) -> Self {
        DesktopError::Io(error.to_string())
    }
}

/// Tauri commands require their error type to be `Serialize`. We flatten the
/// error into a single human-readable message string for the webview, so the
/// frontend never has to know about Rust enum shapes.
impl serde::Serialize for DesktopError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Convenience alias for shell results.
pub type DesktopResult<T> = Result<T, DesktopError>;
