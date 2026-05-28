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
