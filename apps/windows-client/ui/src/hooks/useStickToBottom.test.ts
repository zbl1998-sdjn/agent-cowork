import { describe, expect, it } from 'vitest';
import { isNearBottom, shouldFlagNewContent, shouldResetScroll } from './useStickToBottom';

describe('useStickToBottom helpers', () => {
  it('treats positions inside the threshold as stuck to bottom', () => {
    // 接近底部时继续视为吸底,避免流式输出时轻微滚动误差打断自动跟随。
    expect(isNearBottom({ scrollTop: 452, scrollHeight: 1000, clientHeight: 500 })).toBe(true);
    expect(isNearBottom({ scrollTop: 410, scrollHeight: 1000, clientHeight: 500 }, 48)).toBe(false);
  });

  it('only flags new content when the user is detached from the bottom', () => {
    // 只有用户离开底部且内容增长时才显示“有新内容”提示。
    expect(shouldFlagNewContent(false, 1000, 1050)).toBe(true);
    expect(shouldFlagNewContent(true, 1000, 1050)).toBe(false);
    expect(shouldFlagNewContent(false, 1000, 1000)).toBe(false);
  });

  it('resets scroll when the timeline element appears after the auth gate', () => {
    // 鉴权后首次挂载时间线或切换会话时应重置滚动,同会话已有高度则保持用户位置。
    expect(shouldResetScroll('conversation-1', 'conversation-1', 0)).toBe(true);
    expect(shouldResetScroll('conversation-1', 'conversation-1', 1200)).toBe(false);
    expect(shouldResetScroll('conversation-1', 'conversation-2', 1200)).toBe(true);
  });
});
