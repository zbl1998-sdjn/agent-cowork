// Icon(UI · components/ui):Claude 风格线性 SVG 图标集(stroke,24 视口,currentColor)。
// 单一事实来源,替代散落的 emoji;条目按需增补。用法:<Icon name="new-chat" size={18} />
import type { ReactNode, SVGProps } from 'react';

export type IconName =
  | 'new-chat' | 'search' | 'tools' | 'connectors' | 'artifacts' | 'memory'
  | 'observability' | 'schedules' | 'projects' | 'viz' | 'settings' | 'folder'
  | 'command' | 'more' | 'sun' | 'moon' | 'send' | 'plus' | 'paperclip'
  | 'sidebar' | 'chevron-down' | 'pin' | 'sparkle' | 'template' | 'history'
  | 'package' | 'stop' | 'trash' | 'export' | 'rename' | 'check' | 'mic';

// 每个图标是一组 SVG 子元素(path/circle/…),统一 stroke 渲染。
const GLYPHS: Record<IconName, ReactNode> = {
  'new-chat': <><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
  tools: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 1 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8Z" />,
  connectors: <><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.8 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></>,
  artifacts: <><path d="M12.8 2.2a2 2 0 0 0-1.6 0L2.6 6.1a1 1 0 0 0 0 1.8l8.6 3.9a2 2 0 0 0 1.6 0l8.6-3.9a1 1 0 0 0 0-1.8Z" /><path d="m22 17.7-9.2 4.1a2 2 0 0 1-1.6 0L2 17.7" /><path d="m22 12.7-9.2 4.1a2 2 0 0 1-1.6 0L2 12.7" /></>,
  memory: <><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5" /><path d="M3 12a9 3 0 0 0 18 0" /></>,
  observability: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  schedules: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  projects: <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
  viz: <><path d="M12 20V10" /><path d="M18 20V4" /><path d="M6 20v-4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>,
  folder: <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" />,
  command: <path d="M15 6a3 3 0 1 1 3 3h-3Zm0 0v12m0-12H9m0 0v12m0-12a3 3 0 1 0-3-3v3Zm0 12a3 3 0 1 1-3 3v-3Zm6 0h-6m6 0a3 3 0 1 0 3 3v-3Z" />,
  more: <><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" /></>,
  moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  send: <><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></>,
  plus: <><path d="M5 12h14" /><path d="M12 5v14" /></>,
  paperclip: <path d="m21.4 11-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6A4 4 0 1 1 18 8.8l-8.6 8.6a2 2 0 0 1-2.8-2.9l8.5-8.4" />,
  sidebar: <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /></>,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  pin: <path d="M12 17v5M9 10.8V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v6.8l2 2.2H7Z" />,
  sparkle: <path d="M12 3l1.6 5.9a3 3 0 0 0 2 2L21 12l-5.4 1.1a3 3 0 0 0-2 2L12 21l-1.6-5.9a3 3 0 0 0-2-2L3 12l5.4-1.1a3 3 0 0 0 2-2Z" />,
  template: <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18M9 21V9" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
  package: <><path d="M21 8v8a2 2 0 0 1-1 1.7l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.7l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8Z" /><path d="m3.3 7 8.7 5 8.7-5M12 22V12" /></>,
  stop: <rect width="12" height="12" x="6" y="6" rx="2" />,
  trash: <><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></>,
  export: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5M12 15V3" /></>,
  rename: <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />,
  check: <path d="M20 6 9 17l-5-5" />,
  mic: <><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 19v3" /></>,
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, strokeWidth = 1.75, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {GLYPHS[name]}
    </svg>
  );
}

export default Icon;
