//! 桌面外壳配置(config)——绑定地址、dev URL、可信根解析的单一事实来源。配置集中而非散落(plan/01 B.7)。

use std::env;
use std::path::PathBuf;

use crate::error::{DesktopError, DesktopResult};

/// 打包 Node host 绑定的回环地址。
pub const HOST: &str = "127.0.0.1";
/// 打包 Node host 监听端口,需与 tauri.conf.json 保持一致。
pub const PORT: &str = "3017";
/// host 完整本地 URL,供 webview 与状态命令使用。
pub const HOST_URL: &str = "http://127.0.0.1:3017";

/// 是否已配置正式的在线更新发布源。tauri.conf 的 updater endpoint 仍是占位域名
/// (updates.agent-cowork.local)时保持 false:在线检查/安装直接给"未配置"清晰提示,
/// 而非让用户点"检查更新"后得到一串 DNS/网络裸错。接好正式发布源后改为 true。
pub const UPDATES_CONFIGURED: bool = false;

/// 解析 host 允许操作的可信根。顺序:ACW_TRUSTED_ROOT(兼容旧 KCW_TRUSTED_ROOT)→
/// ACW_REPO_ROOT(兼容旧 KCW_REPO_ROOT)→ 用户 home → 当前目录。
/// 安装版常从不可写系统目录启动,所以优先退回 home,保证 host 能创建自己的 .AgentCowork 状态。
/// 用户每次选择的工作区会随 /api 请求另传;这里仅是 host 自身状态根。
/// 新旧变量名都读取:用户/脚本可能仍在用旧的 KCW_* 环境变量名,直接改读 ACW_* 会
/// 让既有配置悄悄失效,所以优先认新名、找不到再退回旧名。
pub fn trusted_root() -> DesktopResult<PathBuf> {
    for var in ["ACW_TRUSTED_ROOT", "KCW_TRUSTED_ROOT"] {
        if let Ok(root) = env::var(var) {
            if !root.is_empty() {
                return Ok(PathBuf::from(root));
            }
        }
    }
    for var in ["ACW_REPO_ROOT", "KCW_REPO_ROOT"] {
        if let Ok(root) = env::var(var) {
            if !root.is_empty() {
                return Ok(PathBuf::from(root));
            }
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
