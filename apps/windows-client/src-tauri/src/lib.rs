use std::{
    env,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::Serialize;
use tauri::{Emitter, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

const HOST: &str = "127.0.0.1";
const PORT: &str = "3017";
const HOST_URL: &str = "http://127.0.0.1:3017";

#[derive(Default)]
struct HostSidecar {
    child: Mutex<Option<CommandChild>>,
}

#[derive(Serialize)]
struct HostStatus {
    url: &'static str,
    running: bool,
}

fn trusted_root() -> Result<PathBuf, String> {
    if let Ok(root) = env::var("KCW_TRUSTED_ROOT") {
        return Ok(PathBuf::from(root));
    }
    if let Ok(root) = env::var("KCW_REPO_ROOT") {
        return Ok(PathBuf::from(root));
    }
    env::current_dir().map_err(|error| error.to_string())
}

fn canonicalize_existing(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map_err(|error| format!("failed to resolve path {}: {error}", path.display()))
}

fn assert_trusted_path(root: &Path, requested: &str) -> Result<PathBuf, String> {
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
        Err(format!("path escaped trusted root: {}", candidate.display()))
    }
}

#[tauri::command]
fn host_status(state: State<'_, HostSidecar>) -> Result<HostStatus, String> {
    let guard = state.child.lock().map_err(|_| "host sidecar lock poisoned")?;
    Ok(HostStatus {
        url: HOST_URL,
        running: guard.is_some(),
    })
}

#[tauri::command]
fn start_node_host(app: tauri::AppHandle, state: State<'_, HostSidecar>) -> Result<HostStatus, String> {
    let mut guard = state.child.lock().map_err(|_| "host sidecar lock poisoned")?;
    if guard.is_some() {
        return Ok(HostStatus {
            url: HOST_URL,
            running: true,
        });
    }

    let root = trusted_root()?;
    let (_rx, child) = app
        .shell()
        .sidecar("binaries/kimi-cowork-host")
        .map_err(|error| format!("failed to create host sidecar command: {error}"))?
        .env("HOST", HOST)
        .env("PORT", PORT)
        .env("TRUSTED_ROOT", root.to_string_lossy().to_string())
        .env("KCW_TAURI", "1")
        .spawn()
        .map_err(|error| format!("failed to start Kimi Cowork host sidecar: {error}"))?;
    *guard = Some(child);
    app.emit("kimi://host-started", HOST_URL)
        .map_err(|error| error.to_string())?;

    Ok(HostStatus {
        url: HOST_URL,
        running: true,
    })
}

#[tauri::command]
fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let root = trusted_root()?;
    let safe = assert_trusted_path(&root, &path)?;
    app.opener()
        .open_path(safe.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(HostSidecar::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![host_status, start_node_host, open_path])
        .run(tauri::generate_context!())
        .expect("error while running Kimi Cowork desktop");
}
