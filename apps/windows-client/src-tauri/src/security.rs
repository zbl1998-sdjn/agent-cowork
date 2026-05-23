//! Path-safety helpers shared by every command that touches the filesystem.
//!
//! The single invariant enforced here: a resolved path must live inside the
//! trusted root. This mirrors the host's `path-policy` so the desktop shell
//! cannot be used to reach files outside the user's selected workspace.

use std::path::{Path, PathBuf};

use crate::error::{DesktopError, DesktopResult};

/// Canonicalise a path that is expected to already exist, mapping failures to
/// a descriptive [`DesktopError::Path`].
pub fn canonicalize_existing(path: &Path) -> DesktopResult<PathBuf> {
    path.canonicalize()
        .map_err(|error| DesktopError::Path(format!("failed to resolve {}: {error}", path.display())))
}

/// Resolve `requested` (absolute, or relative to `root`) and assert the result
/// stays within the canonicalised trusted `root`.
///
/// Returns the canonical path on success, or [`DesktopError::Path`] if the
/// path escapes the root.
pub fn assert_trusted_path(root: &Path, requested: &str) -> DesktopResult<PathBuf> {
    let root = canonicalize_existing(root)?;
    let candidate = PathBuf::from(requested);
    let candidate = if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    };
    let candidate = canonicalize_existing(&candidate)?;
    if candidate == root || candidate.starts_with(&root) {
        Ok(candidate)
    } else {
        Err(DesktopError::Path(format!(
            "path escaped trusted root: {}",
            candidate.display()
        )))
    }
}
