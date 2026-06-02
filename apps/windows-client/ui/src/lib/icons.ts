// 图标常量(UI · lib)
// ---------------------------------------------------------------------------
// 职责:应用外框(头部按钮/输入区触发器/面板小标)所用 emoji 图标的单一事实来源;
// 集中管理便于将来一处切换为 SVG 图标集、可被 check:icons 看护(禁止 JSX 裸 emoji)、
// 并统一变体选择符(如 ⚙️ 强制 U+FE0F 全彩,避免 Windows 上的线框渲染)。
// 导出:ICONS、IconKey。条目宜少,超 30 项应改用真正的图标字体。

export const ICONS = Object.freeze({
  /** Folder / workspace chip. */
  FOLDER: '📁',
  /** App package / installer reveal. */
  PACKAGE: '📦',
  /** Download a missing runtime / dependency. */
  DOWNLOAD: '📥',
  /** Pinned conversation marker. */
  PIN: '📌',
  /** Settings cog. Forces the U+FE0F variant for full-colour rendering. */
  SETTINGS: '⚙️',
  /** Composer "insert a recipe / template" trigger. */
  TEMPLATE: '📝',
  /** Composer "attach / reference a file" trigger. */
  PAPERCLIP: '📎',
  /** Composer "browse previous runs" trigger. */
  HISTORY: '🕘',
} as const);

export type IconKey = keyof typeof ICONS;
