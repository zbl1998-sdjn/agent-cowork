// 图标常量(UI · lib)
// ---------------------------------------------------------------------------
// 职责:应用外框(头部按钮/输入区触发器/面板小标)所用 emoji 图标的单一事实来源;
// 集中管理便于将来一处切换为 SVG 图标集、可被 check:icons 看护(禁止 JSX 裸 emoji)、
// 并统一变体选择符(如 ⚙️ 强制 U+FE0F 全彩,避免 Windows 上的线框渲染)。
// 导出:ICONS、IconKey。条目宜少,超 30 项应改用真正的图标字体。

export const ICONS = Object.freeze({
  /** 文件夹 / 工作区胶囊图标。 */
  FOLDER: '📁',
  /** 应用包 / 安装器展示图标。 */
  PACKAGE: '📦',
  /** 下载缺失运行时或依赖的图标。 */
  DOWNLOAD: '📥',
  /** 置顶会话标记。 */
  PIN: '📌',
  /** 设置齿轮;强制 U+FE0F 变体以获得全彩图标渲染。 */
  SETTINGS: '⚙️',
  /** 输入框"插入配方/模板"触发器。 */
  TEMPLATE: '📝',
  /** 输入框"附加/引用文件"触发器。 */
  PAPERCLIP: '📎',
  /** 输入框"浏览历史运行"触发器。 */
  HISTORY: '🕘',
} as const);

export type IconKey = keyof typeof ICONS;
