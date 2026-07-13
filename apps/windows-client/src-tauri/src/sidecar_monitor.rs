//! Sidecar 子进程状态与身份监控循环。
//! 对外仅暴露状态快照、注册/停止与监控入口；进程句柄和启动密钥始终留在 native 层。

use std::process::Child;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ring::rand::{SecureRandom, SystemRandom};
use tauri::{AppHandle, Emitter};

use crate::config::{HOST, HOST_URL, PORT};
use crate::error::{DesktopError, DesktopResult};
use crate::sidecar_health::{request_authenticated_health, SECRET_BYTES};

const EVENT_HOST_STARTED: &str = "kimi://host-started";
const EVENT_HOST_STOPPED: &str = "kimi://host-stopped";

struct ManagedChild {
    child: Child,
    secret: [u8; SECRET_BYTES],
    verified: bool,
    generation: u64,
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        self.secret.fill(0);
    }
}

#[derive(Default)]
pub(crate) struct SidecarState {
    child: Option<ManagedChild>,
    next_generation: u64,
}

impl SidecarState {
    /// 刷新真实进程态，并返回运行中进程的 native 身份校验状态。
    pub(crate) fn status(&mut self) -> DesktopResult<Option<bool>> {
        let Some(managed) = self.child.as_mut() else {
            return Ok(None);
        };
        match managed.child.try_wait() {
            Ok(Some(_)) => {
                self.child = None;
                Ok(None)
            }
            Ok(None) => Ok(Some(managed.verified)),
            Err(error) => {
                managed.verified = false;
                Err(DesktopError::Sidecar(format!(
                    "query host process failed: {error}"
                )))
            }
        }
    }

    pub(crate) fn register(&mut self, child: Child, secret: [u8; SECRET_BYTES]) -> u64 {
        self.next_generation = self.next_generation.wrapping_add(1).max(1);
        let generation = self.next_generation;
        self.child = Some(ManagedChild {
            child,
            secret,
            verified: false,
            generation,
        });
        generation
    }

    /// 移除并终止当前进程；返回是否实际持有进程。
    pub(crate) fn stop(&mut self) -> bool {
        let Some(mut managed) = self.child.take() else {
            return false;
        };
        let _ = managed.child.kill();
        let _ = managed.child.wait();
        true
    }
}

pub(crate) fn emit_host_stopped(app: &AppHandle) {
    let _ = app.emit(EVENT_HOST_STOPPED, HOST_URL);
}

fn stop_generation(state: &Arc<Mutex<SidecarState>>, generation: u64) -> bool {
    let child = {
        let Ok(mut guard) = state.lock() else {
            return false;
        };
        let matches = guard
            .child
            .as_ref()
            .is_some_and(|managed| managed.generation == generation);
        if matches {
            guard.child.take()
        } else {
            None
        }
    };

    if let Some(mut managed) = child {
        let _ = managed.child.kill();
        let _ = managed.child.wait();
        true
    } else {
        false
    }
}

pub(crate) fn monitor_generation(state: Arc<Mutex<SidecarState>>, app: AppHandle, generation: u64) {
    let Ok(address) = format!("{HOST}:{PORT}").parse() else {
        stop_generation(&state, generation);
        return;
    };
    let random = SystemRandom::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut announced = false;

    loop {
        let mut secret = {
            let Ok(mut guard) = state.lock() else {
                return;
            };
            let Some(managed) = guard.child.as_mut() else {
                return;
            };
            if managed.generation != generation {
                return;
            }
            match managed.child.try_wait() {
                Ok(Some(_)) => {
                    guard.child = None;
                    emit_host_stopped(&app);
                    return;
                }
                Ok(None) => managed.secret,
                Err(_) => {
                    managed.verified = false;
                    return;
                }
            }
        };

        if !announced {
            let mut challenge = [0_u8; SECRET_BYTES];
            let verified = random.fill(&mut challenge).is_ok()
                && request_authenticated_health(&address, &secret, &challenge);
            secret.fill(0);
            challenge.fill(0);

            if verified {
                let Ok(mut guard) = state.lock() else {
                    return;
                };
                let Some(managed) = guard.child.as_mut() else {
                    return;
                };
                if managed.generation != generation || !matches!(managed.child.try_wait(), Ok(None))
                {
                    return;
                }
                managed.verified = true;
                announced = true;
                let _ = app.emit(EVENT_HOST_STARTED, HOST_URL);
            } else if Instant::now() >= deadline {
                if stop_generation(&state, generation) {
                    emit_host_stopped(&app);
                }
                return;
            }
        } else {
            secret.fill(0);
        }

        std::thread::sleep(Duration::from_millis(200));
    }
}
