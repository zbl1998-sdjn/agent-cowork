//! Sidecar 子进程状态与身份监控循环。
//! 对外仅暴露状态快照、注册/停止与监控入口；进程句柄和启动密钥始终留在 native 层。

use std::process::Child;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ring::rand::{SecureRandom, SystemRandom};
use tauri::{AppHandle, Emitter};

use crate::config::{HOST, HOST_URL, PORT};
use crate::error::{DesktopError, DesktopResult};
use crate::sidecar_health::{request_authenticated_health, HealthProbe, SECRET_BYTES};

const EVENT_HOST_STARTED: &str = "agent-cowork://host-started";
const EVENT_HOST_STOPPED: &str = "agent-cowork://host-stopped";

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

fn diag(msg: &str) {
    if std::env::var_os("ACW_SIDECAR_MONITOR_DIAG").is_none() {
        return;
    }
    use std::io::Write as _;
    let mut path = std::env::temp_dir();
    path.push("acw-sidecar-monitor.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{msg}");
    }
}

pub(crate) fn monitor_generation(state: Arc<Mutex<SidecarState>>, app: AppHandle, generation: u64) {
    diag(&format!("monitor start gen={generation}"));
    let Ok(address) = format!("{HOST}:{PORT}").parse() else {
        stop_generation(&state, generation);
        return;
    };
    let random = SystemRandom::new();
    // 只有连一次都连不上端口才判定 sidecar 真死;"慢"不等于"坏"。
    // SEA 二进制冷启动(含内置 Python 探测)在高负载机器上可能超过 30s,
    // 旧的 10s 硬超时会把健康但启动慢的 sidecar 杀掉,导致 verified 永远为 false、
    // 前端每次 requireHost 都抛错、登录/跳过静默失效。这里改为:持续重试校验,
    // 只有到宽限期(90s)后仍从未连通(端口一次都没接受连接)才放弃并回收。
    let give_up_after = Instant::now() + Duration::from_secs(90);
    let mut announced = false;
    let mut ever_reachable = false;

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
                Ok(Some(status)) => {
                    diag(&format!("gen={generation} child EXITED status={status:?}"));
                    guard.child = None;
                    emit_host_stopped(&app);
                    return;
                }
                Ok(None) => managed.secret,
                Err(error) => {
                    diag(&format!("gen={generation} try_wait ERR={error}"));
                    managed.verified = false;
                    return;
                }
            }
        };

        if !announced {
            let mut challenge = [0_u8; SECRET_BYTES];
            let probe = if random.fill(&mut challenge).is_ok() {
                request_authenticated_health(&address, &secret, &challenge)
            } else {
                HealthProbe::default()
            };
            if probe.reachable {
                ever_reachable = true;
            }
            let verified = probe.verified;
            diag(&format!(
                "gen={generation} probe reachable={} verified={}",
                probe.reachable, probe.verified
            ));
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
            } else if !ever_reachable && Instant::now() >= give_up_after {
                // 90s 内端口一次都没接受过连接 = sidecar 大概率没真正起来,回收后可重生成。
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
