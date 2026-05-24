//! Path-safety helpers shared by every command that touches the filesystem.
//!
//! The single invariant enforced here: a resolved path must live inside the
//! trusted root. This mirrors the host's `path-policy` so the desktop shell
//! cannot be used to reach files outside the user's selected workspace.

use std::path::{Component, Path, PathBuf};

use crate::error::{DesktopError, DesktopResult};

/// Canonicalise a path that is expected to already exist, mapping failures to
/// a descriptive [`DesktopError::Path`].
pub fn canonicalize_existing(path: &Path) -> DesktopResult<PathBuf> {
    path.canonicalize().map_err(|error| {
        DesktopError::Path(format!("failed to resolve {}: {error}", path.display()))
    })
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

fn lower_normal_component(component: Component<'_>) -> Option<String> {
    match component {
        Component::Normal(value) => Some(value.to_string_lossy().to_ascii_lowercase()),
        _ => None,
    }
}

fn has_blocked_workspace_segment(path: &Path) -> bool {
    path.components()
        .filter_map(lower_normal_component)
        .any(|segment| {
            segment.starts_with('.')
                || segment == "appdata"
                || segment == "credentials"
                || segment == ".kimi"
                || segment == ".ssh"
                || segment == ".git"
                || segment == ".aws"
                || segment == ".azure"
                || segment == ".docker"
                || segment == ".gnupg"
                || segment == ".kube"
                || segment == ".env"
                || segment.starts_with(".env")
        })
}

fn has_sensitive_filename(path: &Path) -> bool {
    let Some(name) = path.file_name() else {
        return false;
    };
    let name = name.to_string_lossy().to_ascii_lowercase();
    name == ".env"
        || name == ".netrc"
        || name == ".npmrc"
        || name == ".pypirc"
        || name == "credentials.json"
        || name == "id_dsa"
        || name == "id_ecdsa"
        || name == "id_ed25519"
        || name == "id_rsa"
        || name.starts_with("id_rsa")
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || name.ends_with(".p12")
        || name.ends_with(".pfx")
}

fn is_artifact_path(root: &Path, safe: &Path) -> bool {
    let artifact_root = root.join(".AgentCowork").join("artifacts");
    let Ok(artifact_root) = canonicalize_existing(&artifact_root) else {
        return false;
    };
    safe == artifact_root || safe.starts_with(artifact_root)
}

/// Resolve a path for OS opening. This is stricter than [`assert_trusted_path`]:
/// renderer IPC may ask to open a path, but it must not use that command as a
/// side door into hidden workspace state or secret-like files. Saved artifacts
/// remain openable because the product exposes an explicit artifact panel.
pub fn assert_openable_path(root: &Path, requested: &str) -> DesktopResult<PathBuf> {
    let root = canonicalize_existing(root)?;
    let safe = assert_trusted_path(&root, requested)?;
    if is_artifact_path(&root, &safe) {
        return Ok(safe);
    }
    if safe == root {
        return Err(DesktopError::Path(
            "opening the workspace root is blocked; open a file or artifact instead".to_string(),
        ));
    }
    let relative = safe.strip_prefix(&root).map_err(|_| {
        DesktopError::Path(format!("path escaped trusted root: {}", safe.display()))
    })?;
    if has_blocked_workspace_segment(relative) || has_sensitive_filename(&safe) {
        return Err(DesktopError::Path(format!(
            "hidden or sensitive path blocked: {}",
            safe.display()
        )));
    }
    Ok(safe)
}

#[cfg(test)]
mod tests {
    use super::assert_openable_path;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agent-cowork-{name}-{stamp}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, body).unwrap();
    }

    #[test]
    fn openable_path_blocks_workspace_root_and_hidden_files() {
        let root = temp_root("open-hidden");
        write(&root.join(".npmrc"), "token=secret");
        write(&root.join("notes.txt"), "ok");

        assert!(assert_openable_path(&root, ".").is_err());
        assert!(assert_openable_path(&root, ".npmrc").is_err());
        assert!(assert_openable_path(&root, "notes.txt").is_ok());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn openable_path_allows_artifacts_exception() {
        let root = temp_root("open-artifact");
        let artifact_dir = root.join(".AgentCowork").join("artifacts");
        let artifact = artifact_dir.join("report.md");
        write(&artifact, "# report");

        assert!(assert_openable_path(&root, artifact_dir.to_str().unwrap()).is_ok());
        assert!(assert_openable_path(&root, artifact.to_str().unwrap()).is_ok());

        fs::remove_dir_all(root).unwrap();
    }
}
