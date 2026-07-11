// 设置视图类型(UI · lib/types):运行时 hook 与设置组件共享。
export type SettingsTab =
  | 'account'
  | 'appearance'
  | 'model'
  | 'input'
  | 'api'
  | 'runtime'
  | 'updates'
  | 'selfcheck';

export type AppFontScale = 'small' | 'normal' | 'large' | 'xlarge';

export type AppFontFamily = 'system' | 'chinese' | 'serif' | 'mono';
