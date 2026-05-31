// 设置类型(UI · components):Settings.tsx(模态外框)与 SettingsTabsContent.tsx(各标签内容)共享的 props/类型。
// Shared between Settings.tsx (the modal frame) and SettingsTabsContent.tsx
// (the per-tab JSX). Kept in its own file so the two halves don't import each
// other (check-arch would flag the cycle even though TS type-only imports
// erase at runtime).

export type SettingsTab =
  | 'account'
  | 'appearance'
  | 'model'
  | 'input'
  | 'api'
  | 'runtime'
  | 'updates'
  | 'selfcheck';
