//! 桌面外壳错误处理(error)——所有可失败操作返回 DesktopResult;错误类型小而可序列化,以便跨 Tauri IPC 边界传给 webview。
//! 变体对应 sidecar、路径、锁、IO、更新等失败域;新增失败域应加变体,不要在调用点裸传 String。

use std::fmt;

/// 桌面外壳操作的类型化错误。
#[derive(Debug)]
pub enum DesktopError {
    /// Node host sidecar 创建、启动或停止失败。
    Sidecar(String),
    /// 请求路径无效或逃出可信根。
    Path(String),
    /// 共享锁(如 sidecar 句柄锁)已中毒。
    Lock(&'static str),
    /// 底层 I/O 或平台调用失败。
    Io(String),
    /// 桌面更新检查、下载或安装失败。
    Update(String),
}

impl DesktopError {
    /// 稳定的错误「类别」短字符串,供日志/指标打标使用;有意保留的公共诊断 API,暂未在内部调用。
    #[allow(dead_code)] // 有意保留的诊断辅助,供后续日志/指标打标。
    pub fn kind(&self) -> &'static str {
        match self {
            DesktopError::Sidecar(_) => "sidecar",
            DesktopError::Path(_) => "path",
            DesktopError::Lock(_) => "lock",
            DesktopError::Io(_) => "io",
            DesktopError::Update(_) => "update",
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
            DesktopError::Update(msg) => write!(f, "update error: {msg}"),
        }
    }
}

impl std::error::Error for DesktopError {}

impl From<std::io::Error> for DesktopError {
    fn from(error: std::io::Error) -> Self {
        DesktopError::Io(error.to_string())
    }
}

/// Tauri command 要求错误可 Serialize;这里压平成可读字符串,让前端不需要理解 Rust enum 形状。
impl serde::Serialize for DesktopError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// 桌面外壳结果类型别名。
pub type DesktopResult<T> = Result<T, DesktopError>;
