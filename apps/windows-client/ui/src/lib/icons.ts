// Single source of truth for emoji icons that appear in the chrome of the
// app (header buttons, composer triggers, panel chips). Centralised so:
//   - swapping to a real SVG icon set later is a one-file change;
//   - we can lint for "naked emoji" usage (forbid raw 📦 in JSX, force ICONS.*);
//   - variant selectors are uniform — e.g. ⚙ vs ⚙️ render very differently on
//     Windows (line-only vs full-colour) and we previously used the bare form
//     by accident.
//
// Keep this list short. If you find yourself adding 30+ entries, the answer
// is probably "switch to a real icon font" rather than "add another emoji."

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
