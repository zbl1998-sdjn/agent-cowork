use std::{
    env,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
};

use serde::Serialize;
use tauri::{Emitter, State};
use tauri_plugin_shell::ShellExt;

const HOST: &str = "127.0.0.1";
const PORT: &str = "3017";
const HOST_URL: &str = "http://127.0.0.1:3017";

#[derive(Default)]
struct HostSidecar {
    child: Mutex<Option<Child>>,
}

#[derive(Serialize)]
struct HostStatus {
    url: &'static str,
    running: bool,
}

fn repo_root() -> Result<PathBuf, String> {
    if let Ok(root) = env::var("KCW_REPO_ROOT") {
        return Ok(PathBuf::from(root));
    }
    env::current_dir()
        .map_err(|error| error.to_string())
        .map(|dir| dir.join("..").join("..").join(".."))
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

    let root = repo_root()?;
    let main_js = root.join("apps").join("host").join("src").join("main.js");
    let child = Command::new("node")
        .arg(main_js)
        .env("HOST", HOST)
        .env("PORT", PORT)
        .env("TRUSTED_ROOT", &root)
        .env("KCW_TAURI", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("failed to start Node host: {error}"))?;
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
    app.shell().open(path, None).map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(HostSidecar::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![host_status, start_node_host, open_path])
        .run(tauri::generate_context!())
        .expect("error while running Kimi Cowork desktop");
}
