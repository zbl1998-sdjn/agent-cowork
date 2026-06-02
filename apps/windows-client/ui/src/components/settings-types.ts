// 设置标签类型(UI · 类型层 · lib)
// ---------------------------------------------------------------------------
// 职责:SettingsTab 联合类型的单一来源——供 Settings.tsx(模态外框)与 SettingsTabsContent.tsx(各标签内容)共享;独立成文件避免两半互相 import 形成依赖环。
// 导出:SettingsTab。

export type SettingsTab =
  | 'account'
  | 'appearance'
  | 'model'
  | 'input'
  | 'api'
  | 'runtime'
  | 'updates'
  | 'selfcheck';
