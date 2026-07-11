//! 路径安全(security)——凡触碰文件系统的命令共用:强制「解析后的路径必须落在可信根内」。
//! 与 host 的 path-policy 镜像对应,使外壳侧 open_path 等也守同一围栏(plan/01 D.12 路径 jail)。

use std::path::{Component, Path, PathBuf};

use crate::error::{DesktopError, DesktopResult};

// 只允许交给系统默认程序打开明确的被动文档/图片格式。执行文件、脚本、快捷方式、
// HTML/SVG 等主动内容以及未知扩展均 fail-closed；扩展比较不区分大小写。
const PASSIVE_DOCUMENT_EXTENSIONS: &[&str] = &[
    "bmp", "csv", "docx", "gif", "jpeg", "jpg", "json", "jsonl", "log", "markdown", "md", "pdf",
    "png", "pptx", "tif", "tiff", "tsv", "txt", "webp", "xlsx", "yaml", "yml",
];

/// 规范化一个预期已存在的路径;失败时转成可读的 DesktopError::Path。
pub fn canonicalize_existing(path: &Path) -> DesktopResult<PathBuf> {
    path.canonicalize().map_err(|error| {
        DesktopError::Path(format!("failed to resolve {}: {error}", path.display()))
    })
}

/// 解析 requested(绝对路径或相对 root),并断言规范化后的结果仍在可信 root 内。
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

fn has_passive_document_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .is_some_and(|extension| PASSIVE_DOCUMENT_EXTENSIONS.contains(&extension.as_str()))
}

/// 解析可由系统打开的路径;比 assert_trusted_path 更严格,避免 renderer IPC 借 open_path 打开隐藏状态或密钥文件。
/// 已保存 artifact 仍可打开,因为产品有显式产物面板入口。
pub fn assert_openable_path(root: &Path, requested: &str) -> DesktopResult<PathBuf> {
    let root = canonicalize_existing(root)?;
    let safe = assert_trusted_path(&root, requested)?;
    if safe == root {
        return Err(DesktopError::Path(
            "opening the workspace root is blocked; open a file or artifact instead".to_string(),
        ));
    }
    let artifact_path = is_artifact_path(&root, &safe);
    let relative = safe.strip_prefix(&root).map_err(|_| {
        DesktopError::Path(format!("path escaped trusted root: {}", safe.display()))
    })?;
    if !artifact_path && (has_blocked_workspace_segment(relative) || has_sensitive_filename(&safe))
    {
        return Err(DesktopError::Path(format!(
            "hidden or sensitive path blocked: {}",
            safe.display()
        )));
    }
    // 保留产物面板“打开产物目录”的既有能力；其他目录必须走专用 reveal command，
    // 不能把通用 open_path 扩成任意 Explorer 跳转入口。
    if safe.is_dir() {
        return if artifact_path {
            Ok(safe)
        } else {
            Err(DesktopError::Path(format!(
                "directory opening is blocked; use a dedicated reveal command: {}",
                safe.display()
            )))
        };
    }
    if !safe.is_file() {
        return Err(DesktopError::Path(format!(
            "only regular files can be opened: {}",
            safe.display()
        )));
    }
    if !has_passive_document_extension(&safe) {
        return Err(DesktopError::Path(format!(
            "file type is not allowed for system opening: {}",
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

    #[test]
    fn openable_path_allows_only_passive_document_types() {
        let root = temp_root("open-passive-documents");
        for name in [
            "notes.txt",
            "report.md",
            "table.csv",
            "data.json",
            "REPORT.PDF",
            "brief.docx",
            "workbook.xlsx",
            "slides.pptx",
            "diagram.png",
        ] {
            write(&root.join(name), "safe");
            assert!(
                assert_openable_path(&root, name).is_ok(),
                "expected passive document to be openable: {name}"
            );
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn openable_path_rejects_executables_scripts_shortcuts_and_active_documents() {
        let root = temp_root("open-active-files");
        let artifact_dir = root.join(".AgentCowork").join("artifacts");
        for name in [
            "program.exe",
            "setup.msi",
            "command.cmd",
            "script.ps1",
            "script.js",
            "shortcut.lnk",
            "website.url",
            "report.docm",
            "page.html",
            "image.svg",
            "report.pdf.exe",
        ] {
            let workspace_file = root.join(name);
            let artifact_file = artifact_dir.join(name);
            write(&workspace_file, "active");
            write(&artifact_file, "active");
            assert!(
                assert_openable_path(&root, workspace_file.to_str().unwrap()).is_err(),
                "expected active workspace file to be blocked: {name}"
            );
            assert!(
                assert_openable_path(&root, artifact_file.to_str().unwrap()).is_err(),
                "expected active artifact file to be blocked: {name}"
            );
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn openable_path_rejects_unknown_files_and_non_artifact_directories() {
        let root = temp_root("open-unknown");
        let regular_dir = root.join("documents");
        fs::create_dir_all(&regular_dir).unwrap();
        write(&root.join("README"), "no extension");
        write(&root.join("archive.zip"), "unknown container");

        assert!(assert_openable_path(&root, "README").is_err());
        assert!(assert_openable_path(&root, "archive.zip").is_err());
        assert!(assert_openable_path(&root, regular_dir.to_str().unwrap()).is_err());

        fs::remove_dir_all(root).unwrap();
    }
}
